# Auto-install the connector into virtual machines

Status: **approved**. Sequence A → B → C. Series A implementation starts on `feat/guest-connector-auto-install`.

Date opened: 2026-11-24
Repo: `/home/joseph/code/omarchy-server` (My Own Data Center / formerly Omarchy Server)
Product short name: MODC. Command, units, and paths stay `omarchy-server`.
Implementation, when approved: isolated worktree from `upstream/main`, branch like `feat/guest-connector-auto-install`. Do not commit this onto `feat/machine-dials-persist` or `local/security-and-perf`. Do not bump version, changelog, or `INSTALLER_REVISION` unless a host helper verb actually changes.

## Where to look after a compaction

1. This file.
2. Current guest install UI: `web/src/fleet/GuestLive.tsx` (the **Install connector** button), `web/src/swarm/Swarm.tsx` `AddComputer`, `web/src/swarm/installCommand.ts`, `web/src/swarm/guestLink.ts`.
3. Pairing: `omarchyd/connector.mjs` `swarm.pair` with `machineId` → `guestOf`.
4. VM create + seed: `omarchyd/machines.mjs`, `omarchyd/machine-media.mjs`, `omarchyd/machine-catalog.json`, `web/src/CreateMachine.tsx`.
5. Installers: `connector/install.sh` (Linux/systemd), `connector/install.ps1` (Windows). There is no macOS installer.
6. Tests already covering guests: `test/guest-connector.test.mjs`.
7. Vision (connector on Linux systemd only; Windows/macOS/HAOS do not run it): `docs/vision.md` § Virtual machines.

## Goal

When a virtual machine is created on a host this product can reach (this server today; a joined computer later), install the matching connector without the owner pasting a command into the guest.

When an existing virtual machine has no connector, **Install connector** runs that install itself. If the guest needs a sudo (or equivalent) password, collect it in a secure in-app prompt. Do not send the owner to a terminal for that password.

Success looks like: create a Linux cloud or Windows VM on this server (and, if remote hosting is in this effort, on a joined computer) → it appears with an online guest connector after first boot, without anyone opening the guest console. Press **Install connector** on a running supported VM that already has the QEMU guest agent → it joins the same way. If the agent is missing, the existing copy-paste sheet stays as fallback. Alpine, Android, HAOS, and macOS stay honest about why they cannot install.

## Current behavior (what we are replacing)

- **Install connector** on a guest opens `AddComputer` with `guest={{id, name}}`. That mints `swarm.pair({machineId})` and shows a copy-paste command. The owner must open a terminal *inside the guest*, paste, and type sudo there.
- Linux guests get `curl … | bash` (`connector/install.sh`). Physical Windows computers get PowerShell `install.ps1`. Guest UI currently hides Windows: `linuxConnectorOs()` and copy that says “Not Windows or Home Assistant.”
- Pairing token is one-shot and lasts **15 minutes** (`PAIR_TTL`).
- Guest enroll is the same Linux `agent.py`, stored with `guestOf: <8-hex machine id>`. It is hidden from the physical computer list.
- Default guest abilities: terminal, desktop, manage, files on; storage/backup/services off. Backups stay off for guests.
- New VMs: cloud images get a NoCloud seed (`cloud-init`); Omarchy ISO gets archinstall files on a `cidata` drive; Windows retail ISOs with a `CCCOMA_` label get an unattend file. Custom ISOs are manual.
- QEMU guest-agent **channel defaults off** (`HARDWARE_OPTION_DEFAULTS.agent: false`). The UI says to install `qemu-guest-agent` inside the guest yourself.
- Networking is **passt user-mode NAT**. The guest shares the host’s address; the host does not get a routed IP into the guest unless a port forward exists. Outbound from the guest generally works.
- VMs on a joined computer: `CreateMachine` already takes `host`. If `host.id !== 'server'`, it shows a stub (“The connector on {name} can’t host a virtual machine yet”) and `machines.create` refuses a non-`server` `hostId`. **Remote VM hosting is not built.**
- The host installer prompt (`InstallerPrompt.tsx`) deliberately opens a terminal so sudo never reaches the web page. This feature asks for the opposite for *guest* sudo.

