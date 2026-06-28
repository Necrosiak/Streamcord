# Steamcord

**Discord nella Modalità Gioco di Steam** — un plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) per Steam Deck / Bazzite / SteamOS.

🌍 **Lingue:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Italiano** · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord è un progetto indipendente.** È stato inizialmente ispirato da
> [Deckcord](https://github.com/marios8543/Deckcord) (vedi Ringraziamenti), ma il codice è stato
> ampiamente riscritto e ora segue la propria direzione — non è affiliato né approvato da
> quel progetto.
>
> L'interfaccia è completamente tradotta in 9 lingue e segue automaticamente la lingua di SteamOS.

---

## Come funziona

Steamcord avvia **[Vesktop](https://github.com/Vencord/Vesktop)** — un vero client Discord nativo — invisibile in background, e lo pilota tramite il Chrome DevTools Protocol. Il plugin vi inietta un piccolo client ed espone tutto nel **menu di accesso rapido** di Steam.

Il passaggio al nativo risolve i problemi difficili del vecchio approccio a browser nascosto: **il tuo microfono e l'audio vocale funzionano in modo nativo**, esattamente come nell'app desktop di Discord — niente trucchi di cattura, niente aggiramenti dell'autoplay. Vesktop viene avviato (e installato se manca) automaticamente, resta connesso dopo i riavvii e non ha mai bisogno di una finestra desktop in Modalità Gioco.

---

## Funzioni

- **Accesso con codice QR** — Scansiona un codice QR con l'app mobile di Discord per accedere all'istante. Sul telefono: *Discord → Impostazioni → Scansiona QR Code*, poi inquadra il codice mostrato nel pannello. Nessuna password da digitare sulla Deck.
- **Accesso a schermo intero (alternativa)** — Apre Discord a schermo intero per accedere con email/password o risolvere un CAPTCHA quando il QR non è possibile.
- **Chat vocale** — Entra nei canali vocali e ascolta tutti, con ogni membro mostrato in tempo reale (anello quando parla, badge muto/audio disattivato) e un cursore del volume per persona (0–200 %). Microfono e audio nativi (Vesktop).
- **Messaggi diretti (MP e gruppi)** — Sfoglia le tue conversazioni e avvia/entra in chiamate vocali con gli amici direttamente dal menu di accesso rapido. Le chiamate attive sono evidenziate.
- **Browser vocale dei server** — Vedi quali canali vocali hanno persone (con gli avatar) prima di entrare.
- **Canali di testo** — Leggi i messaggi recenti di un canale di un server dal QAM e rispondi con la tastiera a schermo di Steam (si apre da sola quando metti a fuoco il campo).
- **Stato Discord** — Imposta il tuo stato (online / inattivo / non disturbare / invisibile) dal QAM. Una sincronizzazione automatica opzionale fa **seguire a Discord il tuo stato Steam** in background; scegliere uno stato a mano torna alla modalità manuale.
- **Muto / Audio disattivato / Disconnetti** — Controlli vocali con un tocco dal QAM.
- **Go Live (condivisione schermo)** — Condividi l'intero schermo in un canale vocale.
- **Notifiche in gioco** — MP e menzioni appaiono come notifiche di Steam (e rispettano il tuo stato Discord — silenziate quando invisibile / non disturbare).
- **Push-to-talk** — Con un tasto fisico (R5 di default).
- **Invio di screenshot** — Invia uno screenshot di Steam a qualsiasi canale Discord.
- **[Vencord](https://vencord.dev/)** è integrato in Vesktop, dando accesso al suo ecosistema di plugin.

---

## Installazione

> **Non ancora sul Decky Store.** Installazione manuale tramite la modalità sviluppatore.

1. Attiva la **modalità sviluppatore** in Decky → Impostazioni generali
2. Vai su **Sviluppatore** nelle impostazioni di Decky
3. Installa dall'URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop viene installato e avviato automaticamente dal plugin al primo avvio. Accedi una sola volta (QR o schermo intero) e resti connesso.

### Requisito (condivisione schermo)
La condivisione dello schermo funziona subito: il plugin installa automaticamente la sua dipendenza Python (aiohttp) al primo avvio. GStreamer è fornito dal sistema.

---

## Compilare dai sorgenti

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json in ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Ringraziamenti

- Progetto originale: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architettura, BrowserView, condivisione schermo GStreamer
- [@aagaming](https://github.com/AAGaming00) — supporto microfono tramite la scheda SteamClient (relay WebRTC)
- [@Epictek](https://github.com/Epictek) — base dell'accesso con QR Code
- [@jessebofill](https://github.com/jessebofill) — codice per il patching del menu Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — il client Discord nativo che Steamcord pilota
