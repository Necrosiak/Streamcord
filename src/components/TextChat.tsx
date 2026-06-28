import { DialogButton, Focusable, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";

// Intervalle de polling au niveau module (évite useRef — déconseillé dans le
// QAM DeckyLoader). Une seule instance de TextChat à la fois (le parent monte
// une instance distincte par source via `key`).
let _textPoll: any = null;
const MSG_LIST_ID = "steamcord-msglist";
const scrollMsgsBottom = () => {
  setTimeout(() => {
    const el = document.getElementById(MSG_LIST_ID);
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);
};

// Salon/conversation texte actuellement OUVERT — partagé avec UploadScreenshot
// pour que le partage de capture cible la conversation en cours.
export let currentTextChannel: { id: string; name: string; dm: boolean } | null = null;
const _channelSubs = new Set<() => void>();
export const onTextChannelChange = (fn: () => void) => { _channelSubs.add(fn); return () => { _channelSubs.delete(fn); }; };
const setCurrentTextChannel = (c: typeof currentTextChannel) => {
  currentTextChannel = c;
  _channelSubs.forEach((f) => { try { f(); } catch {} });
};

interface TextChannel { id: string; name: string; type: number; }
interface Guild { id: string; name: string; icon: string | null; channels: TextChannel[]; }
interface DMRecipient { id: string; username: string; avatar: string | null; }
interface DMChannel {
  id: string; type: number; name: string; icon: string | null;
  recipients: DMRecipient[]; active_call: boolean;
}
interface MsgImage { url: string; proxy_url: string; w: number; h: number; }
interface Message {
  id: string; author: string; author_id: string; avatar: string | null;
  bot: boolean; content: string; ts: string | null;
  images: MsgImage[]; files: number;
}

const Btn = DialogButton as any;

// Ouvre une URL dans le navigateur intégré du gamemode Steam (overlay web).
const openUrl = (url: string) => {
  try { (window as any).SteamClient?.URL?.ExecuteSteamURL?.("steam://openurl/" + url); } catch {}
};

// Miniature légère via le CDN média Discord (redimensionne côté serveur → peu de data).
const thumbUrl = (img: MsgImage) => {
  const base = img.proxy_url || img.url;
  return base + (base.includes("?") ? "&" : "?") + "width=240&height=240";
};

// Extrait les liens http(s) du texte (dédupliqués, sans la ponctuation finale).
const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;
const extractLinks = (text: string): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[1].replace(/[.,;:!?]+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
};
// Libellé court et lisible d'un lien (hôte + début de chemin).
const shortLink = (url: string) => {
  try { const u = new URL(url); const p = u.pathname !== "/" ? u.pathname : ""; const s = u.host + p; return s.length > 38 ? s.slice(0, 37) + "…" : s; }
  catch { return url.length > 38 ? url.slice(0, 37) + "…" : url; }
};

// Couleur stable par auteur (comme Discord, agréable à scanner).
const NAME_COLORS = ["#5865f2", "#23a55a", "#f0b232", "#eb459e", "#f23f43", "#00a8fc", "#9b59b6"];
const colorFor = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
};
const shortTime = (ts: string | null) => {
  if (!ts) return "";
  try { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
};

// Avatar d'une conversation privée (DM/GroupDM), même logique que DMBrowser.
function DMAvatar({ ch }: { ch: DMChannel }) {
  if (ch.type === 3 && ch.icon) {
    return <img src={`https://cdn.discordapp.com/channel-icons/${ch.id}/${ch.icon}.webp?size=32`} width={20} height={20} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  }
  if (ch.recipients.length >= 1) {
    const r = ch.recipients[0];
    return <img src={r.avatar ? `https://cdn.discordapp.com/avatars/${r.id}/${r.avatar}.webp?size=32` : `https://cdn.discordapp.com/embed/avatars/0.png`} width={20} height={20} style={{ borderRadius: "50%", flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#5865f2", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff" }}>
      {ch.name[0]?.toUpperCase()}
    </div>
  );
}

// Messagerie texte. `source` = "servers" (serveurs → salons texte) ou "dms"
// (conversations privées en texte). Les deux partagent la même vue de messages.
export function TextChat({ source }: { source: "servers" | "dms" }) {
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [dms, setDms] = useState<DMChannel[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channel, setChannel] = useState<{ id: string; name: string; dm: boolean } | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charge la liste (serveurs ou MP) au montage, selon la source.
  useEffect(() => {
    if (source === "servers") {
      call<[], any>("get_text_channels")
        .then((res) => setGuilds(Array.isArray(res) ? res : []))
        .catch((e) => setError(String(e)));
    } else {
      call<[], any>("get_dm_channels")
        .then((res) => setDms(Array.isArray(res) ? res : []))
        .catch((e) => setError(String(e)));
    }
  }, [source]);

  const loadMessages = (chId: string) => {
    call<[string], any>("get_messages", chId)
      .then((res) => {
        setMessages(Array.isArray(res) ? res : []);
        scrollMsgsBottom(); // auto-scroll vers le message le plus récent
      })
      .catch(() => setMessages([]));
  };

  const openChannel = (id: string, name: string, dm: boolean) => {
    setChannel({ id, name, dm });
    setCurrentTextChannel({ id, name, dm }); // → cible du partage de capture
    setMessages(null);
    loadMessages(id);
    if (_textPoll) clearInterval(_textPoll);
    _textPoll = setInterval(() => loadMessages(id), 5000);
  };

  const closeChannel = () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setChannel(null);
    setCurrentTextChannel(null);
    setMessages(null);
    setDraft("");
  };

  useEffect(() => () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setCurrentTextChannel(null);
  }, []);

  // Toujours suivre le dernier message : re-scroll en bas dès que la liste change
  // (ouverture du salon ET chaque rafraîchissement du poll 5 s). Plus fiable que
  // le seul setTimeout dans loadMessages (qui peut tirer avant le rendu).
  useEffect(() => { if (messages) scrollMsgsBottom(); }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !channel || sending) return;
    setSending(true);
    try {
      await call("send_message", channel.id, text);
      setDraft("");
      loadMessages(channel.id);
    } catch (e) { setError(String(e)); }
    setSending(false);
  };

  // ── Vue MESSAGES d'un salon / d'une conversation ──────────────────────────
  if (channel) {
    return (
      <div>
        <Btn onClick={closeChannel} style={{ width: "100%", padding: "3px 8px", fontSize: 11, marginBottom: 4, display: "flex", gap: 6 }}>
          <span>←</span><span style={{ flex: 1, textAlign: "left" }}>{channel.dm ? channel.name : `#${channel.name}`}</span>
        </Btn>

        <div id={MSG_LIST_ID} style={{ maxHeight: 200, overflowY: "auto", marginBottom: 6, paddingRight: 2 }}>
          {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t("loading_messages")}</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_messages")}</div>}
          {messages?.map((m) => {
            const links = extractLinks(m.content || "");
            const hasBody = !!m.content || (m.images?.length ?? 0) > 0 || (m.files ?? 0) > 0;
            return (
              <div key={m.id} style={{ marginBottom: 7, fontSize: 12, lineHeight: 1.3 }}>
                <span style={{ color: colorFor(m.author_id), fontWeight: 600 }}>{m.author}</span>
                {m.bot && <span style={{ fontSize: 8, background: "#5865f2", color: "#fff", borderRadius: 3, padding: "0 3px", marginLeft: 4 }}>BOT</span>}
                <span style={{ opacity: 0.4, fontSize: 9, marginLeft: 5 }}>{shortTime(m.ts)}</span>
                {m.content
                  ? <div style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", opacity: 0.92 }}>{m.content}</div>
                  : (!hasBody && <div style={{ opacity: 0.4, fontStyle: "italic" }}>—</div>)}

                {/* Miniatures d'images : ne se chargent que lorsque ce salon est
                    ouvert (la vue messages n'est montée qu'à ce moment). Clic →
                    image en grand dans le navigateur du gamemode Steam. */}
                {m.images?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
                    {m.images.map((img, i) => (
                      <Focusable
                        key={i}
                        onActivate={() => openUrl(img.url)}
                        onClick={() => openUrl(img.url)}
                        style={{ display: "inline-block", borderRadius: 6, padding: 0, margin: 0 }}
                      >
                        <img
                          src={thumbUrl(img)}
                          style={{ width: 120, height: "auto", maxHeight: 160, display: "block", borderRadius: 6 }}
                        />
                      </Focusable>
                    ))}
                  </div>
                )}

                {/* Liens cliquables → navigateur gamemode Steam. */}
                {links.map((u, i) => (
                  <Btn key={`l${i}`} onClick={() => openUrl(u)} style={{ width: "100%", padding: "3px 8px", marginTop: 3, fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
                    <span>🔗</span><span style={{ flex: 1, textAlign: "left", color: "#00a8fc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortLink(u)}</span>
                  </Btn>
                ))}

                {m.files > 0 && <div style={{ opacity: 0.55, fontSize: 10, marginTop: 2 }}>📎 {m.files}</div>}
              </div>
            );
          })}
        </div>

        {/* Réponse : champ pleine largeur, bouton Envoyer en dessous (empilé).
            Le clavier Steam s'ouvre tout seul au focus du champ. */}
        <div>
          <TextField
            value={draft}
            placeholder={t("message_placeholder")}
            onChange={(e: any) => setDraft(e?.target?.value ?? "")}
            style={{ fontSize: 12, width: "100%" }}
          />
          <Btn
            disabled={sending || !draft.trim()}
            onClick={send}
            style={{ width: "100%", marginTop: 4, padding: "5px 0", fontSize: 12, minHeight: 0 }}
          >
            {sending ? "…" : t("send")}
          </Btn>
        </div>
        {error && <div style={{ color: "#ff6b6b", fontSize: 10, marginTop: 4 }}>{error}</div>}
      </div>
    );
  }

  // ── Vue BROWSER : conversations privées (texte) ───────────────────────────
  if (source === "dms") {
    return (
      <div>
        {error && <div style={{ padding: 8, color: "#ff6b6b", fontSize: 11 }}>{error}</div>}
        {dms === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading")}</div>}
        {dms && dms.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_dms")}</div>}
        {dms && dms.length > 0 && (
          <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 4 }}>
            {dms.map((ch) => (
              <Btn key={ch.id} onClick={() => openChannel(ch.id, ch.name, true)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "5px 8px", marginBottom: 3 }}>
                <DMAvatar ch={ch} />
                <span style={{ flex: 1, textAlign: "left", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
              </Btn>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Vue BROWSER : serveurs → salons texte ─────────────────────────────────
  return (
    <div>
      {error && <div style={{ padding: 8, color: "#ff6b6b", fontSize: 11 }}>{error}</div>}
      {guilds === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 13 }}>{t("loading_servers")}</div>}
      {guilds && guilds.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_channels")}</div>}
      {guilds && guilds.length > 0 && (
        <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 4 }}>
          {guilds.map((guild) => (
            <div key={guild.id} style={{ marginBottom: 3 }}>
              <Btn
                onClick={() => setExpanded(expanded === guild.id ? null : guild.id)}
                style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "5px 8px" }}
              >
                {guild.icon
                  ? <img src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=32`} width={18} height={18} style={{ borderRadius: "50%", flexShrink: 0 }} />
                  : <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#5865f2", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff" }}>{guild.name[0]}</div>}
                <span style={{ flex: 1, textAlign: "left", fontSize: 12 }}>{guild.name}</span>
                <span style={{ opacity: 0.4, fontSize: 10 }}>{expanded === guild.id ? "▲" : "▼"}</span>
              </Btn>
              {expanded === guild.id && (
                <div style={{ paddingLeft: 6, marginTop: 2 }}>
                  {guild.channels.map((ch) => (
                    <Btn key={ch.id} onClick={() => openChannel(ch.id, ch.name, false)} style={{ width: "100%", padding: "4px 8px", marginBottom: 2, fontSize: 11, display: "flex", gap: 6 }}>
                      <span style={{ opacity: 0.6, fontSize: 10 }}>#</span>
                      <span style={{ flex: 1, textAlign: "left" }}>{ch.name}</span>
                    </Btn>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
