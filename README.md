<p align="center"><img src="assets/watchfire.svg" width="128" alt="Watchfire logo: a gold flame sending out a signal"></p>

<h1 align="center">Watchfire</h1>

Open ports on your router for game servers, so friends outside your home can join, without logging in to your router.

Pick a game, press **Forward ports**, and Watchfire asks your router to forward the right ports to this PC using UPnP. It shows what's open, gives you the address to send your friends, and puts the forwards back after a router reboot.

Watchfire was called **PortHop**. Updating keeps everything: your games, settings and forwards move across on first start, and forwards made under the old name are still recognised.

## Download

Get **Watchfire.exe** from the [latest release](../../releases/latest) and run it. It's a single file: no installer, and it doesn't need Node.js.

Watchfire also comes with [Emberkeep](https://github.com/GreggsNBacon/emberkeep), a game-server manager that uses Watchfire to open ports for the servers it runs. The Emberkeep installer includes Watchfire, so you don't need both downloads.

Windows may show a SmartScreen warning the first time because the exe isn't code-signed. Choose **More info → Run anyway**.

## Using it

1. Make sure **UPnP** is turned on in your router's settings. It usually is.
2. Open Watchfire. The badge at the top shows whether it found your router.
3. Find your game (search, or filter by Sandbox, Co-op, Survival, Shooter or Platform) and press **Forward ports**.
4. Press **Copy IP** and send the address to your friends.

When you're done, remove the forward from the **Active forwards** list, or use **Remove all**.

## Features

- **30 games built in**, including Minecraft (Java and Bedrock), Terraria, Valheim, Palworld, Enshrouded, Satisfactory, Factorio, Project Zomboid, Rust, ARK, V Rising, 7 Days to Die and Stardew Valley, each with the right TCP and UDP ports.
- **Your own games and ports.** Add any game, or change a built-in game's ports (single ports and ranges like `27015-27030`). Your changes survive updates, and you can reset a game to its defaults.
- **Spots running servers.** Games whose server is running on this PC are highlighted, so you can see what needs forwarding.
- **Active forwards.** Everything Watchfire has opened, checked against what the router actually has. Ports opened by other programs are shown too but left alone.
- **Restores forwards.** Routers forget forwards when they reboot. Watchfire puts yours back when it starts and while it runs (you can turn this off).
- **Tray icon.** Watchfire lives in the system tray. A green dot means something is forwarded, and the menu lists your forwards (click one to copy its address).
- **Start with Windows** (in Settings), so forwards come back without you thinking about it.
- **Cover art.** Steam games get their cover automatically. Add a free [SteamGridDB](https://www.steamgriddb.com/profile/preferences/api) key in Settings for covers of other games too.
- **Colour themes:** Flame (default), Void, Light and High contrast, in Settings.
- **Warns about problems** such as carrier-grade NAT (when your router's "internet" address is itself private, so forwarding can't work).

## If it can't find your router

- Turn on UPnP (sometimes called "UPnP IGD" or "NAT-PMP/UPnP") in your router's admin page, then press **Rescan**.
- Some ISP routers, mesh systems and double-NAT setups (a router behind another router) don't support UPnP. In that case, forward the ports shown on the game's card by hand in your router's admin page.
- If the public IP shown is in a private range such as `100.64.x.x` or `10.x.x.x`, your ISP uses carrier-grade NAT and port forwarding can't work. Ask your ISP for a public IP, or use a VPN-style tool such as Tailscale or ZeroTier instead.

## Closing Watchfire

Closing the window quits Watchfire, but your forwards **stay open** on the router. To close them as well, use **Quit & close forwards** in Settings or **Exit and close all forwards** in the tray menu.

## Privacy

Watchfire only talks to your router on your local network, plus Steam and SteamGridDB for cover art. Its page is only reachable from this PC (`127.0.0.1`), and requests that change anything must carry a header that other websites can't send.

## Where things are stored

`%LOCALAPPDATA%\Watchfire\` (on Linux, `$XDG_DATA_HOME/Watchfire` or `~/.local/share/Watchfire`):

- `games-user.json`: your games and changes to built-in ones
- `forwards.json`: the forwards Watchfire made, so they can be restored
- `settings.json`: settings, favourites and theme

## Running from source

Needs [Node.js](https://nodejs.org/) 22 or later.

```sh
npm install
node server.js        # or Watchfire.bat / Watchfire.sh
```

Options: `--port <n>` to pick the port, `--no-tray`, `--no-window`, `--background` (start in the tray only).

Watchfire also runs on Linux (no tray icon; it opens in your browser). On Windows it opens in its own window, using the WebView2 runtime that comes with Windows.

Environment variables (the old `PORTHOP_*` names still work):

| Variable | Use |
|---|---|
| `WATCHFIRE_OFFLINE=1` | Don't look for a router (for testing the UI) |
| `WATCHFIRE_TEST_GATEWAY` | Use this UPnP device description URL instead of searching |
| `WATCHFIRE_SGDB_KEY` | SteamGridDB key, instead of setting one in Settings |
| `WATCHFIRE_BROWSER_WINDOW=1` | Open in an Edge app window instead of Watchfire's own window |

## Building Watchfire.exe

```sh
npm install
node build.js         # writes dist/Watchfire.exe
```

`build.js` packages Watchfire as a Node single-executable app and stamps the exe with Watchfire's name, icon and version. Versions are `1.2.<commit count>`.

The logo and icons are drawn in Emberkeep's repo (`branding/source/watchfire.svg`); `branding/build-icons.ps1` there writes `assets/watchfire.ico` and `assets/watchfire.svg` here.

## For other apps

Watchfire has a small local API that other apps (Emberkeep, for example) use to open ports through it. A running copy writes its port to `%LOCALAPPDATA%\Watchfire\instance.json`. The calls are `GET /api/hello`, `GET /api/forwarded`, `POST /api/forward` and `POST /api/remove`. Requests that change anything need an `X-Watchfire: 1` header.
