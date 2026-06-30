import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaDesktop, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { t } from "../../i18n";

const Btn = DialogButton as any;

export function GoLiveButton() {
  const state = useSteamcordState();
  // Focus géré nous-mêmes : le focus natif du DialogButton met un fond clair +
  // texte sombre → texte illisible/disparu. On force le texte blanc + un simple
  // halo (anneau blanc), fond inchangé.
  const [focused, setFocused] = useState(false);

  // Only available while connected to a voice channel
  if (!state?.vc?.channel_name) return null;

  const live = !!state?.me?.is_live;

  return (
    <Btn
      onClick={() => call(live ? "stop_go_live" : "go_live")}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        width: "100%", margin: 0, padding: "6px 0", minHeight: 0,
        boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        fontSize: 12, fontWeight: 600,
        color: "#fff",
        background: live ? "#ed4245" : (focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)"),
        boxShadow: focused ? "inset 0 0 0 2px #fff" : "none",
      }}
    >
      {live ? <FaStop /> : <FaDesktop />}
      {live ? t("go_live_stop") : t("go_live_start")}
    </Btn>
  );
}
