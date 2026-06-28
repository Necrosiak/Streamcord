# Steamcord

**Discord in Steam Gaming Mode** — a [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for Steam Deck / Bazzite / SteamOS.

🌍 **Languages:** **English** · [Français](docs/README.fr.md) · [Deutsch](docs/README.de.md) · [Español](docs/README.es.md) · [Italiano](docs/README.it.md) · [Português](docs/README.pt.md) · [Nederlands](docs/README.nl.md) · [Polski](docs/README.pl.md) · [Русский](docs/README.ru.md)

> **Steamcord is an independent project.** It was originally inspired by
> [Deckcord](https://github.com/marios8543/Deckcord) (see Credits), but the codebase has been
> largely rewritten and now follows its own direction — it is not affiliated with or endorsed
> by that project.
>
> The plugin UI is fully translated into 9 languages and follows your SteamOS language automatically.

---

## How it works

Steamcord runs **[Vesktop](https://github.com/Vencord/Vesktop)** — a real, native Discord client — invisibly in the background, and drives it over the Chrome DevTools Protocol. The plugin injects a small client into it and exposes everything in the Steam **Quick Access Menu**.

Going native fixes the hard problems of the old hidden-browser approach: **your microphone and the voice audio work natively**, exactly as in the desktop Discord app — no capture hacks, no autoplay workarounds. Vesktop is launched (and installed if missing) automatically, stays logged in across reboots, and never needs a desktop window in Gaming Mode.

---

## Features

- **QR code login** — Scan a QR code with the Discord mobile app to log in instantly. On your phone: *Discord → Settings → Scan QR Code*, then aim at the code shown in the panel. No password typing on the Deck.
- **Fullscreen login (fallback)** — Opens Discord full-screen to log in with email/password or solve a CAPTCHA when QR isn't possible.
- **Voice chat** — Join voice channels and hear everyone, with each member shown live (speaking ring, mute/deafen badges) and a per-user volume slider (0–200%). Mic and audio are native (Vesktop).
- **Private messages (DMs & Group DMs)** — Browse your conversations and start/join voice calls with friends directly from the Quick Access Menu. Active calls are highlighted.
- **Server voice browser** — See which voice channels have people in them (with member avatars) before joining.
- **Text channels** — Read a server channel's recent messages from the QAM and reply with the Steam on-screen keyboard (it opens automatically when you focus the input).
- **Discord status** — Set your status (online / idle / do-not-disturb / invisible) from the QAM. Optional auto-sync makes Discord **follow your Steam status** in the background; picking a status by hand switches back to manual.
- **Mute / Deafen / Disconnect** — One-tap voice controls from the QAM.
- **Go Live (screen share)** — Share your whole screen to a voice channel.
- **In-game notifications** — DM and ping notifications appear as Steam toasts (and respect your Discord status — silenced when invisible / do-not-disturb).
- **Push-to-talk** — With a physical keybind (R5 by default).
- **Post screenshots** — Send a Steam screenshot to any Discord channel.
- **[Vencord](https://vencord.dev/)** is built into Vesktop, giving access to its plugin ecosystem.

---

## Installation

> **Not yet on the Decky Store.** Install manually via Developer Mode.

1. Enable **Developer Mode** in Decky → General settings
2. Go to **Developer** in Decky settings
3. Install from URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop is installed and launched automatically by the plugin the first time it runs. Just log in once (QR or fullscreen) and you stay logged in.

### Screen share
Screen sharing works out of the box — the plugin auto-installs its Python dependency (aiohttp) for the system Python on first run. GStreamer is provided by the system.

---

## Build from source

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copy dist/, main.py, defaults/, plugin.json, package.json to ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Credits

- Original project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView setup, GStreamer screen share
- [@aagaming](https://github.com/AAGaming00) — mic support via the SteamClient tab (WebRTC relay)
- [@Epictek](https://github.com/Epictek) — QR Code login foundation
- [@jessebofill](https://github.com/jessebofill) — Steam menu patching code
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — the native Discord client Steamcord drives
