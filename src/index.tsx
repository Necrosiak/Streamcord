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
    console.error("[Steamcord] QAM render error:", e, info);
  }
  render() {
    if (this.state.hasError)
      return <div style={{ padding: 8, color: "#ff6b6b", fontSize: 13 }}>⚠ Steamcord render error — check webhelper_js.txt<br />{this.state.msg}</div>;
    return this.props.children;
  }
}

import { patchMenu } from "./patches/menuPatch";
import { notify, patchDeckyToaster } from "./notify";
import { initVideoRelay } from "./videoRelay";
import { DiscordTab } from "./components/DiscordTab";
import {
  useSteamcordState,
  isLoaded,
  isLoggedIn,
} from "./hooks/useSteamcordState";

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
import { ScreenCameraButton } from "./components/buttons/ScreenCameraButton";
import { GameAudioShare } from "./components/buttons/GameAudioShare";
import { ChannelBrowser } from "./components/ChannelBrowser";
import { DMBrowser } from "./components/DMBrowser";
import { TextChat } from "./components/TextChat";
import { t } from "./i18n";
import {
  call,
  addEventListener,
  removeEventListener,
  routerHook,
} from "@decky/api";

declare global {
  interface Window {
    DISCORD_TAB: any;
    STEAMCORD: {
      dispatchNotification: any;
      MIC_PEER_CONNECTION: any;
    };
  }
}

// Safe wrappers for @decky/ui components that may be undefined after a Steam update
const SP = PanelSection || ((p: any) => <div>{p.children}</div>);
const SR = PanelSectionRow || ((p: any) => <div>{p.children}</div>);

const NotLoggedIn = ({ qr_login, qr_scanned, captcha_needed }: { qr_login?: string; qr_scanned?: boolean; captcha_needed?: boolean }) => {
  if (captcha_needed) { call("show_discord_login").catch(() => {}); }
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "8px 15px" }}>
      <h2 style={{ marginBottom: 4 }}>{t("not_connected")}</h2>
      {qr_scanned ? (
        // QR scanné → Discord attend la validation sur le téléphone.
        <div style={{ textAlign: "center", padding: "12px 0" }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>📱✅</div>
          <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px" }}>{t("qr_scanned_title")}</p>
          <p style={{ fontSize: 11, opacity: 0.65, margin: 0, lineHeight: 1.4 }}>{t("qr_scanned_body")}</p>
        </div>
      ) : qr_login ? (
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

// Onglet de navigation (Vocal/Conversations, Serveurs/MP). Texte blanc forcé :
// sinon le focus natif du DialogButton met un fond clair + texte sombre =
// illisible. On pilote nous-mêmes le fond actif/focus (bleu Discord + anneau).
const TabBtn = ({ active, focused, onClick, onFocus, onBlur, fontSize, children }: any) => (
  <BtnTab
    onClick={onClick}
    onFocus={onFocus}
    onBlur={onBlur}
    style={{
      flex: "1 1 0", minWidth: 0, margin: 0, padding: "3px 0",
      fontSize: fontSize ?? 11, minHeight: 0, boxSizing: "border-box",
      color: "#fff",
      background: focused
        ? "rgba(88,101,242,0.85)"
        : active ? "rgba(88,101,242,0.35)" : "rgba(255,255,255,0.06)",
      boxShadow: focused ? "0 0 0 2px #fff" : "none",
      fontWeight: active ? 700 : 400,
    }}
  >
    {children}
  </BtnTab>
);

// Bouton pleine largeur (Parcourir Discord / Retour à l'appel).
const WideBtn = ({ onClick, focused, onFocus, onBlur, children }: any) => (
  <BtnTab
    onClick={onClick}
    onFocus={onFocus}
    onBlur={onBlur}
    style={{
      width: "100%", margin: 0, padding: "4px 0", fontSize: 11, minHeight: 0,
      boxSizing: "border-box", color: "#fff",
      background: focused ? "rgba(88,101,242,0.85)" : "rgba(255,255,255,0.06)",
      boxShadow: focused ? "0 0 0 2px #fff" : "none",
    }}
  >
    {children}
  </BtnTab>
);

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

const STATUS_AUTO_KEY = "steamcord_status_auto";
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
  try { await call("set_discord_status", id); } catch (e) { console.error("[Steamcord] set_discord_status", e); }
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
        console.log("[Steamcord] auto: Steam persona " + s + " → Discord " + disc);
        applyDiscordStatus(disc);
      }
    }
  };
  tick();
  _statusTimer = setInterval(tick, 5000);
};
const stopStatusSync = () => { if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; } };

