import { DialogButton } from "@decky/ui";
import { useState } from "react";
import { useSteamcordState } from "../../hooks/useSteamcordState";
import { FaGamepad, FaStop } from "react-icons/fa";
import { call } from "@decky/api";
import { t } from "../../i18n";
import { setScreenCamOn } from "../../screenCam";

const Btn = DialogButton as any;

// Partage d'écran en MODE JEU : gamescope n'a pas de portail → Go Live = écran noir.
// On capture le node PipeWire gamescope → webcam virtuelle (/dev/video42), utilisée
// comme caméra Discord. Voir gst_camera.py + start_screen_camera (backend).
export function ScreenCameraButton() {
  const state = useSteamcordState();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // Focus géré nous-mêmes (cf GoLiveButton) : texte blanc forcé + halo, sinon le
  // focus natif rend le texte illisible.
  const [focused, setFocused] = useState(false);

  // Disponible seulement en vocal.
  if (!state?.vc?.channel_name) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) { await call("stop_screen_camera"); setOn(false); setScreenCamOn(false); }
      else { await call("start_screen_camera"); setOn(true); setScreenCamOn(true); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Btn
      onClick={toggle}
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
        background: on ? "#ed4245" : (focused ? "rgba(88,101,242,0.85)" : "rgba(88,101,242,0.35)"),
        boxShadow: focused ? "inset 0 0 0 2px #fff" : "none",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {on ? <FaStop /> : <FaGamepad />}
      {on ? t("screen_cam_stop") : t("screen_cam_start")}
    </Btn>
  );
}
