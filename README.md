# My Own Data Center

Turn an [Omarchy](https://omarchy.org) machine into a home server you run from any browser. Install
apps from a catalog of about 580, keep your files and drives in one place, run virtual machines, and
reach your real Omarchy desktop — from a phone, a tablet or another computer.

![My Own Data Center's desktop in a browser, with Machines, Terminal and Files windows open](docs/screenshots/desktop-overview.jpg)

<p align="center">
  <img src="docs/screenshots/phone-home.png" width="24%" alt="Home on a phone">
  <img src="docs/screenshots/phone-store.png" width="24%" alt="App Store on a phone">
  <img src="docs/screenshots/phone-site-home.png" width="24%" alt="touchworkstation.com on a phone: the dashboard and the current release">
  <img src="docs/screenshots/phone-site-machines.png" width="24%" alt="touchworkstation.com on a phone: virtual machines">
</p>

## Install

On the Omarchy machine, as your normal user (not with sudo):

```sh
curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash
```

The installer:

- installs what's missing (Node.js, Podman, libvirt, wayvnc and friends);
- builds My Own Data Center in `~/.local/share/omarchy-server`;
- asks you to create your account **in the terminal**, so your password never crosses the network;
- starts two systemd user services that keep running while you're logged out.

Then open `http://<server-ip>:7780` (or `https://`, see [Security](#security)) and sign in.

Run the same command again to update, or use Settings → Software update. Your account, apps, machines
and files are kept. Logs: `journalctl --user -u omarchyd -u omarchy-server-web -f`

Want ZFS pools too? A piped install only receives `--zfs` after `--` (see [Storage](#storage-and-nas)):

```sh
curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash -s -- --zfs
```

To keep Software update and the App Store on local clones you sync yourself (no automatic GitHub
fetches), set these on the installer and they are written onto `omarchyd.service`:

```sh
OMARCHY_SERVER_SOURCE=/path/to/omarchy-server \
OMARCHY_SERVER_APP_STORE=/path/to/app-store \
bash install.sh
```

Each value must be an absolute path to a git repository. If either is set but invalid, omarchyd
refuses to start instead of falling back to GitHub. Unset them to use GitHub as usual. You can also
put them in a systemd drop-in (`~/.config/systemd/user/omarchyd.service.d/local.conf`). Optional:
`OMARCHY_SERVER_REPO` is the URL or local path the installer clones from (defaults to SOURCE when
SOURCE is set, otherwise GitHub).

To remove it, run `omarchy-server uninstall`. Your account, apps and machines stay, so installing again picks up
where you left off; add `--purge` to delete those too.

## What you get

### A web app for every screen

- **Phone and tablet layout:** touch first. Home shows CPU, memory and storage at a glance, plus your
  apps. Tabs for Apps, Files, Machines and System.
- **Desktop layout** on a computer: a top bar, a dock, windows you can drag, snap and resize, desktop
  icons, an app launcher and Activities overview. Switch layouts any time.
- **Your look, everywhere:** themes, accent colours, wallpapers or your own photo, and Omarchy's own
  themes and backgrounds (the icons follow them). The desktop's wallpaper, dock and icons are saved to
  your account, so every browser you sign in on shows the same desktop.
- **The dock your way:** left, bottom, right or top; any icon size; lift or magnify under the pointer;
  bounce when an app opens; floating or auto-hide.

![Desktop & Dock settings with the desktop themes](docs/screenshots/desktop-themes.jpg)

### Apps

- **App Store:** about 580 self-hosted apps (Jellyfin, Immich, Nextcloud, Home Assistant, Vaultwarden,
  Paperless-ngx and many more), in categories, with search. Add other stores, including Umbrel-format
  ones.
- **Tailscale built in:** install it from the App Store and reach your server from anywhere on your
  tailnet. It's Omarchy's own Tailscale, set up on the server; its page sits behind your sign-in, and
  private services stay private.
- **One tap to install.** Apps that need other apps get them too. Each app opens in a window, full
  screen, or its own tab, with its default sign-in shown when it has one.
- **Safe by default:** apps run in **rootless Podman** as you — no root, no Docker socket on the
  network. Before installing, you see exactly what an app asks for (system ports, devices, host
  network, folders outside its own), and it gets only what you allow. Apps never receive your Omarchy
  Server sign-in.
- **Behind your sign-in:** every app's port admits only browsers signed in to My Own Data Center.
- Start, stop, restart, update, logs, and a shell inside any app.
- **Opening apps from outside your network** (through a tunnel or a reverse proxy on https://) needs
  each app to have its own address, which you choose with an *app addresses* pattern such as
  `{app}-touch.example.com` (`{app}` becomes the app's name). Point those names at your server, then
  tell the web app the pattern: run `systemctl --user edit omarchy-server-web.service`, add
  `[Service]` and `Environment=TOUCH_APP_HOSTS={app}-touch.example.com`, save, and run
  `omarchy-server restart`. Set it to `off` to clear it. Until it is set, opening an app that way says
  "Opening apps remotely needs app addresses". On your own network it isn't needed.

![The App Store in the desktop layout: apps by category from every store you've added](docs/screenshots/desktop-store.jpg)

### Files

- Your real home folder, so the browser and the Omarchy desktop see the same files.
- Browse, upload (files and folders, drag and drop), download, rename, copy, move, search, favorites,
  recents, and the same Trash as Omarchy's file manager.
- View photos, videos, music, PDFs, documents, spreadsheets and code in the browser.
- Photo sync from your phone, and SMB network shares for any folder. Shares are opened on your home
  LAN only (the usual 10., 172.16. and 192.168. addresses); Tailscale is a second network and does
  not get port 445.
- **Quick transfers with a QR code** (desktop layout): right-click a file to share it, or a folder to
  upload into it from a phone. The phone opens a small page without signing in; the code lasts 10
  minutes and covers only that file or folder.

![Files in the desktop layout: places, your storage, and folders shared on your network](docs/screenshots/desktop-files.jpg)

<p align="center"><img src="docs/screenshots/qr-upload.png" width="45%" alt="Upload to a folder from a phone: a QR code that lasts 10 minutes"></p>

### Machines (virtual machines)

- **One tap:** Ubuntu, Debian, and Fedora, as server or desktop, plus Rocky, openSUSE Leap, Arch, Alpine, and Omarchy.
  CachyOS and Linux Mint boot their own installers. Windows 10/11 comes from your own ISO, or any ISO
  in Files. Images are checked against their publisher's checksums, and cloud-init sets up your account
  on the cloud images.
- **The same controls on the phone and the desktop:** CPU (sockets, cores, type),
  memory, disks, network, boot order, firmware, snapshots, backups (live), clone, restore, pause,
  hibernate, start with the server, task history, live usage graphs and a monitor.
- The screen in your browser with keyboard, mouse and touch controls, clipboard paste, and
  port forwarding to services inside a machine.
- Machines run as you under libvirt's per-user session, not as root.

![Machines in the desktop layout: the server's summary, status and its virtual machines](docs/screenshots/desktop-machines.jpg)

### Your Omarchy desktop, remotely

- The server's own Omarchy desktop, live in the browser, signed in from anywhere when it's at its
  login screen. It locks again after you finish viewing (you can turn that off).
- **Super key:** the Windows / ⌘ / Super key goes through, or Right Alt stands in for it on computers
  that keep Super to themselves. A Super button and shortcuts for the Omarchy launcher, menu and
  terminal are in the toolbar.
- Paste from your computer into the desktop's apps (Ctrl+V, or right-click → Paste on https://).
- Full screen with system keys passed through (Chrome, Edge and Brave over https://).

### Hyprland layout (the web desktop)

- Desktop & Dock → Layout → Hyprland tiles the same windows (Files, Apps, Machines, Terminal) with
  workspaces 1–9 and Omarchy Super shortcuts.
- On an Omarchy computer, Super is taken by Hyprland. Paste the snippet from Desktop & Dock → Layout
  into `~/.config/hypr/bindings.lua` (or `bindings.conf` on Omarchy from before its config moved to
  Lua; both are offered), run `hyprctl reload`, then press Scroll Lock (or Super+F12) so Super stays in
  the browser. Press it again to give Super back. The lock chip on the bar shows when keys stay here.
  The server never changes your Hyprland config.
- On https:// in Chrome, Edge or Brave, the lock chip can take Super without that snippet (full screen).
  On http://, use the snippet.

### Terminal

A real login shell in the browser, or a shell inside any app. Right-click copies a selection or
pastes. On a phone there's a key row with Esc, Tab, Ctrl, Alt and arrows.

### Storage and NAS

- Every drive with its health (SMART), and sleep timers for hard drives.
- **Btrfs pools** (combined, mirrored or RAID 10) on blank drives, import existing Btrfs drives, add
  drives, error checks.
- **ZFS pools** (combined, mirrored, RAID-Z1, RAID-Z2) and imports, after `curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash -s -- --zfs`.
- Pools appear in Files at `~/Pools/<name>`, and can be shared over SMB.
- Drives that hold anything are never erased: pools are only made on blank drives.

### System

- Live CPU, memory, temperature, uptime and storage, with what each app and machine is using.
- Storage pools with their space, drives, layout and errors.
- If a drive got bigger (a resized virtual disk, say), it shows the space that isn't in use yet and
  the exact commands to grow into it.
- Device name, Wi-Fi, logs, restart, shut down, factory reset, and a What's New after every update.

## Local swarm (other Linux computers)

Join your other Linux computers to your server and see them in **Machines → Local swarm**:
watch them (CPU, memory, disks, temperature, updates waiting), open a terminal, see and use their
desktop, and manage them (verified Omarchy plugins, Omarchy theme, updates, restart). Linux only, on
any distribution with systemd: Omarchy, Arch, Debian, Ubuntu, Fedora, openSUSE and their relatives.

1. On your server: **Machines → Local swarm → Add a computer**. Choose what it may do and tap **Make the install command**. Watching is always on. Five abilities, with these defaults:
   - **Terminal** — on. A shell on that computer.
   - **Desktop** — on. See and use its screen.
   - **Manage** — on. Verified Omarchy plugins and themes, updates, and restart.
   - **Storage** — off, because it can format disks.
   - **Backups** — on. It can add backups, never delete them.
2. On the other computer, open a terminal as the person who uses it (not root), paste the command
   and press Enter. It asks for your password only to install Python, git and screen sharing, and
   to keep the connector running while you're signed out.
3. It appears in Local swarm within a few seconds.

How it stays safe: the connector ([connector/agent.py](connector/agent.py)) runs as that user (a
systemd user service), never as root, and dials out to your server, so the computer opens no ports.
The command carries your server's certificate fingerprint, checked before anything is sent, and a
pairing code that works once, for 15 minutes. The computer only ever allows what you chose when it
joined (the connector enforces it as well as the server), there is no "run any command": the
terminal is a shell you type into, and Manage is a short fixed list. The desktop is shared only
through a private socket in that user's runtime folder. Remove a computer and its connector forgets
your server and stops. To take the connector off a computer:

```sh
curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/connector/install.sh | bash -s -- --uninstall
```

The desktop works with Hyprland, Sway and other wlroots desktops (wayvnc) and X11 desktops
(x11vnc). GNOME and KDE on Wayland can't be shared yet: sign in with an X11 session there.

## Security

- **Your password stays on the server:** it's created in the terminal, stored as a scrypt hash.
  Sign-in slows down after repeated failures, and two-factor (TOTP) codes work once each.
- **Least privilege:** the backend runs as your user and listens on `127.0.0.1` only. Root work
  (storage, firewall) goes through one small helper with a single sudoers rule, which checks every
  request itself.
- **https:// on the same port** with the server's own certificate authority. New servers' authority
  is limited to home-network names and private addresses, so it can't vouch for real websites.
  Settings → Security lets you replace an older one, send browsers to https:// always, and choose
  whether the desktop locks after remote viewing.
- **Apps are contained:** apps only get the access you approve. Their setup scripts run in a sandbox
  with no network. Their ports sit behind your sign-in.
- **No exposed screens:** the desktop and machines' screens are on private sockets, reachable only
  through a single-use ticket.
- **Signed-in devices** are listed in Settings, and you can sign any of them out.

## How it fits together

| Part | Runs as | Listens on | Does |
| --- | --- | --- | --- |
| `omarchyd` (`omarchyd/`) | you | `127.0.0.1:2021`, plus each app's port | Accounts, stats, files, apps, machines, storage. App ports admit only signed-in browsers |
| `omarchy-server-web` (`server/`, `web/`) | you | `7780` (http and https) | The web app you open in a browser |
| `helper/helper.mjs` | root, via one sudoers rule | — | Storage pools, shares, firewall ports, power |

On the server itself: `omarchy-server` (status, open, restart, logs, uninstall), "My Own Data Center" in the
launcher, and a top-bar icon (`omarchy-server widget off` removes it).

## Requirements

- An x86-64 computer running [Omarchy](https://omarchy.org) (Arch Linux + Hyprland)
- An internet connection while installing
- For machines: KVM (`/dev/kvm`) for full speed; machines still run without it, slowly
- For storage pools: extra drives (blank ones for new pools)

## Development

```sh
npm install
npm run build
npm test
```

## Credits

Omarchy is by DHH and the Omarchy contributors. This project is independent and not affiliated with
Omarchy. App icons come from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons).
