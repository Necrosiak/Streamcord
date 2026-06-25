"""Vesktop (native Discord) manager: launch it headless with remote debugging,
connect via CDP, get past the first-launch screen, and inject our client. Used
instead of the Steam CEF BrowserView so the microphone works natively."""

import os
from asyncio import sleep, create_subprocess_exec
from subprocess import DEVNULL
from pathlib import Path
from aiohttp import ClientSession  # type: ignore

from tab_utils.cdp import Tab

VESKTOP_CDP = "http://127.0.0.1:9223"
VESKTOP_APP = "dev.vencord.Vesktop"


async def _cdp_json(path):
    async with ClientSession() as s:
        async with s.get(VESKTOP_CDP + path, timeout=3) as r:
            return await r.json()


async def is_up():
    try:
        await _cdp_json("/json/version")
        return True
    except Exception:
        return False


async def installed():
    try:
        proc = await create_subprocess_exec("flatpak", "info", VESKTOP_APP, stdout=DEVNULL, stderr=DEVNULL)
        return (await proc.wait()) == 0
    except Exception:
        return False


async def install():
    proc = await create_subprocess_exec(
        "flatpak", "install", "-y", "--noninteractive", "flathub", VESKTOP_APP,
        stdout=DEVNULL, stderr=DEVNULL,
    )
    await proc.wait()


async def launch():
    uid = os.getuid()
    env = {
        **os.environ,
        "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{uid}"),
        "WAYLAND_DISPLAY": os.environ.get("WAYLAND_DISPLAY", "wayland-0"),
        "DISPLAY": os.environ.get("DISPLAY", ":0"),
    }
    await create_subprocess_exec(
        "flatpak", "run", VESKTOP_APP,
        "--remote-debugging-port=9223",
        "--remote-allow-origins=*",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        stdout=DEVNULL, stderr=DEVNULL, env=env,
    )
    for _ in range(60):
        if await is_up():
            return True
        await sleep(1)
    return False


async def _get_page():
    """Return the CDP target dict for Vesktop's main page (Discord or first-launch)."""
    tabs = await _cdp_json("/json")
    return next((t for t in tabs if t.get("type") == "page"), None)


async def get_discord_tab(client_js) -> Tab:
    """Ensure Vesktop is running and logged-into-able, inject our client, return the Tab."""
    if not await is_up():
        if not await installed():
            await install()
        await launch()

    # Wait for a page target and get past the first-launch setup screen
    while True:
        page = await _get_page()
        if page:
            tab = Tab(page)
            await tab.open_websocket()
            await tab.enable()
            url = page.get("url", "")
            if "first-launch" in url:
                # Accept defaults and proceed to Discord
                await tab.evaluate("(()=>{const b=document.getElementById('submit');if(b)b.click();})()")
                await tab.close_websocket()
                await sleep(4)
                continue
            # Inject our client (Vesktop already ships Vencord — no Vencord fetch needed).
            # Runs on every navigation (login → app) so the QR mirror works on the login page.
            # Tell the client it's running under Vesktop (native mic) BEFORE it runs, so it
            # never installs the CEF-only getUserMedia/visibility overrides that would break
            # Vesktop's native microphone.
            await tab._send_devtools_cmd({
                "method": "Page.addScriptToEvaluateOnNewDocument",
                "params": {"source": "window.STREAMCORD_IS_VESKTOP = true;\n" + client_js, "runImmediately": True},
            }, False)
            await tab._send_devtools_cmd({"method": "Page.reload", "params": {}}, False)
            return tab
        await sleep(1)