## Challenged assumptions

These look true at a glance and are not.

1. **“Paste the existing command, but from the server.”** The Linux installer must run as the guest user, not root (`install.sh` dies if `id -u` is 0). It needs a TTY for `sudo` unless we change how packages/helper/linger are installed. Cloud-init and qemu-guest-agent `guest-exec` typically run as root. Automation has to split “root prep” from “user enroll,” or wrap with `runuser`/`sudo -u`.

2. **“The guest can use the same server URL the browser used.”** `AddComputer` prefers `location.hostname`. From inside a passt guest, that may be a phone, `localhost`, or an address the guest cannot route. Auto-install must pick an address *the guest* can reach (pairing `addresses`, default gateway, never loopback).

3. **“SSH from the host into the guest.”** Passt does not give the host a guest IP you can SSH to without a port forward. Do not design v1 around host→guest TCP. Use in-band hypervisor channels: cloud-init / unattend at first boot, and qemu-guest-agent while running.

4. **“All catalog guests run the Linux connector.”** `install.sh` requires Linux + systemd + a normal user. Alpine cloud images are OpenRC/`ash`. Android and Home Assistant OS are excluded in `linuxConnectorOs`. Windows has a different installer and a smaller ability set. macOS has no installer and is called out as unsupported in Add a computer.

5. **“VMs on connected computers are in the same code path.”** Hosting on a swarm computer does not exist. Fleet `vms` is hard-false for computers (`${name} can’t host its own virtual machines.`). `CreateMachine` is a stub. `machines.create` refuses a non-`server` `hostId`. Unraid import copies disks onto *this* server’s libvirt; those guests are not left running on Unraid. Auto-install into a remote guest means qemu-ga runs **on that computer**, so the swarm connector needs a closed `vms` ability (virsh/qemu-ga verbs, not a general shell). The owner asked to include connected computers; see Locked decisions and the remaining hosting question.

6. **“A 15-minute pairing token survives first boot.”** Ubuntu/Fedora desktop cloud-init installs a desktop, then reboots. That routinely exceeds 15 minutes. Putting the token in the seed ISO also leaves a secret on disk in the VM folder. Mint the token when the guest is actually ready to enroll.

7. **“Sudo password is always required.”** First-boot cloud-init is root: packages and linger need no guest password. qemu-guest-agent `guest-exec` is root: same. A password prompt is for the case where we execute *as the guest user* (or Windows UAC / macOS admin). Do not send the guest account password to the server if a root in-band channel exists.

8. **“Enable the QEMU agent flag and we can exec.”** The libvirt channel is only the host side. The guest still needs `qemu-guest-agent` (Linux) or `qemu-ga` (Windows) running. New cloud images should install that package in the seed. Existing VMs without it cannot be driven until that package is there, or we fall back to copy-paste.

9. **“macOS VMs are like Windows VMs.”** There is no catalog macOS image, no `install.sh` for Darwin, and running macOS under Linux KVM is its own problem. A Mac *computer* joining the swarm is a different product (new Darwin connector). Do not pretend a Linux VM path covers macOS.

10. **“Install at create can always finish before the UI moves on.”** Create already returns while download/install continues as a task. Connector enroll is another async task on that machine (`connector-install`), shown on the machine page, not a blocking wizard step.

## Operating systems and what each actually needs

