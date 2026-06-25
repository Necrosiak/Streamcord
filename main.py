from aiohttp.web import (  # type: ignore
    Application,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
)
from asyncio import sleep, create_task, create_subprocess_exec
import aiohttp_cors  # type: ignore
from json import dumps
from pathlib import Path
from subprocess import PIPE

import sys
import os

from decky import logger, DECKY_PLUGIN_DIR, emit  # type: ignore
from logging import INFO

sys.path.append(DECKY_PLUGIN_DIR)

from tab_utils.tab import (
    create_discord_tab,
    setup_discord_tab,
    boot_discord,
    setOSK,
)
from tab_utils.cdp import Tab, get_tab
from discord_client.event_handler import EventHandler

logger.setLevel(INFO)


async def stream_watcher(stream, is_err=False):
    async for line in stream:
        line = line.decode("utf-8").rstrip()
        if not line.strip():
            continue
        # Surface GStreamer/WebRTC subprocess output in the journal (was logger.debug,
        # invisible at INFO level — made screenshare failures impossible to diagnose).
        if is_err:
            logger.warning("[gst] " + line)
        else:
            logger.info("[gst] " + line)


async def initialize():
    # NATIVE approach: drive Vesktop (a real Electron Discord, mic works) over CDP
    # instead of a hidden Steam CEF BrowserView (where the mic is impossible).
    import vesktop
    client_js = open(Path(DECKY_PLUGIN_DIR) / "streamcord_client.js", "r").read()
    tab = await vesktop.get_discord_tab(client_js)

    Plugin.discord_tab = tab

    create_task(watchdog(tab))
    return tab


async def watchdog(tab: Tab):
    while True:
        while not tab.websocket.closed:
            await sleep(1)

        logger.info("Discord tab websocket is no longer open. Trying to reconnect...")

        try:
            await tab.open_websocket()
            logger.info("Reconnected")

        except:
            break

    logger.info("Discord has died. Re-initializing...")

    while True:
        try:
            await initialize()
            break

        except:
            await sleep(1)


