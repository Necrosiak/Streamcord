import { DialogButton } from "@decky/ui";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaDesktop, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { t } from "../../i18n";

const Btn = DialogButton as any;

export function GoLiveButton() {
  const state = useSteamcordState();

  // Only available while connected to a voice channel
  if (!state?.vc?.channel_name) return null;

  const live = !!state?.me?.is_live;

  return (
    <Btn
      onClick={() => call(live ? "stop_go_live" : "go_live")}
      style={{
        width: "100%", margin: 0, padding: "6px 0", minHeight: 0,
        boxSizing: "border-box",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        fontSize: 12, fontWeight: 600,
        background: live ? "#ed4245" : "rgba(88,101,242,0.35)",
      }}
    >
      {live ? <FaStop /> : <FaDesktop />}
      {live ? t("go_live_stop") : t("go_live_start")}
    </Btn>
  );
}
