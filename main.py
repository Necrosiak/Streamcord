from aiohttp.web import (  # type: ignore
    Application,
    get,
    WebSocketResponse,
    AppRunner,
    TCPSite,
    Response,
)
from asyncio import sleep, create_task, create_subprocess_exec
import aiohttp_cors  # type: ignore
from json import dumps
from pathlib import Path
from subprocess import PIPE, DEVNULL

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

# Decky enregistre son PROPRE module `updater` dans sys.modules, donc un simple
# `import updater` renvoie CELUI-LÀ (qui n'a pas is_autoupdate_enabled) au lieu du
# updater.py du plugin → l'auto-update a silencieusement cassé après une MAJ Decky
# ("module 'decky_loader.updater' has no attribute 'is_autoupdate_enabled'"). On
# charge notre fichier explicitement par chemin (nom unique) pour éviter la collision.
import importlib.util as _ilu
# Charger depuis defaults/ (toujours synchronisé par le deploy + présent dans le zip)
# plutôt que la copie racine ; nom de module unique pour éviter la collision Decky.
_upath = Path(DECKY_PLUGIN_DIR) / "defaults" / "updater.py"
if not _upath.exists():
    _upath = Path(DECKY_PLUGIN_DIR) / "updater.py"
_uspec = _ilu.spec_from_file_location("sc_updater", str(_upath))
updater = _ilu.module_from_spec(_uspec)
_uspec.loader.exec_module(updater)

logger.setLevel(INFO)


async def stream_watcher(stream, is_err=False, prefix="[gst]"):
    async for line in stream:
        line = line.decode("utf-8").rstrip()
        if not line.strip():
            continue
        # Surface GStreamer/WebRTC subprocess output in the journal (was logger.debug,
        # invisible at INFO level — made screenshare failures impossible to diagnose).
        if is_err:
            logger.warning(prefix + " " + line)
        else:
            logger.info(prefix + " " + line)


async def initialize():
    # NATIVE approach: drive Vesktop (a real Electron Discord, mic works) over CDP
    # instead of a hidden Steam CEF BrowserView (where the mic is impossible).
    import vesktop
    client_js = open(Path(DECKY_PLUGIN_DIR) / "steamcord_client.js", "r").read()
    # webrtc_client.js surcharge getDisplayMedia → capture d'écran GStreamer pour
    # le partage d'écran (Go Live). DOIT être injecté sous Vesktop aussi, sinon le
    # partage d'écran « ne donne rien » (getDisplayMedia natif inutilisable headless).
    try:
        webrtc_js = open(Path(DECKY_PLUGIN_DIR) / "webrtc_client.js", "r").read()
    except Exception:
        webrtc_js = ""
    tab = await vesktop.get_discord_tab(webrtc_js + "\n" + client_js)

    Plugin.discord_tab = tab

    create_task(watchdog(tab))
    create_task(_ensure_handshake(tab))
    return tab


# The injected client only emits LOADED / CONNECTION_OPEN once, on its first
# DOMContentLoaded. If the backend (re-)initializes AFTER that point — watchdog
# recovery (re-initialize()), a soft websocket reconnect, or simply Vesktop having
# survived a plugin_loader restart — the handshake is never re-delivered, so
# evt_handler.loaded stays False and the QAM is stuck on "Initializing…" forever
# even though Vesktop/CDP/the Discord tab all work. Actively re-request the
# handshake from the already-injected client until the backend sees itself loaded.
_REHANDSHAKE_JS = """
(() => {
  try {
    var w = window.STEAMCORD_WS;
    if (!w || w.readyState !== 1) return;
    if (!(window.Vencord && Vencord.Webpack && Vencord.Webpack.Common
          && Vencord.Webpack.Common.UserStore)) return;
    w.send(JSON.stringify({ type: "LOADED", result: true }));
    var u = Vencord.Webpack.Common.UserStore.getCurrentUser();
    if (u) w.send(JSON.stringify({ type: "CONNECTION_OPEN", user: u }));
  } catch (e) {}
})()
"""


