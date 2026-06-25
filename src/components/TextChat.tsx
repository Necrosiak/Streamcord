import { DialogButton, Focusable, TextField } from "@decky/ui";
import { call } from "@decky/api";
import { useEffect, useState } from "react";
import { t } from "../i18n";

// Intervalle de polling au niveau module (évite useRef — déconseillé dans le
// QAM DeckyLoader). Une seule instance de TextChat à la fois.
let _textPoll: any = null;
const MSG_LIST_ID = "streamcord-msglist";
const scrollMsgsBottom = () => {
  setTimeout(() => {
    const el = document.getElementById(MSG_LIST_ID);
    if (el) el.scrollTop = el.scrollHeight;
  }, 50);
};

interface TextChannel { id: string; name: string; type: number; }
interface Guild { id: string; name: string; icon: string | null; channels: TextChannel[]; }
interface Message {
  id: string; author: string; author_id: string; avatar: string | null;
  bot: boolean; content: string; ts: string | null; attachments: number;
}

const Btn = DialogButton as any;

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

export function TextChat() {
  const [open, setOpen] = useState(false);
  const [guilds, setGuilds] = useState<Guild[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channel, setChannel] = useState<{ id: string; name: string } | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Charge la liste des serveurs/salons à la 1re ouverture de la section.
  useEffect(() => {
    if (open && guilds === null) {
      call<[], any>("get_text_channels")
        .then((res) => setGuilds(Array.isArray(res) ? res : []))
        .catch((e) => setError(String(e)));
    }
  }, [open]);

  const loadMessages = (chId: string) => {
    call<[string], any>("get_messages", chId)
      .then((res) => {
        setMessages(Array.isArray(res) ? res : []);
        scrollMsgsBottom(); // auto-scroll vers le message le plus récent
      })
      .catch(() => setMessages([]));
  };

  const openChannel = (ch: TextChannel) => {
    setChannel({ id: ch.id, name: ch.name });
    setMessages(null);
    loadMessages(ch.id);
    if (_textPoll) clearInterval(_textPoll);
    _textPoll = setInterval(() => loadMessages(ch.id), 5000);
  };

  const closeChannel = () => {
    if (_textPoll) { clearInterval(_textPoll); _textPoll = null; }
    setChannel(null);
    setMessages(null);
    setDraft("");
  };

  useEffect(() => () => { if (_textPoll) { clearInterval(_textPoll); _textPoll = null; } }, []);

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

  // ── En-tête de section (toujours visible) ─────────────────────────────────
  const header = (
    <Btn
      onClick={() => setOpen((o) => !o)}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "5px 8px" }}
    >
      <span style={{ flex: 1, textAlign: "left", fontSize: 12 }}>💬 {t("text_messages")}</span>
      <span style={{ opacity: 0.4, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
    </Btn>
  );

  if (!open) return header;

  // ── Vue MESSAGES d'un salon ───────────────────────────────────────────────
  if (channel) {
    return (
      <div>
        {header}
        <Btn onClick={closeChannel} style={{ width: "100%", padding: "3px 8px", fontSize: 11, marginBottom: 4, display: "flex", gap: 6 }}>
          <span>←</span><span style={{ flex: 1, textAlign: "left" }}>#{channel.name}</span>
        </Btn>

        <div id={MSG_LIST_ID} style={{ maxHeight: 200, overflowY: "auto", marginBottom: 6, paddingRight: 2 }}>
          {messages === null && <div style={{ padding: 8, opacity: 0.6, fontSize: 12 }}>{t("loading_messages")}</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5, fontSize: 12 }}>{t("no_messages")}</div>}
          {messages?.map((m) => (
            <div key={m.id} style={{ marginBottom: 5, fontSize: 12, lineHeight: 1.3 }}>
              <span style={{ color: colorFor(m.author_id), fontWeight: 600 }}>{m.author}</span>
              {m.bot && <span style={{ fontSize: 8, background: "#5865f2", color: "#fff", borderRadius: 3, padding: "0 3px", marginLeft: 4 }}>BOT</span>}
              <span style={{ opacity: 0.4, fontSize: 9, marginLeft: 5 }}>{shortTime(m.ts)}</span>
              <div style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", opacity: 0.92 }}>
                {m.content || (m.attachments > 0 ? `📎 ${m.attachments}` : <span style={{ opacity: 0.4, fontStyle: "italic" }}>—</span>)}
              </div>
            </div>
          ))}
        </div>

        {/* Réponse : le clavier Steam s'ouvre tout seul au focus du champ. */}
        <Focusable style={{ display: "flex", gap: 4, alignItems: "center" }} flow-children="horizontal">
          <div style={{ flex: 1 }}>
            <TextField
              value={draft}
              placeholder={t("message_placeholder")}
              onChange={(e: any) => setDraft(e?.target?.value ?? "")}
              style={{ fontSize: 12 }}
            />
          </div>
          <Btn
            disabled={sending || !draft.trim()}
            onClick={send}
            style={{ padding: "4px 10px", fontSize: 12, minHeight: 0 }}
          >
            {sending ? "…" : t("send")}
          </Btn>
        </Focusable>
        {error && <div style={{ color: "#ff6b6b", fontSize: 10, marginTop: 4 }}>{error}</div>}
      </div>
    );
  }

  // ── Vue BROWSER serveurs → salons texte ───────────────────────────────────
  return (
    <div>
      {header}
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
                    <Btn key={ch.id} onClick={() => openChannel(ch)} style={{ width: "100%", padding: "4px 8px", marginBottom: 2, fontSize: 11, display: "flex", gap: 6 }}>
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
