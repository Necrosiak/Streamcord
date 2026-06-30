#!/usr/bin/env python
# Feeder « webcam virtuelle » : capture l'écran gamescope (node PipeWire direct —
# le SEUL chemin qui marche en mode jeu, gamescope n'ayant pas de portail) et le
# pousse dans /dev/video42 (v4l2loopback "Steamcord Screen"). Discord l'utilise
# ensuite comme CAMÉRA (getUserMedia), ce qui contourne entièrement le partage
# d'écran Go Live (portail → écran noir en gamescope).
#
# Tourne comme sous-process (stdout/stderr capturés par stream_watcher → préfixe
# [gstcam] au journal Steamcord). Boucle de reconnexion : le node gamescope
# n'existe que pendant le jeu et change d'id → on le re-cherche tant qu'absent.

import os
import sys
import time
import json
import logging
from subprocess import getoutput
from gi import require_version  # type: ignore

logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(levelname)s %(name)s: %(message)s", force=True)
log = logging.getLogger("screencam")

require_version("Gst", "1.0")
from gi.repository import Gst, GLib  # type: ignore

DEVICE = "/dev/video42"
# Discord/Chromium aime un format simple et borné. YUY2 720p30 = sûr.
WIDTH, HEIGHT, FPS = 1280, 720, 30


def find_screen_node():
    """Node PipeWire de l'écran gamescope (publie l'écran complet en mode jeu).
    Renvoie l'id (str) ou None."""
    try:
        data = json.loads(getoutput("pw-dump"))
    except Exception as e:
        log.warning(f"pw-dump KO: {e!r}")
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
    if vids:
        log.info(f"nodes vidéo candidats: {vids}")
    for nid, name, mc in vids:
        if "gamescope" in name.lower() or "screen" in name.lower():
            return str(nid)
    for nid, name, mc in vids:
        if "video/source" in mc.lower():
            return str(nid)
    return None


def find_x_display():
    """Display X imbriqué de gamescope où le JEU est rendu. gamescope crée un X
    nested (typiquement :1) pour le contenu jeu, :0 = UI Steam. On préfère :1.
    Inspiré de decky-streamer (ximagesrc DISPLAY=:1, capture fiable sans portail
    ni node PipeWire). Renvoie ":1"/":0" ou None."""
    try:
        socks = getoutput("ls /tmp/.X11-unix/ 2>/dev/null")
    except Exception as e:
        log.warning(f"ls .X11-unix KO: {e!r}")
        socks = ""
    order = []
    if "X1" in socks:
        order.append(":1")
    if "X0" in socks:
        order.append(":0")
    if not order:
        order = [":0"]
    log.info(f"displays X candidats: {socks!r} → essai {order}")
    return order[0]


def build_pipeline(backend, node=None, display=None):
    """backend = 'pipewire' (node gamescope) | 'ximagesrc' (X nested :1)."""
    if backend == "ximagesrc":
        src = (f"ximagesrc display-name={display} use-damage=0 "
               f"show-pointer=false do-timestamp=true")
    else:
        src = (f"pipewiresrc path={node}" if node else "pipewiresrc") + " do-timestamp=true"
    desc = (
        f"{src} ! videoconvert ! videoscale ! videorate ! "
        f"video/x-raw,format=YUY2,width={WIDTH},height={HEIGHT},framerate={FPS}/1 ! "
        f"identity name=cnt silent=false ! "
        f"v4l2sink name=vsink device={DEVICE} sync=false"
    )
    log.info(f"Pipeline ({backend}): " + desc)
    return Gst.parse_launch(desc)


