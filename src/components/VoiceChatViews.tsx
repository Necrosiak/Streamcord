import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { useSteamcordState } from "../hooks/useSteamcordState";
import { t } from "../i18n";
import { SliderField, DialogButton } from "@decky/ui";

const SliderFieldAny = SliderField as any;
const Btn = DialogButton as any;

export function VoiceChatChannel() {
  const state = useSteamcordState();
  if (!state?.vc) return <div />;
  // DM calls have no guild — the backend sends null and we localize the label.
  return (
    <div style={{ marginBottom: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{state.vc.channel_name || t("private_message")}</span>
      <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 6 }}>{state.vc.guild_name || t("private_message")}</span>
    </div>
  );
}

function UserRow({ user, isSelf }: { user: any; isSelf?: boolean }) {
  const [volume, setVolume] = useState<number>(100);
  // Mute LOCAL : on ne l'entend plus, de NOTRE côté seulement (lui ne le sait pas).
  const [localMuted, setLocalMuted] = useState<boolean>(false);

  const speaking = user?.is_speaking;
  const muted = user?.is_muted;
  const deafened = user?.is_deafened;

  // État initial du mute local (persiste côté Discord) au montage de la ligne.
  // Inutile pour soi-même (on ne se mute pas localement).
  useEffect(() => {
    if (isSelf) return;
    call<[string], boolean>("get_local_mute", user.id)
      .then((r) => setLocalMuted(!!r))
      .catch(() => {});
  }, [user.id, isSelf]);

  const onVolumeChange = async (val: number) => {
    setVolume(val);
    await call("set_user_volume", user.id, val);
  };

  const toggleLocalMute = async () => {
    // Optimiste, puis on aligne sur l'état réel renvoyé par Discord.
    setLocalMuted((m) => !m);
    try {
      const r = await call<[string], boolean>("toggle_local_mute", user.id);
      setLocalMuted(!!r);
    } catch { setLocalMuted((m) => !m); }
  };

  return (
    <li style={{ listStyle: "none", marginBottom: 8, padding: "6px 0", background: "rgba(255,255,255,0.04)", borderRadius: 6, overflow: "hidden", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px" }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <img
            src={user?.avatar
              ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp`
              : `https://cdn.discordapp.com/embed/avatars/0.png`}
            width={28} height={28}
            style={{
              borderRadius: "50%",
              display: "block",
              // Native-Discord-style glowing halo while speaking
              boxShadow: speaking
                ? "0 0 0 2px #23a55a, 0 0 10px 3px rgba(35,165,90,0.75)"
                : "0 0 0 2px transparent",
              transition: "box-shadow 0.08s ease-out",
            }}
          />
          {(muted || deafened) && (
            <div style={{
              position: "absolute", bottom: -1, right: -1,
              background: "#ed4245", borderRadius: "50%",
              width: 12, height: 12,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 8, lineHeight: 1
            }}>
              {deafened ? "🔇" : "🔕"}
            </div>
          )}
        </div>
        <span style={{ flex: 1, fontSize: 12, opacity: muted ? 0.45 : 0.9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {user?.username}
          {user?.is_live && <span style={{ marginLeft: 4, color: "#ed4245", fontSize: 9 }}>● LIVE</span>}
        </span>
        {speaking && (
          <div style={{
            width: 8, height: 8, borderRadius: "50%", background: "#23a55a", flexShrink: 0,
            boxShadow: "0 0 6px 1px rgba(35,165,90,0.8)"
          }} />
        )}
      </div>
      {/* Volume (à quel point TU l'entends) + bouton mute LOCAL à droite. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 4px", boxSizing: "border-box", maxWidth: "100%", overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SliderFieldAny
            label={`🔊 ${volume}%`}
            value={volume}
            min={0}
            max={200}
            step={5}
            onChange={onVolumeChange}
            bottomSeparator="none"
          />
        </div>
        {/* Mute local : pas de sens pour soi-même → masqué sur sa propre ligne. */}
        {!isSelf && (
          <Btn
            onClick={toggleLocalMute}
            style={{
              flexShrink: 0, minWidth: 0, minHeight: 0, padding: "4px 8px", fontSize: 14, lineHeight: 1,
              background: localMuted ? "#ed4245" : "rgba(255,255,255,0.08)",
            }}
          >
            {localMuted ? "🔇" : "🎙️"}
          </Btn>
        )}
      </div>
    </li>
  );
}

export function VoiceChatMembers() {
  const state = useSteamcordState();
  if (!state?.vc?.users) return <div />;
  const meId = state?.me?.id;
  return (
    <ul style={{ margin: 0, padding: 0 }}>
      {state.vc.users.map((user: any) => (
        <UserRow key={user.id} user={user} isSelf={user.id === meId} />
      ))}
    </ul>
  );
}
