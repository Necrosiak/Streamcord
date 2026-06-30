// Partage d'écran "mode jeu" (caméra virtuelle /dev/video42). Ce module tient
// l'état on/off côté QAM ET fournit un APERÇU LOCAL : on lit la même caméra
// virtuelle "Steamcord Screen" via getUserMedia dans le SharedJSContext, pour
// afficher sous SON propre pseudo ce que les autres voient (auto-contrôle).
// v4l2loopback autorise plusieurs lecteurs → Discord + cet aperçu coexistent.

type Listener = () => void;
const listeners = new Set<Listener>();
let camOn = false;
let previewStream: MediaStream | null = null;

const notify = () => listeners.forEach((l) => l());

export function subscribeScreenCam(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const isScreenCamOn = () => camOn;

export function setScreenCamOn(on: boolean) {
  if (camOn === on) return;
  camOn = on;
  if (!on) stopSelfPreview();
  notify();
}

// Trouve le deviceId de la caméra virtuelle "Steamcord Screen". Les labels sont
// masqués tant qu'aucune permission caméra n'est accordée → on débloque via un
// getUserMedia({video:true}) jetable si besoin, puis on relit la liste.
async function findScreenDeviceId(): Promise<string | null> {
  const match = (ds: MediaDeviceInfo[]) =>
    ds.find((d) => d.kind === "videoinput" && /steamcord screen/i.test(d.label));
  try {
    let devs = await navigator.mediaDevices.enumerateDevices();
    let d = match(devs);
    if (!d) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
        tmp.getTracks().forEach((t) => t.stop());
      } catch { /* permission/refus : on tente quand même la relecture */ }
      devs = await navigator.mediaDevices.enumerateDevices();
      d = match(devs);
    }
    return d ? d.deviceId : null;
  } catch (e) {
    console.error("[Steamcord] enumerate devices (preview) failed", e);
    return null;
  }
}

// Ouvre (ou réutilise) le flux d'aperçu local. null si la caméra virtuelle
// n'est pas trouvée (feeder gst pas encore prêt → l'appelant réessaiera).
export async function startSelfPreview(): Promise<MediaStream | null> {
  if (previewStream && previewStream.getVideoTracks().some((t) => t.readyState === "live")) {
    return previewStream;
  }
  const id = await findScreenDeviceId();
  if (!id) return null;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: id } },
    });
    return previewStream;
  } catch (e) {
    console.error("[Steamcord] self preview getUserMedia failed", e);
    return null;
  }
}

export function stopSelfPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
}
