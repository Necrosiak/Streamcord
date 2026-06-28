import { call } from "@decky/api";
import { DialogButton } from "@decky/ui";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { currentTextChannel, onTextChannelChange } from "./TextChat";

declare const SteamClient: any;

function urlContentToDataUri(url: string) {
  return fetch(url)
    .then((response) => response.blob())
    .then(
      (blob) =>
        new Promise((callback) => {
          let reader = new FileReader();
          reader.onload = function () {
            callback(this.result);
          };
          reader.readAsDataURL(blob);
        })
    );
}

// Partage de capture : envoie la dernière capture Steam vers la conversation
// texte ACTUELLEMENT ouverte (currentTextChannel). Plus de sélecteur de salon —
// la cible suit le salon où on est.
export function UploadScreenshot() {
  const [screenshot, setScreenshot] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [target, setTarget] = useState(currentTextChannel);

  useEffect(() => {
    const unsub = onTextChannelChange(() => { setTarget(currentTextChannel); setSent(false); });
    setTarget(currentTextChannel);
    SteamClient.Screenshots.GetLastScreenshotTaken().then((res: any) => setScreenshot(res));
    return unsub;
  }, []);

  // Rien à partager → on n'affiche rien.
  if (!screenshot?.strUrl) return null;

  return (
    <div>
      <hr />
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.8 }}>
        📷 {t("share_screenshot")}
      </div>
      <img
        width={240}
        height={160}
        style={{ borderRadius: 6, display: "block", maxWidth: "100%" }}
        src={"https://steamloopback.host/" + screenshot.strUrl}
      />
      {target ? (
        <>
          <div style={{ fontSize: 11, opacity: 0.7, margin: "5px 0" }}>
            → {target.dm ? target.name : "#" + target.name}
          </div>
          <DialogButton
            style={{ width: "100%", padding: "5px 0", fontSize: 12, minHeight: 0 }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const data = await urlContentToDataUri(`https://steamloopback.host/${screenshot.strUrl}`);
              await call("post_screenshot", target.id, data);
              setBusy(false);
              setSent(true);
            }}
          >
            {busy ? "…" : sent ? "✓ " + t("upload") : t("upload")}
          </DialogButton>
        </>
      ) : (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 5 }}>{t("screenshot_open_channel")}</div>
      )}
    </div>
  );
}
