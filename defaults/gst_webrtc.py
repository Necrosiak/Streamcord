#Most of the code here is adapted from https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/main/subprojects/gst-examples/webrtc/sendrecv/gst/webrtc_sendrecv.py
#Code for setting up pipelinesrc and audio pipeline is from https://github.com/marissa999/decky-recorder

import aiohttp # type: ignore
from aiohttp import web # type: ignore
from logging import getLogger
from gi import require_version # type: ignore
import asyncio
from asyncio import run_coroutine_threadsafe
from subprocess import getoutput

log = getLogger("webrtc")

require_version("Gst", "1.0")
require_version("GstWebRTC", "1.0")
require_version("GstSdp", "1.0")
from gi.repository import Gst, GstWebRTC, GstSdp # type: ignore

# Whole-screen capture: pipewiresrc with no target binds to the compositor's
# default screencast node (gamescope exposes the full screen in Steam gaming mode).
# Audio: the default sink's .monitor source (system output mix).
PIPELINE_DESC = """
  webrtcbin name=send latency=0 stun-server=stun://stun.l.google.com:19302
  turn-server=turn://gstreamer:IsGreatWhenYouCanGetItToWork@webrtc.nirbheek.in:3478
  {video_src} do-timestamp=true ! videoconvert ! queue !
  vp8enc deadline=1 keyframe-max-dist=2000 ! rtpvp8pay picture-id-mode=15-bit !
  queue ! application/x-rtp,media=video,encoding-name=VP8,payload={video_pt} ! send.
  pulsesrc device="{monitor}" ! audioconvert ! audioresample ! queue ! opusenc ! rtpopuspay !
  queue ! application/x-rtp,media=audio,encoding-name=OPUS,payload={audio_pt} ! send.
"""


def _find_screen_node():
    """Trouve le node PipeWire de l'écran (gamescope publie l'écran complet en mode
    jeu Steam → capturable SANS portail/dialogue). Log tous les nodes vidéo pour
    diagnostic. Renvoie l'id du node (str) ou None (→ pipewiresrc par défaut)."""
    import json
    from subprocess import getoutput
    try:
        data = json.loads(getoutput("pw-dump"))
    except Exception as e:
        log.warning(f"[screen] pw-dump KO: {e!r}")
        return None
    vids = []
    for n in data:
        if not str(n.get("type", "")).endswith("Node"):
            continue
        p = (n.get("info", {}) or {}).get("props", {}) or {}
        mc = str(p.get("media.class", ""))
        name = str(p.get("node.name", ""))
        desc = str(p.get("node.description", ""))
        blob = (mc + " " + name + " " + desc).lower()
        if "video/source" in mc.lower() or "gamescope" in blob or "screen" in blob or "video/output" in mc.lower():
            vids.append((n.get("id"), name, mc))
    log.info(f"[screen] nodes vidéo candidats: {vids}")
    # Préférence : un node gamescope/screen explicite, sinon le 1er Video/Source.
    for nid, name, mc in vids:
        if "gamescope" in (name.lower()) or "screen" in (name.lower()):
            return str(nid)
    for nid, name, mc in vids:
        if "video/source" in mc.lower():
            return str(nid)
    return None


def get_payload_types(sdpmsg, video_encoding, audio_encoding):
    video_pt = None
    audio_pt = None

    for i in range(0, sdpmsg.medias_len()):
        media = sdpmsg.get_media(i)

        for j in range(0, media.formats_len()):
            fmt = media.get_format(j)

            if fmt == "webrtc-datachannel":
                continue

            pt = int(fmt)
            caps = media.get_caps_from_media(pt)
            s = caps.get_structure(0)
            encoding_name = s.get_string("encoding-name")

            if video_pt is None and encoding_name == video_encoding:
                video_pt = pt

            elif audio_pt is None and encoding_name == audio_encoding:
                audio_pt = pt

    ret = {video_encoding: video_pt, audio_encoding: audio_pt}
    print(ret)
    return ret


