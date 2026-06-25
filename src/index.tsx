import {
  definePlugin,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  Router,
  sleep,
  Focusable,
  DialogButton,
  Toggle,
  ToggleField,
  SliderField,
  Dropdown,
  findModuleExport,
} from "@decky/ui";
import { Component, Suspense, useState, useEffect } from "react";
import { FaDiscord } from "react-icons/fa";

class ContentErrorBoundary extends Component<{ children: any }, { hasError: boolean; msg: string }> {
  state = { hasError: false, msg: "" };
  static getDerivedStateFromError(e: any) {
    return { hasError: true, msg: e?.message ?? String(e) };
  }
  componentDidCatch(e: any, info: any) {
    console.error("[Streamcord] QAM render error:", e, info);
  }
  render() {
    if (this.state.hasError)
      return <div style={{ padding: 8, color: "#ff6b6b", fontSize: 13 }}>⚠ Streamcord render error — check webhelper_js.txt<br />{this.state.msg}</div>;
    return this.props.children;
  }
}

import { patchMenu } from "./patches/menuPatch";
import { DiscordTab } from "./components/DiscordTab";
import {
  useStreamcordState,
  isLoaded,
  isLoggedIn,
} from "./hooks/useStreamcordState";

import { MuteButton } from "./components/buttons/MuteButton";
import { DeafenButton } from "./components/buttons/DeafenButton";
import { DisconnectButton } from "./components/buttons/DisconnectButton";
import { PushToTalkButton } from "./components/buttons/PushToTalk";
import {
  VoiceChatChannel,
  VoiceChatMembers,
} from "./components/VoiceChatViews";
import { UploadScreenshot } from "./components/UploadScreenshot";
import { GoLiveButton } from "./components/buttons/GoLiveButton";
import { ChannelBrowser } from "./components/ChannelBrowser";
import { DMBrowser } from "./components/DMBrowser";
import { TextChat } from "./components/TextChat";
import { t } from "./i18n";
import {
  call,
  toaster,
  addEventListener,
  removeEventListener,
  routerHook,
} from "@decky/api";

declare global {
  interface Window {
    DISCORD_TAB: any;
    STREAMCORD: {
      dispatchNotification: any;
      MIC_PEER_CONNECTION: any;
    };
  }
}

// Safe wrappers for @decky/ui components that may be undefined after a Steam update
const SP = PanelSection || ((p: any) => <div>{p.children}</div>);
const SR = PanelSectionRow || ((p: any) => <div>{p.children}</div>);
const SF = (p: any) => <div style={p.style}>{p.children}</div>;

const NotLoggedIn = ({ qr_login, captcha_needed }: { qr_login?: string; captcha_needed?: boolean }) => {
  if (captcha_needed) { call("show_discord_login").catch(() => {}); }
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "8px 15px" }}>
      <h2 style={{ marginBottom: 4 }}>{t("not_connected")}</h2>
      {qr_login ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 12, opacity: 0.8, margin: "4px 0 8px" }}>
            {t("qr_scan")}
          </p>
          <img src={qr_login} style={{ width: 160, height: 160, borderRadius: 8, background: "#fff", padding: 4 }} />
          <p style={{ fontSize: 11, opacity: 0.55, margin: "8px 0 0", lineHeight: 1.4 }}>
            {t("qr_explain")}
          </p>
        </div>
      ) : (
        <p style={{ fontSize: 12, opacity: 0.6 }}>{t("qr_loading")}</p>
      )}
      {captcha_needed && (
        <p style={{ fontSize: 12, color: "#ffcc44", margin: "4px 0" }}>
          {t("captcha_needed")}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <DialogButton onClick={async () => { await call("show_discord_login"); }} style={{ fontSize: 13 }}>
          {t("login_fullscreen")}
        </DialogButton>
        <p style={{ fontSize: 10, opacity: 0.5, margin: "4px 2px 0", lineHeight: 1.35 }}>
          {t("login_fullscreen_explain")}
        </p>
      </div>
      <div style={{ marginTop: 8 }}>
        <DialogButton onClick={async () => { await call("hide_discord_login"); }} style={{ fontSize: 12 }}>
          {t("close_discord")}
        </DialogButton>
      </div>
    </div>
  );
};

const BtnTab = DialogButton as any;