// Pseudo cliquable : avatar + nom + icône du statut courant à droite. Clic →
// déplie le sélecteur de statut (en ligne). Une sélection manuelle coupe l'auto-sync.
const UserStatusButton = ({ me }: { me: any }) => {
  const [current, setCurrent] = useState<string>(currentDiscordStatus);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    const fn = (s: string) => setCurrent(s);
    statusListeners.add(fn);
    setCurrent(currentDiscordStatus);
    return () => { statusListeners.delete(fn); };
  }, []);

  const pick = async (id: string) => {
    if (getAutoSync()) setAutoSync(false); // prise de contrôle manuelle
    setCurrent(id);
    setOpen(false);
    await applyDiscordStatus(id);
  };

  const cur = STATUSES.find((x) => x.id === current) || STATUSES[0];

  return (
    <div>
      <BtnTab
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setFocused("name")}
        onBlur={() => setFocused((f) => (f === "name" ? null : f))}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "4px 8px", margin: 0, minHeight: 0, boxSizing: "border-box",
          background: focused === "name" ? "rgba(88,101,242,0.6)" : "rgba(255,255,255,0.06)",
          boxShadow: focused === "name" ? "0 0 0 2px #fff" : "none",
        }}
      >
        <img
          src={"https://cdn.discordapp.com/avatars/" + me?.id + "/" + me?.avatar + ".webp"}
          width={32} height={32}
          style={{ display: "block", borderRadius: "50%", flexShrink: 0 }}
        />
        <span style={{ flex: 1, textAlign: "left", fontSize: 13, fontWeight: 600 }}>{me?.username}</span>
        {/* Statut courant (icône) à droite du pseudo. */}
        <span style={{ fontSize: 14 }}>{cur.emoji}</span>
        <span style={{ opacity: 0.4, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </BtnTab>
      {open && (
        <Focusable
          style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 6 }}
          flow-children="horizontal"
        >
          {STATUSES.map((s) => {
            const selected = current === s.id;
            const isF = focused === s.id;
            return (
              <BtnTab
                key={s.id}
                onClick={() => pick(s.id)}
                onFocus={() => setFocused(s.id)}
                onBlur={() => setFocused((f) => (f === s.id ? null : f))}
                style={{
                  flex: "1 1 0", minWidth: 0, margin: 0, padding: "4px 0", fontSize: 16, minHeight: 0,
                  boxSizing: "border-box",
                  background: selected ? s.color : "rgba(255,255,255,0.06)",
                  opacity: selected ? 1 : 0.5,
                  border: selected ? "2px solid #fff" : "2px solid transparent",
                  boxShadow: isF ? "0 0 0 3px #fff, 0 0 10px 2px " + s.color : "none",
                  transform: isF ? "scale(1.12)" : "scale(1)",
                  transition: "transform .08s ease, box-shadow .08s ease, opacity .08s ease",
                  zIndex: isF ? 1 : 0,
                }}
              >
                {s.emoji}
              </BtnTab>
            );
          })}
        </Focusable>
      )}
    </div>
  );
};

// Réglage Config : toggle de suivi auto du statut Steam → Discord.
const StatusAutoToggle = () => {
  const [auto, setAutoState] = useState<boolean>(getAutoSync());
  const toggleAuto = (v: boolean) => {
    setAutoSync(v);
    setAutoState(v);
    if (v) {
      // Réactivation → resync immédiat sur l'état Steam courant.
      _statusLastSteam = null;
      const s = readSteamPersona();
      if (s !== null) { _statusLastSteam = s; applyDiscordStatus(steamToDiscord(s)); }
    }
  };
  return (
    <SR>
      <ToggleField
        label={t("follow_steam_status")}
        checked={auto}
        onChange={toggleAuto}
        bottomSeparator="none"
      />
    </SR>
  );
};