class WebRTCServer:
    def __init__(self, loop=None) -> None:
        Gst.init(None)

        self.loop = loop
        self.app = web.Application()
        self.app.add_routes([web.get("/webrtc", self.websocket_handler)])

        self.webrtc = None
        self.remote_ws = None

    def start_pipeline(self, create_offer=True, audio_pt=96, video_pt=97):
        default_sink = getoutput("pactl get-default-sink").splitlines()
        audio_monitor = (default_sink[0] + ".monitor") if default_sink and default_sink[0] else "@DEFAULT_MONITOR@"
        log.info(f"Creating pipeline, create_offer={create_offer}, audio_monitor={audio_monitor}")
        node = _find_screen_node()
        video_src = f"pipewiresrc path={node}" if node else "pipewiresrc"
        log.info(f"[screen] source vidéo: {video_src}")
        desc = PIPELINE_DESC.format(video_src=video_src, video_pt=video_pt, audio_pt=audio_pt, monitor=audio_monitor)
        log.info("Pipeline:\n" + desc)
        try:
            self.pipe = Gst.parse_launch(desc)
        except Exception as e:
            log.error(f"Failed to build pipeline: {e}")
            raise
        self.webrtc = self.pipe.get_by_name("send")
        self.webrtc.connect("on-negotiation-needed", self.on_negotiation_needed, create_offer)
        self.webrtc.connect("on-ice-candidate", self.send_ice_candidate_message)
        # Surface pipeline errors instead of failing silently (whole-screen capture diagnosis)
        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error)
        ret = self.pipe.set_state(Gst.State.PLAYING)
        log.info(f"Pipeline set_state(PLAYING) → {ret}")

    def _on_bus_error(self, _bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"GStreamer pipeline error: {err} | debug: {dbg}")

    def close_pipeline(self):
        if self.pipe:
            self.pipe.set_state(Gst.State.NULL)
            self.pipe = None

        self.webrtc = None
    
    def on_negotiation_needed(self, _, create_offer):
        if create_offer:
            log.info('Call was connected: creating offer')
            promise = Gst.Promise.new_with_change_func(self.on_offer_created, None, None)
            self.webrtc.emit('create-offer', None, promise)

    def send_ice_candidate_message(self, _, mlineindex, candidate):
        icemsg = {'ice': {'candidate': candidate, 'sdpMLineIndex': mlineindex}}
        run_coroutine_threadsafe(self.remote_ws.send_json(icemsg), self.loop)

    def on_offer_set(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        promise = Gst.Promise.new_with_change_func(self.on_answer_created, None, None)
        self.webrtc.emit("create-answer", None, promise)

    def on_answer_created(self, promise, _, __):
        assert promise.wait() == Gst.PromiseResult.REPLIED
        reply = promise.get_reply()
        answer = reply.get_value("answer")
        promise = Gst.Promise.new()
        self.webrtc.emit("set-local-description", answer, promise)
        promise.interrupt()
        print(answer)
        self.send_sdp(answer)

    def send_sdp(self, offer):
        text = offer.sdp.as_text()
        log.info("Sending answer:\n%s" % text)
        msg = {'sdp': {'type': 'answer', 'sdp': text}}
        run_coroutine_threadsafe(self.remote_ws.send_json(msg), self.loop)

    async def websocket_handler(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.remote_ws = ws

        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = msg.json()

                if "offer" in data:
                    res, sdpmsg = GstSdp.SDPMessage.new_from_text(data["offer"]["sdp"])

                    if not self.webrtc:
                        log.info("Incoming call: received an offer, creating pipeline")
                        pts = get_payload_types(sdpmsg, video_encoding="VP8", audio_encoding="OPUS")
                        assert "VP8" in pts
                        assert "OPUS" in pts
                        self.start_pipeline(create_offer=False, video_pt=pts["VP8"], audio_pt=pts["OPUS"])

                    assert self.webrtc
                    offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdpmsg)
                    promise = Gst.Promise.new_with_change_func(self.on_offer_set, None, None)
                    self.webrtc.emit("set-remote-description", offer, promise)

                elif "ice" in data:
                    assert self.webrtc
                    candidate = data['ice']['candidate']
                    sdpmlineindex = data['ice']['sdpMLineIndex']
                    self.webrtc.emit('add-ice-candidate', sdpmlineindex, candidate)

                elif "stop" in data:
                    await ws.close()
                    break

        self.close_pipeline()
        return ws


def main():
    # Python 3.14: no implicit event loop, and aiohttp removed run_app(loop=...).
    # Create the loop explicitly so GStreamer callback threads can target it via
    # run_coroutine_threadsafe.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    server = WebRTCServer(loop=loop)
    runner = web.AppRunner(server.app)
    loop.run_until_complete(runner.setup())
    site = web.TCPSite(runner, "0.0.0.0", 65124)
    loop.run_until_complete(site.start())
    log.info("WebRTC screenshare server listening on :65124")
    loop.run_forever()


if __name__ == "__main__":
    main()