async def _ensure_handshake(tab: Tab):
    # Poll for up to ~30s: as soon as the backend is loaded we're done; otherwise
    # nudge the client to re-emit the handshake. Idempotent (LOADED just re-sets the
    # flag, CONNECTION_OPEN refreshes the current user). Bounded so the QR/login flow
    # (never "loaded" until the user scans) doesn't loop forever.
    for _ in range(30):
        if Plugin.evt_handler.loaded:
            return
        try:
            await tab.evaluate(_REHANDSHAKE_JS)
        except Exception:
            pass
        await sleep(1)


async def watchdog(tab: Tab):
    import vesktop
    while True:
        # `tab.websocket.closed` stays False on a half-broken CDP transport (the
        # "Cannot write to closing transport" case seen when Vesktop dies but the
        # socket lingers in a closing state). So ALSO probe Vesktop's CDP endpoint:
        # if it stops answering, treat the tab as dead and fall through to recovery
        # (re-initialize() relaunches Vesktop and re-injects the client).
        while not tab.websocket.closed:
            await sleep(3)
            if not await vesktop.is_up():
                logger.info("Vesktop CDP stopped responding — treating Discord tab as dead.")
                break

        logger.info("Discord tab websocket is no longer open. Trying to reconnect...")

        try:
            # Only a soft reconnect makes sense if Vesktop is actually alive.
            if await vesktop.is_up():
                await tab.open_websocket()
                logger.info("Reconnected")
            else:
                break

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
    # Routage audio par-application (PipeWire) : None = auto (suit le système).
    _audio_out = None
    _audio_in = None
    _AUDIO_CFG = os.path.expanduser("~/.config/steamcord-audio.json")
    # ── Partage audio du jeu (voir section "Partage AUDIO du jeu") ──
    _ga_active = False
    _ga_modules = []          # ids des modules pactl chargés (ordre de chargement)
    _ga_loop_mod = {}         # branche ("voice"/"game") -> id du module loopback
    _ga_real_sink = None      # vraie sortie à restaurer au stop
    _ga_vol = {"voice": 100, "game": 60}

    @classmethod
    async def _main(cls):
        logger.info("Starting Steamcord backend")
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
        # Le plugin GStreamer `nice` (ICE, requis par webrtcbin) n'est PAS dans l'image
        # Bazzite de base → webrtcbin échouait à construire le pipeline VP8 ("missing
        # plug-in") et getDisplayMedia se bloquait. On embarque libgstnice.so et on
        # l'ajoute au GST_PLUGIN_PATH (pas d'install système / pas de reboot).
        gst_plugins_dir = str(Path(DECKY_PLUGIN_DIR) / "defaults" / "gst-plugins")
        gst_env = {
            **os.environ,
            "GST_VAAPI_ALL_DRIVERS": "1",
            "LIBVA_DRIVER_NAME": "radeonsi",
            "GST_PLUGIN_PATH": gst_plugins_dir + os.pathsep + os.environ.get("GST_PLUGIN_PATH", ""),
            "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"),
            "DBUS_SESSION_BUS_ADDRESS": os.environ.get(
                "DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus"
            ),
        }
        # Réutilisé par le feeder webcam virtuelle (gst_camera.py).
        cls._gst_env = gst_env
        # Auto-install des dépendances du partage d'écran (self-contained sur toute
        # BC-250 fraîche) AVANT de lancer gst_webrtc.py.
        await cls._ensure_screenshare_deps()
        # Tuer un gst_webrtc.py orphelin (restart de plugin_loader ne tue pas toujours
        # l'enfant → port 65124 "address already in use"). Puis laisser le port se libérer.
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_webrtc.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
            await sleep(1)
        except Exception:
            pass
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
        create_task(cls._autoupdate_check())
        cls._load_audio_cfg()
        create_task(cls._audio_routing_watcher())
        create_task(cls._screen_diag())
        create_task(cls._ga_boot_cleanup())

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
        # Remote auth is now handled entirely in steamcord_client.js
        # This task is kept as a no-op for compatibility
        while True:
            await sleep(3600)

    @classmethod
    async def _toast(cls, title, body):
        try:
            # API NATIVE Steam (DisplayClientNotification, type 1) au lieu du toaster
            # Decky : ce dernier crée des notifs sans `notification_type` qui ne font
            # pas de popup ET font planter le panneau de notifs Steam sur ce build.
            payload = dumps({"title": title, "body": body, "state": "active"}).replace("\\", "\\\\").replace("'", "\\'")
            await cls.shared_js_tab.ensure_open()
            await cls.shared_js_tab.evaluate(
                "(()=>{const o=JSON.parse('" + payload + "');"
                "const A=window.App;o.steamid=A&&A.GetCurrentUser&&A.GetCurrentUser()?A.GetCurrentUser().strSteamID:'';"
                "window.SteamClient&&window.SteamClient.ClientNotifications&&"
                "window.SteamClient.ClientNotifications.DisplayClientNotification(1,JSON.stringify(o),function(){});})()"
            )
        except Exception as e:
            logger.debug(f"toast failed: {e}")

    @classmethod
    async def _autoupdate_check(cls):
        # Non-blocking release check at boot. If enabled and a newer release
        # exists, download + unpack over the plugin dir and restart the loader.
        try:
            if not updater.is_autoupdate_enabled():
                return
            info = await updater.check()
            if not info.get("update_available"):
                return
            logger.info(
                f"[updater] {info['latest']} available (have {info['current']}); auto-applying"
            )
            await cls._toast("Steamcord", f"Mise à jour {info['latest']} — installation…")
            if await updater.apply(info["url"]):
                await cls._toast("Steamcord", "Mise à jour installée — rechargement…")
                await sleep(2)
                updater.restart_loader()
        except Exception as e:
            logger.warning(f"[updater] auto-check error: {e}")

    @classmethod
    async def check_update(cls):
        return await updater.check()

    @classmethod
    async def get_version(cls):
        return updater.get_current_version()

    @classmethod
    async def apply_update(cls, url):
        ok = await updater.apply(url)
        if ok:
            await cls._toast("Steamcord", "Mise à jour installée — rechargement…")
            await sleep(1)
            updater.restart_loader()
        return ok

    @classmethod
    async def get_autoupdate(cls):
        return updater.is_autoupdate_enabled()

    @classmethod
    async def set_autoupdate(cls, enabled):
        return updater.set_autoupdate_enabled(enabled)

    @classmethod
    async def _openkb(cls, request):
        await cls.shared_js_tab.ensure_open()
        await setOSK(cls.shared_js_tab, True)
        logger.info("Setting discord visibility to true")
        return Response(text="OK")

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
        return Response(text="OK")

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
        return Response(text="OK")

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
                f"window.STEAMCORD.dispatchNotification(JSON.parse('{payload}'));"
            )

    @classmethod
    async def connect_ws(cls):
        await cls.shared_js_tab.ensure_open()
        await cls.shared_js_tab.evaluate(f"window.STEAMCORD.connectWs()")

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
        result = await tab.evaluate(f"window.steamcordLoginWithToken({repr(token)})")
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
        await cls.evt_handler.send_client({"type": "$ptt", "value": value})

    @classmethod
    async def enable_ptt(cls, enabled):
        await cls.evt_handler.send_client({"type": "$setptt", "enabled": enabled})

    @classmethod
    async def set_rpc(cls, game):
        logger.info("Setting RPC")
        await cls.evt_handler.send_client({"type": "$rpc", "game": game})

    @classmethod
    async def set_user_volume(cls, user_id, volume, context="default"):
        await cls.evt_handler.send_client({"type": "$set_user_volume", "id": user_id, "volume": volume, "context": context})

    @classmethod
    async def set_discord_status(cls, status):
        # status: "online" | "idle" | "dnd" | "invisible"
        await cls.evt_handler.send_client({"type": "$set_status", "status": status})

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

        payload = dumps({"title": "Steamcord", "body": "Error while posting screenshot"})
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
    async def get_local_mute(cls, user_id):
        r = await cls.evt_handler.api.get_local_mute(user_id)
        # Le client (ancien, déjà en page) renvoie `false` coercé en `{}` via
        # `result || {}` → le frontend ferait `!!{}` = true = muet à tort. Seul un
        # vrai `True` = réellement muté localement. On normalise ici → fix immédiat
        # sans dépendre d'une ré-injection du client.
        return r is True

    @classmethod
    async def toggle_local_mute(cls, user_id):
        return await cls.evt_handler.api.toggle_local_mute(user_id)

    @classmethod
    async def set_local_mute(cls, user_id, muted):
        return await cls.evt_handler.api.set_local_mute(user_id, muted)

    @classmethod
    async def get_audio_processing(cls):
        return await cls.evt_handler.api.get_audio_processing()

    @classmethod
    async def set_noise_reduction(cls, mode):
        return await cls.evt_handler.api.set_noise_reduction(mode)

    @classmethod
    async def set_echo_cancellation(cls, enabled):
        return await cls.evt_handler.api.set_echo_cancellation(enabled)

    @classmethod
    async def set_automatic_gain_control(cls, enabled):
        return await cls.evt_handler.api.set_automatic_gain_control(enabled)

    @classmethod
    async def _screen_diag(cls):
        # Diagnostic capture d'écran : log périodiquement si on est en mode JEU
        # (gamescope) et quels nodes vidéo PipeWire existent. Tourne dans plugin_loader
        # (survit aux changements de mode) → capture l'état mode jeu même offline.
        from json import loads
        import vesktop
        while True:
            try:
                g = await create_subprocess_exec("pgrep", "-x", "gamescope", stdout=DEVNULL, stderr=DEVNULL)
                in_game = (await g.wait()) == 0
                vids = []
                try:
                    p = await create_subprocess_exec("pw-dump", stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
                    out, _ = await p.communicate()
                    for n in loads(out.decode() or "[]"):
                        if not str(n.get("type", "")).endswith("Node"):
                            continue
                        pr = (n.get("info", {}) or {}).get("props", {}) or {}
                        mc = str(pr.get("media.class", "")); nm = str(pr.get("node.name", ""))
                        if "Video" in mc or "gamescope" in (nm + mc).lower() or "screen" in nm.lower():
                            vids.append(f"{n.get('id')}:{nm}:{mc}")
                except Exception as e:
                    vids = [f"pw-dump err {e!r}"]
                logger.info(f"[screendiag] gamescope={in_game} video_nodes={vids}")
            except Exception as e:
                logger.warning(f"[screendiag] {e!r}")
            await sleep(15)

    @classmethod
    async def logout_discord(cls):
        # Déconnexion totale de Discord (invalide le token + retour login/QR).
        await cls.evt_handler.send_client({"type": "$logout"})

    # ── Sélection des périphériques audio (sortie/entrée) pour Discord ──────────
    # Discord/Vesktop ne voit que "Default" en headless → on pilote au niveau
    # SYSTÈME via PipeWire (pactl), en routant les flux de Vesktop par-application.
    # Ça permet p.ex. d'envoyer le son Discord UNIQUEMENT vers le casque.
    @classmethod
    async def _pactl(cls, *args, want_json=False):
        import vesktop
        pre = ("-f", "json") if want_json else ()
        p = await create_subprocess_exec("pactl", *pre, *args, stdout=PIPE, stderr=DEVNULL, env=vesktop._user_env())
        out, _ = await p.communicate()
        return out.decode()

    @staticmethod
    def _dev_label(d):
        desc = d.get("description")
        return desc if desc and desc != "(null)" else d.get("name", "")

    @classmethod
    async def get_audio_devices(cls):
        from json import loads
        try:
            sinks = loads(await cls._pactl("list", "sinks", want_json=True) or "[]")
            sources = loads(await cls._pactl("list", "sources", want_json=True) or "[]")
            def_sink = (await cls._pactl("get-default-sink")).strip()
            def_source = (await cls._pactl("get-default-source")).strip()
        except Exception as e:
            return {"error": str(e)}
        outputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)} for s in sinks]
        # Entrées : exclure les monitors (rebouclage de sortie, pas un vrai micro).
        inputs = [{"name": s.get("name", ""), "label": cls._dev_label(s)}
                  for s in sources if not s.get("name", "").endswith(".monitor")]
        return {
            "outputs": outputs, "inputs": inputs,
            "default_output": def_sink, "default_input": def_source,
            "selected_output": cls._audio_out or "auto",
            "selected_input": cls._audio_in or "auto",
        }

    @classmethod
    async def set_audio_output(cls, name):
        cls._audio_out = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        await cls._apply_audio_routing()
        return True

    @classmethod
    async def set_audio_input(cls, name):
        cls._audio_in = None if name in (None, "auto") else name
        cls._save_audio_cfg()
        await cls._apply_audio_routing()
        return True

    @staticmethod
    def _is_vesktop_stream(s):
        props = s.get("properties", {}) or {}
        blob = " ".join(str(v) for v in props.values()).lower()
        return ("vesktop" in blob) or ("discord" in blob) or ("electron" in blob)

    @classmethod
    async def _apply_audio_routing(cls):
        from json import loads
        out_target = cls._audio_out
        in_target = cls._audio_in
        if cls._ga_active:
            # Partage audio jeu : Vesktop ÉCOUTE sur la vraie sortie (surtout pas le
            # sink jeu, sinon la voix des autres repartirait dans le mix = écho) et
            # CAPTURE le mix micro+jeu à la place du micro.
            out_target = out_target or cls._ga_real_sink
            in_target = "steamcord_mix.monitor"
        try:
            if out_target or cls._ga_active:
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(si):
                        if out_target:
                            await cls._pactl("move-sink-input", str(si.get("index")), out_target)
                    elif cls._ga_active and str(si.get("owner_module", "")) not in cls._ga_modules:
                        # Tout le reste (jeu, système) joue dans le sink jeu — les
                        # nouveaux flux y vont déjà (default sink), ceci rattrape les
                        # apps qui ciblent un sink explicite. Move idempotent.
                        await cls._pactl("move-sink-input", str(si.get("index")), "steamcord_game")
            if in_target:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), in_target)
        except Exception as e:
            logger.warning(f"audio routing failed: {e!r}")

    @classmethod
    async def _audio_routing_watcher(cls):
        # Les flux Vesktop apparaissent/disparaissent (à chaque appel) → on ré-applique
        # le routage périodiquement pour qu'un nouveau flux suive le choix de l'user.
        while True:
            try:
                if cls._audio_out or cls._audio_in or cls._ga_active:
                    await cls._apply_audio_routing()
            except Exception:
                pass
            await sleep(4)

    @classmethod
    def _load_audio_cfg(cls):
        from json import load
        try:
            with open(cls._AUDIO_CFG) as f:
                cfg = load(f)
            cls._audio_out = cfg.get("output") or None
            cls._audio_in = cfg.get("input") or None
            if isinstance(cfg.get("ga_vol"), dict):
                cls._ga_vol.update({k: int(v) for k, v in cfg["ga_vol"].items()
                                    if k in cls._ga_vol})
        except Exception:
            pass

    @classmethod
    def _save_audio_cfg(cls):
        from json import dump
        try:
            os.makedirs(os.path.dirname(cls._AUDIO_CFG), exist_ok=True)
            with open(cls._AUDIO_CFG, "w") as f:
                dump({"output": cls._audio_out, "input": cls._audio_in,
                      "ga_vol": cls._ga_vol}, f)
        except Exception as e:
            logger.warning(f"save audio cfg failed: {e!r}")

    @classmethod
    async def _ensure_screenshare_deps(cls):
        # gst_webrtc.py tourne sous le SYSTEM /usr/bin/python (requis pour les bindings
        # GStreamer `gi`, absents du python embarqué du plugin). Sur une machine fraîche
        # cet interpréteur n'a pas aiohttp → partage d'écran muet. On l'installe
        # automatiquement en user-site (sans root) → plugin self-contained sur toute BC-250.
        import vesktop
        env = vesktop._user_env()
        try:
            check = await create_subprocess_exec(
                "/usr/bin/python", "-c", "import aiohttp, aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            if (await check.wait()) == 0:
                return
            logger.info("Screen-share deps missing — installing aiohttp (user-site) for system python…")
            proc = await create_subprocess_exec(
                "/usr/bin/python", "-m", "pip", "install", "--user", "--quiet",
                "aiohttp", "aiohttp_cors",
                stdout=DEVNULL, stderr=DEVNULL, env=env,
            )
            await proc.wait()
        except Exception as e:
            logger.warning(f"Screen-share deps auto-install failed: {e!r}")

    @classmethod
    async def go_live(cls):
        await cls.evt_handler.send_client({"type": "$golive", "stop": False})

    @classmethod
    async def stop_go_live(cls):
        await cls.evt_handler.send_client({"type": "$golive", "stop": True})

    # ── Partage d'écran via CAMÉRA virtuelle (contournement gamescope) ──────────
    # gamescope n'a pas de portail → Go Live (getDisplayMedia) = écran noir. À la
    # place : gst_camera.py capture le node PipeWire gamescope → /dev/video42
    # (v4l2loopback), que Discord utilise comme caméra. Voir gst_camera.py + client.
    @classmethod
    async def start_screen_camera(cls):
        import os
        from pathlib import Path as _P
        if not os.path.exists("/dev/video42"):
            logger.warning("[gstcam] /dev/video42 absent — v4l2loopback non chargé "
                           "(reboot requis après setup, ou module non installé).")
            return False
        # Tuer un feeder précédent puis (re)lancer.
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_camera.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
            await sleep(0.5)
        except Exception:
            pass
        script = _P(DECKY_PLUGIN_DIR) / "gst_camera.py"
        if not script.exists():
            script = _P(DECKY_PLUGIN_DIR) / "defaults" / "gst_camera.py"
        cls.camera_feeder = await create_subprocess_exec(
            "/usr/bin/python",
            str(script),
            env=getattr(cls, "_gst_env", None) or dict(os.environ),
            stdout=PIPE, stderr=PIPE,
        )
        create_task(stream_watcher(cls.camera_feeder.stdout, prefix="[gstcam]"))
        create_task(stream_watcher(cls.camera_feeder.stderr, True, prefix="[gstcam]"))
        # Laisser le pipeline s'établir avant de sélectionner la caméra côté Discord.
        await sleep(2)
        await cls.evt_handler.send_client({"type": "$screen_camera", "stop": False})
        return True

    @classmethod
    async def stop_screen_camera(cls):
        import os
        try:
            await cls.evt_handler.send_client({"type": "$screen_camera", "stop": True})
        except Exception:
            pass
        try:
            import vesktop
            killer = await create_subprocess_exec("pkill", "-f", "gst_camera.py",
                                                  stdout=DEVNULL, stderr=DEVNULL, env=vesktop._user_env())
            await killer.wait()
        except Exception:
            pass
        if hasattr(cls, "camera_feeder") and cls.camera_feeder:
            try:
                cls.camera_feeder.kill()
                await cls.camera_feeder.wait()
            except Exception:
                pass
            cls.camera_feeder = None
        return True

    @classmethod
    async def get_camera_preview(cls):
        """Aperçu du partage écran pour le QAM : état du feeder + dernier JPEG.

        Le CEF de Steam n'a pas accès caméra en gamescope (getUserMedia échoue
        sur /dev/video42) → l'aperçu passe par les instantanés que gst_camera.py
        écrit toutes les 2s dans /tmp/steamcord-preview.jpg."""
        import base64
        import os
        import time as _t
        feeder = getattr(cls, "camera_feeder", None)
        running = feeder is not None and feeder.returncode is None
        jpg = ""
        path = "/tmp/steamcord-preview.jpg"
        try:
            if running and os.path.exists(path) and _t.time() - os.path.getmtime(path) < 6:
                with open(path, "rb") as f:
                    jpg = base64.b64encode(f.read()).decode()
        except Exception:
            jpg = ""
        return {"running": running, "jpg": jpg}

    # ── Partage AUDIO du jeu (son du jeu → micro Discord, jauges voix/jeu) ───────
    # Deux sinks virtuels : `steamcord_game` devient la sortie PAR DÉFAUT (les jeux
    # y jouent) et reboucle vers la vraie sortie (le user continue d'entendre) ;
    # `steamcord_mix` reçoit micro + jeu via deux loopbacks dont le volume = les
    # jauges du QAM, et son monitor devient l'entrée de Vesktop (via
    # _apply_audio_routing). Vesktop reste routé sur la vraie sortie → la voix des
    # participants n'entre pas dans le mix (pas d'écho chez eux).
    @classmethod
    async def _pactl_load(cls, *args):
        out = (await cls._pactl("load-module", *args)).strip()
        if not out.isdigit():
            raise Exception(f"load-module {args[0]} a échoué ({out!r})")
        cls._ga_modules.append(out)
        return out

    @classmethod
    async def _ga_boot_cleanup(cls):
        # Après un restart de plugin_loader, d'éventuels modules steamcord_* survivent
        # dans pipewire-pulse alors que notre état est perdu → on repart propre (et on
        # restaure la sortie par défaut si elle pointait encore sur le sink jeu).
        try:
            if "steamcord_" in (await cls._pactl("get-default-sink")).strip():
                await cls.stop_game_audio()
            else:
                await cls._ga_cleanup_modules()
        except Exception as e:
            logger.warning(f"[gameaudio] boot cleanup: {e!r}")

    @classmethod
    async def _ga_cleanup_modules(cls):
        # Purge idempotente des modules steamcord_* résiduels (crash / restart
        # plugin_loader : pipewire-pulse, lui, garde les modules chargés).
        from json import loads
        try:
            for m in loads(await cls._pactl("list", "modules", want_json=True) or "[]"):
                if "steamcord_" in str(m.get("argument", "")):
                    await cls._pactl("unload-module", str(m.get("index")))
        except Exception as e:
            logger.warning(f"[gameaudio] purge modules: {e!r}")

    @classmethod
    async def start_game_audio(cls):
        from json import loads
        if cls._ga_active:
            return True
        try:
            await cls._ga_cleanup_modules()
            cls._ga_modules = []
            cls._ga_loop_mod = {}
            real = cls._audio_out or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                raise Exception(f"sortie réelle introuvable ({real!r})")
            cls._ga_real_sink = real
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_game",
                                  "sink_properties=device.description=SteamcordGame")
            await cls._pactl_load("module-null-sink", "sink_name=steamcord_mix",
                                  "sink_properties=device.description=SteamcordMix")
            # Le user continue d'entendre le jeu sur la vraie sortie.
            await cls._pactl_load("module-loopback", "source=steamcord_game.monitor",
                                  f"sink={real}", "latency_msec=30")
            # Branche JEU du mix (jauge 🎮).
            cls._ga_loop_mod["game"] = await cls._pactl_load(
                "module-loopback", "source=steamcord_game.monitor",
                "sink=steamcord_mix", "latency_msec=30")
            # Branche VOIX du mix (jauge 🎙️) — seulement si un vrai micro existe
            # (sur cette machine la source par défaut peut être un monitor HDMI).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and not mic.endswith(".monitor") and "steamcord_" not in mic:
                cls._ga_loop_mod["voice"] = await cls._pactl_load(
                    "module-loopback", f"source={mic}",
                    "sink=steamcord_mix", "latency_msec=30")
            else:
                logger.warning(f"[gameaudio] aucun micro réel ({mic!r}) — branche voix absente")
            await cls._pactl("set-default-sink", "steamcord_game")
            cls._ga_active = True
            await cls._apply_audio_routing()  # déplace jeu→steamcord_game, Vesktop→réel/mix
            await cls._ga_apply_volumes()
            logger.info(f"[gameaudio] ACTIF (sortie réelle={real}, micro={mic!r}, "
                        f"branches={list(cls._ga_loop_mod)})")
            return True
        except Exception as e:
            logger.warning(f"[gameaudio] démarrage KO: {e!r}")
            await cls.stop_game_audio()
            return False

    @classmethod
    async def stop_game_audio(cls):
        from json import loads
        cls._ga_active = False
        try:
            real = cls._ga_real_sink or (await cls._pactl("get-default-sink")).strip()
            if not real or "steamcord_" in real:
                # État perdu (restart) et défaut encore sur le sink virtuel → premier
                # sink matériel disponible.
                for line in (await cls._pactl("list", "sinks", "short")).splitlines():
                    name = (line.split("\t") + [""])[1]
                    if name and "steamcord_" not in name:
                        real = name
                        break
            if real and "steamcord_" not in real:
                await cls._pactl("set-default-sink", real)
                for si in loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]"):
                    if str(si.get("owner_module", "")) not in cls._ga_modules:
                        await cls._pactl("move-sink-input", str(si.get("index")), real)
            # Rendre à Vesktop son entrée d'origine (choix user ou défaut système).
            mic = cls._audio_in or (await cls._pactl("get-default-source")).strip()
            if mic and "steamcord_" not in mic:
                for so in loads(await cls._pactl("list", "source-outputs", want_json=True) or "[]"):
                    if cls._is_vesktop_stream(so):
                        await cls._pactl("move-source-output", str(so.get("index")), mic)
        except Exception as e:
            logger.warning(f"[gameaudio] restauration: {e!r}")
        for mid in reversed(cls._ga_modules):
            try:
                await cls._pactl("unload-module", mid)
            except Exception:
                pass
        cls._ga_modules = []
        cls._ga_loop_mod = {}
        cls._ga_real_sink = None
        await cls._ga_cleanup_modules()
        logger.info("[gameaudio] arrêté, routage restauré")
        return True

    @classmethod
    async def _ga_apply_volumes(cls):
        # Les jauges = volume du sink-input que chaque loopback pousse dans le mix
        # (retrouvé par owner_module, seul lien stable module→flux).
        from json import loads
        try:
            sis = loads(await cls._pactl("list", "sink-inputs", want_json=True) or "[]")
            for kind, mid in cls._ga_loop_mod.items():
                pct = max(0, min(150, int(cls._ga_vol.get(kind, 100))))
                for si in sis:
                    if str(si.get("owner_module")) == str(mid):
                        await cls._pactl("set-sink-input-volume", str(si.get("index")), f"{pct}%")
        except Exception as e:
            logger.warning(f"[gameaudio] volumes: {e!r}")

    @classmethod
    async def set_game_audio_volume(cls, kind, pct):
        if kind in cls._ga_vol:
            cls._ga_vol[kind] = int(pct)
            cls._save_audio_cfg()
        if cls._ga_active:
            await cls._ga_apply_volumes()
        return True

    @classmethod
    async def get_game_audio(cls):
        return {"active": cls._ga_active,
                "has_mic": ("voice" in cls._ga_loop_mod) if cls._ga_active else True,
                "voice": cls._ga_vol["voice"], "game": cls._ga_vol["game"]}

    @classmethod
    async def mic_webrtc_answer(cls, answer):
        await cls.evt_handler.send_client({"type": "$webrtc", "payload": answer})

    # ── Relais vidéo inverse (voir le Go Live/cam des autres dans le QAM) ──
    @classmethod
    async def watch_video(cls, user_id):
        # Ask the Discord tab to watch this user's stream, capture its video track
        # and offer it back to us. Correlated by user_id.
        await cls.evt_handler.send_client({"type": "$WATCH_VIDEO", "userId": user_id})

    @classmethod
    async def unwatch_video(cls, user_id):
        await cls.evt_handler.send_client({"type": "$UNWATCH_VIDEO", "userId": user_id})

    @classmethod
    async def video_webrtc_answer(cls, user_id, answer):
        await cls.evt_handler.send_client({"type": "$VIDEO_ANSWER", "userId": user_id, "payload": answer})

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
