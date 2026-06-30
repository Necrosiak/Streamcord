from discord_client.remote_auth import RemoteAuth
from discord_client.store_access import StoreAccess, User
from aiohttp.web import WebSocketResponse  # type: ignore
from asyncio import Task, create_task, Event
from json import loads
from aiohttp import WSMsgType  # type: ignore
from decky import emit  # type: ignore
import logging


logger = logging.getLogger(__name__)


class EventHandler:
    def __init__(self) -> None:
        self.event_handlers = {
            "LOADED": self._loaded,
            "CONNECTION_OPEN": self._logged_in,
            "REMOTE_AUTH_FINGERPRINT": self._remote_auth_fingerprint,
            "REMOTE_AUTH_QR_SVG": self._remote_auth_qr_svg,
            "REMOTE_AUTH_SCANNED": self._remote_auth_scanned,
            "REMOTE_AUTH_TICKET": self._remote_auth_ticket,
            "STREAM_START": self._stream_start,
            "STREAM_STOP": self._stream_stop,
            "CONNECTION_CLOSED": self._logout,
            "LOGOUT": self._logout,
            "VOICE_STATE_UPDATES": self._voice_state_updates,
            "VOICE_CHANNEL_SELECT": self._voice_channel_select,
            "AUDIO_TOGGLE_SELF_MUTE": self._toggle_mute,
            "AUDIO_TOGGLE_SELF_DEAF": self._toggle_deaf,
            "RPC_NOTIFICATION_CREATE": self._rpc_notification,
            "SPEAKING": self._speaking,
            "$MIC_WEBRTC": self._mic_webrtc,
            "$VIDEO_WEBRTC": self._video_webrtc,
            "CALL_RING": self._call_ring,
        }
        self.loaded = False
        self.logged_in = False
        self.me = User({"id": "", "username": "", "discriminator": None, "avatar": ""})
        self.api = StoreAccess()
        self.ws = None
        self.vc_channel_id = None
        self.api._channel_name = None
        self.api._guild_name = None
        self.vc_members = {}
        # IDs des participants qui partagent (Go Live). Découplé de vc_members pour
        # éviter une race : STREAM_START peut arriver avant que la liste vocale soit
        # peuplée (ou les membres sont reconstruits à chaque VOICE_STATE_UPDATES).
        self.streaming_users = set()
        self._qr_scanned = False  # QR scanné, en attente de validation sur le téléphone
        self.state_changed_event = Event()
        self.notification = None
        # Event DÉDIÉ aux notifications. Avant, yield_notification attendait/clear()
        # le MÊME state_changed_event que yield_new_state → sous events rapprochés
        # (arrivée d'un participant : VOICE_CHANNEL_SELECT + VOICE_STATE_UPDATES +
        # reconcile en rafale) un consommateur clear() l'event posé pour l'autre →
        # une mise à jour d'ÉTAT était AVALÉE (le frontend restait figé sur le mute
        # transitoire du début). Découplé : state_changed_event n'a plus qu'UN seul
        # consommateur (yield_new_state).
        self.notification_event = Event()
        self.remote_auth = RemoteAuth()

    def build_state_dict(self):
        return {
            "loaded": self.loaded,
            "logged_in": self.logged_in,
            "me": self.me.to_dict(),
            "vc": self._build_vc_dict(),
            "qr_login": self.remote_auth.qr_b64,
            "qr_scanned": self._qr_scanned,
            "captcha_needed": getattr(self, "_captcha_needed", False),
        }

    def _build_vc_dict(self):
        if self.vc_channel_id is None:
            return None

        users = list(self.vc_members.values())
        # Garantir que SOI est toujours présent dans la liste affichée. self est
        # ignoré dans _voice_state_updates (présence multi-appareils) ET dans la
        # réconciliation → un rebuild mal timé pouvait l'omettre → l'utilisateur ne
        # se voyait pas alors qu'il est en vocal. On l'injecte en tête si absent.
        if self.me.id and not any(u.id == self.me.id for u in users):
            users = [self.me] + users
        # Reflète l'état de partage courant indépendamment de l'ordre des events.
        for user in users:
            user.is_live = user.id in self.streaming_users

        return {
            "channel_id": self.vc_channel_id,
            "channel_name": self.api._channel_name,
            "guild_name": self.api._guild_name,
            "users": [u.to_dict() for u in users],
        }

    async def toggle_mute(self, act=False):
        if act:
            # ON N'ENVOIE QUE LA COMMANDE — surtout PAS de lecture ni de push ici.
            # Discord ré-émet TOUJOURS AUDIO_TOGGLE_SELF_MUTE en écho (prouvé via
            # CDP) → `_toggle_mute` met à jour depuis la VÉRITÉ et pousse l'état =
            # SOURCE UNIQUE. Si on pousse EN PLUS ici, on émet un 2e état : soit
            # optimiste aveugle (base périmée), soit un get_media() racé (le toggle
            # n'est pas encore appliqué quand on lit) → valeur ≠ écho → le bouton
            # « clignote » (part et revient). Un seul push (l'écho, settled) = zéro
            # flicker.
            await self.ws.send_json({"type": "AUDIO_TOGGLE_SELF_MUTE", "context": "default", "syncRemote": False})
            return
        self.me.is_muted = not self.me.is_muted
        self.state_changed_event.set()

    async def toggle_deafen(self, act=False):
        if act:
            # Idem mute : l'écho AUDIO_TOGGLE_SELF_DEAF (_toggle_deaf) est la source
            # unique. On n'envoie que la commande pour ne pas pousser un 2e état.
            await self.ws.send_json({"type": "AUDIO_TOGGLE_SELF_DEAF", "context": "default"})
            return
        self.me.is_deafened = not self.me.is_deafened
        self.state_changed_event.set()

    async def disconnect_vc(self):
        await self.ws.send_json({"type": "VOICE_CHANNEL_SELECT", "channelId": None, "guildId": None})

    async def yield_new_state(self):
        while True:
            await self.state_changed_event.wait()
            self.state_changed_event.clear()
            yield self.build_state_dict()

    async def yield_notification(self):
        while True:
            await self.notification_event.wait()
            self.notification_event.clear()
            if self.notification:
                yield self.notification
                self.notification = None

    async def main(self, ws):
        logger.info("Received WS Connection. Starting event processing loop")
        self.ws = ws
        self.api.ws = ws
        async for msg in self.ws:
            if msg.type == WSMsgType.TEXT:
                self._process_event(loads(msg.data))
            elif msg.type == WSMsgType.ERROR:
                print('ws connection closed with exception %s' % self.ws.exception())

    def _process_event(self, data):
        if data["type"] == "$ping":
            return
        if data["type"] == "$diag":
            logger.info(f"[clientdiag] {data.get('m')}")
            return
        if data["type"] == "$steamcord_request" and "increment" in data:
            self.api._set_result(data["increment"], data["result"])
            return
        if data["type"] in self.event_handlers:
            callback = self.event_handlers[data["type"]]
            logger.info(f"Handling event: {data['type']}")
            #print(dumps(data, indent=2)+"\n\n")
        else:
            return
        def _(future: Task):
            self.state_changed_event.set()
            e = future.exception()
            if e:
                print(f"Exception during handling of {data['type']} event.   {e}")

        create_task(callback(data)).add_done_callback(_)

    async def _loaded(self, data):
        self.loaded = True
        if not self.logged_in:
            self.remote_auth.start(self.state_changed_event.set)

    async def _logged_in(self, data):
        self.logged_in = True
        self._qr_scanned = False
        self.remote_auth.stop()
        self._login_tab_visible = False
        user_data = data.get("user") if isinstance(data, dict) else None
        if not user_data or not user_data.get("id"):
            return
        self.me = User(user_data)
        s = await self.api.get_media()
        self.me.is_muted = s["mute"]
        self.me.is_deafened = s["deaf"]
        self.me.is_live = s["live"]

    async def _logout(self, data):
        self.logged_in = False
        self._qr_scanned = False
        self.me = User({"id": "", "username": "", "discriminator": None, "avatar": ""})
        # Purger l'état d'appel pour ne pas laisser un faux « en vocal » au QAM.
        self.vc_channel_id = None
        self.vc_members = {}
        self.streaming_users = set()
        self.remote_auth.start(self.state_changed_event.set)

    async def _voice_channel_select(self, data):
        new_id = data["channelId"]
        # Re-sélection du MÊME salon (events VOICE_CHANNEL_SELECT dupliqués : poll
        # client toutes les 2s + dispatch Discord natif + re-handshake) → NE PAS
        # reconstruire vc_members. Le rebuild via get_voice_states peut renvoyer []
        # transitoirement (store pas prêt pendant une reconnexion) → la liste était
        # VIDÉE → le participant disparaissait (ou réapparaissait greyé). La
        # réconciliation 2s maintient déjà l'état à jour ; on ne rebuild qu'au VRAI
        # changement de salon (ou si la liste a été perdue).
        if new_id is not None and new_id == self.vc_channel_id and self.vc_members:
            return
        self.vc_channel_id = new_id
        if self.vc_channel_id is None:
            self.vc_members = {}
            self.api._channel_name = None
            self.api._guild_name = None
            return

        channel = await self.api.get_channel(self.vc_channel_id)
        if not isinstance(channel, dict):
            channel = {}
        guild_id = channel.get("guild_id")

        if guild_id:
            # Guild voice channel
            self.api._channel_name = channel.get("name") or "Salon vocal"
            guild = await self.api.get_guild(guild_id)
            self.api._guild_name = guild.get("name") if isinstance(guild, dict) else None
        else:
            # DM (type 1) or Group DM (type 3) — no guild
            name = channel.get("name")
            if not name:
                # 1:1 DM: derive the name from the recipient
                recips = channel.get("rawRecipients") or channel.get("recipients") or []
                if recips:
                    r0 = recips[0]
                    if isinstance(r0, dict):
                        name = r0.get("global_name") or r0.get("username")
                    elif isinstance(r0, str):
                        u = await self.api.get_user(r0)
                        name = u.get("username") if isinstance(u, dict) else None
            # Leave names neutral — the frontend localizes the "private message"
            # label so it follows the SteamOS language.
            self.api._channel_name = name or None
            self.api._guild_name = None

        # Load existing members already in the channel
        self.vc_members = {}
        try:
            voice_states = await self.api.get_voice_states(self.vc_channel_id)
            if isinstance(voice_states, list):
                for vs in voice_states:
                    user_id = vs.get("userId")
                    if not user_id:
                        continue
                    user = User({"id": user_id, "username": "", "discriminator": None, "avatar": ""})
                    user.is_muted = vs.get("mute", False)
                    user.is_deafened = vs.get("deaf", False)
                    user.is_video = vs.get("video", False)
                    await user.populate(self.api)
                    self.vc_members[user_id] = user
        except Exception as e:
            logger.error(f"Failed to load voice states: {e}")

    async def _voice_state_updates(self, data):
        for vs in data.get("voiceStates", []):
            user_id = vs["userId"]
            channel_id = vs.get("channelId")

            # Skip our OWN voice state here: VOICE_STATE_UPDATES reflects ACCOUNT-level
            # presence, so it also reports voice connections on OTHER devices (PC, phone).
            # Reconciling from it made the BC show "in call" while we were actually
            # connected elsewhere. The JS poller tracks the LOCAL connection via
            # SelectedChannelStore.getVoiceChannelId() and emits VOICE_CHANNEL_SELECT —
            # that is the single source of truth for "in call on THIS machine".
            if user_id == self.me.id:
                continue

            if channel_id == self.vc_channel_id:
                if user_id not in self.vc_members:
                    user = User({"id": user_id, "username": "", "discriminator": None, "avatar": ""})
                    await user.populate(self.api)
                    self.vc_members[user_id] = user
                u = self.vc_members[user_id]
                # Lecture défensive multi-casse (camelCase store / snake_case gateway)
                # pour ne jamais rester coincé sur un faux « muet ».
                def _flag(*keys):
                    return any(vs.get(k) for k in keys)
                new_mute = _flag("mute", "selfMute", "self_mute")
                new_deaf = _flag("deaf", "selfDeaf", "self_deaf")
                new_video = _flag("video", "selfVideo", "self_video")
                u.is_muted = new_mute
                u.is_deafened = new_deaf
                u.is_video = new_video
            elif user_id in self.vc_members:
                del self.vc_members[user_id]

    # Échos de Discord (AUDIO_TOGGLE_SELF_MUTE/DEAF). Ces events arrivent AUSSI quand
    # c'est NOUS qui avons déclenché le toggle (Discord ré-émet l'event qu'on lui a
    # envoyé) → re-toggler ici annulait notre action (« ça se démute direct »). On LIT
    # l'état réel et on le FIXE (idempotent) : marche pour nos toggles ET les externes.
    async def _toggle_mute(self, data):
        s = await self.api.get_media()
        self.me.is_muted = s["mute"]
        self.me.is_deafened = s["deaf"]

    async def _toggle_deaf(self, data):
        s = await self.api.get_media()
        self.me.is_muted = s["mute"]
        self.me.is_deafened = s["deaf"]

    async def _rpc_notification(self, data):
        self.notification = {"title": data["message"]["embeds"][0]["author"]["name"], "body": data["message"]["embeds"][0]["description"]}
        self.notification_event.set()

    async def _call_ring(self, data):
        # Incoming DM call → notify. The frontend localizes the title via kind="call".
        self.notification = {"title": "", "body": data.get("caller") or "Discord", "kind": "call"}
        self.notification_event.set()

    async def _mic_webrtc(self, data):
        # Relay the Discord tab's mic offer/ICE to the SharedJSContext frontend,
        # which captures the REAL microphone and answers. No handler existed before
        # — the offer was silently dropped, so the mic peer connection stayed in
        # "new" and others could never hear the user.
        payload = {}
        if "offer" in data:
            payload["offer"] = data["offer"]
        if "ice" in data:
            payload["ice"] = data["ice"]
        if payload:
            await emit("webrtc", payload)

    async def _video_webrtc(self, data):
        # Reverse video relay: the Discord tab offers a remote participant's video
        # stream; forward the offer/ICE to the QAM frontend, which answers and renders
        # it in that user's block. Correlated by userId.
        payload = {"userId": data.get("userId")}
        if "offer" in data:
            payload["offer"] = data["offer"]
        if "ice" in data:
            payload["ice"] = data["ice"]
        await emit("video_webrtc", payload)

    async def _speaking(self, data):
        user_id = data.get("userId") or data.get("user_id")
        speaking = data.get("speakingFlags", 0) > 0
        if user_id == self.me.id:
            self.me.is_speaking = speaking
        elif user_id in self.vc_members:
            self.vc_members[user_id].is_speaking = speaking

    async def _remote_auth_fingerprint(self, data):
        fingerprint = data.get("fingerprint")
        if fingerprint:
            from discord_client.remote_auth import _make_qr_b64
            self.remote_auth.qr_b64 = _make_qr_b64(f"https://discord.com/ra/{fingerprint}")
        else:
            self.remote_auth.qr_b64 = None

    async def _remote_auth_qr_svg(self, data):
        self.remote_auth.qr_b64 = data.get("svg_b64")
        if data.get("svg_b64"):
            self._qr_scanned = False  # un QR visible = pas encore scanné

    async def _remote_auth_scanned(self, data):
        # QR scanné → Discord attend la validation sur le téléphone.
        self._qr_scanned = bool(data.get("scanned"))

    async def _remote_auth_ticket(self, data):
        from discord_client.remote_auth import exchange_ticket
        ticket = data.get("ticket")
        priv_jwk = data.get("priv_jwk")
        if not ticket or not priv_jwk:
            return
        token, captcha = await exchange_ticket(ticket, priv_jwk)
        if token:
            self._captcha_needed = False
            await self.ws.send_json({"type": "$login_token", "token": token})
        else:
            self.remote_auth.qr_b64 = None
            if captcha:
                self._captcha_needed = True

    async def _stream_start(self, data):
        # Reflect Go Live state in the QAM. Discord emits STREAM_START for any
        # participant; the streamer is the last segment of the stream key
        # (call:channelId:ownerId / guild:guildId:channelId:ownerId).
        stream_key = data.get("streamKey", "") or ""
        owner_id = stream_key.split(":")[-1] if stream_key else None
        if owner_id:
            self.streaming_users.add(owner_id)
        if (self.me.id and self.me.id in stream_key) or not stream_key:
            self.me.is_live = True

    async def _stream_stop(self, data):
        stream_key = data.get("streamKey", "") or ""
        owner_id = stream_key.split(":")[-1] if stream_key else None
        if owner_id:
            self.streaming_users.discard(owner_id)
        if (self.me.id and self.me.id in stream_key) or not stream_key:
            self.me.is_live = False
