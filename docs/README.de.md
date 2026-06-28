# Steamcord

**Discord im Steam-Spielmodus** — ein [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)-Plugin für Steam Deck / Bazzite / SteamOS.

🌍 **Sprachen:** [English](../README.md) · [Français](README.fr.md) · **Deutsch** · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord ist ein unabhängiges Projekt.** Es wurde ursprünglich von
> [Deckcord](https://github.com/marios8543/Deckcord) inspiriert (siehe Danksagungen), aber der Code
> wurde weitgehend neu geschrieben und folgt nun seiner eigenen Richtung — es ist nicht mit
> diesem Projekt verbunden oder von ihm befürwortet.
>
> Die Oberfläche ist vollständig in 9 Sprachen übersetzt und folgt automatisch deiner SteamOS-Sprache.

---

## Wie es funktioniert

Steamcord startet **[Vesktop](https://github.com/Vencord/Vesktop)** — einen echten, nativen Discord-Client — unsichtbar im Hintergrund und steuert ihn über das Chrome DevTools Protocol. Das Plugin injiziert einen kleinen Client und stellt alles im **Schnellzugriffsmenü** von Steam bereit.

Der Wechsel zu nativem Code löst die schwierigen Probleme des alten Ansatzes mit verstecktem Browser: **dein Mikrofon und der Sprachton funktionieren nativ**, genau wie in der Discord-Desktop-App — keine Erfassungs-Tricks, keine Autoplay-Umgehungen. Vesktop wird automatisch gestartet (und installiert, falls nicht vorhanden), bleibt über Neustarts hinweg angemeldet und braucht im Spielmodus nie ein Desktop-Fenster.

---

## Funktionen

- **QR-Code-Anmeldung** — Scanne einen QR-Code mit der Discord-Handy-App, um dich sofort anzumelden. Auf deinem Handy: *Discord → Einstellungen → QR-Code scannen*, dann auf den im Panel angezeigten Code richten. Kein Passwort-Tippen auf dem Deck.
- **Vollbild-Anmeldung (Ausweichlösung)** — Öffnet Discord im Vollbild zur Anmeldung mit E-Mail/Passwort oder zum Lösen eines CAPTCHAs, wenn QR nicht möglich ist.
- **Sprachchat** — Tritt Sprachkanälen bei und höre alle, jedes Mitglied live angezeigt (Sprechring, Stumm-/Taub-Abzeichen) mit Lautstärkeregler pro Person (0–200 %). Mikrofon und Ton sind nativ (Vesktop).
- **Direktnachrichten (DMs & Gruppen-DMs)** — Durchsuche deine Unterhaltungen und starte/tritt Sprachanrufen mit Freunden direkt aus dem Schnellzugriffsmenü bei. Aktive Anrufe werden hervorgehoben.
- **Server-Sprachbrowser** — Sieh, in welchen Sprachkanälen Leute sind (mit Avataren), bevor du beitrittst.
- **Textkanäle** — Lies die letzten Nachrichten eines Serverkanals im QAM und antworte mit der Steam-Bildschirmtastatur (sie öffnet sich automatisch, wenn du das Eingabefeld fokussierst).
- **Discord-Status** — Setze deinen Status (online / abwesend / bitte nicht stören / unsichtbar) im QAM. Eine optionale Auto-Synchronisierung lässt Discord deinem **Steam-Status folgen** (im Hintergrund); wählst du einen Status von Hand, wird wieder manuell umgeschaltet.
- **Stumm / Taub / Trennen** — Sprachsteuerung mit einem Tippen aus dem QAM.
- **Go Live (Bildschirmübertragung)** — Teile deinen ganzen Bildschirm in einem Sprachkanal.
- **Benachrichtigungen im Spiel** — DM- und Ping-Benachrichtigungen erscheinen als Steam-Toasts (und respektieren deinen Discord-Status — stumm bei unsichtbar / bitte nicht stören).
- **Push-to-Talk** — Mit physischer Tastenbelegung (R5 standardmäßig).
- **Screenshots senden** — Sende einen Steam-Screenshot an jeden Discord-Kanal.
- **[Vencord](https://vencord.dev/)** ist in Vesktop integriert und gibt Zugang zu seinem Plugin-Ökosystem.

---

## Installation

> **Noch nicht im Decky Store.** Manuelle Installation über den Entwicklermodus.

1. Aktiviere den **Entwicklermodus** in Decky → Allgemeine Einstellungen
2. Gehe zu **Entwickler** in den Decky-Einstellungen
3. Installiere von der URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop wird beim ersten Start automatisch vom Plugin installiert und gestartet. Melde dich einmal an (QR oder Vollbild) und du bleibst angemeldet.

### Voraussetzung (Bildschirmübertragung)
Die Bildschirmfreigabe funktioniert sofort — das Plugin installiert seine Python-Abhängigkeit (aiohttp) beim ersten Start automatisch. GStreamer kommt vom System.

---

## Aus dem Quellcode bauen

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# dist/, main.py, defaults/, plugin.json, package.json nach ~/homebrew/plugins/Steamcord/ kopieren
sudo systemctl restart plugin_loader
```

---

## Danksagungen

- Ursprüngliches Projekt: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — Architektur, BrowserView, GStreamer-Bildschirmübertragung
- [@aagaming](https://github.com/AAGaming00) — Mikrofon-Unterstützung über den SteamClient-Tab (WebRTC-Relay)
- [@Epictek](https://github.com/Epictek) — Grundlage der QR-Code-Anmeldung
- [@jessebofill](https://github.com/jessebofill) — Code für das Steam-Menü-Patching
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — der native Discord-Client, den Steamcord steuert