| Guest | How MODC creates it today | Connector today | Auto-install channel | Privileged step | Notes |
|---|---|---|---|---|---|
| Ubuntu / Debian / Fedora / Arch **cloud** (server or desktop) | NoCloud seed, `cloud-init` packages + `runcmd` | Linux `install.sh` + `agent.py` | Seed: install `qemu-guest-agent`, python3, tmux, optional vnc pkgs; enable agent channel. Then host `guest-exec` as the created user to enroll. Optional: `runcmd` enroll if token is VM-bound and not the 15‑min code. | Root via cloud-init; no sudo password | Desktop variants reboot after packages (`power_state`). Wait for agent after that reboot. |
| Omarchy ISO | archinstall JSON on `cidata` | Same Linux installer; Omarchy has `omarchy pkg add` | After first boot, qemu-ga or a user systemd drop-in written into the seed if archinstall allows extra files. | sudo for linger/packages; Omarchy pkg path may avoid sudo for packages | No cloud-init `runcmd`. First boot is a real user session. |
| Alpine cloud | cloud-init, `ash`, sudo package only | **Fails:** `install.sh` requires systemd | Out of v1 unless we add OpenRC unit support | — | Be honest in the UI. |
| Windows 10/11 (CCCOMA ISO) | unattend: local admin, bypass TPM | `install.ps1` + Python 3.8+; scheduled task at sign-in; abilities: terminal, files, power | **In v1.** `FirstLogonCommands` installs Python if needed, then `install.ps1`. Existing: qemu-ga-win + `guest-exec`, else copy-paste. | No Administrator prompt in current installer (user scheduled task) | Guest UI currently refuses Windows (`linuxConnectorOs`, GuestLive copy). That gate must open for Windows guests. Vision.md still says Windows does not run the *Linux* connector; the Windows installer is a different binary. |
| Other Windows ISOs | Manual setup | Same as Windows if we allow it | Only after the OS is up + qemu-ga-win or a logon script | — | No unattend. |
| Custom Linux ISO | Manual | Linux installer if systemd | Same as existing VM path once the OS and qemu-ga are up | sudo password prompt if we exec as the user | |
| Android / HAOS | Catalog/UI treat as non-Linux connector | Explicitly excluded | Do not install | — | Keep the current quiet message. |
| macOS VM | No catalog image | No installer | Out of v1 | — | See questions. |
| VM on a joined computer | Stub only | n/a | Out of v1 hosting | — | Same install *idea* later, executed by that computer’s connector. |

### Linux installer commands (what automation must invoke)

`connector/install.sh` today:

- Requires: Linux, not root, systemd, python3.
- Detects `apt-get` / `dnf` / `pacman` / `zypper`.
- `sudo` for missing packages, helper install, sudoers, `loginctl enable-linger`.
- Downloads `agent.py` (and `helper.py` if storage) from GitHub raw *or* `https://<server>/api/connector/…` with CA pin.
- Enrolls with `--token`, writes user unit `omarchy-connector.service`, `enable --now`.

Package mapping already in the script:

- python: `python` on pacman, `python3` elsewhere
- manage → `git`
- terminal → `tmux`
- desktop → `x11vnc` and `wayvnc`
- storage → `smartmontools`, `e2fsprogs`, `exfatprogs`, `btrfs-progs`, `hdparm`

For a **root** first-boot path, install those packages in cloud-init (no sudo), write the user unit into the created user’s systemd, `loginctl enable-linger USER`, then run enroll as that user.

### Windows installer commands

`connector/install.ps1`:

- PowerShell 5.1+ or 7+.
- Finds `python` / `python3` / `py` ≥ 3.8; otherwise tells you to `winget install Python.Python.3.12`.
- Fetches CA, pins SHA-256, downloads `agent.py`, registers scheduled task `OmarchyConnector` at sign-in.
- Abilities that work: terminal, files, power. Desktop/storage/backup/services need Linux.

First-boot automation must install Python noninteractively, then run the script with `-Server -Ca -Token -Allow -Source`. Prefer `https://<reachable-host>:<port>/api/connector/install.ps1` so a local clone still works.

### macOS (not built)

A Darwin connector would need: outbound WSS + pinned CA, a LaunchAgent (user) not a systemd unit, `python3` from Xcode/Homebrew or a bundled runtime, osascript/Screen Sharing for desktop (not wayvnc), and an admin prompt via a proper macOS auth dialog — not `sudo` over SSH. None of that exists. Do not stretch `install.sh`.