const UpdaterSection = () => {
  const [auto, setAuto] = useState(true);
  const [status, setStatus] = useState<
    "idle" | "checking" | "available" | "uptodate" | "installing"
  >("idle");
  const [latest, setLatest] = useState("");
  const [current, setCurrent] = useState("");
  const [url, setUrl] = useState("");
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    call<[], boolean>("get_autoupdate").then((v) => setAuto(!!v)).catch(() => {});
  }, []);

  const doCheck = async () => {
    setStatus("checking");
    try {
      const info: any = await call<[], any>("check_update");
      setCurrent(info?.current || "");
      if (info?.update_available) {
        setLatest(info.latest);
        setUrl(info.url);
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch {
      setStatus("idle");
    }
  };

  const doInstall = async () => {
    setStatus("installing");
    // The backend unpacks the release and restarts plugin_loader on success.
    try { await call<[string], boolean>("apply_update", url); } catch {}
  };

  const onToggle = (v: boolean) => {
    setAuto(v);
    call<[boolean], boolean>("set_autoupdate", v).catch(() => {});
  };

  const label =
    status === "checking" ? t("update_checking")
    : status === "installing" ? t("update_installing")
    : status === "available" ? t("update_install", { v: latest })
    : status === "uptodate" ? t("update_up_to_date", { v: current })
    : t("update_check");

  return (
    <>
      <SR>
        <ToggleField
          label={t("update_auto")}
          checked={auto}
          onChange={onToggle}
          bottomSeparator="none"
        />
      </SR>
      <SR>
        <WideBtn
          onClick={status === "available" ? doInstall : doCheck}
          focused={focused === "upd"}
          onFocus={() => setFocused("upd")}
          onBlur={() => setFocused((f) => (f === "upd" ? null : f))}
        >
          🔄 {label}
        </WideBtn>
      </SR>
    </>
  );
};

// Environnement d'affichage : "desktop" (KWin = Bureau/Big Picture, Go Live
// marche), "gamescope" (console, seul « mode jeu » marche), "unknown" (on
// affiche les deux boutons plutôt que d'en priver l'utilisateur).
function useShareEnv(): "desktop" | "gamescope" | "unknown" {
  const [env, setEnv] = useState<"desktop" | "gamescope" | "unknown">("unknown");
  useEffect(() => {
    let alive = true;
    const poll = () =>
      call<[], { env: string }>("get_share_env")
        .then((r) => { if (alive) setEnv((r?.env as any) || "unknown"); })
        .catch(() => { if (alive) setEnv("unknown"); });
    poll();
    const id = setInterval(poll, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return env;
}

const Content = () => {
  const state = useSteamcordState();
  const [topTab, setTopTab] = useState<"voice" | "text" | "config">("voice");
  const [srcTab, setSrcTab] = useState<"servers" | "dms">("servers");
  const [tabFocus, setTabFocus] = useState<string | null>(null);
  // En appel : la vue par défaut est l'appel en cours. « Parcourir Discord »
  // bascule browsing=true pour révéler la navigation SANS quitter l'appel.
  const [browsing, setBrowsing] = useState(false);
  const shareEnv = useShareEnv();

  const inCall = !!state?.vc?.channel_id;
  // Chaque début/fin d'appel ramène à la vue naturelle (appel si en appel).
  useEffect(() => { setBrowsing(false); }, [inCall]);

  if (!state?.loaded) {
    return (
      <div style={{ display: "flex", justifyContent: "center" }}>
        <h2>{t("initializing")}</h2>
      </div>
    );
  } else if (!state?.logged_in) {
    return <NotLoggedIn qr_login={state?.qr_login} qr_scanned={state?.qr_scanned} captcha_needed={state?.captcha_needed} />;
  } else {
    return (
      <SP>
        {/* Pseudo TOUJOURS en haut → changement de statut accessible en permanence. */}
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <UserStatusButton me={state?.me} />
          </SR>
        </div>
        <hr></hr>
        {/* Contrôles vocaux SOUS le pseudo : mute micro / casque / déconnexion.
            Focusable + flow-children="horizontal" → D-pad gauche/droite circule
            entre les boutons (sinon nav unidirectionnelle). */}
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <Focusable flow-children="horizontal" style={{ display: "flex", justifyContent: "center", gap: 6 }}>
              <MuteButton />
              <DeafenButton />
              <DisconnectButton />
            </Focusable>
          </SR>
        </div>
        <div style={{ marginBottom: "12px" }}>
          <SR>
            <Focusable flow-children="horizontal" style={{ display: "flex", justifyContent: "center" }}>
              <PushToTalkButton />
            </Focusable>
          </SR>
        </div>
        {/* Navigation Discord. Deux menus empilés, TOUJOURS visibles (même en
            appel) :
              1. Mode  : Vocal / Textuel  (en haut)
              2. Source: Serveurs / MP    (partagé entre les deux modes)
            Le contenu = mode × source. En appel actif, l'onglet Vocal affiche
            d'abord l'appel en cours ; « Parcourir » révèle le menu Serveurs/MP
            sans raccrocher. */}
        <div style={{ marginBottom: "12px" }}>
          <SR>
            {/* 1. Menu de haut niveau (persistant) : Vocal / Textuel / Config.
                Focusable + flow-children="horizontal" : la rangée devient UN arrêt
                de nav vertical, gauche/droite circule entre les onglets (un <div>
                flex de boutons bruts ne navigue que dans un sens à la manette). */}
            <Focusable flow-children="horizontal" style={{ display: "flex", gap: 4, marginBottom: 6, width: "100%", boxSizing: "border-box" }}>
              <TabBtn
                active={topTab === "voice"} focused={tabFocus === "top-voice"}
                onClick={() => setTopTab("voice")}
                onFocus={() => setTabFocus("top-voice")}
                onBlur={() => setTabFocus((f) => (f === "top-voice" ? null : f))}
              >
                {inCall ? "📞" : "🎧"} {t("tab_voice")}
              </TabBtn>
              <TabBtn
                active={topTab === "text"} focused={tabFocus === "top-text"}
                onClick={() => setTopTab("text")}
                onFocus={() => setTabFocus("top-text")}
                onBlur={() => setTabFocus((f) => (f === "top-text" ? null : f))}
              >
                💬 {t("tab_text")}
              </TabBtn>
              <TabBtn
                active={topTab === "config"} focused={tabFocus === "top-config"}
                onClick={() => setTopTab("config")}
                onFocus={() => setTabFocus("top-config")}
                onBlur={() => setTabFocus((f) => (f === "top-config" ? null : f))}
              >
                ⚙️
              </TabBtn>
            </Focusable>

            {topTab === "config" ? (
              // ── Onglet Config : réglages regroupés (mises à jour, etc.) ──
              <ConfigPanel />
            ) : topTab === "voice" && inCall && !browsing ? (
              // ── Onglet Vocal, en appel : vue de l'appel en cours ──
              <>
                <VoiceChatChannel />
                <VoiceChatMembers />
                {/* Un seul bouton de partage selon l'environnement : Go Live
                    (portail) en Bureau/Big Picture, « mode jeu » (v4l2) en
                    console gamescope. Env inconnu → les deux, par sécurité. */}
                {shareEnv !== "gamescope" && (
                  <div style={{ marginTop: 8 }}>
                    <GoLiveButton />
                  </div>
                )}
                {shareEnv !== "desktop" && (
                  <div style={{ marginTop: 8 }}>
                    <ScreenCameraButton />
                  </div>
                )}
                <div style={{ marginTop: 8 }}>
                  <GameAudioShare />
                </div>
                {/* Rejoindre un AUTRE vocal sans quitter l'appel courant. */}
                <div style={{ marginTop: 8 }}>
                  <WideBtn
                    onClick={() => setBrowsing(true)}
                    focused={tabFocus === "browse"}
                    onFocus={() => setTabFocus("browse")}
                    onBlur={() => setTabFocus((f) => (f === "browse" ? null : f))}
                  >
                    📂 {t("browse_discord")}
                  </WideBtn>
                </div>
              </>
            ) : (
              // ── Vue navigation (Vocal hors-appel/parcourir OU Textuel) ──
              <>
                {/* En appel : revenir à la vue de l'appel sans raccrocher. */}
                {topTab === "voice" && inCall && (
                  <div style={{ marginBottom: 6 }}>
                    <WideBtn
                      onClick={() => setBrowsing(false)}
                      focused={tabFocus === "back"}
                      onFocus={() => setTabFocus("back")}
                      onBlur={() => setTabFocus((f) => (f === "back" ? null : f))}
                    >
                      ← {t("back_to_call")}
                    </WideBtn>
                  </div>
                )}
                {/* 2. Menu source (partagé) : Serveurs / MP */}
                <Focusable flow-children="horizontal" style={{ display: "flex", gap: 4, marginBottom: 6, width: "100%", boxSizing: "border-box" }}>
                  <TabBtn
                    active={srcTab === "servers"} focused={tabFocus === "servers"}
                    onClick={() => setSrcTab("servers")}
                    onFocus={() => setTabFocus("servers")}
                    onBlur={() => setTabFocus((f) => (f === "servers" ? null : f))}
                  >
                    🏠 {t("tab_servers")}
                  </TabBtn>
                  <TabBtn
                    active={srcTab === "dms"} focused={tabFocus === "dms"}
                    onClick={() => setSrcTab("dms")}
                    onFocus={() => setTabFocus("dms")}
                    onBlur={() => setTabFocus((f) => (f === "dms" ? null : f))}
                  >
                    👤 {t("tab_dms")}
                  </TabBtn>
                </Focusable>
                {/* Contenu = mode × source. La clé force un remontage propre au
                    changement de source (réinitialise la conversation ouverte).
                    Le partage de captures n'apparaît QUE dans Textuel (envoi vers
                    le salon/conversation en cours). */}
                {topTab === "voice"
                  ? (srcTab === "servers" ? <ChannelBrowser /> : <DMBrowser />)
                  : (
                    <>
                      <TextChat key={srcTab} source={srcTab} />
                      <hr />
                      <SR>
                        <UploadScreenshot />
                      </SR>
                    </>
                  )}
              </>
            )}
          </SR>
        </div>
      </SP>
    );
  }
};

// Panneau « Config » : réglages regroupés, accessibles via l'onglet ⚙️.
// Aujourd'hui : mises à jour (auto + manuel). Prévu pour accueillir d'autres
// réglages (ex. suivi du statut Steam).
// Sélection des périphériques audio (sortie/entrée) pour Discord. Discord ne voit
// que "Default" en headless → on liste les périphériques SYSTÈME (PipeWire) et le
// backend route le flux Vesktop par-application (ex. son Discord → casque seul).
const AudioDevicesConfig = () => {
  const [dev, setDev] = useState<any>(null);
  const [outSel, setOutSel] = useState<string>("auto");
  const [inSel, setInSel] = useState<string>("auto");

  const load = () => {
    call<[], any>("get_audio_devices").then((d) => {
      if (d && !d.error) { setDev(d); setOutSel(d.selected_output || "auto"); setInSel(d.selected_input || "auto"); }
    }).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  if (!dev) return null;
  const opt = (arr: any[]) => [{ data: "auto", label: t("audio_auto") }, ...(arr || []).map((o: any) => ({ data: o.name, label: o.label }))];

  return (
    <>
      <SR><div style={{ fontSize: 12, opacity: 0.85, margin: "2px 0" }}>🔊 {t("audio_output")}</div></SR>
      <SR>
        <Dropdown rgOptions={opt(dev.outputs) as any} selectedOption={outSel}
          onChange={(e: any) => { setOutSel(e.data); call("set_audio_output", e.data).catch(() => {}); }} />
      </SR>
      <SR><div style={{ fontSize: 12, opacity: 0.85, margin: "6px 0 2px" }}>🎙️ {t("audio_input")}</div></SR>
      <SR>
        <Dropdown rgOptions={opt(dev.inputs) as any} selectedOption={inSel}
          onChange={(e: any) => { setInSel(e.data); call("set_audio_input", e.data).catch(() => {}); }} />
      </SR>
    </>
  );
};

// Réglages micro Discord (Voix & Vidéo) pilotés via le client CDP : réduction de
// bruit tri-état (Krisp > Standard > Aucune) + annulation d'écho + gain auto.
const MicProcessingConfig = () => {
  const [cfg, setCfg] = useState<any>(null);

  useEffect(() => {
    call<[], any>("get_audio_processing").then((d) => {
      if (d && !d.error) setCfg(d);
    }).catch(() => {});
  }, []);

  if (!cfg) return null;
  const noiseOpts = [
    { data: "krisp", label: t("mic_noise_krisp") },
    { data: "standard", label: t("mic_noise_standard") },
    { data: "none", label: t("mic_noise_none") },
  ];

  return (
    <>
      <SR><div style={{ fontSize: 12, opacity: 0.85, margin: "2px 0" }}>🎙️ {t("mic_noise_reduction")}</div></SR>
      <SR>
        <Dropdown rgOptions={noiseOpts as any} selectedOption={cfg.noise}
          onChange={(e: any) => { setCfg({ ...cfg, noise: e.data }); call("set_noise_reduction", e.data).catch(() => {}); }} />
      </SR>
      <SR>
        <ToggleField
          label={t("mic_echo_cancellation")}
          checked={!!cfg.echoCancellation}
          onChange={(v: boolean) => { setCfg({ ...cfg, echoCancellation: v }); call("set_echo_cancellation", v).catch(() => {}); }}
          bottomSeparator="none"
        />
      </SR>
      <SR>
        <ToggleField
          label={t("mic_auto_gain")}
          checked={!!cfg.automaticGainControl}
          onChange={(v: boolean) => { setCfg({ ...cfg, automaticGainControl: v }); call("set_automatic_gain_control", v).catch(() => {}); }}
          bottomSeparator="none"
        />
      </SR>
    </>
  );
};

// À propos rapide (bas de l'onglet Config).
const AboutSection = () => {
  const [version, setVersion] = useState<string>("");
  useEffect(() => { call<[], string>("get_version").then((v) => setVersion(v || "")).catch(() => {}); }, []);
  const open = (url: string) => { try { (window as any).SteamClient?.URL?.ExecuteSteamURL?.("steam://openurl/" + url); } catch {} };
  return (
    <>
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>ℹ️ {t("about")}</div>
      </SR>
      <SR>
        <div style={{ fontSize: 11, color: "#aaa", lineHeight: 1.6 }}>
          <div><b style={{ color: "#fff" }}>Steamcord</b>{version ? ` v${version}` : ""}</div>
          <div>{t("about_by")} <span style={{ color: "#67a3ff" }}>Necrosiak</span></div>
        </div>
      </SR>
      <SR>
        <WideBtn onClick={() => open("https://github.com/Necrosiak/Steamcord")}>🔗 GitHub</WideBtn>
      </SR>
    </>
  );
};

const LogoutSection = () => {
  const [confirm, setConfirm] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const Btn = DialogButton as any;
  // Texte TOUJOURS blanc + halo blanc au focus (le fond ne change pas → jamais de
  // texte illisible sur le surlignage clair de Steam).
  const btn = (key: string, bg: string, extra: any = {}) => ({
    onFocus: () => setFocused(key),
    onBlur: () => setFocused((f: string | null) => (f === key ? null : f)),
    style: {
      margin: 0, padding: "5px 0", minHeight: 0, fontSize: 11, fontWeight: 600,
      borderRadius: 6, color: "#fff", background: bg,
      boxShadow: focused === key ? "0 0 0 2px #fff" : "none",
      transition: "box-shadow .08s ease",
      ...extra,
    },
  });
  return (
    <>
      <hr />
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🚪 {t("config_account")}</div>
      </SR>
      <SR>
        {!confirm ? (
          <Btn onClick={() => setConfirm(true)} {...btn("out", "rgba(237,66,69,0.6)", { width: "100%" })}>
            🚪 {t("logout_discord")}
          </Btn>
        ) : (
          <div style={{ width: "100%" }}>
            <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6, textAlign: "center", color: "#fff" }}>{t("logout_confirm")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => { call("logout_discord").catch(() => {}); setConfirm(false); }} {...btn("yes", "#ed4245", { flex: 1 })}>
                {t("logout_yes")}
              </Btn>
              <Btn onClick={() => setConfirm(false)} {...btn("cancel", "rgba(255,255,255,0.18)", { flex: 1 })}>
                {t("logout_cancel")}
              </Btn>
            </div>
          </div>
        )}
      </SR>
    </>
  );
};

const ConfigPanel = () => {
  return (
    <div>
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🎮 {t("config_status")}</div>
      </SR>
      <StatusAutoToggle />
      <hr />
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🎧 {t("config_audio")}</div>
      </SR>
      <AudioDevicesConfig />
      <hr />
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🎤 {t("config_mic")}</div>
      </SR>
      <MicProcessingConfig />
      <hr />
      <SR>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🔄 {t("config_updates")}</div>
      </SR>
      <UpdaterSection />
      <hr />
      <AboutSection />
      <LogoutSection />
    </div>
  );
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
      console.log('[Steamcord] FCTrampoline unwrapped from function component:', fn.name || '(anon)');
    });
    if (broken.length > 0)
      console.log('[Steamcord] Fixed ' + broken.length + ' bad FCTrampoline wrapping(s)');
  } catch (e) {
    console.warn('[Steamcord] FCTrampoline unwrap scan failed:', e);
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
    console.warn('[Steamcord] createElement guard failed:', e);
  }

  // Diagnostic: which @decky/ui components are defined after Steam update?
  console.log('[Steamcord] PanelSection=' + !!PanelSection + ' PanelSectionRow=' + !!PanelSectionRow +
    ' Focusable=' + !!Focusable + ' DialogButton=' + !!DialogButton +
    ' Toggle=' + !!Toggle + ' SliderField=' + !!SliderField + ' Dropdown=' + !!Dropdown);

  window.STEAMCORD = {
    dispatchNotification: (payload: { title: string; body: string; kind?: string }) => {
      console.log("Dispatching Steamcord notification: ", payload);
      // Incoming DM call: localize the title to the SteamOS language.
      const title = payload.kind === "call" ? `📞 ${t("incoming_call")}` : payload.title;
      notify({ title, body: payload.body });
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
      console.log("[Steamcord] mic: offer received, capturing mic");
      if (peerConnection) peerConnection.close();
      peerConnection = new RTCPeerConnection();
      window.STEAMCORD.MIC_PEER_CONNECTION = peerConnection;
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
      console.log("[Steamcord] mic: sending answer");
      await call("mic_webrtc_answer", peerConnection.localDescription);
    } else if (data.ice) {
      try {
        while (peerConnection.remoteDescription == null) await sleep(10);
        await peerConnection.addIceCandidate(data.ice);
      } catch (e) {
        console.error("[Steamcord] mic: error adding ice candidate", e);
      }
    }
  };
  addEventListener("webrtc", webrtcEventListener);

  // Réception vidéo (voir le Go Live/cam des autres dans leur bloc).
  initVideoRelay();

  // Anti-crash panneau de notifs Steam : sécurise le toaster Decky partagé
  // (Decky + plugins tiers) qui crée des entrées sans notification_type.
  patchDeckyToaster();

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
        console.log("[Steamcord] mic: followed new default input device");
      }
    } catch (e) {
      console.error("[Steamcord] mic: devicechange follow failed", e);
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
    // .catch : pendant une re-init Vesktop (bascule Bureau↔gamemode) le backend
    // rejette (discord_reconnecting) → sans catch, rejet non géré dans le QAM.
    call("set_rpc", app !== undefined ? app?.display_name : null).catch(() => {});
  };

  let lastDisplayIsExternal = false;
  (async () => {
    await isLoaded();

    settingsChangeUnregister = SteamClient.Settings.RegisterForSettingsChanges(
      async (settings: any) => {
        if (settings.bDisplayIsExternal != lastDisplayIsExternal) {
          lastDisplayIsExternal = settings.bDisplayIsExternal;
          try {
            const bounds: any = await call("get_screen_bounds");
            window.DISCORD_TAB.HEIGHT = bounds.height;
            window.DISCORD_TAB.WIDTH = bounds.width;
            window.DISCORD_TAB.m_browserView.SetBounds(
              0,
              0,
              bounds.width,
              bounds.height
            );
          } catch {}
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
    title: <div className={staticClasses.Title}>Steamcord</div>,
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