const STATUSES: { id: string; emoji: string; color: string }[] = [
  { id: "online", emoji: "🟢", color: "#23a55a" },
  { id: "idle", emoji: "🌙", color: "#f0b232" },
  { id: "dnd", emoji: "⛔", color: "#f23f43" },
  { id: "invisible", emoji: "⚪", color: "#80848e" },
];

// Map Steam persona state → Discord status (Steam: 0 offline,1 online,2 busy,3 away,4 snooze,7 invisible)
const steamToDiscord = (s: number): string =>
  ({ 1: "online", 2: "dnd", 3: "idle", 4: "idle", 7: "invisible", 0: "invisible" } as any)[s] || "online";

// ── Sync de statut Steam→Discord ───────────────────────────────────────────
// Tourne en TÂCHE DE FOND au niveau plugin (démarrée dans definePlugin), donc
// indépendante de l'ouverture du QAM. Le flag "auto" est persisté ; un pub-sub
// minimal reflète dans l'UI le statut posé par le poll.

const STATUS_AUTO_KEY = "streamcord_status_auto";
const getAutoSync = (): boolean => {
  try { return localStorage.getItem(STATUS_AUTO_KEY) !== "0"; } catch { return true; } // défaut ON
};
const setAutoSync = (v: boolean) => {
  try { localStorage.setItem(STATUS_AUTO_KEY, v ? "1" : "0"); } catch { }
};

// Lit le persona Steam local effectif (EPersonaState). Voir readSteam d'origine :
// le vrai store est m_FriendsUIFriendStore (les anciens chemins renvoyaient undefined).
const readSteamPersona = (): number | null => {
  try {
    const uifs: any = (window as any).friendStore?.m_FriendsUIFriendStore;
    const st = uifs?.m_eUserPersonaState ?? uifs?.GetPersonaStatePreference?.();
    return typeof st === "number" ? st : null;
  } catch { return null; }
};

let currentDiscordStatus = "online";
const statusListeners = new Set<(s: string) => void>();
const applyDiscordStatus = async (id: string) => {
  currentDiscordStatus = id;
  statusListeners.forEach((fn) => { try { fn(id); } catch { } });
  try { await call("set_discord_status", id); } catch (e) { console.error("[Streamcord] set_discord_status", e); }
};

let _statusLastSteam: number | null = null;
let _statusTimer: any = null;
const startStatusSync = () => {
  if (_statusTimer) return;
  // Seed le statut Discord courant pour l'UI + comparaison.
  call<[], any>("get_discord_status")
    .then((r) => { if (r?.status) { currentDiscordStatus = r.status; statusListeners.forEach((fn) => fn(r.status)); } })
    .catch(() => { });
  const tick = () => {
    if (!getAutoSync()) return; // manuel → le poll n'écrase rien
    const s = readSteamPersona();
    if (s !== null && s !== _statusLastSteam) {
      _statusLastSteam = s;
      const disc = steamToDiscord(s);
      if (disc !== currentDiscordStatus) {
        console.log("[Streamcord] auto: Steam persona " + s + " → Discord " + disc);
        applyDiscordStatus(disc);
      }
    }
  };
  tick();
  _statusTimer = setInterval(tick, 5000);
};
const stopStatusSync = () => { if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; } };