## Execution channels (ranked)

Use the first that exists. Do not invent a general “run any command” swarm action.

1. **First-boot seed (new guests only)**  
   cloud-init packages + qemu-guest-agent + linger. Unattend FirstLogonCommands for Windows. Seed must not hold the 15‑minute pairing token if we can avoid it.

2. **qemu-guest-agent `guest-exec` (running guests)**  
   Host: always add the virtio serial channel for new VMs (`options.agent: true`). Command: `virsh --connect qemu:///session qemu-agent-command <domain> '{"execute":"guest-exec",…}'` then `guest-exec-status`. This is the only reliable host→guest channel under passt.

3. **Secure password sheet + exec as the guest user**  
   Only if we cannot do the privileged steps as root (no agent, or policy wants user-context install). SPA password field → one-shot RPC → `sudo -S` or `runuser`. Never write the password to disk, logs, machines.json, or the seed ISO. Owner-only. TLS already on the session.

4. **Copy-paste fallback**  
   Keep today’s `AddComputer` sheet when 1–3 cannot run (no agent, Alpine, HAOS, owner cancelled). Do not pretend it installed.

Do **not** use: typing into the VNC console, `expect` on `virsh console`, host SSH to a guessed guest IP, or virt-customize while the domain is running.

## Approaches

### A. Seed-only (create path, no live exec)

Put packages and an enroll script in cloud-init / unattend. Simple for new cloud VMs. Misses existing VMs, Omarchy ISO, custom ISOs. Token-in-seed and 15‑minute expiry are ugly. **Too small for the request.**

### B. qemu-guest-agent as the live installer, seed only prepares the agent (recommended)

- New VMs: turn the agent channel on; cloud-init installs `qemu-guest-agent` (and python3); Windows unattend installs virtio guest tools / python as we can.
- When the domain is `running` and `guest-ping` works, omarchyd mints a **guest** pairing token (bound to that `machineId`, longer TTL or until enroll/cancel), picks a guest-reachable server URL, and `guest-exec`s the installer as the VM’s account.
- **Install connector** on an existing VM is the same RPC: `machines.installConnector`. If the agent is missing, tell the owner how to add it (and keep copy-paste).
- Sudo password sheet only when exec is not root and sudo asks.

This matches passt, matches “button runs it,” and keeps secrets off the seed disk.

### C. In-guest HTTP pull with a host-side loopback helper

Guest curls `http://gateway/…` with a metadata token, like cloud-init. More moving parts, duplicates qemu-ga, still needs first-boot network. **Worse than B.**

**Recommendation: B**, with seed prep so new Linux cloud VMs do not need a password at all.

## Draft design (pending approval)

### RPC

`machines.installConnector` (mutation, owner-only, slow):

```
input: {
  id: string,              // 8-hex machine id
  abilities?: { terminal?, desktop?, manage?, files?, storage?, backup?, services? },
  sudoPassword?: string    // only when the server asked for it; never stored
}
output: {
  status: 'started' | 'needs-password' | 'needs-agent' | 'unsupported',
  os: 'linux' | 'windows' | 'other',
  message?: string,
  taskId?: string
}
```

`machines.connectorInstall` (query): status of the in-flight task for that id (running / ok / error / waiting-password).

Allow-list both on `server/app.mjs`. Add to `SLOW`.

Create path: after the domain is defined, if the OS is a supported guest OS, start the same task with default guest abilities. Do not block `machines.create`. Show progress on the machine page (existing task list).

### Host-side flow

