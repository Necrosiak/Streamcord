(() => {
    let waitingForMedia = false;
    // getDisplayMedia NATIF (portail Electron/xdg) capturé AVANT la surcharge, pour
    // pouvoir y revenir en mode BUREAU (cf fallback ci-dessous).
    const md = window.navigator?.mediaDevices;
    // Capturer le VRAI getDisplayMedia natif UNE seule fois, et JAMAIS notre propre
    // override (sinon une ré-injection ferait fallback sur lui-même). On reconnaît
    // le nôtre à sa source, et on mémorise le natif sur window pour les ré-injections.
    const looksLikeOurs = (fn) => { try { return /STEAMCORD_RTC|65124|fallbackNative/.test(fn.toString()); } catch (_) { return false; } };
    if (md && md.getDisplayMedia && !window.STEAMCORD_NATIVE_GDM && !looksLikeOurs(md.getDisplayMedia)) {
        window.STEAMCORD_NATIVE_GDM = md.getDisplayMedia.bind(md);
    }
    const nativeGetDisplayMedia = window.STEAMCORD_NATIVE_GDM || null;

    // Surcharge getDisplayMedia : en GAMEMODE (gamescope, pas de portail), on tire la
    // capture d'écran produite par GStreamer (gst_webrtc.py) via WebRTC local sur
    // 65124. En BUREAU, gst_webrtc n'a aucune source d'écran directe → il renvoie
    // `no_source` (ou rien) → on RETOMBE sur le portail natif, qui marche en bureau.
    const getRTCStream = (constraints) => new Promise((resolve, reject) => {
        if (window.STEAMCORD_RTC_STREAM) return resolve(window.STEAMCORD_RTC_STREAM);
        if (waitingForMedia) return reject();
        waitingForMedia = true;

        let settled = false;
        const peerConnection = new RTCPeerConnection(null);
        const ws = new WebSocket("ws://127.0.0.1:65124/webrtc");
        window.STEAMCORD_PEER_CONNECTION = peerConnection;
        const inbound = new MediaStream();

        // FALLBACK BUREAU → portail natif. Appelé si gst ne fournit aucune source
        // (no_source explicite, timeout sans piste vidéo, ou erreur WS/RTC).
        const fallbackNative = (why) => {
            if (settled) return;
            settled = true;
            waitingForMedia = false;
            try { ws.close(); } catch (_) {}
            try { peerConnection.close(); } catch (_) {}
            console.log("[Steamcord] getDisplayMedia → portail natif (" + why + ")");
            if (nativeGetDisplayMedia) nativeGetDisplayMedia(constraints).then(resolve, reject);
            else reject("pas de getDisplayMedia natif");
        };
        // Si gst ne renvoie aucune piste vidéo sous 4s (= bureau, source absente),
        // on bascule sur le portail natif.
        let fbTimer = setTimeout(() => fallbackNative("timeout gst (aucune source)"), 4000);

        // API moderne (Chrome 144) : ontrack remplace onaddstream.
        peerConnection.ontrack = (ev) => {
            inbound.addTrack(ev.track);
            // Attendre la piste vidéo avant de résoudre (l'audio peut arriver avant).
            if (inbound.getVideoTracks().length === 0) return;
            if (settled) return;
            settled = true;
            clearTimeout(fbTimer);
            window.STEAMCORD_RTC_STREAM = inbound;
            for (const track of inbound.getTracks()) {
                track.stop = () => {
                    try { ws.send(JSON.stringify({ "stop": "" })); } catch (_) {}
                    try { peerConnection.close(); } catch (_) {}
                    window.STEAMCORD_RTC_STREAM = undefined;
                };
            }
            waitingForMedia = false;
            resolve(inbound);
        };

        // Poser le listener ICE AVANT createOffer (sinon candidats précoces perdus).
        peerConnection.addEventListener("icecandidate", (event) => {
            if (event.candidate) { try { ws.send(JSON.stringify({ "ice": event.candidate })); } catch (_) {} }
        });

        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === "failed") {
                clearTimeout(fbTimer);
                fallbackNative("rtc peer connection failed");
            }
        };

        ws.onopen = async () => {
            // recvonly : on REÇOIT la vidéo+audio de GStreamer.
            peerConnection.addTransceiver("video", { direction: "recvonly" });
            peerConnection.addTransceiver("audio", { direction: "recvonly" });
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            ws.send(JSON.stringify({ "offer": offer }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.no_source) {           // gst : pas d'écran capturable (bureau)
                clearTimeout(fbTimer);
                return fallbackNative("gst no_source");
            }
            if (data.sdp) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } else if (data.ice) {
                try { await peerConnection.addIceCandidate(data.ice); } catch (_) {}
            }
        };

        ws.onerror = () => { clearTimeout(fbTimer); fallbackNative("ws error"); };
    });

    if (window.navigator?.mediaDevices) {
        window.navigator.mediaDevices.getDisplayMedia = getRTCStream;
    }
})();