class Plugin:
    server = Application()
    cors = aiohttp_cors.setup(
        server,
        defaults={
            "*": aiohttp_cors.ResourceOptions(
                expose_headers="*", allow_headers="*", allow_credentials=True
            )
        },
    )
    evt_handler = EventHandler()
    last_ws: WebSocketResponse = None
    discord_tab = None

    @classmethod
    async def _main(cls):
        logger.info("Starting Streamcord backend")
        # CEF (SharedJSContext) can disconnect/reload during startup, which throws
        # mid-evaluate and would otherwise kill _main permanently (watchdog never
        # starts). Retry until the Discord tab is successfully created.
        while True:
            try:
                await initialize()
                break
            except Exception as e:
                logger.warning(f"initialize() failed ({e!r}); retrying in 2s")
                await sleep(2)
        logger.info("Discord initialized")

        cls.server.add_routes(
            [
                get("/openkb", cls._openkb),
                get("/voice_render", cls._voice_render),
                get("/voice_hide", cls._voice_hide),
                get("/socket", cls._websocket_handler)
            ]
        )
        for r in list(cls.server.router.routes())[:-1]:
            cls.cors.add(r)

        cls.runner = AppRunner(cls.server, access_log=None)
        await cls.runner.setup()
        logger.info("Starting server.")
        await TCPSite(cls.runner, "0.0.0.0", 65123).start()

        cls.shared_js_tab = await get_tab("SharedJSContext")
        await cls.shared_js_tab.open_websocket()
        create_task(cls._notification_dispatcher())

        # Use the SYSTEM GStreamer (1.26+). The original Deckcord bundled GStreamer in
        # bin/, but this fork never shipped it — pointing at a nonexistent bin/ broke the
        # subprocess silently. Inherit the full environment so PATH/HOME/typelibs resolve,
        # and only override what's needed for hw encode + pipewire/pulse access.
        uid = os.getuid()
        gst_env = {
            **os.environ,
            "GST_VAAPI_ALL_DRIVERS": "1",
            "LIBVA_DRIVER_NAME": "radeonsi",
            "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"),
            "DBUS_SESSION_BUS_ADDRESS": os.environ.get(
                "DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus"
            ),
        }
        cls.webrtc_server = await create_subprocess_exec(
            "/usr/bin/python",
            str(Path(DECKY_PLUGIN_DIR) / "gst_webrtc.py"),
            env=gst_env,
            stdout=PIPE,
            stderr=PIPE,
        )
        create_task(stream_watcher(cls.webrtc_server.stdout))
        create_task(stream_watcher(cls.webrtc_server.stderr, True))
        create_task(cls._remote_auth_watcher())
        create_task(cls._audio_keepalive())

        async for state in cls.evt_handler.yield_new_state():
            await emit("state", state)

    @classmethod
    async def _audio_keepalive(cls):
        # ROOT CAUSE of "I can't hear anyone": Chromium's autoplay policy keeps
        # AudioContexts suspended in the hidden Discord BrowserView because it never
        # receives a user gesture. A page-side resume() doesn't count. Resuming via a
        # CDP eval with userGesture=True simulates a real activation and unblocks the
        # audio output (a "Chromium / Playback" sink-input then appears on the default
        # sink, which follows headphones/HDMI automatically). Re-assert periodically
        # because Discord spins up new contexts when (re)joining a voice call.
        js = """(() => {
          try {
            let resumed = 0, states = [];
            const me = Vencord.Webpack.findStore('MediaEngineStore')?.getMediaEngine?.();
            const ctxs = [];
            if (me?.audioContext) ctxs.push(me.audioContext);
            if (window.__sc_extra_ctx) ctxs.push(window.__sc_extra_ctx);
            for (const c of ctxs) {
              states.push(c.state);
              if (c.state === 'suspended') { c.resume(); resumed++; }
            }
            return 'resumed=' + resumed + ' states=' + JSON.stringify(states);
          } catch (e) { return 'err:' + e.message; }
        })()"""
        while True:
            try:
                tab = getattr(cls, "discord_tab", None)
                if tab is not None:
                    await tab.ensure_open()
                    res = await tab.evaluate(js, wait=True, user_gesture=True)
                    val = (((res or {}).get("result") or {}).get("result") or {}).get("value")
                    if val and "resumed=0" not in val:
                        logger.info(f"[audio] keepalive: {val}")
            except Exception as e:
                logger.debug(f"[audio] keepalive error: {e}")
            await sleep(4)

    @classmethod
    async def _remote_auth_watcher(cls):
        # Remote auth is now handled entirely in streamcord_client.js
        # This task is kept as a no-op for compatibility
        while True:
            await sleep(3600)

    @classmethod
    async def _openkb(cls, request):
        await cls.shared_js_tab.ensure_open()
        await setOSK(cls.shared_js_tab, True)
        logger.info("Setting discord visibility to true")
        return "OK"

    @classmethod
    async def _voice_render(cls, request):
        # Chromium freezes WebRTC in the occluded (hidden) BrowserView, so the voice
        # connection stalls forever at DTLS_CONNECTING. Rendering the view (even 1×1)
        # un-backgrounds the renderer so the handshake completes. The JS calls this
        # while the voice connection is establishing, then /voice_hide once connected.
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, 1, 1);
                    window.DISCORD_TAB.m_browserView.SetVisible(true);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_render failed: {e}")
        return "OK"

    @classmethod
    async def _voice_hide(cls, request):
        try:
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate("""
                try {
                    window.DISCORD_TAB.m_browserView.SetVisible(false);
                    window.DISCORD_TAB.m_browserView.SetBounds(0, 0, window.DISCORD_TAB.WIDTH, window.DISCORD_TAB.HEIGHT);
                } catch (e) {}
            """)
        except Exception as e:
            logger.warning(f"voice_hide failed: {e}")
        return "OK"

    @classmethod
    async def _websocket_handler(cls, request):
        logger.info("Received websocket connection!")
        ws = WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        await cls.evt_handler.main(ws)
        return ws

    @classmethod
    async def _notification_dispatcher(cls):
        async for notification in cls.evt_handler.yield_notification():
            logger.info("Dispatching notification")
            payload = dumps(
                {
                    "title": notification["title"],
                    "body": notification["body"],
                    "kind": notification.get("kind", ""),
                }
            )
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                f"window.STREAMCORD.dispatchNotification(JSON.parse('{payload}'));"
            )

    @classmethod
    async def connect_ws(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(f"window.STREAMCORD.connectWs()")

    @classmethod
    async def get_state(cls):
        return cls.evt_handler.build_state_dict()

    @classmethod
    async def show_discord_login(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate("""
            window.DISCORD_TAB.m_browserView.SetBounds(0, 0, 1280, 800);
            window.DISCORD_TAB.m_browserView.SetVisible(true);
        """)
        cls.evt_handler._login_tab_visible = True

    @classmethod
    async def hide_discord_login(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate("""
            window.DISCORD_TAB.m_browserView.SetVisible(false);
            window.DISCORD_TAB.m_browserView.SetBounds(0, 0, window.DISCORD_TAB.WIDTH, window.DISCORD_TAB.HEIGHT);
        """)
        cls.evt_handler._login_tab_visible = False

    @classmethod
    async def login_with_token(cls, token: str):
        from tab_utils.cdp import get_tab
        tab = await get_tab("discord")
        if tab is None:
            return False
        await tab.open_websocket()
        result = await tab.evaluate(f"window.streamcordLoginWithToken({repr(token)})")
        await tab.close_websocket()
        return result in ("ok", "reload")

    @classmethod
    async def toggle_mute(cls):
        logger.info("Toggling mute")
        return await cls.evt_handler.toggle_mute(act=True)

    @classmethod
    async def toggle_deafen(cls):
        logger.info("Toggling deafen")
        return await cls.evt_handler.toggle_deafen(act=True)

    @classmethod
    async def disconnect_vc(cls):
        logger.info("Disconnecting vc")
        return await cls.evt_handler.disconnect_vc()

    @classmethod
    async def set_ptt(cls, value):
        await cls.evt_handler.ws.send_json({"type": "$ptt", "value": value})

    @classmethod
    async def enable_ptt(cls, enabled):
        await cls.evt_handler.ws.send_json({"type": "$setptt", "enabled": enabled})

    @classmethod
    async def set_rpc(cls, game):
        logger.info("Setting RPC")
        await cls.evt_handler.ws.send_json({"type": "$rpc", "game": game})

    @classmethod
    async def set_user_volume(cls, user_id, volume):
        await cls.evt_handler.ws.send_json({"type": "$set_user_volume", "id": user_id, "volume": volume})

    @classmethod
    async def set_discord_status(cls, status):
        # status: "online" | "idle" | "dnd" | "invisible"
        await cls.evt_handler.ws.send_json({"type": "$set_status", "status": status})

    @classmethod
    async def get_discord_status(cls):
        return await cls.evt_handler.api._store_access_request("$get_status")

    @classmethod
    async def get_last_channels(cls):
        return await cls.evt_handler.api.get_last_channels()

    @classmethod
    async def post_screenshot(cls, channel_id, data):
        logger.info("Posting screenshot to " + channel_id)
        r = await cls.evt_handler.api.post_screenshot(channel_id, data)

        if r:
            return True

        payload = dumps({"title": "Streamcord", "body": "Error while posting screenshot"})
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(
            f"DeckyPluginLoader.toaster.toast(JSON.parse('{payload}'));"
        )

    @classmethod
    async def get_screen_bounds(cls):
        return await cls.evt_handler.api.get_screen_bounds()

    @classmethod
    async def get_guilds_vc(cls):
        return await cls.evt_handler.api.get_guilds_vc()

    @classmethod
    async def join_vc(cls, channel_id, guild_id):
        return await cls.evt_handler.api.join_vc(channel_id, guild_id)

    @classmethod
    async def get_dm_channels(cls):
        return await cls.evt_handler.api.get_dm_channels()

    @classmethod
    async def dm_call(cls, channel_id, join_existing=False):
        return await cls.evt_handler.api.dm_call(channel_id, join_existing)

    @classmethod
    async def get_text_channels(cls):
        return await cls.evt_handler.api.get_text_channels()

    @classmethod
    async def get_messages(cls, channel_id):
        return await cls.evt_handler.api.get_messages(channel_id)

    @classmethod
    async def send_message(cls, channel_id, content):
        return await cls.evt_handler.api.send_message(channel_id, content)

    @classmethod
    async def go_live(cls):
        await cls.evt_handler.ws.send_json({"type": "$golive", "stop": False})

    @classmethod
    async def stop_go_live(cls):
        await cls.evt_handler.ws.send_json({"type": "$golive", "stop": True})

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls.evt_handler.ws.send_json({"type": "$webrtc", "payload": answer})

    @classmethod
    async def _unload(cls):
        if hasattr(cls, "webrtc_server"):
            cls.webrtc_server.kill()
            await cls.webrtc_server.wait()

        if hasattr(cls, "runner"):
            await cls.runner.shutdown()
            await cls.runner.cleanup()

        if hasattr(cls, "shared_js_tab"):
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                """
                window.DISCORD_TAB.m_browserView.SetVisible(false);
                window.DISCORD_TAB.Destroy();
                window.DISCORD_TAB = undefined;
            """
            )
            await cls.shared_js_tab.close_websocket()