const StatusSelector = () => {
  const [current, setCurrent] = useState<string>(currentDiscordStatus);
  const [auto, setAutoState] = useState<boolean>(getAutoSync());
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    // Reflète le statut posé par le poll de fond.
    const fn = (s: string) => setCurrent(s);
    statusListeners.add(fn);
    setCurrent(currentDiscordStatus);
    return () => { statusListeners.delete(fn); };
  }, []);

  const pickStatus = async (id: string) => {
    // Sélection manuelle = prise de contrôle → coupe l'auto pour ne pas être réécrasé.
    if (auto) { setAutoSync(false); setAutoState(false); }
    setCurrent(id);
    await applyDiscordStatus(id);
  };

  const toggleAuto = (v: boolean) => {
    setAutoSync(v);
    setAutoState(v);
    if (v) {
      // Réactivation → resync immédiat sur l'état Steam courant.
      _statusLastSteam = null;
      const s = readSteamPersona();
      if (s !== null) {
        _statusLastSteam = s;
        const disc = steamToDiscord(s);
        setCurrent(disc);
        applyDiscordStatus(disc);
      }
    }
  };

  return (
    <>
      <SR>
        <ToggleField
          label={t("follow_steam_status")}
          checked={auto}
          onChange={toggleAuto}
          bottomSeparator="none"
        />
      </SR>
      <SR>
        {/* Focusable + flow-children="horizontal" : la rangée devient UN seul arrêt
            de navigation verticale (D-pad bas sort vers le reste du panneau) tandis
            que gauche/droite circule entre les boutons. Un <div> flex de boutons
            bruts piège le focus en horizontal (impossible de descendre). */}
        <Focusable
          style={{ display: "flex", gap: 6, justifyContent: "center" }}
          flow-children="horizontal"
        >
          {STATUSES.map((s) => {
            const selected = current === s.id;
            const isFocused = focused === s.id;
            return (
              <BtnTab
                key={s.id}
                onClick={() => pickStatus(s.id)}
                onFocus={() => setFocused(s.id)}
                onBlur={() => setFocused((f) => (f === s.id ? null : f))}
                style={{
              flex: "1 1 0", minWidth: 0, margin: 0, padding: "4px 0", fontSize: 16, minHeight: 0,
              boxSizing: "border-box",
              // Fond couleur plein = statut ACTIF ; sinon estompé.
              background: selected ? s.color : "rgba(255,255,255,0.06)",
              opacity: selected ? 1 : 0.5,
              // Bordure blanche permanente sur l'actif (lisible sans focus).
              border: selected ? "2px solid #fff" : "2px solid transparent",
              // Anneau blanc + agrandissement = CURSEUR manette (focus).
              boxShadow: isFocused ? "0 0 0 3px #fff, 0 0 10px 2px " + s.color : "none",
              transform: isFocused ? "scale(1.12)" : "scale(1)",
              transition: "transform .08s ease, box-shadow .08s ease, opacity .08s ease",
              zIndex: isFocused ? 1 : 0,
            }}
          >
            {s.emoji}
          </BtnTab>
        );
      })}
        </Focusable>
      </SR>
    </>
  );
};

const Content = () => {
  const state = useStreamcordState();
  const [voiceTab, setVoiceTab] = useState<"servers" | "dms">("servers");
  const [tabFocus, setTabFocus] = useState<string | null>(null);
  if (!state?.loaded) {
    return (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <h2>{t("initializing")}</h2>
      </div>
    );
  } else if (!state?.logged_in) {
    return <NotLoggedIn qr_login={state?.qr_login} captcha_needed={state?.captcha_needed} />;
  } else {
    return (
      <SP>
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <SF style={{ display: "flex", justifyContent: "center" }}>
              <MuteButton />
              <DeafenButton />
              <DisconnectButton />
            </SF>
          </SR>
        </div>
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <PushToTalkButton />
            </div>
          </SR>
        </div>
        <hr></hr>
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <img
                src={
                  "https://cdn.discordapp.com/avatars/" +
                  state?.me?.id +
                  "/" +
                  state?.me?.avatar +
                  ".webp"
                }
                width={32}
                height={32}
                style={{ display: "block", borderRadius: "50%" }}
              />
              {state?.me?.username}
            </span>
          </SR>
        </div>
        <div style={{ marginBottom: "12px" }}>
          <StatusSelector />
        </div>
        <div style={{ marginBottom: "12px" }}>
          <SR>
            {state?.vc?.channel_id ? (
              <>
                <VoiceChatChannel />
                <VoiceChatMembers />
                <div style={{ marginTop: 8 }}>
                  <GoLiveButton />
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", gap: 4, marginBottom: 6, width: "100%", boxSizing: "border-box" }}>
                  <BtnTab
                    onClick={() => setVoiceTab("servers")}
                    onFocus={() => setTabFocus("servers")}
                    onBlur={() => setTabFocus((f) => (f === "servers" ? null : f))}
                    style={{
                      flex: "1 1 0", minWidth: 0, margin: 0, padding: "3px 0",
                      fontSize: 11, minHeight: 0, boxSizing: "border-box",
                      // Texte blanc forcé : sinon le focus natif du DialogButton
                      // met un fond clair + texte sombre = illisible. On pilote
                      // nous-mêmes le fond de focus (bleu Discord vif + anneau).
                      color: "#fff",
                      background: tabFocus === "servers"
                        ? "rgba(88,101,242,0.85)"
                        : voiceTab === "servers" ? "rgba(88,101,242,0.35)" : "rgba(255,255,255,0.06)",
                      boxShadow: tabFocus === "servers" ? "0 0 0 2px #fff" : "none",
                      fontWeight: voiceTab === "servers" ? 700 : 400,
                    }}
                  >
                    🔊 {t("tab_servers")}
                  </BtnTab>
                  <BtnTab
                    onClick={() => setVoiceTab("dms")}
                    onFocus={() => setTabFocus("dms")}
                    onBlur={() => setTabFocus((f) => (f === "dms" ? null : f))}
                    style={{
                      flex: "1 1 0", minWidth: 0, margin: 0, padding: "3px 0",
                      fontSize: 11, minHeight: 0, boxSizing: "border-box",
                      color: "#fff",
                      background: tabFocus === "dms"
                        ? "rgba(88,101,242,0.85)"
                        : voiceTab === "dms" ? "rgba(88,101,242,0.35)" : "rgba(255,255,255,0.06)",
                      boxShadow: tabFocus === "dms" ? "0 0 0 2px #fff" : "none",
                      fontWeight: voiceTab === "dms" ? 700 : 400,
                    }}
                  >
                    💬 {t("tab_dms")}
                  </BtnTab>
                </div>
                {voiceTab === "servers" ? <ChannelBrowser /> : <DMBrowser />}
              </>
            )}
          </SR>
        </div>
        <hr />
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <TextChat />
          </SR>
        </div>
        <SR>
          <UploadScreenshot />
        </SR>
      </SP>
    );
  }
};