1. Resolve machine, refuse if not this server’s libvirt (until remote hosting exists).
2. Classify OS: Linux systemd / Windows / unsupported (`linuxConnectorOs` plus a Windows sibling).
3. Ensure domain XML has the `org.qemu.guest_agent.0` channel (next start if the VM is off).
4. If not running: for new cloud images the seed already has qemu-ga; start as today; wait.
5. Wait for `guest-ping` (timeout ~5–10 min after `running`, longer after desktop cloud-init reboot).
6. `swarm.pair({ machineId, …abilities })` with a **guest TTL** (recommend 6 hours or until first enroll / cancel — decision needed).
7. Choose `--server` / `-Server` from `serverAddresses()`: never `127.0.0.1`/`localhost`. Prefer a LAN or Tailscale address. Also pass the passt gateway as a fallback the installer can try (`ip route` default via).
8. `guest-exec` the OS-specific command. Linux: write a temp script or `runuser -u USER -- bash -lc '…'` after root has already installed packages. Windows: `powershell.exe -NoProfile -Command …`.
9. Watch `swarm.list` for `guestOf === id` online; complete the task. On token expiry, mint once more (cap retries).

### Linux root vs user split

Root (cloud-init or guest-exec as root), no password:

- Install qemu-guest-agent, python3, and ability packages.
- `systemctl enable --now qemu-guest-agent`.
- `loginctl enable-linger USER`.
- If storage: helper + sudoers NOPASSWD for that helper only (same as `install.sh`).

User (enroll):

- Fetch `agent.py` with CA pin (same as installer).
- `python3 agent.py enroll …`
- User systemd unit enable --now.

Keep using `install.sh` with env `OMARCHY_CONNECTOR_NONINTERACTIVE=1` and, when root already did packages, skip sudo — **or** a `--user-enroll-only` flag. Prefer a flag plus tests over a parallel script.

### Sudo password prompt

SPA sheet, `type="password"`, `autocomplete="off"`, not in React Query cache, not in task messages.

When the RPC returns `needs-password`, the button sheet asks once and retries with `sudoPassword`. omarchyd passes it on stdin to `sudo -S` **inside the guest** via guest-exec, then drops it. If sudo fails, `needs-password` again with a generic error. Do not log stdin. Do not put it on the libvirt qemu-ga command line (`-S` + stdin only).

If qemu-ga is root, skip this sheet.

### Create-time seed additions (`machine-media.mjs`)

Always, for cloud Linux images we will auto-enroll:

- packages: `qemu-guest-agent`, `python3` (or `python` on Arch/Fedora as required)
- `runcmd`: enable/start qemu-guest-agent
- Keep existing desktop packages/commands

Do **not** embed the pairing token in user-data.

Windows unattend: add a FirstLogonCommands stub only if Windows guests are in v1.

Omarchy ISO: v1 can wait until first boot + qemu-ga if we add `qemu-guest-agent` to the installed system; otherwise treat like an existing VM (button after the user is in).

Turn **QEMU Guest Agent** hardware option **on by default** for new machines.

### UI

- **Install connector** stays. It calls the RPC instead of only opening the paste sheet. Show spinner + task error. Open the paste sheet only on `needs-agent` / `unsupported` as a fallback (if we keep fallback).
- Password sheet as above.
- Create wizard: no extra checkbox. Supported OS always starts the install task.
- Keep the “can’t be installed on this guest” copy for HAOS/macOS/Alpine.
- Guest **Install connector** uses `install.ps1` when the guest is Windows, and still opens the paste sheet when qemu-ga is missing.
- Password sheet only when a live install is running as the guest user and sudo/UAC asked.

### Security

- Owner-only. Members do not install connectors.
- Pairing token still one-shot, still CA-pinned, still outbound WSS.
- No new “run any command” agent verb.
- qemu-ga `guest-exec` is powerful (root in the guest). Treat `machines.installConnector` as the only caller; argv is a generated installer invocation, not owner-supplied shell.
- `sudoPassword` is a write-only field, max length capped, stripped from any thrown error.
- Guest-reachable URL must still be `https://` with the fingerprint in the command.

### Tests (TDD, no real VMs in unit tests)

