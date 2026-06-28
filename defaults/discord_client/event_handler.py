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
            "REMOTE_AUTH_TICKET": self._remote_auth_ticket,
            "STREAM_START": self._stream_start,
            "STREAM_STOP": self._stream_stop,
            "CONNECTION_CLOSED": self._logout,
            "VOICE_STATE_UPDATES": self._voice_state_updates,
            "VOICE_CHANNEL_SELECT": self._voice_channel_select,
            "AUDIO_TOGGLE_SELF_MUTE": self._toggle_mute,
            "AUDIO_TOGGLE_SELF_DEAF": self._toggle_deaf,
            "RPC_NOTIFICATION_CREATE": self._rpc_notification,
            "SPEAKING": self._speaking,
            "$MIC_WEBRTC": self._mic_webrtc,
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
        self.state_changed_event = Event()
        self.notification = None
        self.remote_auth = RemoteAuth()

    def build_state_dict(self):
        return {
            "loaded": self.loaded,
            "logged_in": self.logged_in,
            "me": self.me.to_dict(),
            "vc": self._build_vc_dict(),
            "qr_login": self.remote_auth.qr_b64,
            "captcha_needed": getattr(self, "_captcha_needed", False),
        }

    def _build_vc_dict(self):
        if self.vc_channel_id is None:
            return None

        users = list(self.vc_members.values())
        me = None
        for user in users:
            if user.id == self.me.id:
                me = user
                break

        return {
            "channel_id": self.vc_channel_id,
            "channel_name": self.api._channel_name,
            "guild_name": self.api._guild_name,
            "users": [u.to_dict() for u in users],
        }

    async def toggle_mute(self, act=False):
        self.me.is_muted = not self.me.is_muted
        if act:
            await self.ws.send_json({"type": "AUDIO_TOGGLE_SELF_MUTE", "context": "default", "syncRemote": False})
        self.state_changed_event.set()

    async def toggle_deafen(self, act=False):
        self.me.is_deafened = not self.me.is_deafened
        if act:
            await self.ws.send_json({"type": "AUDIO_TOGGLE_SELF_DEAF", "context": "default"})
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
            await self.state_changed_event.wait()
            self.state_changed_event.clear()
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
        self.me = User({"id": "", "username": "", "discriminator": None, "avatar": ""})
        self.remote_auth.start(self.state_changed_event.set)

    async def _voice_channel_select(self, data):
        self.vc_channel_id = data["channelId"]
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
                u.is_muted = vs.get("mute", False) or vs.get("selfMute", False)
                u.is_deafened = vs.get("deaf", False) or vs.get("selfDeaf", False)
            elif user_id in self.vc_members:
                del self.vc_members[user_id]

    async def _toggle_mute(self, data):
        await self.toggle_mute()

    async def _toggle_deaf(self, data):
        await self.toggle_deafen()

    async def _rpc_notification(self, data):
        self.notification = {"title": data["message"]["embeds"][0]["author"]["name"], "body": data["message"]["embeds"][0]["description"]}

    async def _call_ring(self, data):
        # Incoming DM call → notify. The frontend localizes the title via kind="call".
        self.notification = {"title": "", "body": data.get("caller") or "Discord", "kind": "call"}

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
        # Reflect our own Go Live state in the QAM. Discord emits STREAM_START for
        # any participant; only flip our flag if the stream key is ours.
        stream_key = data.get("streamKey", "") or ""
        if self.me.id and self.me.id in stream_key:
            self.me.is_live = True
        elif not stream_key:
            self.me.is_live = True

    async def _stream_stop(self, data):
        stream_key = data.get("streamKey", "") or ""
        if (self.me.id and self.me.id in stream_key) or not stream_key:
            self.me.is_live = False
