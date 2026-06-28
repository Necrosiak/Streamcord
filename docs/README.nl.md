# Steamcord

**Discord in de Steam-spelmodus** — een [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)-plugin voor Steam Deck / Bazzite / SteamOS.

🌍 **Talen:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · **Nederlands** · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord is een onafhankelijk project.** Het werd oorspronkelijk geïnspireerd door
> [Deckcord](https://github.com/marios8543/Deckcord) (zie Met dank aan), maar de code is
> grotendeels herschreven en volgt nu zijn eigen richting — het is niet verbonden met of
> goedgekeurd door dat project.
>
> De interface is volledig vertaald in 9 talen en volgt automatisch je SteamOS-taal.

---

## Hoe het werkt

Steamcord start **[Vesktop](https://github.com/Vencord/Vesktop)** — een echte, native Discord-client — onzichtbaar op de achtergrond, en stuurt het aan via het Chrome DevTools Protocol. De plugin injecteert er een kleine client in en toont alles in het **snelmenu** van Steam.

Overstappen op native lost de moeilijke problemen van de oude verborgen-browseraanpak op: **je microfoon en de spraakaudio werken native**, precies zoals in de Discord-desktopapp — geen capture-trucs, geen autoplay-omwegen. Vesktop wordt automatisch gestart (en geïnstalleerd indien afwezig), blijft ingelogd na een herstart en heeft in de spelmodus nooit een bureaubladvenster nodig.

---

## Functies

- **Aanmelden met QR-code** — Scan een QR-code met de Discord-app op je telefoon om direct in te loggen. Op je telefoon: *Discord → Instellingen → QR-code scannen*, richt dan op de code in het paneel. Geen wachtwoord typen op de Deck.
- **Volledig scherm aanmelden (terugval)** — Opent Discord op volledig scherm om in te loggen met e-mail/wachtwoord of een CAPTCHA op te lossen wanneer QR niet mogelijk is.
- **Spraakchat** — Word lid van spraakkanalen en hoor iedereen, met elk lid live weergegeven (sprekring, mute/doof-badges) en een volumeschuif per persoon (0–200 %). Microfoon en audio zijn native (Vesktop).
- **Privéberichten (DM's & groeps-DM's)** — Blader door je gesprekken en start/neem deel aan spraakoproepen met vrienden rechtstreeks vanuit het snelmenu. Actieve oproepen worden gemarkeerd.
- **Spraakbrowser voor servers** — Zie in welke spraakkanalen mensen zitten (met avatars) voordat je deelneemt.
- **Tekstkanalen** — Lees de recente berichten van een serverkanaal vanuit het QAM en antwoord met het schermtoetsenbord van Steam (het opent vanzelf wanneer je het invoerveld focust).
- **Discord-status** — Stel je status in (online / afwezig / niet storen / onzichtbaar) vanuit het QAM. Een optionele automatische synchronisatie laat Discord je **Steam-status volgen** op de achtergrond; een status met de hand kiezen schakelt terug naar handmatig.
- **Mute / Doof / Verbinding verbreken** — Spraakbediening met één tik vanuit het QAM.
- **Go Live (scherm delen)** — Deel je hele scherm in een spraakkanaal.
- **Meldingen in het spel** — DM- en ping-meldingen verschijnen als Steam-meldingen (en respecteren je Discord-status — gedempt bij onzichtbaar / niet storen).
- **Push-to-talk** — Met een fysieke toets (standaard R5).
- **Schermafbeeldingen versturen** — Stuur een Steam-schermafbeelding naar elk Discord-kanaal.
- **[Vencord](https://vencord.dev/)** is ingebouwd in Vesktop en geeft toegang tot zijn plugin-ecosysteem.

---

## Installatie

> **Nog niet in de Decky Store.** Handmatige installatie via de ontwikkelaarsmodus.

1. Schakel de **ontwikkelaarsmodus** in via Decky → Algemene instellingen
2. Ga naar **Ontwikkelaar** in de Decky-instellingen
3. Installeer vanaf de URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop wordt de eerste keer automatisch door de plugin geïnstalleerd en gestart. Log één keer in (QR of volledig scherm) en je blijft ingelogd.

### Vereiste (scherm delen)
Schermdelen werkt meteen — de plugin installeert zijn Python-afhankelijkheid (aiohttp) automatisch bij de eerste start. GStreamer komt van het systeem.

---

## Vanaf de broncode bouwen

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# kopieer dist/, main.py, defaults/, plugin.json, package.json naar ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Met dank aan

- Origineel project: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architectuur, BrowserView, GStreamer scherm delen
- [@aagaming](https://github.com/AAGaming00) — microfoonondersteuning via de SteamClient-tab (WebRTC-relay)
- [@Epictek](https://github.com/Epictek) — basis van het aanmelden met QR-code
- [@jessebofill](https://github.com/jessebofill) — code voor het patchen van het Steam-menu
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — de native Discord-client die Steamcord aanstuurt
