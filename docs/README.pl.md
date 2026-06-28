# Steamcord

**Discord w trybie gry Steam** — wtyczka [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) dla Steam Deck / Bazzite / SteamOS.

🌍 **Języki:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · **Polski** · [Русский](README.ru.md)

> **Steamcord to niezależny projekt.** Pierwotnie zainspirowany przez
> [Deckcord](https://github.com/marios8543/Deckcord) (zobacz Podziękowania), ale kod został
> w dużej części przepisany i podąża teraz własną drogą — nie jest powiązany z tym projektem
> ani przez niego zatwierdzony.
>
> Interfejs jest w pełni przetłumaczony na 9 języków i automatycznie podąża za językiem SteamOS.

---

## Jak to działa

Steamcord uruchamia **[Vesktop](https://github.com/Vencord/Vesktop)** — prawdziwego, natywnego klienta Discord — niewidocznie w tle i steruje nim przez Chrome DevTools Protocol. Wtyczka wstrzykuje do niego mały klient i udostępnia wszystko w **menu szybkiego dostępu** Steam.

Przejście na natywność rozwiązuje trudne problemy starego podejścia z ukrytą przeglądarką: **twój mikrofon i dźwięk głosowy działają natywnie**, dokładnie jak w desktopowej aplikacji Discord — bez sztuczek przechwytywania, bez obejść autoodtwarzania. Vesktop jest uruchamiany (i instalowany, jeśli go brak) automatycznie, pozostaje zalogowany po restarcie i nigdy nie potrzebuje okna pulpitu w trybie gry.

---

## Funkcje

- **Logowanie kodem QR** — Zeskanuj kod QR aplikacją Discord na telefonie, aby zalogować się natychmiast. Na telefonie: *Discord → Ustawienia → Skanuj kod QR*, a następnie wyceluj w kod pokazany w panelu. Bez wpisywania hasła na Decku.
- **Logowanie na pełnym ekranie (zapasowe)** — Otwiera Discord na pełnym ekranie, aby zalogować się e-mailem/hasłem lub rozwiązać CAPTCHA, gdy QR nie jest możliwy.
- **Czat głosowy** — Dołączaj do kanałów głosowych i słysz wszystkich, każdy członek pokazany na żywo (pierścień mówienia, plakietki wyciszenia/ogłuszenia) oraz suwak głośności na osobę (0–200 %). Mikrofon i dźwięk są natywne (Vesktop).
- **Wiadomości prywatne (DM i grupy)** — Przeglądaj rozmowy oraz rozpoczynaj/dołączaj do połączeń głosowych ze znajomymi bezpośrednio z menu szybkiego dostępu. Aktywne połączenia są wyróżnione.
- **Przeglądarka głosowa serwerów** — Zobacz, w których kanałach głosowych są ludzie (z awatarami), zanim dołączysz.
- **Kanały tekstowe** — Czytaj ostatnie wiadomości kanału serwera z poziomu QAM i odpowiadaj klawiaturą ekranową Steam (otwiera się sama po zaznaczeniu pola).
- **Status Discord** — Ustaw swój status (online / zaraz wracam / nie przeszkadzać / niewidoczny) z poziomu QAM. Opcjonalna automatyczna synchronizacja sprawia, że Discord **podąża za twoim statusem Steam** w tle; ręczny wybór statusu przełącza z powrotem na tryb ręczny.
- **Wycisz / Ogłusz / Rozłącz** — Sterowanie głosem jednym dotknięciem z QAM.
- **Go Live (udostępnianie ekranu)** — Udostępnij cały ekran na kanale głosowym.
- **Powiadomienia w grze** — DM-y i wzmianki pojawiają się jako powiadomienia Steam (i respektują twój status Discord — wyciszone przy niewidoczny / nie przeszkadzać).
- **Push-to-talk** — Z fizycznym przyciskiem (domyślnie R5).
- **Wysyłanie zrzutów ekranu** — Wyślij zrzut ekranu Steam na dowolny kanał Discord.
- **[Vencord](https://vencord.dev/)** jest wbudowany w Vesktop, dając dostęp do swojego ekosystemu wtyczek.

---

## Instalacja

> **Jeszcze nie ma w Decky Store.** Instalacja ręczna w trybie deweloperskim.

1. Włącz **tryb deweloperski** w Decky → Ustawienia ogólne
2. Przejdź do **Deweloper** w ustawieniach Decky
3. Zainstaluj z adresu URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop jest instalowany i uruchamiany automatycznie przez wtyczkę przy pierwszym uruchomieniu. Wystarczy zalogować się raz (QR lub pełny ekran) i pozostajesz zalogowany.

### Wymaganie (udostępnianie ekranu)
Udostępnianie ekranu działa od razu — wtyczka automatycznie instaluje zależność Pythona (aiohttp) przy pierwszym uruchomieniu. GStreamer pochodzi z systemu.

---

## Budowanie ze źródeł

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# skopiuj dist/, main.py, defaults/, plugin.json, package.json do ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Podziękowania

- Oryginalny projekt: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — architektura, BrowserView, udostępnianie ekranu GStreamer
- [@aagaming](https://github.com/AAGaming00) — obsługa mikrofonu przez kartę SteamClient (przekazywanie WebRTC)
- [@Epictek](https://github.com/Epictek) — podstawa logowania kodem QR
- [@jessebofill](https://github.com/jessebofill) — kod łatania menu Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — natywny klient Discord, którym steruje Steamcord