- Fake `virsh qemu-agent-command` in `test/machines.test.mjs` / a new `test/guest-connector-install.test.mjs`.
- Seed user-data contains `qemu-guest-agent` and does not contain a pairing token.
- New machine XML includes the agent channel by default.
- `installConnector` owner-only; member 403.
- Unsupported OS → `unsupported` without virsh exec.
- Agent not pinging → `needs-agent`.
- Password is not in task `message`, not in `machines.json`.
- Guest URL picker never returns localhost.
- `linuxConnectorOs` / Windows helper stays in `guestLink.ts`.
- `install.sh` noninteractive / `--user-enroll-only` covered in `test/connector-uninstall.test.mjs` style fake-sudo tests.

Do not run full `npm test` as the only check; targeted tests + `tsc --noEmit -p web`. Mention known host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) in the PR body.

## Locked decisions (2026-11-24)

- **OS:** Linux systemd guests and Windows guests. Not macOS, Alpine OpenRC, Android, or HAOS.
- **Create-time:** always start connector install on a supported OS. No checkbox.
- **Missing qemu-ga:** live install returns `needs-agent` and the existing copy-paste sheet stays.
- **Connected computers:** in scope as **both** full remote VM hosting and auto-install, sequenced as separate PRs in this effort.
- **Default abilities (assumed, still easy to flip):** Linux guest: terminal, desktop, manage, files on; storage/backup/services off. Windows guest: the Windows set (terminal, files, power) only.
- **Pairing token (assumed):** mint when qemu-ga is ready, bound to that `machineId`, live until enroll, cancel, or 6 hours. Do not write it into the seed ISO. Physical Add-a-computer stays 15 minutes.
- **Omarchy ISO / custom ISO (assumed):** button (and copy-paste fallback) once the OS is up. Cloud Linux and Windows unattend get seed prep at create.

## Two subsystems (this effort)

Unraid is not remote hosting: import already copies the guest onto this server’s libvirt.

### Subsystem 1 — Guest connector auto-install

Linux systemd + Windows. Create always starts it. Button runs it. qemu-ga missing → copy-paste. Password sheet only when sudo is required. Details in Draft design above.

### Subsystem 2 — Virtual machines on a joined computer

A Linux joined computer with libvirt/QEMU can host guests the same way this server does. Fleet ability `vms` becomes real. `CreateMachine` for that host creates the guest **there**, not here. The guest’s page is the same machine page, with `hostId` set to that computer.

Then subsystem 1’s installer runs through that computer’s qemu-ga verbs.

## Recommended sequence

The owner asked for hosting then auto-install on the remote path. Local auto-install does not wait on hosting: this server already has VMs and the button. Shipping it first means the button works on quito while hosting is built.

1. **PR series A — auto-install on this server** (subsystem 1, `hostId=server`).
2. **PR series B — swarm VM hosting** (subsystem 2 without connector install).
3. **PR series C — auto-install on remote guests** (same installer, qemu-ga via the host computer’s connector).

Do not mix A and B in one PR. C is small if A and B kept the same qemu-ga wrapper shape.

## Remote hosting architecture (subsystem 2)

### Approaches

**1. Python VM helper on the joined computer (recommended).** Like `connector/helper.py` for storage: a closed verb list, user-session libvirt (`qemu:///session`) so it matches this server and does not need root for ordinary guests. Privileged package install of libvirt/qemu/passt/xorriso happens once at connector install when `vms` is allowed (sudo / password sheet). omarchyd `machines.mjs` grows a backend: local virsh vs `swarm.call(hostId, 'vm-*')`. One inventory: this server’s `machines.json` with `hostId`.

**2. Install full MODC on every host.** Vision already says another box can run the app at :7780. That is a second server, not a guest on a connected computer. Rejected for this feature.

**3. Duplicate `machines.mjs` in the agent.** The agent would grow into Node+libvirt. Rejected.

### Inventory

