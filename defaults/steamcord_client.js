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
        window.old_enumerate_devices = navigator.mediaDevices.enumerateDevices
        navigator.mediaDevices.enumerateDevices = async () => {
            const devices = await window.old_enumerate_devices();
            return devices.filter(f => f.label != "Filter Chain Source" && f.label != "Virtual Source" && !(f.label == "" && f.deviceId == "default"))
        }

        // Camera support (later): when a real webcam is plugged in, set
        // window.STEAMCORD_CAMERA_ENABLED = true and Discord's camera requests
        // (getUserMedia with video) will use the real device instead of the mic relay.
        // Screenshare uses getDisplayMedia (see webrtc_client.js), not this path.
        window.old_get_user_media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
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
                                    FluxDispatcher.dispatch({ type: "AUDIO_SET_LOCAL_VOLUME", userId: data.id, volume: data.volume });
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

                                    // Discord's stream-start module ID changes every update — look it up
                                    // by signature instead of hardcoding it. Fall back to the legacy wreq.
                                    const StreamActions = Vencord.Webpack.find(m =>
                                        m && typeof m.startStream === "function" && typeof m.stopStream === "function");
                                    try {
                                        if (data.stop) {
                                            if (StreamActions?.stopStream) StreamActions.stopStream();
                                            else Vencord.Webpack.wreq(799808).default(null, null, null);
                                            console.log("[Steamcord] Go Live STOP envoyé");
                                        } else {
                                            // Whole-screen only — getDisplayMedia is overridden in
                                            // webrtc_client.js to return the GStreamer full-screen capture,
                                            // so Discord never shows a window/source picker.
                                            if (StreamActions?.startStream) {
                                                StreamActions.startStream(golive_guild_id, golive_channel_id, {
                                                    pid: null,
                                                    sourceId: null,
                                                    sourceName: "Entire Screen",
                                                    guildId: golive_guild_id,
                                                    channelId: golive_channel_id,
                                                    previewDisabled: false,
                                                });
                                            } else {
                                                Vencord.Webpack.wreq(799808).default(golive_guild_id, golive_channel_id, "Activity Panel");
                                            }
                                            console.log("[Steamcord] Go Live START envoyé (écran entier), found StreamActions=" + !!StreamActions);
                                        }
                                    } catch (e) {
                                        console.error("[Steamcord] Go Live échec:", e);
                                    }
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
                                case "$login_token": {
                                    const t = data.token;
                                    if (!t) return;
                                    const lm = Vencord.Webpack.find(m => m && typeof m.loginToken === "function");
                                    if (lm) lm.loginToken(t, true);
                                    else { localStorage.setItem("token", JSON.stringify(t)); location.reload(); }
                                    return;
                                }
                            }
                        } catch (error) {
                            result = { error: error }
                            if (data.increment == undefined) return;
                        }
                        const payload = {
                            type: "$steamcord_request",
                            increment: data.increment,
                            result: result || {}
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
            // A real QR is black & white; Discord's "loading" placeholder in the same
            // 240×240 canvas is a colorful shapes animation. Only mirror an actual QR so
            // the QAM never shows the weird loading image.
            const looksLikeQR = (canvas) => {
                try {
                    const ctx = canvas.getContext("2d");
                    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    let colorful = 0, total = 0;
                    for (let i = 0; i < d.length; i += 4 * 64) {
                        const r = d[i], g = d[i + 1], b = d[i + 2];
                        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colorful++;
                        total++;
                    }
                    return total > 0 && (colorful / total) < 0.12; // QR ≈ pure B/W
                } catch (e) { return true; }
            };
            let lastUrl = null;
            setInterval(() => {
                if (Vencord.Webpack.Common.UserStore?.getCurrentUser?.()) {
                    if (lastUrl !== null) { lastUrl = null; sendQR(null); }
                    return;
                }
                const spinner = document.querySelector('[class*="spinner"]');
                const canvas = Array.from(document.querySelectorAll('canvas')).find(c => c.width === 240 && c.height === 240);
                if (canvas && !spinner && looksLikeQR(canvas)) {
                    const url = canvas.toDataURL('image/png');
                    if (url.length > 5000 && url !== lastUrl) { lastUrl = url; sendQR(url); }
                    return;
                }
                // No real QR yet (loading placeholder) → clear so the QAM shows "loading"
                if (lastUrl !== null) { lastUrl = null; sendQR(null); }
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