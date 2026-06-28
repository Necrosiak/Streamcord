# Steamcord

**Discord en Mode Jeu Steam** — un plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) pour Steam Deck / Bazzite / SteamOS.

🌍 **Langues :** [English](../README.md) · **Français** · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord est un projet indépendant.** Il a été inspiré à l'origine par
> [Deckcord](https://github.com/marios8543/Deckcord) (voir Remerciements), mais le code a été
> largement réécrit et suit désormais sa propre direction — il n'est ni affilié, ni approuvé
> par ce projet.
>
> L'interface est entièrement traduite en 9 langues et suit automatiquement la langue de SteamOS.

---

## Comment ça marche

Steamcord lance **[Vesktop](https://github.com/Vencord/Vesktop)** — un vrai client Discord natif — invisible en arrière-plan, et le pilote via le Chrome DevTools Protocol. Le plugin y injecte un petit client et expose tout dans le **menu d'accès rapide** de Steam.

Le passage au natif règle les problèmes difficiles de l'ancienne approche par navigateur caché : **ton micro et l'audio vocal fonctionnent nativement**, exactement comme dans l'app Discord de bureau — aucun bricolage de capture, aucun contournement d'autoplay. Vesktop est lancé (et installé s'il manque) automatiquement, reste connecté après redémarrage, et n'a jamais besoin de fenêtre en mode Jeu.

---

## Fonctionnalités

- **Connexion par QR code** — Scanne un QR code avec l'app mobile Discord pour te connecter instantanément. Sur ton téléphone : *Discord → Réglages → Scanner le QR Code*, puis vise le code affiché dans le panneau. Aucun mot de passe à taper sur la Deck.
- **Connexion plein écran (secours)** — Ouvre Discord en plein écran pour se connecter par e-mail/mot de passe ou résoudre un CAPTCHA quand le QR n'est pas possible.
- **Chat vocal** — Rejoins les salons vocaux et entends tout le monde, chaque membre affiché en direct (anneau quand il parle, badges muet/sourd) et un curseur de volume par personne (0–200 %). Micro et audio natifs (Vesktop).
- **Messages privés (MP & groupes)** — Parcours tes conversations et lance/rejoins des appels vocaux avec tes amis directement depuis le menu d'accès rapide. Les appels actifs sont mis en évidence.
- **Explorateur vocal des serveurs** — Vois quels salons vocaux ont du monde (avec les avatars) avant de rejoindre.
- **Salons textuels** — Lis les messages récents d'un salon de serveur depuis le QAM et réponds avec le clavier à l'écran de Steam (il s'ouvre tout seul au focus du champ).
- **Statut Discord** — Règle ton statut (en ligne / absent / ne pas déranger / invisible) depuis le QAM. Une synchro auto optionnelle fait **suivre ton statut Steam** par Discord en arrière-plan ; choisir un statut à la main repasse en manuel.
- **Muet / Sourdine / Déconnexion** — Contrôles vocaux en un appui depuis le QAM.
- **Go Live (partage d'écran)** — Partage ton écran entier dans un salon vocal.
- **Notifications en jeu** — Les MP et mentions apparaissent en notifications Steam (et respectent ton statut Discord — silencieuses en invisible / ne pas déranger).
- **Push-to-talk** — Avec un raccourci physique (R5 par défaut).
- **Envoi de captures** — Envoie une capture Steam dans n'importe quel salon Discord.
- **[Vencord](https://vencord.dev/)** est intégré à Vesktop, donnant accès à son écosystème de plugins.

---

## Installation

> **Pas encore sur le Decky Store.** Installation manuelle via le mode développeur.

1. Active le **mode développeur** dans Decky → Réglages généraux
2. Va dans **Développeur** dans les réglages Decky
3. Installe depuis l'URL :
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop est installé et lancé automatiquement par le plugin au premier démarrage. Connecte-toi une seule fois (QR ou plein écran) et tu restes connecté.

### Prérequis (partage d'écran)
Le partage d'écran fonctionne tout seul — le plugin installe automatiquement sa dépendance Python (aiohttp) au premier lancement. GStreamer est fourni par le système.

---

## Compiler depuis les sources

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copier dist/, main.py, defaults/, plugin.json, package.json vers ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Remerciements

- Projet original : [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architecture, BrowserView, partage d'écran GStreamer
- [@aagaming](https://github.com/AAGaming00) — support du micro via l'onglet SteamClient (relais WebRTC)
- [@Epictek](https://github.com/Epictek) — base de la connexion par QR Code
- [@jessebofill](https://github.com/jessebofill) — code de patch du menu Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — le client Discord natif que Steamcord pilote