This server keeps the fleet list. Each guest in `machines.json` has `hostId: 'server' | <12-hex agent id>`. Runtime state (running/paused) is read from the host that owns the domain. The SPA does not change shape because of `hostId`; grouping may show the host (vision).

### Ability `vms`

New pairing ability, opt-in, cannot widen later. Connector enforces it. Fleet `vms` is granted when the computer is online, `vms` is allowed and on, and the helper reports libvirt available. Otherwise the existing “can’t host” reason stays.

### Closed verbs (not a shell)

Enough to replace what `machines.mjs` does locally: image fetch+checksum, disk create, seed ISO, define/start/stop/reboot/pause, VNC socket path, qemu-ga ping/exec/status, port forwards, options. Argv validated the same way as storage verbs.

### Console

The connector already tunnels a VNC channel for the computer’s desktop. Add a channel keyed by guest id to that host’s VM VNC unix socket. The SPA console URL stays `/api/console?machineId=<guest>` and omarchyd proxies to local virsh or to the host connector.

### Create

`machines.create({hostId, ...})` with `hostId` of an online computer that has `vms`: allocate id here, persist `hostId`, send the spec and catalog URL to the host, host downloads the image (checksum), writes the seed, defines the domain. Progress events come back on the connector. Failure marks the machine error here; no silent create-on-this-server fallback (that refusal already exists and stays).

### Networking

Same passt user-mode on the remote host. Guest outbound uses that host’s network. Auto-install `--server` must be an address **that guest** can reach (this MODC server’s LAN/Tailscale), not the hypervisor’s localhost.

### What the joined computer must have

Linux + systemd (already required for the connector) + libvirt session + QEMU + passt + xorriso. `install.sh --allow vms` installs those packages. Windows as a *hypervisor* is out: a Windows joined computer does not host KVM guests in v1. A Windows *guest* can run on a Linux host (this server or a Linux joined computer).

### Existing domains on that computer

v1 hosts guests **this product created**. Scanning leftover virt-manager domains is a later import, not this effort. Install connector on an existing guest means a guest already in `machines.json`.

## Non-goals (unless the hosting question expands them)

- macOS connector.
- Alpine OpenRC connector.
- Android / HAOS connector.
- Changing physical “Add a computer” (still copy-paste).
- Assistant tool for install-connector.
- Switching guests from passt to bridged networking just to SSH.
- Storing the guest login password to reuse later.
- A general “run this command” agent.

## Open questions

- [x] **OS scope for v1:** Linux systemd + Windows guests.
- [x] **Create-time:** always on for supported OS.
- [x] **Existing VM without qemu-ga:** keep copy-paste fallback.
- [x] **Joined-computer VMs:** must be included. Depth of hosting still open.
- [x] **Default abilities:** current guest defaults; Windows uses the Windows ability set.
- [x] **Guest pairing TTL:** mint at agent-ready, until enroll/cancel/6h.
- [x] **Omarchy ISO / custom ISO:** button-only once the OS is up.
- [x] **Remote hosting depth:** both, sequenced. Full hosting and auto-install. Separate PRs.
- [x] **Sequence:** local auto-install first, then hosting, then remote auto-install.
- [x] **Remote hosting shape:** Python VM helper + `machines.json` `hostId`.

## Draft implementation slices (not started)

Worktree: `/home/joseph/.worktrees/omarchy-server-guest-connector-install` from `upstream/main`. `node_modules` symlink from the main clone. Style: tabs, no semicolons, single quotes. Commits: sentence case, no `feat:` prefix, no trailing period. PR against MyOwnDataCenter/server when asked.

**Series A — auto-install on this server** (worktree `omarchy-server-guest-connector-install`):

