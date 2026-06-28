(() => {
    let waitingForMedia = false;
    // Surcharge getDisplayMedia : au lieu du picker natif (inutilisable dans un
    // Vesktop minimisé/gamescope), on tire la capture d'écran complète produite
    // par GStreamer (gst_webrtc.py) via WebRTC local sur 65124.
    const getRTCStream = (_) => new Promise((resolve, reject) => {
        if (window.STEAMCORD_RTC_STREAM) return resolve(window.STEAMCORD_RTC_STREAM);
        if (waitingForMedia) return reject();
        waitingForMedia = true;

        const peerConnection = new RTCPeerConnection(null);
        const ws = new WebSocket("ws://127.0.0.1:65124/webrtc");
        window.STEAMCORD_PEER_CONNECTION = peerConnection;

        const inbound = new MediaStream();

        // API moderne (Chrome 144) : ontrack remplace onaddstream (supprimé).
        peerConnection.ontrack = (ev) => {
            inbound.addTrack(ev.track);
            // Attendre la piste vidéo avant de résoudre (l'audio peut arriver avant).
            if (inbound.getVideoTracks().length === 0) return;
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
            if (event.candidate) ws.send(JSON.stringify({ "ice": event.candidate }));
        });

        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === "failed") {
                waitingForMedia = false;
                reject("rtc peer connection failed");
            }
        };

        ws.onopen = async () => {
            // recvonly : on REÇOIT la vidéo+audio de GStreamer (remplace les
            // options obsolètes offerToReceiveVideo/Audio de createOffer).
            peerConnection.addTransceiver("video", { direction: "recvonly" });
            peerConnection.addTransceiver("audio", { direction: "recvonly" });
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            ws.send(JSON.stringify({ "offer": offer }));
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.sdp) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } else if (data.ice) {
                try { await peerConnection.addIceCandidate(data.ice); } catch (_) {}
            }
        };

        ws.onerror = () => { waitingForMedia = false; reject("ws error"); };
    });

    if (window.navigator?.mediaDevices) {
        window.navigator.mediaDevices.getDisplayMedia = getRTCStream;
    }
})();