def run_backend(backend, node, display):
    """Lance un pipeline pour un backend donné. Renvoie True si arrêt normal
    (EOS/stop), False si erreur GStreamer (→ l'appelant bascule de backend)."""
    loop = GLib.MainLoop()
    ok = {"value": True}
    pipe = build_pipeline(backend, node=node, display=display)
    bus = pipe.get_bus()
    bus.add_signal_watch()

    # --- Lecteur factice « keepalive » -----------------------------------
    # v4l2loopback (exclusive_caps=1) ne recycle les buffers du writer que s'il
    # y a un CONSOMMATEUR qui lit. Sans lecteur, v4l2sink (MMAP) sature après
    # 2 frames → "buffer not queued, driver bug" → le writer MEURT → le device
    # retombe en mode OUTPUT-only → Chromium ne l'énumère pas (videoinputs=[]) →
    # Discord ne l'ouvre jamais → écran noir. On maintient donc un petit
    # v4l2src!fakesink interne qui draine le device : le writer survit ET le
    # device reste annoncé en CAPTURE en permanence → Chromium l'énumère à chaud
    # → Discord peut l'ouvrir (en lecteur supplémentaire ; max_openers=10).
    reader = {"pipe": None}

    def start_reader():
        if reader["pipe"] is not None:
            return False  # one-shot (GLib retire le timeout)
        try:
            rp = Gst.parse_launch(f"v4l2src device={DEVICE} ! fakesink sync=false")
            rb = rp.get_bus()
            rb.add_signal_watch()

            def on_reader_err(_b, m):
                e, d = m.parse_error()
                # Typiquement si le writer n'a pas encore établi le mode output :
                # on relâche et on retente.
                log.warning(f"lecteur keepalive err: {e} | {d} — retry 1s")
                try:
                    rp.set_state(Gst.State.NULL)
                except Exception:
                    pass
                reader["pipe"] = None
                GLib.timeout_add(1000, start_reader)

            rb.connect("message::error", on_reader_err)
            rp.set_state(Gst.State.PLAYING)
            reader["pipe"] = rp
            log.info("lecteur keepalive (v4l2src→fakesink) démarré → device en CAPTURE")
        except Exception as e:
            log.warning(f"lecteur keepalive KO: {e!r} — retry 1s")
            GLib.timeout_add(1000, start_reader)
        return False

    def on_error(_bus, msg):
        err, dbg = msg.parse_error()
        log.error(f"gst error ({backend}): {err} | {dbg}")
        ok["value"] = False
        loop.quit()

    bus.connect("message::error", on_error)
    bus.connect("message::eos", lambda *_: (log.info("EOS"), loop.quit()))

    # --- Compteur de frames vers /dev/video42 -----------------------------
    # On est aveugles : set_state(PLAYING) ne prouve PAS que gamescope livre des
    # buffers. Un probe sur le sink pad de v4l2sink compte les frames réellement
    # poussées + loggue les caps négociées (résolution/format réels de la source)
    # une seule fois. Verdict net au prochain test : >0 frames/s = ça coule
    # (problème côté Discord) ; 0 frame = gamescope ne capture rien (source à
    # changer). Log ~1×/s pour ne pas spammer.
    stats = {"n": 0, "logged_caps": False, "last_log": 0.0}

    def on_buffer(pad, info):
        stats["n"] += 1
        now = time.monotonic()
        if not stats["logged_caps"]:
            caps = pad.get_current_caps()
            log.info(f"PREMIÈRE FRAME poussée vers {DEVICE} — caps négociées: "
                     f"{caps.to_string() if caps else '?'}")
            stats["logged_caps"] = True
            stats["last_log"] = now
        elif now - stats["last_log"] >= 1.0:
            log.info(f"frames poussées vers {DEVICE}: total={stats['n']} "
                     f"(~{stats['n'] / max(now - (stats['last_log'] - 1.0), 0.001):.0f}/s cumul)")
            stats["last_log"] = now
        return Gst.PadProbeReturn.OK

    vsink = pipe.get_by_name("vsink")
    if vsink is not None:
        sp = vsink.get_static_pad("sink")
        if sp is not None:
            sp.add_probe(Gst.PadProbeType.BUFFER, on_buffer)
    # Filet : si AUCUNE frame n'est arrivée après 5s, on le crie fort.
    def warn_if_no_frames():
        if stats["n"] == 0:
            log.warning(f"AUCUNE frame poussée vers {DEVICE} après 5s "
                        f"(backend={backend}, node={node}) — gamescope ne livre "
                        f"rien sur cette source → écran noir garanti.")
        return False
    GLib.timeout_add(5000, warn_if_no_frames)

    ret = pipe.set_state(Gst.State.PLAYING)
    log.info(f"set_state(PLAYING) → {ret} (backend={backend}, device={DEVICE}, node={node}, display={display})")
    # Démarrer le lecteur ~1s après, le temps que le writer établisse le mode
    # output sur le loopback (sinon v4l2src ne peut pas préroller).
    GLib.timeout_add(1000, start_reader)
    try:
        loop.run()
    finally:
        if reader["pipe"] is not None:
            try:
                reader["pipe"].set_state(Gst.State.NULL)
            except Exception:
                pass
            reader["pipe"] = None
        pipe.set_state(Gst.State.NULL)
    return ok["value"]


def main():
    Gst.init(None)

    # On tente d'abord le node PipeWire gamescope (capture "officielle"), mais
    # sans s'éterniser : il est capricieux/absent. Attente courte (~30s).
    node = None
    for _ in range(15):
        node = find_screen_node()
        if node:
            break
        log.info("aucun node écran PipeWire pour l'instant, attente…")
        time.sleep(2)
    display = find_x_display()

    # Stratégies de capture, par ordre de préférence, avec bascule auto en cas
    # d'erreur GStreamer (boucle infinie jusqu'à arrêt explicite) :
    #   1. pipewiresrc path=<node gamescope>   (si node trouvé)
    #   2. pipewiresrc            (plain, PipeWire choisit la source par défaut —
    #      c'est le chemin par défaut de decky-streamer, souvent le plus fiable)
    #   3. ximagesrc display=:1   (X nested du jeu — dernier recours)
    strategies = []
    if node:
        strategies.append(("pipewire", node, None))
    strategies.append(("pipewire", None, None))
    strategies.append(("ximagesrc", None, display))

    i = 0
    while True:
        backend, n, disp = strategies[i % len(strategies)]
        normal = run_backend(backend, n, disp)
        if normal:
            break  # arrêt demandé (process tué par stop_screen_camera)
        # erreur → stratégie suivante, petite pause anti-boucle-folle.
        # Si le node a disparu (jeu quitté), on re-cherche pour le prochain tour.
        if n and not find_screen_node():
            try:
                strategies = [s for s in strategies if not (s[0] == "pipewire" and s[1])]
            except Exception:
                pass
        i += 1
        time.sleep(2)


if __name__ == "__main__":
    main()
