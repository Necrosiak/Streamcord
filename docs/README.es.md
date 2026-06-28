# Steamcord

**Discord en el Modo Juego de Steam** — un plugin de [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) para Steam Deck / Bazzite / SteamOS.

🌍 **Idiomas:** [English](../README.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Español** · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [Русский](README.ru.md)

> **Steamcord es un proyecto independiente.** Originalmente se inspiró en
> [Deckcord](https://github.com/marios8543/Deckcord) (ver Créditos), pero el código se ha
> reescrito en gran parte y ahora sigue su propia dirección — no está afiliado ni respaldado
> por ese proyecto.
>
> La interfaz está totalmente traducida a 9 idiomas y sigue automáticamente el idioma de SteamOS.

---

## Cómo funciona

Steamcord ejecuta **[Vesktop](https://github.com/Vencord/Vesktop)** — un cliente de Discord nativo de verdad — invisible en segundo plano, y lo controla mediante el Chrome DevTools Protocol. El plugin le inyecta un pequeño cliente y expone todo en el **menú de acceso rápido** de Steam.

Pasar a nativo resuelve los problemas difíciles del antiguo enfoque de navegador oculto: **tu micrófono y el audio de voz funcionan de forma nativa**, igual que en la app de escritorio de Discord — sin trucos de captura ni rodeos de reproducción automática. Vesktop se inicia (y se instala si falta) automáticamente, mantiene la sesión tras reiniciar y nunca necesita una ventana de escritorio en el Modo Juego.

---

## Funciones

- **Inicio de sesión con código QR** — Escanea un código QR con la app móvil de Discord para entrar al instante. En tu teléfono: *Discord → Ajustes → Escanear código QR*, luego apunta al código del panel. Sin escribir contraseñas en la Deck.
- **Inicio de sesión en pantalla completa (alternativa)** — Abre Discord en pantalla completa para entrar con correo/contraseña o resolver un CAPTCHA cuando el QR no es posible.
- **Chat de voz** — Únete a canales de voz y escucha a todos, con cada miembro mostrado en vivo (anillo al hablar, distintivos de silencio/ensordecer) y un control de volumen por persona (0–200 %). Micrófono y audio nativos (Vesktop).
- **Mensajes directos (MD y grupos)** — Explora tus conversaciones e inicia/únete a llamadas de voz con amigos directamente desde el menú de acceso rápido. Las llamadas activas se resaltan.
- **Explorador de voz de servidores** — Mira qué canales de voz tienen gente (con avatares) antes de unirte.
- **Canales de texto** — Lee los mensajes recientes de un canal de servidor desde el QAM y responde con el teclado en pantalla de Steam (se abre solo al enfocar el campo).
- **Estado de Discord** — Configura tu estado (en línea / ausente / no molestar / invisible) desde el QAM. Una sincronización automática opcional hace que Discord **siga tu estado de Steam** en segundo plano; elegir un estado a mano vuelve al modo manual.
- **Silenciar / Ensordecer / Desconectar** — Controles de voz con un toque desde el QAM.
- **Go Live (compartir pantalla)** — Comparte toda tu pantalla en un canal de voz.
- **Notificaciones en el juego** — Los MD y menciones aparecen como notificaciones de Steam (y respetan tu estado de Discord — silenciadas en invisible / no molestar).
- **Pulsar para hablar** — Con una tecla física (R5 por defecto).
- **Enviar capturas** — Envía una captura de Steam a cualquier canal de Discord.
- **[Vencord](https://vencord.dev/)** está integrado en Vesktop, dando acceso a su ecosistema de plugins.

---

## Instalación

> **Aún no está en la Decky Store.** Instalación manual mediante el modo desarrollador.

1. Activa el **modo desarrollador** en Decky → Ajustes generales
2. Ve a **Desarrollador** en los ajustes de Decky
3. Instala desde la URL:
   `https://github.com/Necrosiak/Steamcord/releases/latest/download/Steamcord.zip`

Vesktop se instala y se inicia automáticamente con el plugin la primera vez. Solo inicia sesión una vez (QR o pantalla completa) y permaneces conectado.

### Requisito (compartir pantalla)
La pantalla compartida funciona de inmediato: el complemento instala automáticamente su dependencia de Python (aiohttp) en el primer arranque. GStreamer lo proporciona el sistema.

---

## Compilar desde el código fuente

```bash
git clone https://github.com/Necrosiak/Steamcord
cd Steamcord
pnpm install
pnpm run build
# copia dist/, main.py, defaults/, plugin.json, package.json a ~/homebrew/plugins/Steamcord/
sudo systemctl restart plugin_loader
```

---

## Créditos

- Proyecto original: [marios8543/Deckcord](https://github.com/marios8543/Deckcord) — arquitectura, BrowserView, compartir pantalla con GStreamer
- [@aagaming](https://github.com/AAGaming00) — soporte de micrófono vía la pestaña SteamClient (relé WebRTC)
- [@Epictek](https://github.com/Epictek) — base del inicio de sesión con QR
- [@jessebofill](https://github.com/jessebofill) — código de parcheo del menú de Steam
- [Vesktop / Vencord](https://github.com/Vencord/Vesktop) — el cliente de Discord nativo que controla Steamcord
