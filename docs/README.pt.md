# Steamcord

**Discord no Modo Jogo do Steam** — um plugin [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) para Steam Deck / Bazzite / SteamOS.

🌍 **Idiomas:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Italiano](README.it.md) · **Português** · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord é um projeto independente.** Foi originalmente inspirado pelo
> [Deckcord](https://github.com/marios8543/Deckcord) (ver Créditos), mas o código foi
> amplamente reescrito e agora segue sua própria direção — não é afiliado nem endossado
> por esse projeto.
>
> A interface está totalmente traduzida em 9 idiomas e segue automaticamente o idioma do SteamOS.

---

## Como funciona

O Steamcord executa o **[Vesktop](https://github.com/Vencord/Vesktop)** — um cliente Discord nativo de verdade — invisível em segundo plano, e o controla pelo Chrome DevTools Protocol. O plugin injeta um pequeno cliente nele e expõe tudo no **menu de acesso rápido** do Steam.

Ir para o nativo resolve os problemas difíceis da antiga abordagem de navegador oculto: **seu microfone e o áudio de voz funcionam de forma nativa**, exatamente como no app de desktop do Discord — sem truques de captura, sem contornos de autoplay. O Vesktop é iniciado (e instalado se faltar) automaticamente, mantém o login após reiniciar e nunca precisa de uma janela de desktop no Modo Jogo.

---

## Funcionalidades

- **Login por código QR** — Escaneie um código QR com o app do Discord no celular para entrar na hora. No celular: *Discord → Configurações → Ler código QR*, depois aponte para o código mostrado no painel. Sem digitar senha no Deck.
- **Login em tela cheia (alternativa)** — Abre o Discord em tela cheia para entrar com e-mail/senha ou resolver um CAPTCHA quando o QR não é possível.
- **Chat de voz** — Entre em canais de voz e ouça todos, com cada membro mostrado ao vivo (anel ao falar, selos de mudo/sem áudio) e um controle de volume por pessoa (0–200 %). Microfone e áudio nativos (Vesktop).
- **Mensagens diretas (DMs e grupos)** — Navegue pelas suas conversas e inicie/entre em chamadas de voz com amigos direto pelo menu de acesso rápido. Chamadas ativas são destacadas.
- **Navegador de voz dos servidores** — Veja quais canais de voz têm pessoas (com avatares) antes de entrar.
- **Canais de texto** — Leia as mensagens recentes de um canal de servidor pelo QAM e responda com o teclado na tela do Steam (ele abre sozinho ao focar o campo).
- **Status do Discord** — Defina seu status (online / ausente / não perturbe / invisível) pelo QAM. Uma sincronização automática opcional faz o Discord **seguir o seu status do Steam** em segundo plano; escolher um status manualmente volta ao modo manual.
- **Mudo / Sem áudio / Desconectar** — Controles de voz com um toque pelo QAM.
- **Go Live (compartilhar tela)** — Compartilhe sua tela inteira em um canal de voz.
- **Notificações no jogo** — DMs e menções aparecem como notificações do Steam (e respeitam seu status do Discord — silenciadas em invisível / não perturbe).
- **Push-to-talk** — Com uma tecla física (R5 por padrão).
- **Enviar capturas** — Envie uma captura do Steam para qualquer canal do Discord.
- **[Vencord](https://vencord.dev/)** está integrado no Vesktop, dando acesso ao seu ecossistema de plugins.

---

## Instalação

> **Ainda não está na Decky Store.** Instalação manual pelo modo desenvolvedor.

1. Ative o **modo desenvolvedor** em Decky → Configurações gerais
2. Vá em **Desenvolvedor** nas configurações do Decky
3. Instale pela URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

O Vesktop é instalado e iniciado automaticamente pelo plugin na primeira vez. Basta fazer login uma vez (QR ou tela cheia) e você permanece conectado.

### Requisito (compartilhamento de tela)
A partilha de ecrã funciona logo — o plugin instala automaticamente a sua dependência Python (aiohttp) no primeiro arranque. O GStreamer é fornecido pelo sistema.

---

## Compilar a partir do código

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copie dist/, main.py, defaults/, plugin.json, package.json para ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Créditos

- Projeto original: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — arquitetura, BrowserView, compartilhamento de tela GStreamer
- [@aagaming](https://github.com/AAGaming00) — suporte de microfone via a aba SteamClient (relé WebRTC)
- [@Epictek](https://github.com/Epictek) — base do login por QR Code
- [@jessebofill](https://github.com/jessebofill) — código de patch do menu do Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — o cliente Discord nativo que o Steamcord controla