export default definePlugin(() => {
  // Workaround for DeckyLoader v3.2.4 + Steam update (24/06/2026) incompatibility:
  // After Steam update, some components (e.g. ValveToastRenderer) changed from class to
  // function components. FCTrampoline incorrectly sets isReactComponent=true on them,
  // causing React to call `new fn()` → fn returns JSX → `instance.render` crashes.
  //
  // Fix 1: scan webpack modules and remove FCTrampoline wrapping from any function
  // component it incorrectly wrapped (function components have Object.prototype as their
  // prototype's parent, not React.Component.prototype).
  try {
    const broken: any[] = [];
    findModuleExport((e: any) => {
      if (typeof e === 'function' &&
          e.prototype?.isReactComponent === true &&
          Object.getPrototypeOf(e.prototype) === Object.prototype) {
        broken.push(e);
      }
      return false; // scan all modules
    });
    broken.forEach((fn: any) => {
      delete fn.prototype.render;
      delete fn.prototype.isReactComponent;
      try { delete fn.prototype.updater; } catch (_) {}
      try { delete fn.prototype.getDerivedStateFromProps; } catch (_) {}
      try { delete (fn as any).contextType; } catch (_) {}
      console.log('[Streamcord] FCTrampoline unwrapped from function component:', fn.name || '(anon)');
    });
    if (broken.length > 0)
      console.log('[Streamcord] Fixed ' + broken.length + ' bad FCTrampoline wrapping(s)');
  } catch (e) {
    console.warn('[Streamcord] FCTrampoline unwrap scan failed:', e);
  }

  // Fix 2: prevent createElement from being stubbed (belt-and-suspenders)
  // If any wrapped function component was missed by the scan, the stub would
  // still crash React. This ensures createElement always returns the real implementation.
  try {
    const _origCE = (window as any).SP_REACT?.createElement;
    if (_origCE) {
      Object.defineProperty((window as any).SP_REACT, 'createElement', {
        get: () => _origCE, set: () => {}, configurable: true,
      });
    }
    const _jsx = (window as any).SP_JSX;
    if (_jsx) {
      const _origJsx = _jsx.jsx;
      const _origJsxs = _jsx.jsxs;
      if (_origJsx) Object.defineProperty(_jsx, 'jsx', { get: () => _origJsx, set: () => {}, configurable: true });
      if (_origJsxs) Object.defineProperty(_jsx, 'jsxs', { get: () => _origJsxs, set: () => {}, configurable: true });
    }
  } catch (e) {
    console.warn('[Streamcord] createElement guard failed:', e);
  }

  // Diagnostic: which @decky/ui components are defined after Steam update?
  console.log('[Streamcord] PanelSection=' + !!PanelSection + ' PanelSectionRow=' + !!PanelSectionRow +
    ' Focusable=' + !!Focusable + ' DialogButton=' + !!DialogButton +
    ' Toggle=' + !!Toggle + ' SliderField=' + !!SliderField + ' Dropdown=' + !!Dropdown);

  window.STREAMCORD = {
    dispatchNotification: (payload: { title: string; body: string; kind?: string }) => {
      console.log("Dispatching Streamcord notification: ", payload);
      // Incoming DM call: localize the title to the SteamOS language.
      const title = payload.kind === "call" ? `📞 ${t("incoming_call")}` : payload.title;
      toaster.toast({ title, body: payload.body });
    },
    MIC_PEER_CONNECTION: undefined,
  };

  // Mic relay: the hidden Discord tab can't capture the mic, so it sends us an
  // offer; we capture the REAL mic here in SharedJSContext and answer. Without
  // this, others can't hear the user.
  let peerConnection: RTCPeerConnection;
  const webrtcEventListener = async (data: any) => {
    if (!data) return;
    if (data.offer) {
      console.log("[Streamcord] mic: offer received, capturing mic");
      if (peerConnection) peerConnection.close();
      peerConnection = new RTCPeerConnection();
      window.STREAMCORD.MIC_PEER_CONNECTION = peerConnection;
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
      });
      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(data.offer)
      );
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      // Non-trickle ICE: wait for gathering so candidates are in the answer SDP.
      await new Promise<void>((res) => {
        if (peerConnection.iceGatheringState === "complete") return res();
        const cb = () => {
          if (peerConnection.iceGatheringState === "complete") {
            peerConnection.removeEventListener("icegatheringstatechange", cb);
            res();
          }
        };
        peerConnection.addEventListener("icegatheringstatechange", cb);
        setTimeout(res, 2000);
      });
      console.log("[Streamcord] mic: sending answer");
      await call("mic_webrtc_answer", peerConnection.localDescription);
    } else if (data.ice) {
      try {
        while (peerConnection.remoteDescription == null) await sleep(10);
        await peerConnection.addIceCandidate(data.ice);
      } catch (e) {
        console.error("[Streamcord] mic: error adding ice candidate", e);
      }
    }
  };
  addEventListener("webrtc", webrtcEventListener);

  // Always follow the default audio INPUT automatically: when a mic is plugged
  // in/out (headset, RØDECaster…), swap the relayed track for the new default
  // without renegotiating. (Output already follows: Discord is set to "default",
  // so PipeWire routes playback to the current default sink.)
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    try {
      if (!peerConnection) return;
      const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (!sender) return;
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const newTrack = newStream.getAudioTracks()[0];
      if (newTrack) {
        await sender.replaceTrack(newTrack);
        console.log("[Streamcord] mic: followed new default input device");
      }
    } catch (e) {
      console.error("[Streamcord] mic: devicechange follow failed", e);
    }
  });

  let settingsChangeUnregister: any;
  const appLifetimeUnregister =
    SteamClient.GameSessions.RegisterForAppLifetimeNotifications(async () => {
      await sleep(500);
      setPlaying();
    }).unregister;
  const unpatchMenu = patchMenu();

  const setPlaying = () => {
    const app = Router.MainRunningApp;
    call("set_rpc", app !== undefined ? app?.display_name : null);
  };

  let lastDisplayIsExternal = false;
  (async () => {
    await isLoaded();

    settingsChangeUnregister = SteamClient.Settings.RegisterForSettingsChanges(
      async (settings: any) => {
        if (settings.bDisplayIsExternal != lastDisplayIsExternal) {
          lastDisplayIsExternal = settings.bDisplayIsExternal;
          const bounds: any = await call("get_screen_bounds");
          window.DISCORD_TAB.HEIGHT = bounds.height;
          window.DISCORD_TAB.WIDTH = bounds.width;
          window.DISCORD_TAB.m_browserView.SetBounds(
            0,
            0,
            bounds.width,
            bounds.height
          );
        }
      }
    );
    await isLoggedIn();
    setPlaying();
  })();

  routerHook.addRoute("/discord", () => {
    return <DiscordTab />;
  });

  // Sync de statut Steam→Discord en tâche de fond (indépendante du QAM).
  startStatusSync();

  return {
    title: <div className={staticClasses.Title}>Streamcord</div>,
    content: <Suspense fallback={<div style={{ padding: 8 }}>{t("loading")}</div>}><ContentErrorBoundary><Content /></ContentErrorBoundary></Suspense>,
    icon: <FaDiscord />,
    onDismount() {
      routerHook.removeRoute("/discord");
      unpatchMenu();
      stopStatusSync();
      removeEventListener("webrtc", webrtcEventListener);
      try {
        appLifetimeUnregister();
        settingsChangeUnregister();
      } catch (error) { }
    },
    alwaysRender: true,
  };
});