1. [x] Guest URL picker + guest pairing token (bound to `machineId`, 6h / until enroll). Tests first. (`3e22e25`)
2. [x] Default-on qemu-ga channel; cloud-init packages `qemu-guest-agent` + python3. Windows unattend FirstLogonCommands stay in create-time. (`9c013b2`, `55eee91`)
3. [x] Host qemu-agent wrapper: ping, exec, status (fake virsh). Keep the function shape that series C will call through the connector. (`f20c8e8`)
4. [x] `install.sh` `--user-enroll-only` / noninteractive. (`cc1c61e`, `970de8f`)
5. [x] `machines.installConnector` Linux + Windows + task. Owner-only. `needs-agent` → paste fallback. Password sheet when sudo is required. (`e598199`)
6. [x] Create-time starts that task for supported OS on this server. Guest UI allows Windows. (`d900d62`, `550c8dd`)

**Series B — swarm VM hosting** (own spec under `docs/superpowers/specs/`, own worktree):

7. Ability `vms`, Python VM helper, libvirt packages in `install.sh`, fleet grant, `hostId` on machines.
8. Remote create/list/power/options/seed.
9. Console tunnel for a remote guest.

**Series C — remote auto-install:**

10. `installConnector` with `hostId !== server` uses the same qemu-ga wrapper over `swarm.call`. Create on a remote host starts the same task.

## Progress

- [x] Read current guest connector, installers, create, vision, passt, qemu-ga default
- [x] Write this tracker
- [x] Product answers (OS, create-time, fallback, connected computers, both hosting and install)
- [x] Approve sequence (A then B then C) and remote helper shape
- [x] Lock design in this file (status → approved)
- [x] Isolated worktree (`/home/joseph/.worktrees/omarchy-server-guest-connector-install`, `feat/guest-connector-auto-install` from `upstream/main` `f2f41e2` / 0.9.76)
- [x] Implement Series A slices (Tasks 1–7 on `feat/guest-connector-auto-install`, HEAD `970de8f`)
- [x] Final-review fixes: wait for guest-ping, root linger prep, and Windows AutoLogon (`0f0adfe`); linger before enroll (`61a227d`); show install failure (`cfa1e07`)
- [x] Targeted tests + web typecheck (re-run at finish: 97 pass, 0 fail; `tsc --noEmit -p web` exit 0; HEAD `b819d52`)
- [x] PR Series A: https://github.com/MyOwnDataCenter/Server/pull/951 (`feat/guest-connector-auto-install` → `main`)
- [x] Series B spec and plan on `feat/swarm-vm-hosting`: `docs/superpowers/specs/2026-11-24-swarm-vm-hosting-design.md` and `docs/superpowers/plans/2026-11-24-swarm-vm-hosting.md` (`d29fd96`)
- [x] Implement Series B slices 7–9 (Tasks 1–12 on `feat/swarm-vm-hosting`, HEAD `94bcf2f`)
- [x] Targeted tests + web typecheck (93 pass, 0 fail on swarm-vms/console/machines/fleet-list/connector-install-noint; `tsc --noEmit -p web` exit 0; Python VM helper and agent suites OK)
- [x] PR Series B stacked on A: https://github.com/MyOwnDataCenter/Server/pull/952 (`feat/swarm-vm-hosting` → `main`, land after #951)
- [x] Series C spec and plan on `feat/remote-guest-connector-install`: `docs/superpowers/specs/2026-11-24-remote-guest-connector-design.md` and `docs/superpowers/plans/2026-11-24-remote-guest-connector.md`
- [x] Series C: remote `installConnector` when `hostId !== 'server'`, and create-time auto-install on a remote guest (HEAD `b25f482`)
- [x] PR Series C stacked on B: https://github.com/MyOwnDataCenter/Server/pull/954 (`feat/remote-guest-connector-install` → `main`, land after #952)

## Constraints to keep

- Isolated feature branch from `upstream/main`. Do not push `local/security-and-perf`. Do not mix isolation overlay paths into the diff.
- Do not restart omarchyd from a session that is a child of `omarchyd.service`.
- `connector/agent.py` stays 4-space Python. JS stays tabs.
- qemu-ga `guest-exec` is not a generic shell RPC for the assistant.
