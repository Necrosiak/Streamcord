// Detect host: Vesktop (native Electron Discord — mic works) vs Steam's hidden CEF
// BrowserView (mic broken). In Vesktop we must NOT hijack getUserMedia / visibility,
// or we'd break the native mic. The CEF-only workarounds are guarded by !IS_VESKTOP.
// The backend sets window.STEAMCORD_IS_VESKTOP = true before this script when it
// injects into Vesktop (most reliable). Fall back to runtime detection otherwise.
window.STEAMCORD_IS_VESKTOP = window.STEAMCORD_IS_VESKTOP
    || !!window.VesktopNative
    || (navigator.userAgent || "").toLowerCase().includes("vesktop");

// CEF only: override Page Visibility API so Discord audio/WebRTC stays active in a
// hidden BrowserView (Chrome throttles background tabs). Not needed in Vesktop.
if (!window.STEAMCORD_IS_VESKTOP) try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    const _origAEL = document.addEventListener.bind(document);
    document.addEventListener = (type, handler, opts) => {
        if (type === 'visibilitychange') return;
        return _origAEL(type, handler, opts);
    };
} catch(_) {}

window.Vencord.Plugins.plugins.Steamcord = {
    name: "Steamcord",
    description: "Plugin required for Steamcord to work",
    authors: [],
    required: true,
    startAt: "DOMContentLoaded",
    async start() {
        // Garde anti-double-wrap : Vesktop survit aux restarts plugin_loader, donc
        // initialize() ré-injecte ce client plusieurs fois. Sans cette garde, la 2e
        // injection prend le wrapper de la 1re comme "old_" → le wrapper finit par
        // s'appeler lui-même → récursion infinie (Maximum call stack size exceeded,
        // crashait enableScreenCamera dès enumerateDevices). On ne wrappe qu'UNE fois
        // et on .bind() pour garder le bon `this` (sinon "Illegal invocation").
        if (!window.old_enumerate_devices) {
            window.old_enumerate_devices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
            navigator.mediaDevices.enumerateDevices = async () => {
                const devices = await window.old_enumerate_devices();
                return devices.filter(f => f.label != "Filter Chain Source" && f.label != "Virtual Source" && !(f.label == "" && f.deviceId == "default"))
            }
        }

        // Camera support (later): when a real webcam is plugged in, set
        // window.STEAMCORD_CAMERA_ENABLED = true and Discord's camera requests
        // (getUserMedia with video) will use the real device instead of the mic relay.
        // Screenshare uses getDisplayMedia (see webrtc_client.js), not this path.
        // Idem enumerateDevices : ne capturer le getUserMedia NATIF qu'une seule fois.
        // Sinon une ré-injection capture notre propre wrapper (steamcordGUM) comme
        // "old_" → récursion infinie quand le wrapper rappelle old_get_user_media.
        if (!window.old_get_user_media) {
            window.old_get_user_media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        }
        window.STEAMCORD_CAMERA_ENABLED = window.STEAMCORD_CAMERA_ENABLED ?? false;
        const steamcordGUM = (constraints) => new Promise(async (resolve, reject) => {
            console.log("[Steamcord] getUserMedia CALLED constraints=" + JSON.stringify(constraints) +
                " by: " + (new Error().stack || "").split("\n").slice(1, 4).join(" || "));
            if (window.STEAMCORD_CAMERA_ENABLED && constraints && constraints.video) {
                console.log("[Steamcord] Camera requested — using real device");
                return resolve(await window.old_get_user_media.call(navigator.mediaDevices, constraints));
            }
            if (window.MIC_STREAM != undefined && window.MIC_PEER_CONNECTION != undefined && window.MIC_PEER_CONNECTION.connectionState == "connected") {
                console.log("WebRTC stream available. Returning that.");
                return resolve(window.MIC_STREAM);
            }

            console.log("Starting WebRTC handshake for mic stream");
            const peerConnection = new RTCPeerConnection(null);
            window.MIC_PEER_CONNECTION = peerConnection;

            window.STEAMCORD_WS.addEventListener("message", async (e) => {
                const data = JSON.parse(e.data);
                if (data.type != "$webrtc") return;

                const remoteDescription = new RTCSessionDescription(data.payload);
                await peerConnection.setRemoteDescription(remoteDescription);
                console.log("[Steamcord] mic: answer set, connection negotiating");
            });

            peerConnection.ontrack = (ev) => {
                ev.track.stop = () => { console.log("CALLED STOP ON TRACK") }
                window.MIC_STREAM = new MediaStream([ev.track]);
                console.log("[Steamcord] mic: WEBRTC STREAM (ontrack)", window.MIC_STREAM);
                resolve(window.MIC_STREAM);
            }

            const offer = await peerConnection.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: true });
            await peerConnection.setLocalDescription(offer);
            // Non-trickle ICE: wait until candidates are gathered so they're embedded
            // in the SDP (localhost host candidates gather instantly). This avoids
            // routing ICE messages between the hidden tab and SharedJSContext.
            await new Promise((res) => {
                if (peerConnection.iceGatheringState === "complete") return res();
                const cb = () => {
                    if (peerConnection.iceGatheringState === "complete") {
                        peerConnection.removeEventListener("icegatheringstatechange", cb);
                        res();
                    }
                };
                peerConnection.addEventListener("icegatheringstatechange", cb);
                setTimeout(res, 2000);
            });
            console.log("[Steamcord] mic: sending offer to backend");
            window.STEAMCORD_WS.send(JSON.stringify({ type: "$MIC_WEBRTC", offer: peerConnection.localDescription }));
        });

        // ── Partage d'écran via CAMÉRA virtuelle (contournement gamescope) ──────────
        // En mode jeu, gamescope n'a PAS de portail → getDisplayMedia (Go Live) = noir.
        // À la place : gst_camera.py capture le node PipeWire gamescope → /dev/video42
        // (v4l2loopback "Steamcord Screen"). Ici on sélectionne cette caméra et on
        // active la vidéo dans le salon vocal. getUserMedia(video) renverra le vrai
        // device (STEAMCORD_CAMERA_ENABLED=true → branche "real device" plus haut).
        window.STEAMCORD_enableScreenCamera = async (on) => {
            const log = (m) => { try { window.STEAMCORD_WS.send(JSON.stringify({ type: "$diag", m: "[cam] " + m })); } catch (_) {} };
            try {
                const WP = Vencord.Webpack;
                if (!on) {
                    window.STEAMCORD_CAMERA_ENABLED = false;
                    try {
                        // Même lookup que le chemin d'activation (findByProps). Ne PAS
                        // utiliser findByCode("setVideoEnabled") : ça peut renvoyer un
                        // hook React → appelé hors render = "Minified React error #321".
                        const va = WP.findByProps?.("setVideoEnabled");
                        if (va?.setVideoEnabled) { va.setVideoEnabled(false); log("caméra coupée"); }
                        else log("setVideoEnabled introuvable (off)");
                    } catch (e) { log("off err " + e); }
                    return;
                }
                window.STEAMCORD_CAMERA_ENABLED = true;
                // 1) Trouver notre device par label. Le feeder gstcam met ~1-3s à
                // établir le pipeline + le lecteur keepalive qui fait passer le
                // device en CAPTURE (donc énumérable par Chromium). On RÉESSAIE
                // l'énumération jusqu'à ~12s avant d'abandonner, sinon on perd la
                // course (videoinputs=[] alors que le device arrive juste après).
                let cam = null;
                for (let attempt = 0; attempt < 12; attempt++) {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    const vins = devs.filter(d => d.kind === "videoinput");
                    cam = vins.find(d => /steamcord screen/i.test(d.label));
                    if (cam) {
                        log("videoinputs=" + JSON.stringify(vins.map(d => d.label || "(label vide)")) + " (essai " + attempt + ")");
                        break;
                    }
                    if (attempt === 0 || attempt === 11) {
                        log("videoinputs=" + JSON.stringify(vins.map(d => d.label || "(label vide)")) + " — pas encore 'Steamcord Screen' (essai " + attempt + ")");
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!cam) { log("AUCUN 'Steamcord Screen' après 12s — le feeder gstcam n'a pas fait passer /dev/video42 en CAPTURE (lecteur keepalive ?)"); return; }
                log("device choisi: " + JSON.stringify(cam.label) + " id=" + cam.deviceId.slice(0, 12));
                // 2) Sélectionner le device vidéo dans Discord.
                try {
                    const va = WP.findByProps?.("setVideoDevice");
                    if (va?.setVideoDevice) { va.setVideoDevice(cam.deviceId); log("setVideoDevice OK"); }
                    else log("setVideoDevice introuvable");
                } catch (e) { log("setVideoDevice err " + e); }
                // 3) Activer la caméra dans le salon vocal courant.
                try {
                    const selCh = WP.findStore?.("SelectedChannelStore");
                    const vcId = selCh?.getVoiceChannelId?.();
                    if (!vcId) { log("pas dans un vocal — la cam s'activera au prochain appel"); }
                    const va = WP.findByProps?.("setVideoEnabled");
                    if (va?.setVideoEnabled) { va.setVideoEnabled(true); log("setVideoEnabled(true) OK"); }
                    else log("setVideoEnabled introuvable");
                } catch (e) { log("enable err " + e); }
            } catch (e) { log("FATAL " + e); }
        };

        // ── Relais vidéo INVERSE (Vesktop → QAM) ────────────────────────────────
        // Pour VOIR le Go Live/cam d'un participant dans le panneau QAM : on regarde
        // son stream (Discord décode + rend un <video>), on capture sa piste vidéo et
        // on l'OFFRE au QAM par WebRTC local — miroir du relais micro, sens inverse.
        // L'audio n'est PAS relayé : il est déjà audible via la sortie de Vesktop.
        // Corrélation par userId. findByCode (≠ id de module) survit aux MAJ Discord.
        window.STEAMCORD_VIDEO = window.STEAMCORD_VIDEO || {}; // userId -> { pc, streamKey }

        window.STEAMCORD_startVideoRelay = async (userId) => {
            try {
                const WP = Vencord.Webpack;
                const ASS = WP.findStore("ApplicationStreamingStore");
                const SCS = WP.findStore("SelectedChannelStore");
                const chId = SCS.getVoiceChannelId();
                // Deux cas : (a) GO LIVE = un stream actif (ApplicationStreamingStore)
                // qu'il faut WATCH pour s'abonner ; (b) CAMÉRA = pas de stream, Discord
                // rend déjà la cam du participant dans la tuile vocale → on capte
                // directement (pas de STREAM_WATCH, pas de streamKey).
                const s = (ASS.getAllActiveStreamsForChannel(chId) || []).find(x => (x.ownerId || x.userId) === userId);
                let streamKey = null;
                if (s) {
                    streamKey = s.guildId
                        ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
                        : `call:${s.channelId}:${s.ownerId}`;
                    // Regarder le stream (s'abonner) — SEULEMENT si pas déjà viewer, car
                    // re-dispatcher STREAM_WATCH re-render le tile et tue la piste captée.
                    const myId = WP.findStore("UserStore").getCurrentUser()?.id;
                    const alreadyViewing = (ASS.getViewerIds?.(streamKey) || []).includes(myId);
                    if (!alreadyViewing) {
                        const watch = WP.findByCode('"STREAM_WATCH",streamKey');
                        if (watch) watch(s); else console.warn("[Steamcord] video: action STREAM_WATCH introuvable");
                    }
                } else {
                    console.log("[Steamcord] video: pas de stream → cas CAMÉRA pour " + userId);
                }

                // CAPTURER via captureStream() : la piste capturée suit le RENDU de
                // l'élément. Quand Discord swappe/re-render le tile, la piste capturée
                // passe "ended" → un keepalive la remplace (replaceTrack) sans renégocier.
                // Capter JUSQU'À 2 vidéos live (une même personne peut partager
                // ÉCRAN + CAMÉRA en même temps = 2 pistes). Triées par taille
                // décroissante (l'écran est généralement plus grand que la cam).
                const grabAll = (max) => {
                    const cands = Array.from(document.querySelectorAll("video"))
                        .filter(e => e.srcObject && e.srcObject.getVideoTracks().length
                            && !e.srcObject.getVideoTracks()[0].muted && e.videoWidth > 0)
                        .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
                    const out = [];
                    const seen = new Set();
                    for (const el of cands) {
                        try {
                            const ct = el.captureStream().getVideoTracks()[0];
                            if (ct && ct.readyState === "live" && !seen.has(ct.id)) { seen.add(ct.id); out.push(ct); }
                        } catch (e) { /* élément cross-origin (avatar/banner) → suivant */ }
                        if (out.length >= max) break;
                    }
                    return out;
                };
                // Laisser le(s) tile(s) se (re)monter avant de capturer des pistes stables.
                await new Promise(r => setTimeout(r, 1200));
                let tracks = [];
                for (let i = 0; i < 60 && tracks.length === 0; i++) { tracks = grabAll(2); if (!tracks.length) await new Promise(r => setTimeout(r, 100)); }
                if (!tracks.length) { console.warn("[Steamcord] video: piste introuvable pour " + userId); return; }

                // Fermer un éventuel relais précédent pour ce user avant d'en recréer un.
                const prev = window.STEAMCORD_VIDEO[userId];
                if (prev) { try { prev.pc && prev.pc.close(); } catch {} if (prev.keepalive) clearInterval(prev.keepalive); }

                const pc = new RTCPeerConnection(null);
                const senders = tracks.map(t => pc.addTrack(t));

                // Keepalive : si une piste capturée meurt (re-render Discord), re-capturer
                // les éléments live et remplacer les pistes des senders — flux continu.
                const keepalive = setInterval(() => {
                    try {
                        if (pc.connectionState === "closed") { clearInterval(keepalive); return; }
                        const dead = senders.some(s => !s.track || s.track.readyState === "ended");
                        if (!dead) return;
                        const fresh = grabAll(senders.length);
                        senders.forEach((s, i) => {
                            if ((!s.track || s.track.readyState === "ended") && fresh[i]) {
                                s.replaceTrack(fresh[i]); console.log("[Steamcord] video: piste " + i + " remplacée (keepalive) pour " + userId);
                            }
                        });
                    } catch (e) { /* ignore */ }
                }, 1000);
                window.STEAMCORD_VIDEO[userId] = { pc, streamKey, keepalive };

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                await new Promise((res) => {
                    if (pc.iceGatheringState === "complete") return res();
                    const cb = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", cb); res(); } };
                    pc.addEventListener("icegatheringstatechange", cb);
                    setTimeout(res, 2000);
                });
                window.STEAMCORD_WS.send(JSON.stringify({ type: "$VIDEO_WEBRTC", userId, offer: pc.localDescription }));
                console.log("[Steamcord] video: offer envoyée pour " + userId);
            } catch (e) { console.error("[Steamcord] video relay start failed", e); }
        };

        window.STEAMCORD_stopVideoRelay = (userId) => {
            try {
                const entry = window.STEAMCORD_VIDEO[userId];
                if (!entry) return;
                if (entry.keepalive) clearInterval(entry.keepalive);
                if (entry.pc) entry.pc.close();
                const close = Vencord.Webpack.findByCode('"STREAM_CLOSE",streamKey');
                if (close && entry.streamKey) close(entry.streamKey);
                delete window.STEAMCORD_VIDEO[userId];
                console.log("[Steamcord] video: relais arrêté pour " + userId);
            } catch (e) { console.error("[Steamcord] video relay stop failed", e); }
        };

        // Discord's MediaEngine reinitializes and OVERWRITES our getUserMedia override,
        // so it ends up calling the native one and capturing a silent CEF device →
        // nobody hears the user. Install our override resiliently (defineProperty with a
        // no-op setter) on both the instance and the prototype, and re-assert it.
        function installMicOverride() {
            const desc = { configurable: true, get: () => steamcordGUM, set: () => {} };
            try { Object.defineProperty(navigator.mediaDevices, "getUserMedia", desc); }
            catch (e) { try { navigator.mediaDevices.getUserMedia = steamcordGUM; } catch (_) {} }
            try { Object.defineProperty(MediaDevices.prototype, "getUserMedia", desc); } catch (_) {}
        }
        // CEF only: in Vesktop the native mic works, so installing this override would
        // hijack/break it. Never install it under Vesktop.
        if (!window.STEAMCORD_IS_VESKTOP) {
            installMicOverride();
            setInterval(installMicOverride, 2000);
        }

        function dataURLtoFile(dataurl, filename) {
            var arr = dataurl.split(','),
                mime = arr[0].match(/:(.*?);/)[1],
                bstr = atob(arr[arr.length - 1]),
                n = bstr.length,
                u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new File([u8arr], filename, { type: mime });
        }

        function patchTypingField() {
            const t = setInterval(() => {
                try {
                    document.querySelectorAll("[role=\"textbox\"]")[0].onclick = (e) => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" });
                    clearInterval(t);
                } catch (err) { }
            }, 100)
        }

        async function getAppId(name) {
            const res = await Vencord.Webpack.Common.RestAPI.get({ url: "/applications/detectable" });
            if (res.ok) {
                const item = res.body.filter(e => e.name == name);
                if (item.length > 0) return item[0].id;
            }
            return "0";
        }

        // Le statut Discord (online/idle/dnd/invisible) vit dans le settings proto
        // "PreloadedUserSettings" (type 1), pas dans un action-creator updateStatus
        // (qui n'existe plus). On localise le proto store dont getCurrentValue()
        // expose .status, puis on mute via updateAsync("status", ...).
        let _statusProtoStore;
        function getStatusProtoStore() {
            if (_statusProtoStore) return _statusProtoStore;
            try {
                const cache = Vencord.Webpack.wreq && Vencord.Webpack.wreq.c;
                if (!cache) return null;
                const test = (m) => {
                    try {
                        if (m && typeof m.updateAsync === "function" && m.type === 1 &&
                            typeof m.getCurrentValue === "function" && m.getCurrentValue().status) return m;
                    } catch (e) { }
                    return null;
                };
                for (const id in cache) {
                    try {
                        const exp = cache[id] && cache[id].exports;
                        if (!exp) continue;
                        let s = test(exp);
                        if (!s && typeof exp === "object") {
                            for (const k in exp) { s = test(exp[k]); if (s) break; }
                        }
                        if (s) { _statusProtoStore = s; return s; }
                    } catch (e) { }
                }
            } catch (e) { }
            return null;
        }

        let CloudUpload;
        CloudUpload = Vencord.Webpack.findLazy(m => m.prototype?.trackUploadFinished);;
        function sendAttachmentToChannel(channelId, attachment_b64, filename) {
            return new Promise((resolve, reject) => {
                const file = dataURLtoFile(`data:text/plain;base64,${attachment_b64}`, filename);
                const upload = new CloudUpload({
                    file: file,
                    isClip: false,
                    isThumbnail: false,
                    platform: 1,
                }, channelId, false, 0);
                upload.on("complete", () => {
                    Vencord.Webpack.Common.RestAPI.post({
                        url: `/channels/${channelId}/messages`,
                        body: {
                            channel_id: channelId,
                            content: "",
                            nonce: Vencord.Webpack.Common.SnowflakeUtils.fromTimestamp(Date.now()),
                            sticker_ids: [],
                            type: 0,
                            attachments: [{
                                id: "0",
                                filename: upload.filename,
                                uploaded_filename: upload.uploadedFilename
                            }]
                        }
                    });
                    resolve(true);
                });
                upload.on("error", () => resolve(false))
                upload.upload();
            })
        }

        let MediaEngineStore, FluxDispatcher;
        console.log("Steamcord: Waiting for FluxDispatcher...");
        Vencord.Webpack.waitFor(["subscribe", "dispatch", "register"], fdm => {
            FluxDispatcher = fdm;
            Vencord.Webpack.waitFor(Vencord.Webpack.filters.byStoreName("MediaEngineStore"), m => {
                MediaEngineStore = m;
                FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AUDIO_ENABLED", enabled: true, unmute: true });
                // ROOT CAUSE of "nobody hears me": Discord's MediaEngine never enables mic
                // capture because the hidden tab never gets a user interaction
                // (engine.interacted stays false → engine.enabled stays false → no capture).
                // Force the interaction flag and enable the engine, and re-assert it since
                // Discord can reset it.
                const forceEngineEnabled = () => {
                    try {
                        const eng = m.getMediaEngine && m.getMediaEngine();
                        if (!eng) return;
                        eng.interacted = true;
                        if (typeof eng.setAudioEnabled === "function") eng.setAudioEnabled(true);
                        else if (typeof eng.enable === "function") eng.enable();
                    } catch (_) {}
                };
                // Also dispatch the DOM events Discord listens to for "interacted"
                try {
                    for (const type of ["pointerdown", "mousedown", "click", "keydown", "touchstart"])
                        document.dispatchEvent(new Event(type, { bubbles: true }));
                } catch (_) {}
                forceEngineEnabled();
                setInterval(forceEngineEnabled, 3000);
            });

            function connect() {
                // Garde anti-double-client : si un WS est déjà ouvert/en cours, ne pas
                // en créer un second (sinon chaque message backend est traité 2×).
                if (window.STEAMCORD_WS && window.STEAMCORD_WS.readyState <= 1) return;
                window.STEAMCORD_WS = new WebSocket('ws://127.0.0.1:65123/socket');
                window.STEAMCORD_WS.addEventListener("message", async function (e) {
                    const data = JSON.parse(e.data);
                    if (data.type.startsWith("$")) {
                        let result;
                        try {
                            switch (data.type) {
                                case "$getuser":
                                    result = Vencord.Webpack.Common.UserStore.getUser(data.id);
                                    break;
                                case "$getchannel":
                                    result = Vencord.Webpack.Common.ChannelStore.getChannel(data.id);
                                    break;
                                case "$getguild":
                                    result = Vencord.Webpack.Common.GuildStore.getGuild(data.id);
                                    break;
                                case "$getmedia":
                                    result = {
                                        mute: MediaEngineStore.isSelfMute(),
                                        deaf: MediaEngineStore.isSelfDeaf(),
                                        live: MediaEngineStore.getGoLiveSource() != undefined
                                    }
                                    break;
                                case "$get_last_channels":
                                    result = {}
                                    const ChannelStore = Vencord.Webpack.Common.ChannelStore;
                                    const GuildStore = Vencord.Webpack.Common.GuildStore;
                                    const channelIds = Object.values(JSON.parse(Vencord.Util.localStorage.SelectedChannelStore).mostRecentSelectedTextChannelIds);
                                    for (const chId of channelIds) {
                                        const ch = ChannelStore.getChannel(chId);
                                        const guild = GuildStore.getGuild(ch.guild_id);
                                        result[chId] = `${ch.name} (${guild.name})`;
                                    }
                                    break;
                                case "$get_screen_bounds":
                                    result = { width: screen.width, height: screen.height }
                                    break;
                                case "$ptt":
                                    try {
                                        MediaEngineStore.getMediaEngine().connections.values().next().value.setForceAudioInput(data.value);
                                    } catch (error) { }
                                    return;
                                case "$setptt":
                                    FluxDispatcher.dispatch({
                                        "type": "AUDIO_SET_MODE",
                                        "context": "default",
                                        "mode": data.enabled ? "PUSH_TO_TALK" : "VOICE_ACTIVITY",
                                        "options": MediaEngineStore.getSettings().modeOptions
                                    });
                                    return;
                                case "$rpc":
                                    FluxDispatcher.dispatch({
                                        type: "LOCAL_ACTIVITY_UPDATE",
                                        activity: data.game ? {
                                            application_id: await getAppId(data.game),
                                            name: data.game,
                                            type: 0,
                                            flags: 1,
                                            timestamps: { start: Date.now() }
                                        } : {},
                                        socketId: "CustomRPC",
                                    });
                                    return;
                                case "$screenshot":
                                    result = await sendAttachmentToChannel(data.channel_id, data.attachment_b64, "screenshot.jpg");
                                    break;
                                case "$set_user_volume":
                                    // context "default" = voix, "stream" = audio du Go Live (volumes indépendants).
                                    FluxDispatcher.dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", userId: data.id, volume: data.volume, context: data.context || "default" });
                                    return;
                                case "$get_local_mute": {
                                    // Mute LOCAL (côté client seulement : on ne les entend plus, eux ne le savent pas).
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    break;
                                }
                                case "$toggle_local_mute": {
                                    const mod = Vencord.Webpack.findByProps("toggleLocalMute");
                                    if (mod && mod.toggleLocalMute) mod.toggleLocalMute(data.id);
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id)); // nouvel état
                                    break;
                                }
                                case "$set_local_mute": {
                                    // SET idempotent (≠ toggle aveugle) : on ne bascule que si l'état
                                    // courant diffère du voulu → un double-clic gamescope ne re-flip plus.
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const cur = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    if (cur !== !!data.muted) {
                                        const mod = Vencord.Webpack.findByProps("toggleLocalMute");
                                        if (mod && mod.toggleLocalMute) mod.toggleLocalMute(data.id);
                                    }
                                    result = !!(MES && MES.isLocalMute && MES.isLocalMute(data.id));
                                    break;
                                }
                                case "$set_status": {
                                    // data.status: "online" | "idle" | "dnd" | "invisible"
                                    try {
                                        const store = getStatusProtoStore();
                                        if (store) {
                                            await store.updateAsync("status", (s) => { s.status.value = data.status; }, 0);
                                            console.log("[Steamcord] status → " + data.status);
                                        } else console.warn("[Steamcord] proto store status introuvable");
                                    } catch (e) { console.error("[Steamcord] set_status err", e); }
                                    return;
                                }
                                case "$get_status": {
                                    try {
                                        // Le proto store donne la vraie valeur réglée (y compris
                                        // "invisible", que PresenceStore rapporte comme "offline").
                                        const store = getStatusProtoStore();
                                        const protoStatus = store?.getCurrentValue?.()?.status?.status?.value;
                                        if (protoStatus) { result = { status: protoStatus }; break; }
                                        const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
                                        const PS = Vencord.Webpack.findStore("PresenceStore");
                                        result = { status: PS?.getStatus?.(me.id) || "online" };
                                    } catch (e) { result = { status: "online" }; }
                                    break;
                                }
                                case "$golive": {
                                    const selChStore = Vencord.Webpack.findStore("SelectedChannelStore");
                                    const golive_channel_id = selChStore?.getVoiceChannelId?.();
                                    if (!golive_channel_id) {
                                        console.warn("[Steamcord] Go Live: pas dans un salon vocal");
                                        return;
                                    }
                                    const golive_channel = Vencord.Webpack.Common.ChannelStore.getChannel(golive_channel_id);
                                    const golive_guild_id = golive_channel?.guild_id ?? null;

                                    // L'ancienne API (modules m.startStream/m.stopStream) a DISPARU de
                                    // Discord. On utilise les action creators actuels via findByCode
                                    // (robuste aux changements d'ID de module) : STREAM_START / STREAM_STOP.
                                    // getDisplayMedia est surchargé (webrtc_client.js → capture GStreamer
                                    // plein écran) → pas de picker.
                                    const WP = Vencord.Webpack;
                                    try {
                                        if (data.stop) {
                                            const ASS = WP.findStore("ApplicationStreamingStore");
                                            const s = ASS?.getCurrentUserActiveStream?.();
                                            const stopFn = WP.findByCode('"STREAM_STOP"');
                                            if (s && stopFn) {
                                                const key = s.guildId
                                                    ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
                                                    : `call:${s.channelId}:${s.ownerId}`;
                                                stopFn(key);
                                            }
                                            console.log("[Steamcord] Go Live STOP envoyé");
                                        } else {
                                            const startFn = WP.findByCode('"STREAM_START",streamType');
                                            if (startFn) startFn(golive_guild_id, golive_channel_id, {});
                                            else console.warn("[Steamcord] Go Live: action STREAM_START introuvable");
                                            console.log("[Steamcord] Go Live START envoyé (écran entier), found=" + !!startFn);
                                        }
                                    } catch (e) {
                                        console.error("[Steamcord] Go Live échec:", e);
                                    }
                                    return;
                                }
                                case "$screen_camera": {
                                    await window.STEAMCORD_enableScreenCamera?.(!data.stop);
                                    return;
                                }
                                case "$get_dm_channels": {
                                    const CS = Vencord.Webpack.Common.ChannelStore;
                                    const US = Vencord.Webpack.Common.UserStore;
                                    const VSS = Vencord.Webpack.findStore?.("VoiceStateStore");
                                    const sorted = CS?.getSortedPrivateChannels?.() ?? [];
                                    result = sorted.slice(0, 30).map(ch => {
                                        // "Active" only if someone is actually connected to the call.
                                        // CallStore.getCall() lingers after a call ends → false "EN CALL".
                                        const states = VSS?.getVoiceStatesForChannel?.(ch.id) || {};
                                        const activeCall = Object.keys(states).length > 0;
                                        const recipientIds = Array.isArray(ch.recipientIDs) ? ch.recipientIDs
                                            : Array.isArray(ch.recipients) ? ch.recipients.map(r => typeof r === 'string' ? r : r.id)
                                            : [];
                                        const recipients = recipientIds.map(id => {
                                            const u = US?.getUser?.(id);
                                            return { id: String(id), username: u?.username ?? String(id), avatar: u?.avatar ?? null };
                                        });
                                        const name = ch.name || (recipients.length === 1 ? recipients[0].username : `Group (${recipients.length + 1})`);
                                        return {
                                            id: String(ch.id),
                                            type: ch.type ?? 1,
                                            name,
                                            icon: ch.icon ?? null,
                                            recipients,
                                            active_call: activeCall,
                                        };
                                    });
                                    break;
                                }
                                case "$dm_call": {
                                    const channelId = data.id;
                                    if (data.join_existing) {
                                        FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId, guildId: null });
                                    } else {
                                        const CallActions = Vencord.Webpack.find(m => m && typeof m.startCall === 'function');
                                        if (CallActions) CallActions.startCall(channelId);
                                        else FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId, guildId: null });
                                    }
                                    result = true;
                                    break;
                                }
                                case "$get_guilds_vc": {
                                    const GS = Vencord.Webpack.Common.GuildStore;
                                    const GCS = Vencord.Webpack.findStore("GuildChannelStore");
                                    const SGS = Vencord.Webpack.findStore("SortedGuildStore");
                                    const VSS = Vencord.Webpack.findStore("VoiceStateStore");
                                    const US = Vencord.Webpack.Common.UserStore;
                                    const sortedIds = SGS?.getFlattenedGuildIds?.() ?? SGS?.getGuilds?.()?.map(g => g.id) ?? Object.keys(GS.getGuilds());
                                    const allGuilds = GS.getGuilds();
                                    result = [];
                                    for (const guildId of sortedIds) {
                                        const guild = allGuilds[guildId];
                                        if (!guild) continue;
                                        try {
                                            const gc = GCS.getChannels(guild.id);
                                            const vocalList = gc?.VOCAL || [];
                                            const vocal = vocalList
                                                .map(e => {
                                                    const chId = String(e.channel?.id ?? e.id ?? "");
                                                    const chName = String(e.channel?.name ?? e.name ?? "");
                                                    if (!chId || !chName) return null;
                                                    const states = VSS?.getVoiceStatesForChannel?.(chId) || {};
                                                    const members = Object.values(states).map(vs => {
                                                        const u = US?.getUser?.(vs.userId);
                                                        return { id: vs.userId, avatar: u?.avatar || null };
                                                    });
                                                    return { id: chId, name: chName, members };
                                                })
                                                .filter(Boolean);
                                            if (vocal.length > 0) result.push({ id: String(guild.id), name: String(guild.name), icon: guild.icon || null, channels: vocal });
                                        } catch (_) {}
                                    }
                                    break;
                                }
                                case "$join_vc":
                                    FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: data.id, guildId: data.guild_id });
                                    result = true;
                                    break;
                                case "$get_voice_states": {
                                    const vsStore = Vencord.Webpack.findStore("VoiceStateStore");
                                    const states = vsStore?.getVoiceStatesForChannel?.(data.id) || {};
                                    result = Object.values(states).map(vs => ({
                                        userId: vs.userId,
                                        mute: vs.mute || vs.selfMute || false,
                                        deaf: vs.deaf || vs.selfDeaf || false,
                                        video: vs.selfVideo || false,
                                    }));
                                    break;
                                }
                                case "$get_text_channels": {
                                    // Serveurs → salons texte (type 0) + annonces (type 5) accessibles.
                                    const GS = Vencord.Webpack.Common.GuildStore;
                                    const GCS = Vencord.Webpack.findStore("GuildChannelStore");
                                    const SGS = Vencord.Webpack.findStore("SortedGuildStore");
                                    const sortedIds = SGS?.getFlattenedGuildIds?.() ?? Object.keys(GS.getGuilds());
                                    const allGuilds = GS.getGuilds();
                                    result = [];
                                    for (const gid of sortedIds) {
                                        const guild = allGuilds[gid];
                                        if (!guild) continue;
                                        try {
                                            const gc = GCS.getChannels(guild.id);
                                            const list = gc?.SELECTABLE || [];
                                            const channels = list
                                                .map(e => {
                                                    const ch = e.channel ?? e;
                                                    if (!ch || (ch.type !== 0 && ch.type !== 5)) return null;
                                                    return { id: String(ch.id), name: String(ch.name), type: ch.type };
                                                })
                                                .filter(Boolean);
                                            if (channels.length)
                                                result.push({ id: String(guild.id), name: String(guild.name), icon: guild.icon || null, channels });
                                        } catch (_) { }
                                    }
                                    break;
                                }
                                case "$get_messages": {
                                    // MessageStore est vide pour un salon non ouvert → RestAPI (newest-first,
                                    // on inverse pour l'ordre de lecture). Timestamps ISO.
                                    const res = await Vencord.Webpack.Common.RestAPI.get({ url: `/channels/${data.id}/messages?limit=30` });
                                    const arr = (res?.body || []).slice().reverse();
                                    const isImg = (a) => (a?.content_type || "").startsWith("image/")
                                        || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(a?.filename || a?.url || "");
                                    result = arr.map(m => {
                                        const atts = Array.isArray(m.attachments) ? m.attachments : [];
                                        // Images = pièces jointes image + images d'embeds (liens d'images
                                        // postés deviennent des embeds). proxy_url = CDN média redimensionnable.
                                        const images = [];
                                        for (const a of atts) {
                                            if (isImg(a)) images.push({ url: a.url, proxy_url: a.proxy_url || a.url, w: a.width || 0, h: a.height || 0 });
                                        }
                                        for (const e of (Array.isArray(m.embeds) ? m.embeds : [])) {
                                            const im = e?.image || e?.thumbnail;
                                            if (im && im.url) images.push({ url: im.url, proxy_url: im.proxy_url || im.url, w: im.width || 0, h: im.height || 0 });
                                        }
                                        return {
                                            id: String(m.id),
                                            author: m.author?.global_name || m.author?.username || "?",
                                            author_id: String(m.author?.id || ""),
                                            avatar: m.author?.avatar || null,
                                            bot: !!m.author?.bot,
                                            content: m.content ?? "",
                                            ts: m.timestamp || null,
                                            images,
                                            files: atts.filter(a => !isImg(a)).length,
                                        };
                                    });
                                    break;
                                }
                                case "$send_message": {
                                    await Vencord.Webpack.Common.RestAPI.post({
                                        url: `/channels/${data.id}/messages`,
                                        body: { content: String(data.content || "") },
                                    });
                                    result = true;
                                    break;
                                }
                                case "$webrtc":
                                    return;
                                case "$WATCH_VIDEO":
                                    window.STEAMCORD_startVideoRelay(data.userId);
                                    return;
                                case "$UNWATCH_VIDEO":
                                    window.STEAMCORD_stopVideoRelay(data.userId);
                                    return;
                                case "$VIDEO_ANSWER": {
                                    const entry = window.STEAMCORD_VIDEO[data.userId];
                                    if (entry && entry.pc) await entry.pc.setRemoteDescription(new RTCSessionDescription(data.payload));
                                    return;
                                }
                                case "$login_token": {
                                    const t = data.token;
                                    if (!t) return;
                                    const lm = Vencord.Webpack.find(m => m && typeof m.loginToken === "function");
                                    if (lm) lm.loginToken(t, true);
                                    else { localStorage.setItem("token", JSON.stringify(t)); location.reload(); }
                                    return;
                                }
                                case "$logout": {
                                    // Déconnexion TOTALE Discord : invalide le token côté serveur +
                                    // purge la session locale → retour page login (QR). Fallback :
                                    // purge localStorage + reload si l'action n'est pas trouvée.
                                    try {
                                        const auth = Vencord.Webpack.findByProps("logout", "loginToken");
                                        if (auth && typeof auth.logout === "function") auth.logout();
                                        else { localStorage.removeItem("token"); location.reload(); }
                                    } catch (e) {
                                        try { localStorage.removeItem("token"); location.reload(); } catch (_) {}
                                    }
                                    return;
                                }
                                case "$get_audio_processing": {
                                    // Réglages micro Discord (Voix & Vidéo). La réduction de bruit
                                    // est un tri-état : Krisp (noiseCancellation) > Standard
                                    // (noiseSuppression) > Aucune. + écho + gain auto.
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    const nc = !!MES.getNoiseCancellation();
                                    const ns = !!MES.getNoiseSuppression();
                                    result = {
                                        noise: nc ? "krisp" : (ns ? "standard" : "none"),
                                        echoCancellation: !!MES.getEchoCancellation(),
                                        automaticGainControl: !!MES.getAutomaticGainControl(),
                                        ncSupported: MES.isNoiseCancellationSupported ? !!MES.isNoiseCancellationSupported() : true,
                                        nsSupported: MES.isNoiseSuppressionSupported ? !!MES.isNoiseSuppressionSupported() : true,
                                        agcSupported: MES.isAutomaticGainControlSupported ? !!MES.isAutomaticGainControlSupported() : true,
                                    };
                                    break;
                                }
                                case "$set_noise_reduction": {
                                    // data.mode: "none" | "standard" | "krisp"
                                    const SET = Vencord.Webpack.findByProps("setNoiseCancellation");
                                    if (SET) {
                                        if (data.mode === "krisp") { SET.setNoiseSuppression(false); SET.setNoiseCancellation(true); }
                                        else if (data.mode === "standard") { SET.setNoiseCancellation(false); SET.setNoiseSuppression(true); }
                                        else { SET.setNoiseCancellation(false); SET.setNoiseSuppression(false); }
                                    }
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = { noise: MES.getNoiseCancellation() ? "krisp" : (MES.getNoiseSuppression() ? "standard" : "none") };
                                    break;
                                }
                                case "$set_echo_cancellation": {
                                    const SET = Vencord.Webpack.findByProps("setEchoCancellation");
                                    if (SET) SET.setEchoCancellation(!!data.enabled);
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = { echoCancellation: !!MES.getEchoCancellation() };
                                    break;
                                }
                                case "$set_automatic_gain_control": {
                                    const SET = Vencord.Webpack.findByProps("setAutomaticGainControl");
                                    if (SET) SET.setAutomaticGainControl(!!data.enabled);
                                    const MES = Vencord.Webpack.findStore("MediaEngineStore");
                                    result = { automaticGainControl: !!MES.getAutomaticGainControl() };
                                    break;
                                }
                            }
                        } catch (error) {
                            result = { error: error }
                            if (data.increment == undefined) return;
                        }
                        const payload = {
                            type: "$steamcord_request",
                            increment: data.increment,
                            // `?? {}` et PAS `|| {}` : `|| {}` transformait un résultat
                            // booléen `false` (ex. get_local_mute d'un user NON muté) en
                            // `{}` → côté frontend `!!{}` = true → participant affiché
                            // « muet » à tort. `?? {}` ne remplace que null/undefined et
                            // préserve false/0/"".
                            result: result ?? {}
                        };
                        console.debug(data, payload);
                        window.STEAMCORD_WS.send(JSON.stringify(payload));
                        return;
                    }
                    FluxDispatcher.dispatch(data);
                });

                window.STEAMCORD_WS.onopen = function (e) {
                    // CEF only: kick off the mic relay handshake. In Vesktop the mic is
                    // native — don't touch getUserMedia.
                    if (!window.STEAMCORD_IS_VESKTOP) navigator.mediaDevices.getUserMedia();
                    Vencord.Webpack.waitFor("useState", t => {
                        window.STEAMCORD_WS.send(JSON.stringify({ type: "LOADED", result: true }));
                        Vencord.Webpack.onceReady.then(() => {
                            const user = Vencord.Webpack.Common.UserStore.getCurrentUser();
                            if (user) {
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "CONNECTION_OPEN", user }));
                            } else if (window.STEAMCORD_LAST_QR) {
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_QR_SVG", svg_b64: window.STEAMCORD_LAST_QR }));
                            }
                        });
                    });
                }

                window.STEAMCORD_WS.onclose = function (e) {
                    FluxDispatcher._interceptors.pop()
                    setTimeout(function () {
                        connect();
                    }, 100);
                };

                window.STEAMCORD_WS.onerror = function (err) {
                    console.error('Socket encountered error: ', err.message, 'Closing socket');
                    window.STEAMCORD_WS.close();
                };

                Vencord.Webpack.onceReady.then(t => {
                    const user = Vencord.Webpack.Common.UserStore.getCurrentUser();
                    if (user) {
                        window.STEAMCORD_WS.send(JSON.stringify({ type: "CONNECTION_OPEN", user }));
                    }
                });

                FluxDispatcher.addInterceptor(e => {
                    if (e.type == "CHANNEL_SELECT") patchTypingField();

                    // Incoming DM call → Steam toast (DMs only; guild calls are useless).
                    // Respect the user's Discord status: skip if invisible or DnD (busy).
                    try {
                        if (e.type && e.type.indexOf("CALL") === 0)
                            console.log("[Steamcord] CALL event: " + e.type + " ringing=" + JSON.stringify(e.ringing) + " ch=" + e.channelId);
                        if (e.type === "CALL_DELETE" && window.__sc_ringing) {
                            delete window.__sc_ringing[e.channelId];
                        } else if ((e.type === "CALL_CREATE" || e.type === "CALL_UPDATE") && Array.isArray(e.ringing)) {
                            const me = Vencord.Webpack.Common.UserStore.getCurrentUser();
                            window.__sc_ringing = window.__sc_ringing || {};
                            if (!e.ringing.includes(me?.id)) {
                                delete window.__sc_ringing[e.channelId]; // ring stopped / answered
                            } else {
                                const ch = Vencord.Webpack.Common.ChannelStore.getChannel(e.channelId);
                                console.log("[Steamcord] incoming ring for me, ch.type=" + ch?.type + " status=" + Vencord.Webpack.findStore("PresenceStore")?.getStatus?.(me.id));
                                const isDM = ch && (ch.type === 1 || ch.type === 3);
                                const PresenceStore = Vencord.Webpack.findStore("PresenceStore");
                                const status = PresenceStore?.getStatus?.(me.id);
                                const muted = status === "invisible" || status === "dnd";
                                if (isDM && !muted && !window.__sc_ringing[e.channelId]) {
                                    window.__sc_ringing[e.channelId] = true;
                                    let caller = ch.name;
                                    if (!caller) {
                                        const r = (ch.rawRecipients && ch.rawRecipients[0]) ||
                                                  (ch.recipients && ch.recipients[0]);
                                        const u = (r && typeof r === "object") ? r
                                                : Vencord.Webpack.Common.UserStore.getUser(r);
                                        caller = u?.global_name || u?.username || "Discord";
                                    }
                                    window.STEAMCORD_WS.send(JSON.stringify({ type: "CALL_RING", caller, channel_id: String(e.channelId) }));
                                }
                            }
                        }
                    } catch (_) {}

                    const shouldPass = [
                        "CONNECTION_OPEN",
                        "LOGOUT",
                        "CONNECTION_CLOSED",
                        "VOICE_STATE_UPDATES",
                        "VOICE_STATE_UPDATE",
                        "VOICE_CHANNEL_SELECT",
                        "AUDIO_TOGGLE_SELF_MUTE",
                        "AUDIO_TOGGLE_SELF_DEAF",
                        "RPC_NOTIFICATION_CREATE",
                        "STREAM_START",
                        "STREAM_STOP",
                        "SPEAKING"
                    ].includes(e.type);
                    if (shouldPass) {
                        console.log("Dispatching Steamcord event: ", e);
                        window.STEAMCORD_WS.send(JSON.stringify(e));
                    }
                });
                console.log("Steamcord: Added event interceptor");

                // Robust voice-channel tracking: Discord does NOT reliably emit
                // VOICE_CHANNEL_SELECT when you're force-disconnected by joining voice on
                // another device. Poll the store and notify the backend on any change so
                // the QAM state always matches reality (join / leave / move / kicked).
                let steamcordLastVCId = undefined;
                setInterval(() => {
                    try {
                        if (!window.STEAMCORD_WS || window.STEAMCORD_WS.readyState !== 1) return;
                        const selStore = Vencord.Webpack.findStore("SelectedChannelStore");
                        const vcid = selStore?.getVoiceChannelId?.() ?? null;
                        if (vcid !== steamcordLastVCId) {
                            steamcordLastVCId = vcid;
                            let guildId = null;
                            if (vcid) {
                                const ch = Vencord.Webpack.Common.ChannelStore.getChannel(vcid);
                                guildId = ch?.guild_id ?? null;
                            }
                            console.log("[Steamcord] voice channel changed → " + vcid);
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "VOICE_CHANNEL_SELECT", channelId: vcid, guildId }));
                        }

                        // RÉCONCILIATION mute/deaf depuis le STORE autoritatif (et pas
                        // seulement les deltas VOICE_STATE_UPDATES). Discord peut émettre
                        // un état muet TRANSITOIRE à la connexion d'un participant ; si le
                        // delta de nettoyage est manqué (ou arrive sur un autre channelId),
                        // l'icône « muet » restait collée alors que la personne est audible.
                        // On relit la vérité (getVoiceStatesForChannel = ce que l'UI Discord
                        // affiche) et on ne ré-émet QUE si le signal mute/deaf a changé →
                        // auto-guérison sous 2 s, zéro spam / re-render inutile.
                        if (vcid) {
                            const VSS = Vencord.Webpack.findStore("VoiceStateStore");
                            const states = VSS?.getVoiceStatesForChannel?.(vcid) || {};
                            const vsArr = [];
                            for (const uid in states) {
                                const v = states[uid] || {};
                                vsArr.push({
                                    userId: uid, channelId: vcid,
                                    mute: !!(v.mute || v.selfMute), selfMute: !!v.selfMute,
                                    deaf: !!(v.deaf || v.selfDeaf), selfDeaf: !!v.selfDeaf,
                                    video: !!v.selfVideo, selfVideo: !!v.selfVideo,
                                    suppress: !!v.suppress
                                });
                            }
                            const sig = JSON.stringify(vsArr.map(s => [s.userId, s.mute, s.deaf, s.video]));
                            if (sig !== window.__sc_lastVoiceSig) {
                                window.__sc_lastVoiceSig = sig;
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "VOICE_STATE_UPDATES", voiceStates: vsArr }));
                            }
                        } else {
                            window.__sc_lastVoiceSig = undefined;
                        }
                    } catch (_) {}
                }, 2000);

                // Sync des Go Live actifs → is_live des participants dans le QAM. Discord
                // n'émet STREAM_START qu'au DÉMARRAGE : un stream lancé avant notre
                // connexion serait manqué. On diffe l'ensemble des streams actifs et on
                // émet STREAM_START/STOP synthétiques sur changement (clé = call/guild:…:ownerId).
                let steamcordStreamKeys = new Set();
                setInterval(() => {
                    try {
                        if (!window.STEAMCORD_WS || window.STEAMCORD_WS.readyState !== 1) return;
                        const SCS = Vencord.Webpack.findStore("SelectedChannelStore");
                        const ASS = Vencord.Webpack.findStore("ApplicationStreamingStore");
                        const vcid = SCS?.getVoiceChannelId?.() ?? null;
                        const now = new Set();
                        if (vcid) {
                            for (const s of (ASS?.getAllActiveStreamsForChannel?.(vcid) || [])) {
                                const owner = s.ownerId || s.userId;
                                const key = s.guildId ? `guild:${s.guildId}:${s.channelId}:${owner}` : `call:${s.channelId}:${owner}`;
                                now.add(key);
                                if (!steamcordStreamKeys.has(key))
                                    window.STEAMCORD_WS.send(JSON.stringify({ type: "STREAM_START", streamKey: key }));
                            }
                        }
                        for (const key of steamcordStreamKeys)
                            if (!now.has(key))
                                window.STEAMCORD_WS.send(JSON.stringify({ type: "STREAM_STOP", streamKey: key }));
                        steamcordStreamKeys = now;
                    } catch (_) {}
                }, 2000);

                // Chromium freezes the occluded BrowserView: the voice WebRTC stalls at
                // DTLS_CONNECTING AND Discord's mic capture never runs → nobody hears
                // anyone. Keep the view rendered (1×1, barely visible) for the WHOLE time
                // we're in a voice channel so both the connection and the mic capture stay
                // alive; hide it again when we leave the call.
                let steamcordVoiceShown = false;
                setInterval(() => {
                    try {
                        const inVoice = !!Vencord.Webpack.findStore("SelectedChannelStore").getVoiceChannelId();
                        if (inVoice && !steamcordVoiceShown) {
                            steamcordVoiceShown = true;
                            fetch("http://127.0.0.1:65123/voice_render", { mode: "no-cors" }).catch(() => {});
                        } else if (!inVoice && steamcordVoiceShown) {
                            steamcordVoiceShown = false;
                            fetch("http://127.0.0.1:65123/voice_hide", { mode: "no-cors" }).catch(() => {});
                        }
                    } catch (_) {}
                }, 1000);
            }
            connect();
        });

        (() => {
            const t = setInterval(() => {
                try {
                    if (window.location.pathname == "/login") {
                        for (const el of document.getElementsByTagName('input')) {
                            el.onclick = (ev) => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" });
                        }
                    }
                    clearInterval(t);
                }
                catch (err) { }
            }, 100)
        })();

        // Resume Discord's MediaEngine AudioContext if it somehow gets suspended
        (function keepAudioAlive() {
            setInterval(() => {
                try {
                    const me = Vencord.Webpack.findStore?.("MediaEngineStore")?.getMediaEngine?.();
                    if (me?.audioContext?.state === "suspended") {
                        me.audioContext.resume();
                        console.log("[Steamcord] Resumed MediaEngine AudioContext");
                    }
                } catch(_) {}
            }, 5000);
        })();

        // Token login: callable from QAM via CDP
        window.steamcordLoginWithToken = function(token) {
            const loginMod = Vencord.Webpack.find(m => m && typeof m.loginToken === "function");
            if (loginMod) {
                loginMod.loginToken(token, true);
                return "ok";
            }
            localStorage.setItem("token", JSON.stringify(token));
            location.reload();
            return "reload";
        };

        // Canvas QR mirror: extract Discord's own QR when the tab is visible (no spinner)
        window.STEAMCORD_LAST_QR = null;
        (function startCanvasQRMirror() {
            const sendQR = (url) => {
                window.STEAMCORD_LAST_QR = url;
                if (window.STEAMCORD_WS?.readyState === 1)
                    window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_QR_SVG", svg_b64: url }));
            };
            // Discord rend désormais le QR en <svg> (≈160px, viewBox carré "0 0 37 37",
            // un gros <path> de modules), PAS en canvas (le canvas 240×240 est un
            // placeholder caché/coloré). On capture le SVG → data URL que l'<img> du QAM
            // affiche directement. Détection = SVG carré 100–300px avec une grosse data
            // de path (le QR ≈ 35 Ko ; les logos/icônes ont des paths courts).
            const findQRSvg = () => {
                for (const s of document.querySelectorAll("svg")) {
                    const r = s.getBoundingClientRect();
                    if (r.width < 100 || r.width > 320 || Math.abs(r.width - r.height) > 30) continue;
                    let pathLen = 0;
                    for (const p of s.querySelectorAll("path, rect")) pathLen += (p.getAttribute("d") || "").length;
                    if (pathLen > 3000) return s;
                }
                return null;
            };
            const svgToDataUrl = (svg) => {
                const clone = svg.cloneNode(true);
                clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
                const s = new XMLSerializer().serializeToString(clone);
                return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(s)));
            };
            const sendScanned = (b) => {
                if (window.STEAMCORD_WS?.readyState === 1)
                    window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_SCANNED", scanned: b }));
            };
            let lastUrl = null, lastScanned = false;
            setInterval(() => {
                try {
                    if (Vencord.Webpack.Common.UserStore?.getCurrentUser?.()) {
                        if (lastUrl !== null) { lastUrl = null; sendQR(null); }
                        if (lastScanned) { lastScanned = false; sendScanned(false); }
                        return;
                    }
                    const svg = findQRSvg();
                    if (svg) {
                        if (lastScanned) { lastScanned = false; sendScanned(false); }
                        const url = svgToDataUrl(svg);
                        if (url.length > 2000 && url !== lastUrl) { lastUrl = url; sendQR(url); }
                        return;
                    }
                    // Pas de QR. Soit SCANNÉ (Discord affiche « regarde ton téléphone » avec
                    // l'avatar du compte → attente de validation), soit en chargement.
                    if (lastUrl !== null) { lastUrl = null; sendQR(null); }
                    const scanned = !!document.querySelector('img[src*="avatars"]');
                    if (scanned !== lastScanned) { lastScanned = scanned; sendScanned(scanned); }
                } catch (e) { /* ignore */ }
            }, 1500);
        })();

        // Remote auth: our own WS, QR from segno (Python), ticket sent to backend for POST with desktop UA
        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
        window.steamcordStartRemoteAuth = async function() {
            if (window.STEAMCORD_REMOTE_AUTH_ACTIVE) return;
            window.STEAMCORD_REMOTE_AUTH_ACTIVE = true;
            try {
                const keyPair = await crypto.subtle.generateKey(
                    { name: "RSA-OAEP", modulusLength: 2048,
                      publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
                    true, ["decrypt"]
                );
                const pubDer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
                const encodedPub = btoa(String.fromCharCode(...new Uint8Array(pubDer)));
                const privJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

                const ws = new WebSocket("wss://remote-auth-gateway.discord.gg/?v=2");
                let hbTimer = null;

                ws.onmessage = async (event) => {
                    const data = JSON.parse(event.data);
                    const op = data.op;
                    if (op === "hello") {
                        hbTimer = setInterval(() => ws.send(JSON.stringify({ op: "heartbeat" })), data.heartbeat_interval);
                        ws.send(JSON.stringify({ op: "init", encoded_public_key: encodedPub }));
                    } else if (op === "nonce_proof") {
                        const enc = Uint8Array.from(atob(data.encrypted_nonce), c => c.charCodeAt(0));
                        const nonce = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, keyPair.privateKey, enc);
                        const hash = await crypto.subtle.digest("SHA-256", nonce);
                        const proof = btoa(String.fromCharCode(...new Uint8Array(hash)))
                            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
                        ws.send(JSON.stringify({ op: "nonce_proof", proof }));
                    } else if (op === "pending_remote_init") {
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_FINGERPRINT", fingerprint: data.fingerprint }));
                    } else if (op === "pending_login") {
                        if (hbTimer) clearInterval(hbTimer);
                        ws.close(1000);
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        // Send ticket + private key to backend — Python makes the POST with desktop UA
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({
                                type: "REMOTE_AUTH_TICKET",
                                ticket: data.ticket,
                                priv_jwk: JSON.stringify(privJwk)
                            }));
                        return;
                    } else if (op === "cancel") {
                        if (hbTimer) clearInterval(hbTimer);
                        ws.close(1000);
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        if (window.STEAMCORD_WS?.readyState === 1)
                            window.STEAMCORD_WS.send(JSON.stringify({ type: "REMOTE_AUTH_FINGERPRINT", fingerprint: null }));
                        setTimeout(window.steamcordStartRemoteAuth, 3000);
                    }
                };
                ws.onerror = () => {};
                ws.onclose = (e) => {
                    if (hbTimer) clearInterval(hbTimer);
                    if (e.code !== 1000 && e.code !== 1001) {
                        window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                        setTimeout(window.steamcordStartRemoteAuth, 3000);
                    }
                };
            } catch(e) {
                window.STEAMCORD_REMOTE_AUTH_ACTIVE = false;
                setTimeout(window.steamcordStartRemoteAuth, 5000);
            }
        };

        // Our custom remote-auth (Python ticket exchange) triggers Discord's hCaptcha,
        // especially on a flagged IP. In Vesktop we DON'T need it: the native Discord
        // login page shows its own QR, which startCanvasQRMirror() mirrors to the QAM —
        // scanning it logs Vesktop in natively, no ticket exchange, no CAPTCHA. So only
        // run the custom remote-auth in the CEF flow.
        if (!window.STEAMCORD_IS_VESKTOP) {
            Vencord.Webpack.onceReady.then(() => {
                if (!Vencord.Webpack.Common.UserStore.getCurrentUser()) window.steamcordStartRemoteAuth();
            });
            setInterval(() => {
                if (!Vencord.Webpack.Common.UserStore?.getCurrentUser?.() && !window.STEAMCORD_REMOTE_AUTH_ACTIVE)
                    window.steamcordStartRemoteAuth();
            }, 15000);
        }
    }
};

// In Vesktop, Vencord is already initialized and won't auto-start our (late-injected)
// plugin, so start it ourselves once Vencord/Webpack is ready. (In the CEF flow Vencord
// is injected fresh and calls start() itself.)
if (window.STEAMCORD_IS_VESKTOP && !window.__steamcord_started) {
    window.__steamcord_started = true;
    (function waitAndStart() {
        try {
            if (window.Vencord && window.Vencord.Webpack && window.Vencord.Webpack.Common) {
                window.Vencord.Plugins.plugins.Steamcord.start();
                console.log("[Steamcord] started in Vesktop");
                return;
            }
        } catch (e) { console.log("[Steamcord] vesktop start err " + e.message); }
        setTimeout(waitAndStart, 500);
    })();
}