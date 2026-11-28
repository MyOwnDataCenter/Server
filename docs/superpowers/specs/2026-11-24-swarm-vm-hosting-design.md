# Virtual machines on a joined computer

Date: 2026-11-24
Status: ready for implementation
Repo: omarchy-server. Implement on `feat/swarm-vm-hosting`, stacked on Series A `feat/guest-connector-auto-install` (`ab7d6a0`). Do not open a PR from this spec. Do not add local clone-path wiring. Leave `package.json` version, `OMARCHYD_VERSION`, and `web/src/changelog.ts` to the maintainer.

This is Series B of `docs/plans/guest-connector-auto-install.md`: subsystem 2, without guest connector auto-install. Series C (`machines.installConnector` when `hostId !== 'server'`, and create-time auto-install on a remote guest) is out of this spec.

## 1. Goal

The owner pairs a Linux computer with **Virtual machines** switched on. When that computer is online, the ability is on, and its helper reports libvirt, the fleet grants `vms`. Create on that computer runs the guest **there**. The guest is a row in this server’s `machines.json` with `hostId` set to that computer’s 12-hex agent id. The same machine page, power buttons, options, cloud-init seed, and `/api/console?machineId=<guest>` work. The guest’s traffic uses that computer’s network through passt.

A failure while creating marks the row `error` on this server. Nothing is defined on this server instead.

## 2. Why

Fleet already shows `vms` as not granted: `${name} can’t host its own virtual machines.` `CreateMachine` for `host.id !== 'server'` explains that and creates nothing. `machines.create` throws `PRECONDITION_FAILED` if `hostId` is anything but empty or `server`. This series makes that path real, using the same closed-verb connector shape as Storage.

## 3. Non-goals

- Series C: `machines.installConnector` when the guest’s `hostId` is not `server`. Create on a remote host does not call `waitForGuestConnector` and does not put connector packages, linger, or an install command in the seed or Windows answer file.
- Windows or macOS as a hypervisor. The agent forces `vms` off unless it is Linux. `connector/install.sh` on macOS drops `vms` from `--allow` the same way it drops Storage.
- Scanning virt-manager or other leftover domains. Inventory is only guests this product created (`omarchy-` plus an 8-hex id).
- Unraid import onto a joined computer. Import stays copy-onto-this-server and records `hostId: 'server'`.
- An ISO that lives in this server’s Home folder (`osId` starting with `local:`). That includes today’s Windows install ISOs. Remote create refuses them. The helper still knows the Windows domain layout (SATA disk, `e1000e`, answer ISO) so a catalog image with `kind: 'windows'` works. There is no such catalog image today.
- Snapshots, backups, clone, hibernate, USB, the QEMU monitor, adding or resizing disks, and changing CD media on a remote guest. Those procedures refuse before any local `virsh`.
- Bridged networking. Passt only, same as this server.
- A general shell on the joined computer. `ga-exec` is qemu-guest-agent `guest-exec` for a later series, not a host shell, and Series B does not call it from `installConnector`.
- Nested hosting: the Add-a-computer sheet for a guest hides Virtual machines and does not send `vms: true`.
- Assistant tools.
- Bumping `INSTALLER_REVISION` in the server `install.sh`. The VM helper is the connector script. Host `helper/helper.mjs` does not change.
- `qemu-agent.mjs` behavior. Keep `createQemuAgent({run, domain})` as it is. Series C will point `run` at the host. This series does not edit that file.

## 4. Architecture

```
SPA Create / machine page /api/console?machineId=<8 hex>
        │
        ▼
omarchyd machines.mjs
  hostId missing or 'server'  →  virsh -c qemu:///session   (unchanged)
  hostId = <12-hex agent>     →  connector.call(hostId, 'vm-*')
        │                              │
        │                              ▼
        │                     connector/agent.py  (user, ability vms)
        │                              │  python3 vm-helper.py <verb> …
        │                              ▼
        │                     ~/.local/share/omarchy-connector/vm-helper.py
        │                       qemu:///session as that user
        │                       passt, disks under vm-images/ and vms/<id>/
        ▼
machines.json on this server   (one inventory, hostId on each guest)
```

The VM helper is not the storage helper. Storage runs as root through sudo because it formats disks. Session libvirt is the installing user’s session. Running the VM helper through sudo would define domains in root’s session, which is the wrong bus. Package install is the only privileged step.

`NoNewPrivileges=yes` stays on the connector unit unless Storage was allowed. Virtual machines do not clear that flag.

Console: the browser URL does not change. omarchyd already bridges `/machines/console?machineId=` to a local unix socket, and `agent-<12 hex>` to the computer’s desktop VNC. A guest whose `hostId` is an agent opens a VNC channel on that agent with `guest: <8 hex>`. The agent connects to the socket `vm-helper.py vnc-path` prints. It does not start wayvnc and it does not accept a path from the server.

## 5. Ability `vms`

Opt-in at pairing. It cannot be widened later (`swarm.setAbilities` already refuses an ability that was not allowed at join).

| Place | Change |
|---|---|
| `omarchyd/connector.mjs` `ABILITIES` | Append `'vms'` |
| `connector/agent.py` `ABILITY_NAMES` | Append `"vms"` |
| `WINDOWS_ABILITIES` / `MAC_ABILITIES` | Do not add `vms`. `supported_abilities` forces it false |
| `connector/install.sh` macOS keep-list | Do not add `vms` |
| `web/src/swarm/Swarm.tsx` `Abilities` / `ABILITY` | `vms: {label: 'Virtual machines', icon: 'machine', what: 'Create and run virtual machines on this computer'}` |
| Add-a-computer default | `vms: false` for a physical computer. Hidden and forced false when `guest` is set |
| Guest connector defaults in `guest-install.mjs` | Unchanged. Do not add `vms` to `LINUX_CONNECTOR_ALLOW` or `WINDOWS_CONNECTOR_ALLOW` |

The agent reports libvirt on hello, not on the 3s metrics push. `info()` adds `libvirt: true` only when `vms` is allowed and `vm-helper.py status` says libvirt is available. Any other case, including a missing helper, is `libvirt: false`. `info()` must not throw because the helper is missing.

`cleanInfo` keeps `libvirt: i.libvirt === true` and drops every other value. `swarm.list`’s view adds `libvirt: a.info?.libvirt === true`.

### Fleet grant

`web/src/fleet/list.ts` `ComputerFleetInput` gains `vms` on `allowed` and `on`, plus `libvirt?: boolean`.

```
granted = online && allowed.vms && on.vms && libvirt === true
reason  = `${name} can’t host its own virtual machines.`
```

That reason is the only fleet reason. Offline, ability off, and missing libvirt all use it. Guests still cannot host (`guestAbilities` stays `granted: false` with the same sentence). Home and Machines pass `libvirt` from `swarm.list` into `computerFleetInput`.

When the grant is on, the computer glance lists guests whose `hostId` equals that agent id, plus Create. The server glance and server sheet list guests whose `hostId` is missing or `server` only. A remote guest must not appear as a virtual machine of this server.

## 6. Where files live on the host

Under the connector data directory (`$XDG_DATA_HOME/omarchy-connector` or `~/.local/share/omarchy-connector`):

- `vm-helper.py` — the script, mode `0700`, same directory as `agent.py`
- `vm-images/<image id>` — cached catalog download
- `vms/<8-hex>/` — mode `0700`: `disk.qcow2`, `seed.iso`, `answer.iso`, `domain.xml`, `vnc.sock`, `cd0.iso` when a catalog ISO is the boot CD

Every path the helper writes is `realpath`’d and must stay inside `vm-images/` or `vms/<that id>/`. A `..` segment fails before any `virsh` or `qemu-img`.

Domain name is `omarchy-<8 hex>`, same as this server. This server’s `machines.json` stores the logical layout (disk ids, buses, roles, basename `file` such as `disk.qcow2`). It does not store the host’s home path.

## 7. Helper verbs

`connector/vm-helper.py`. Python 3.8+, stdlib plus the commands below. Entry:

```
python3 vm-helper.py <verb> [args...]
```

stdin is a JSON object only for `seed`, `define`, and `ga-exec`. Any other stdin is ignored. The process refuses uid 0: `Run this as the person who installed the connector, not root`. Unknown verb: stderr `Unknown action`, exit 1. Extra arguments: stderr `Unknown action`, exit 1. No shell. `subprocess` lists only.

`handle(verb, args, stdin=None, run=None, fetch=None, data_dir=None, kvm_path=None, uid=None)` is the test seam. `run(cmd, args, input=None)` returns stdout text. `fetch(url)` returns bytes. Defaults shell out and download.

### 7.1 `status` (no args)

Stdout one JSON object:

```
{"libvirt": bool, "kvm": bool, "arch": "amd64"|"arm64", "threads": int,
 "memoryMb": int, "freeGb": int, "passt": bool, "xorriso": bool,
 "videoModels": string[], "qemu": string|null, "libvirtVersion": string|null}
```

`libvirt` is true only when `virsh --version` and `qemu-img --version` both exit 0. `kvm` is true when `kvm_path` (default `/dev/kvm`) is readable and writable. `arch` is `arm64` when `uname -m` is `aarch64` or `arm64`, otherwise `amd64`. `threads` is `os.cpu_count()` or 1. `memoryMb` is `MemTotal` from `/proc/meminfo` (tests inject it). `freeGb` is free space on `data_dir`. `passt` / `xorriso` are `shutil.which`. `videoModels` is `vga`, `virtio`, `none`, plus any of `bochs`, `qxl`, `cirrus` whose device name appears in `qemu-system-x86_64 -device help` (on ARM, `virtio` and `none` only). A probe failure leaves versions null and `libvirt` false; it does not raise past `handle`.

### 7.2 `fetch IMAGE_ID CATALOG_URL`

- `IMAGE_ID`: `^[a-z0-9][a-z0-9.-]{1,63}$`
- `CATALOG_URL`: `^https://` , length 8–500, no whitespace, no `@` before the host

Fetch the catalog. It must be JSON `{version: 1, images: [...]}`. Find `IMAGE_ID`. Its `url` must be `https://` with the same limits. Checksum is either `checksums: {url: https://…, algorithm: sha256|sha512}` or `sha256` as 64 hex. Download the image to `vm-images/<id>.part`, hash it, rename to `vm-images/<id>` only on match. Mismatch deletes the partial and fails `The image didn’t match its checksum`. A catalog image whose arch doesn’t match this host fails `That operating system isn’t available on this computer`.

Progress: stderr lines `PROGRESS <0-100>` during the image body (not the checksum file). The agent turns those into connector `op: progress`. Stdout on success is the absolute image path.

### 7.3 `disk-create GUEST_ID SIZE_GB [IMAGE_ID]`

`GUEST_ID` is `^[a-f0-9]{8}$`. `SIZE_GB` is an integer 1–4096. Optional `IMAGE_ID` must already exist under `vm-images/`.

Write `vms/<id>/disk.qcow2.part`, then rename to `disk.qcow2`. With `IMAGE_ID`: `qemu-img convert -O qcow2 <image> <part>` then `qemu-img resize <part> <SIZE_GB>G`. Without: `qemu-img create -f qcow2 <part> <SIZE_GB>G`. A crash must not leave a final `disk.qcow2` from a partial convert. Stdout `ok`.

### 7.4 `seed GUEST_ID NAME`

`NAME` is `seed` or `answer`. stdin JSON:

```
{"label": "cidata" | "OMARCHY_ANSWER", "files": {"<name>": "<text>", ...}}
```

File names match `^[A-Za-z0-9_.-]{1,64}$`. At most 8 files. Each text is at most 256 KiB and the total at most 1 MiB. Label is exactly `cidata` or `OMARCHY_ANSWER`. `seed` requires label `cidata`. `answer` requires `OMARCHY_ANSWER`.

Write the files in a temp directory inside `vms/<id>/` and run `xorriso -as mkisofs -quiet -output <vms/<id>/<NAME>.iso> -volid <label> -joliet -rock <names>`. Delete the temp directory. Do not print file contents. Stdout `ok`.

The server builds the text. Cloud and Omarchy seeds are account and hostname only (password already hashed in the user-data or credentials JSON). The Windows answer file is the existing `windowsAnswerFile` output. No connector install command and no `qemu-guest-agent` package list are added on this path.

### 7.5 `define GUEST_ID`

stdin is one JSON spec. Reject unknown keys. Schema:

| Field | Rule |
|---|---|
| `id` | same 8 hex as the argv guest id |
| `name` | 1–64 chars, XML 1.0 Char (same rule as `xmlChars` in `machines.mjs`) |
| `memoryMb` | integer 256–1048576 |
| `sockets` | integer 1–16 |
| `cores` | integer 1–256 |
| `cpuType` | `host`, `host-model`, `max`, `qemu64` |
| `mac` | `^([0-9a-f]{2}:){5}[0-9a-f]{2}$`, unicast (low bit of the first octet clear) |
| `firmware` | `bios` or `efi` |
| `arch` | `amd64` or `arm64`, must match `status.arch` |
| `machineType` | `q35` or `pc` |
| `nic` | `virtio`, `e1000e`, `e1000`, `rtl8139` |
| `video` | `vga`, `virtio`, `bochs`, `qxl`, `cirrus`, `none` |
| `kvm`, `tablet`, `acpi`, `agent`, `bootMenu`, `linkDown` | booleans |
| `notes` | string, at most 8000 chars, XML Char, may be empty |
| `boot` | array of disk ids or `net`, at least one, no duplicates |
| `disks` | 1–8 objects: `id` `^[a-z][a-z0-9]{0,15}$`, `device` `disk` or `cdrom`, `bus` `virtio`/`sata`/`scsi`/`ide`, `format` `qcow2` or `raw`, optional `role` `seed` or `answer` or null, optional `cache` from the host list in `machines.mjs` (`default`, `none`, `writeback`, `writethrough`, `directsync`, `unsafe`), optional `discard` bool, `file` basename `^[A-Za-z0-9._-]{1,64}$` |
| `portForwards` | at most 32: `protocol` `tcp` or `udp`, `hostPort` integer 40000–49999, `guestPort` integer 1–65535 |

A `disk` device’s file must already exist in `vms/<id>/`. A cdrom file may be missing. `role: seed` uses `seed.iso`. `role: answer` uses `answer.iso`.

Write `domain.xml` mode `0600` and `virsh -c qemu:///session define <that file>`. XML matches `domainXml` in `machines.mjs`: passt user interface, VNC on `vms/<id>/vnc.sock` (not a TCP port), virtio guest-agent channel when `agent` is true, tablet unless `tablet` is false. ARM uses machine `virt`, UEFI, SCSI instead of SATA or IDE, and virtio video unless video is `none`. On x86, IDE with machine type `q35` fails `IDE is only available on the i440fx (pc) machine type`. Re-define keeps `virsh domuuid` when the domain already exists, same as this server. Domain type is `kvm` only when `kvm` is true and `/dev/kvm` is usable; otherwise `qemu`. Stdout `ok`.

### 7.6 Power, state, inspect, stats, vnc, undefine

| Verb | Args | Does |
|---|---|---|
| `start` | guest id | `virsh start omarchy-<id>`. Already-active is success |
| `shutdown` | guest id | `virsh shutdown` |
| `reboot` | guest id | `virsh reboot` |
| `destroy` | guest id | `virsh destroy`. Missing domain is success |
| `suspend` | guest id | `virsh suspend` |
| `resume` | guest id | `virsh resume` |
| `state` | none | JSON object of `omarchy-<8 hex>` → libvirt state string from `virsh list --all`. Other domain names are omitted |
| `vnc-path` | guest id | stdout the absolute `vnc.sock` path if it is a socket. Else exit 1 `isn’t running` |
| `inspect` | guest id | JSON `{state, disks: [{file, virtualGb, usedGb}]}` using `qemu-img info --output=json -U` for each `disk` file in the directory |
| `stats` | none | stdout of `virsh domstats --list-running --cpu-total --balloon --interface --block`, filtered to `Domain: 'omarchy-<8 hex>'` blocks only |
| `undefine` | guest id | `destroy` if listed and not shut off; then `undefine --nvram --managed-save`, then `--nvram`, then plain `undefine` (older libvirt); then delete `vms/<id>` only after `realpath` is that directory. Does not delete `vm-images/` |

Stdout of the power verbs and `undefine` is `ok`.

### 7.7 qemu-ga

These exist so Series C can call them. Series B does not call them from `installConnector` or from create.

| Verb | Args | stdin | Does |
|---|---|---|---|
| `ga-ping` | guest id | none | `virsh qemu-agent-command omarchy-<id> {"execute":"guest-ping"}` |
| `ga-exec` | guest id | `{path, args?, input?, capture?}` | `guest-exec`. `path` matches `^/(?:[A-Za-z0-9._+-]+/)*[A-Za-z0-9._+-]+$` and is at most 200 chars. `args` is at most 32 strings, each at most 4096 chars, no NUL. `input` is a string at most 65536 chars; the helper base64-encodes it as `input-data`. `capture` defaults true. Stdout JSON `{"pid": number}` |
| `ga-status` | guest id, pid | none | pid is an integer 1–2147483647. `guest-exec-status`. Stdout JSON `{"exited": bool, "exitcode": number|null, "out": string, "err": string}` with base64 decoded |

`virsh` argv is the JSON as one argument, same shape `createQemuAgent` already sends. The helper does not run `path` on the host.

## 8. Agent

`VM_HELPER = os.path.join(DATA_DIR, "vm-helper.py")`.

`VM_ACTIONS` maps call names to the helper. The agent runs `[sys.executable, VM_HELPER, verb, *positional]` with stdin bytes for the three JSON verbs. Timeout 30 minutes for `vm-fetch` and `vm-disk-create`, 2 minutes otherwise. stderr `PROGRESS n` lines become `{op: "progress", id: <call id>, percent: n/100, step: "download"}` and are not part of the result. Any other stderr line is the error string, clipped to 300 chars the way `call` already clips.

| Call name | Verb |
|---|---|
| `vm-status` | `status` |
| `vm-fetch` | `fetch` |
| `vm-disk-create` | `disk-create` |
| `vm-seed` | `seed` |
| `vm-define` | `define` |
| `vm-start` | `start` |
| `vm-shutdown` | `shutdown` |
| `vm-reboot` | `reboot` |
| `vm-destroy` | `destroy` |
| `vm-suspend` | `suspend` |
| `vm-resume` | `resume` |
| `vm-undefine` | `undefine` |
| `vm-state` | `state` |
| `vm-vnc-path` | `vnc-path` |
| `vm-inspect` | `inspect` |
| `vm-stats` | `stats` |
| `vm-ga-ping` | `ga-ping` |
| `vm-ga-exec` | `ga-exec` |
| `vm-ga-status` | `ga-status` |

`call()` checks `vms` before `VM_ACTIONS`. Missing ability: `This computer doesn’t allow virtual machines`. Unknown `vm-*` name: `Unknown action`. Names are not passed to a shell and are not prefixed onto `sudo`.

Positional args are strings the helper’s regex accepts. The agent rejects a non-string arg, a string longer than 500 chars, or a string containing whitespace before it spawns. JSON verbs send the object on stdin, not argv.

Guest VNC is a channel, not a call. See section 11.

## 9. Install

`connector/install.sh`, only when `has vms`, the OS is Linux, and `--user-enroll-only` is not set.

Download `vm-helper.py` with `fetch_connector`, `python_ok` it, and `install -m 700` it to `$DIR/vm-helper.py`. Do not copy it to `/usr/local/libexec` and do not add a sudoers rule.

Then install packages the same way Storage does (one package at a time, a missing package warns, the rest continue):

| Package manager | Packages |
|---|---|
| `pacman` on x86_64 | `qemu-base`, `edk2-ovmf`, `libvirt`, `passt`, `libisoburn` |
| `pacman` on aarch64 | `qemu-base`, `qemu-system-aarch64`, `edk2-aarch64` (if `pacman -Si` / `-Qi` fails, `qemu-system-arm-firmware` instead), `libvirt`, `passt`, `libisoburn` |
| `apt-get` on x86_64 / amd64 | `qemu-system-x86`, `qemu-utils`, `libvirt-clients`, `libvirt-daemon`, `passt`, `xorriso`, `ovmf` |
| `apt-get` on aarch64 / arm64 | `qemu-system-arm`, `qemu-utils`, `libvirt-clients`, `libvirt-daemon`, `passt`, `xorriso`, `qemu-efi-aarch64` |
| `dnf` | `qemu-kvm`, `qemu-img`, `libvirt-client`, `libvirt-daemon`, `passt`, `xorriso`, `edk2-ovmf` |
| `zypper` | `qemu-x86`, `qemu-tools`, `libvirt-client`, `libvirt-daemon`, `passt`, `xorriso`, `qemu-ovmf-x86_64` |

Use `omarchy pkg add` on Omarchy, same as the storage loop. No package manager: warn and continue. After install, the fleet grant still depends on `status.libvirt`, not on the package manager’s exit code.

Uninstall already deletes `$DIR`, which removes `vm-helper.py` and `vms/`. Do not add a sudo `rm` for this helper.

`--allow` stays `^[a-z,]*$`. `vms` is a legal token. macOS still rebuilds `ALLOW` as only `terminal`, `files`, and `manage`.

## 10. Inventory and RPCs

### 10.1 `hostId`

Each machine in `machines.json` has `hostId: 'server'` or a 12-hex agent id. `normalize` sets a missing `hostId` to `'server'`. `machines.list` returns `hostId` on every row. The SPA `Machine` type gains `hostId?: string`. Home and Machines pass it to `guestFleetInput`.

`createMachines` gains optional `isOwner(ctx)`. The server passes `(ctx) => accounts.getUser(ctx?.auth?.userId)?.role !== 'member'`. The default is `() => true` so existing direct procedure tests stay valid. Remote mutations call it and throw `FORBIDDEN` `Only the server’s owner can manage virtual machines on another computer.` Local mutations do not call it. `machines.installConnector` stays owner-only in `server.mjs` as it is today.

The connector facade passed into `createMachines` gains:

```
call: (id, name, args, timeout) => connector.call(id, name, args, timeout)
progress: (id) => connector.progress(id)
```

`pair` and `list` stay. `connector` is still assigned after `createMachines`; the closures follow the existing `pair` / `list` pattern.

`hostOf(m)` is `'server'` when `hostId` is missing or `'server'`, otherwise the agent id. `assertLocal(m)` throws `PRECONDITION_FAILED` `${m.name} is on another computer. That action isn’t available there yet.` and is the first line of every procedure that is not in the remote set below.

On `ready`, a remote machine whose saved `state` is `'installing'` is rewritten to `state: 'error'`, `errorMessage: 'Creating it was interrupted. Delete it and create it again.'` There is no resume.

### 10.2 `swarm.vms.status`

Query, owner, in `connector.procedures`, the `server.mjs` swarm name list (kind `query`), and `server/app.mjs` `ALLOWED`.

Input `{id}` agent id. Offline → `PRECONDITION_FAILED` `${name} is offline right now`. Ability off → the result is `{vmsAllowed: false, libvirt: false}` and not a throw (the fleet already explains). Ability on → `call(id, 'vm-status', {})` and return `{vmsAllowed: true, libvirt, kvm, arch, threads, memoryMb, freeGb, videoModels, performanceWarning?}`. `performanceWarning` is the same sentence `machines.capabilities` uses when libvirt is up and kvm is not. A call failure while the ability is on is `BAD_GATEWAY` with the agent’s error.

### 10.3 `machines.capabilities`

Optional input `{hostId}`. Empty or `server`: today’s local probe. A 12-hex id: owner check, then `vm-status`, mapped to `{hostArchitecture, libvirtAvailable, kvmAvailable, threads, memoryTotalMb, performanceWarning?}`. Bad id: `BAD_REQUEST` `That computer isn’t valid.`

### 10.4 `machines.node`

Optional input `{id}` of a machine. No id: this server, unchanged. A remote machine: owner check, then the host’s `vm-status` mapped into the existing node fields the hardware sheet reads (`threads`, `memoryTotalMb`, `memoryFreeMb` from `freeGb`, `libvirtVersion`, `qemuVersion`, `videoModels`, `cpuTypes`, `nicModels`, `diskBuses`, `diskCaches`). `cpuTypes` and the nic/bus/cache lists are the same constants as local. Counts count only machines with that `hostId`.

### 10.5 Create

`machines.create` still returns `{id}` before the work finishes.

`hostId` empty or `server`: the current function, including Series A `waitForGuestConnector`. Do not call the helper.

`hostId` a 12-hex id:

1. Owner check.
2. Agent exists or `NOT_FOUND` `That computer isn’t in your swarm`.
3. Online or `PRECONDITION_FAILED` `${name} is offline right now`.
4. `vms` allowed and on or `FORBIDDEN` `Pair ${name} again with Virtual machines switched on.`
5. `vm-status`. `libvirt` false → `PRECONDITION_FAILED` `Virtual machines need libvirt and QEMU on ${name}. Run the connector install again with Virtual machines switched on.`
6. `osId` starting with `local:` → `PRECONDITION_FAILED` `That ISO is on this server. Create this machine here.` Do not read the ISO and do not define a domain.
7. Catalog image must exist and `img.arch` must equal the host arch. Else `BAD_REQUEST` `That operating system isn’t available on ${name}`.
8. Same name, username, password, cores, memory, and disk checks as local create, using the host’s `threads`, `memoryMb`, and `freeGb`. The memory ceiling is `max(1, floor(memoryMb/1024) - 1)` gigabytes. The error text names the computer, not “the server”, when the limit is the host’s.
9. Windows catalog `kind` (none today) still requires host arch `amd64`.
10. Allocate an 8-hex id that does not collide. Persist `hostId`, `state: 'installing'`, `options: {agent: true}`, and the layout from `layoutFor` with basenames only (`disk.qcow2`, `seed.iso`, `answer.iso`). `save()` failure removes the row and does not call the host.
11. Return `{id}` and continue in the background.

Background, in order, with `busy` progress taken from `connector.progress(hostId)` while each call runs (percent 0–1 mapped onto the same 0–100 scale local create uses: fetch through 80, disk through 90, seed 92, define 96, start 100):

| Kind | Calls |
|---|---|
| cloud | `vm-seed` (user-data + meta-data, no `connectorCloudInit`), `vm-fetch`, `vm-disk-create` with the image id, `vm-define`, `vm-start` |
| omarchy (`kind: 'iso'`) | `vm-seed` (user_configuration.json + user_credentials.json), `vm-fetch`, `vm-disk-create` blank, `vm-define` with `cd0` pointing at the cached image basename copied into the guest dir by `disk-create`’s sibling: the helper `fetch` path is not inside the guest dir, so `disk-create` without an extra copy is wrong for the CD. `define`’s cdrom `file` may be the image id basename only when the helper resolves `cd0` files that name a `vm-images/<id>` file. The spec field `file` for a boot CD is `image:<image id>` and the helper maps that to the cache file, read-only, and refuses any other `image:` value |
| windows catalog | `vm-seed` name `answer`, `vm-fetch`, blank `vm-disk-create`, `vm-define` with `image:<id>` as `cd0`, `vm-start` |

Cloud seed is built with `cloudUserData` and `hashPassword` on the server. Do not call `connectorCloudInit`. Omarchy uses `omarchyConfiguration` and `omarchyCredentials`. Windows uses `windowsAnswerFile` without `windowsCommand`.

`vm-define`’s spec is the persisted layout plus forwards (none at create), mac, and options. `agent: true` so the guest-agent channel exists for Series C. That is not an install.

On success: delete `state` and `errorMessage`, set `liveForwards`, end the create task. On failure: `state: 'error'`, `errorMessage` the call’s message, end the task with the error. Do not `virsh` on this server. Do not retry on this server. Do not start Series A’s connector wait.

### 10.6 List, details, stats

`machines.list` groups remote rows by `hostId` and calls `vm-state` once per online host. Map libvirt words with the existing `STATE` table. A host that is offline or whose call fails keeps the last saved `hostState` (`running`, `stopped`, `suspended`, `hibernated` is not used remotely). If there is no `hostState`, use `stopped`. Do not mark the row `error` just because the host is offline. `installing` and `error` in the saved record win over libvirt, same as local `busy` and `error`. After a successful read, persist `hostState` on the next `save` (the list path may save at most once per call).

`machines.details` for a remote guest uses the saved layout and `vm-inspect` for sizes. Offline: return the saved layout with null sizes, not a throw, so the page opens.

`sample()` keeps using local `virsh domstats` for `hostId === 'server'`. For each online remote host it also calls `vm-stats` and feeds that text through the same parser. One failed host does not stop the others.

### 10.7 Power

`start`, `stop` (`shutdown`), `forceStop` (`destroy`), `restart` (`reboot`), `pause` (`suspend`), `resume` (`resume`) go to the matching `vm-*` call when `hostOf` is an agent. Owner check. Busy → `CONFLICT` as today. `error` state and start: if `disk.qcow2` exists on the host (`vm-inspect` lists it), `vm-define` then `vm-start`. Otherwise `PRECONDITION_FAILED` `${name} didn’t finish setting up. Delete it and create it again.`

Restart while `pending`: `vm-shutdown`, poll `vm-state` until `shut off` or 3 minutes, then `vm-define` and `vm-start`. The 3-minute failure text stays `didn’t shut down within 3 minutes; use Stop, then Start`.

Hibernate calls `assertLocal`.

### 10.8 Options, forwards, hardware, seed

These are the remote set, all owner-checked, all refused with `assertLocal`’s opposite (they run remotely):

- `machines.updateOptions`
- `machines.updateSettings` (port forwards only; other settings in that function follow the same saved-then-define path)
- `machines.updateHardware`
- `machines.setBootOrder`
- `machines.updateCloudInit`

Validate with the existing functions. Then persist and `vm-define` with the new spec. While the domain is running, set `pending` the way `markChanged` does, except a cloud-init seed change only replaces `seed.iso` via `vm-seed` and `vm-define` and still waits for the next boot (cloud-init’s own rule). `updateCloudInit` on a guest without `cloudInit` throws the existing `doesn’t use cloud-init` error.

`updateHardware` video must be in the host’s `videoModels` from `vm-status`.

### 10.9 Uninstall

Remote `machines.uninstall` is owner-only. Offline → `PRECONDITION_FAILED` `${host} is offline, so ${name} was not deleted.` Do not remove the row. Online → `vm-undefine`, then remove the row and save. A failed undefine leaves the row.

`uninstallAll` (factory reset) calls the same remote uninstall and then the local one. A remote failure is logged and the row remains; factory reset does not pretend the disks are gone.

### 10.10 Refused on a remote guest

`assertLocal` on: `hibernate`, `snapshot`, `revertSnapshot`, `deleteSnapshot`, `listBackups`, `backup`, `restoreBackup`, `deleteBackup`, `clone`, `monitor`, `addDisk`, `updateDisk`, `resizeDisk`, `removeDisk`, `addCdrom`, `setMedia`, USB bind/unbind/attach/detach, and `installConnector`.

`installConnector` checks `hostOf` before `liveState` and before `createQemuAgent`, and throws `PRECONDITION_FAILED` `Install the connector from the computer that hosts this virtual machine once that is available.` It must not ping a local domain.

Import and clone always write `hostId: 'server'`. An input `hostId` on those paths is ignored.

## 11. Console

SPA URL stays `/api/console?machineId=<8 hex guest id>`. No new query parameter.

`machines.vncSocket(id)`:

- Local: today’s unix path, or throw `PRECONDITION_FAILED` `${name} isn’t running`.
- Remote: owner is not required (a member who can open a local guest console can open this one). Host offline or `vms` off → `PRECONDITION_FAILED` with the offline or pair-again sentence from section 10.5. Return `{agentId, guest: id}` instead of a path. Do not call `vm-vnc-path` here; the agent does, so a missing socket becomes the connector close reason rather than a path the server could misuse.

`omarchyd/server.mjs` upgrade for `/machines/console`: if `vncSocket` returns `agentId`, `connector.openChannel(agentId, 'vnc', ws, {guest})`. Otherwise the existing `net.connect({path})`.

`openChannel`:

- `kind === 'vnc'` and `opts.guest` matches `^[a-f0-9]{8}$`: the ability is `vms`, not `desktop`. The open message is `{op:'open', ch, kind:'vnc', guest}`.
- `kind === 'vnc'` without `guest`: today’s desktop channel, ability `desktop`.
- Any other `guest` value closes the browser socket with `1011` and does not send `open`.

Agent `Connection` on `op: open` for `vnc` with `guest`: require `vms`, validate the id, spawn a thread that runs `vm-helper.py vnc-path <id>` and connects an `AF_UNIX` `SOCK_STREAM` to that path only if `realpath` is `vms/<id>/vnc.sock` under the data dir. Bytes are the existing channel head plus payload. Do not call `vnc_start` or `vnc_release`. A bad id or a missing socket sends `{op:'closed', code:1011, reason}` and does not open the desktop socket.

Switching `vms` off in `swarm.setAbilities` closes live channels whose `kind` is `vnc` and whose `guest` is set. Desktop channels still follow the `desktop` ability.

`/api/console/check` is unchanged: it issues a machines ticket and does not owner-gate an 8-hex machine id. The websocket close reason carries “isn’t running” or the ability sentence.

## 12. Errors

| Situation | Code | Message |
|---|---|---|
| Remote create/power/options/seed/uninstall by a member | `FORBIDDEN` | `Only the server’s owner can manage virtual machines on another computer.` |
| Unknown host id shape | `BAD_REQUEST` | `That computer isn’t valid.` |
| Agent id not in the swarm | `NOT_FOUND` | `That computer isn’t in your swarm` |
| Agent offline | `PRECONDITION_FAILED` | `${name} is offline right now` |
| `vms` not allowed or not on | `FORBIDDEN` | `Pair ${name} again with Virtual machines switched on.` |
| Helper or libvirt missing | `PRECONDITION_FAILED` | `Virtual machines need libvirt and QEMU on ${name}. Run the connector install again with Virtual machines switched on.` |
| Home-folder ISO | `PRECONDITION_FAILED` | `That ISO is on this server. Create this machine here.` |
| Catalog arch mismatch | `BAD_REQUEST` | `That operating system isn’t available on ${name}` |
| Create or define failed | row `state: 'error'` | the helper/agent sentence, no local domain |
| Action not in the remote set | `PRECONDITION_FAILED` | `${machine} is on another computer. That action isn’t available there yet.` |
| Remote install connector | `PRECONDITION_FAILED` | `Install the connector from the computer that hosts this virtual machine once that is available.` |
| Delete while the host is offline | `PRECONDITION_FAILED` | `${host} is offline, so ${name} was not deleted.` |
| Checksum mismatch | helper failure → row error | `The image didn’t match its checksum` |
| Helper argv rejected | `BAD_GATEWAY` | the helper’s stderr line |

RpcError codes stay `PRECONDITION_FAILED`, `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`, `BAD_GATEWAY`.

## 13. SPA

- `CreateMachine`: when `host.id !== 'server'`, render the same picker and form as local create, with `hostId: host.id` on `machines.create`. Delete the “can’t host a virtual machine yet” stub. Subtitle names the computer.
- Capabilities query key includes `hostId`. Cores and memory max come from that result (`threads`, `memoryTotalMb`), not from `useCpu` / `useMemory` of this server.
- Hide “Your own ISO” for a remote host. Footer: `The operating system is downloaded on ${name}. An ISO from this server’s files stays here.`
- `machines.osImages` stays this server’s catalog. Filter with the host architecture.
- Glance and server sheet filter by `hostId` as in section 5.
- Hardware sheet `useNode` passes the open machine’s id so `machines.node` can target the host.
- Console opener is unchanged (`desk.openConsole(selected.id)` / `/api/console?machineId=`).

## 14. Testing

TDD. Fake `run` / `fetch` / `connector.call`. No real libvirt and no remote computer. `node --test --test-concurrency=1` on the files touched. `python3 connector/test_vm_helper.py` and `python3 connector/test_vm_agent.py`. `npx tsc --noEmit -p web`. Do not treat full `npm test` host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) as this work’s bugs.

Cover at least:

- Helper rejects uid 0, unknown verbs, `..`, non-https catalog URLs, checksum mismatch, and a guest id that is not 8 hex. `fetch` never calls `virsh`. `state` drops a domain not named `omarchy-` plus 8 hex.
- `define` XML contains `qemu:///session`’s passt backend and a unix VNC socket under `vms/<id>/`, and no TCP `port=`.
- `ga-exec` puts `input-data` base64 in the JSON argv element and does not put the plaintext in a separate argv.
- Agent: `vms` off → error, no spawn. `vm-fetch` progress line becomes `op: progress`. A call name is not passed to `sh`.
- `install.sh --allow vms` copies `vm-helper.py` to `$DIR` mode `0700` and does not sudo-install it. `--allow terminal` does not install qemu. macOS allow list still drops `vms`. Unit keeps `NoNewPrivileges=yes` when storage is off, even if `vms` is on.
- Pairing stores `vms`. A later `swarm.setAbilities` cannot turn `vms` on if it was not allowed. Windows `supported_abilities` forces `vms` false.
- Fleet grant is true only when online, allowed, on, and `libvirt`. Otherwise the can’t-host sentence. A guest row is never granted `vms`.
- `machines.list` returns `hostId: 'server'` for old rows.
- Remote create persists `hostId` and, on helper failure, `state: 'error'` with no local `virsh define`. `hostId: 'server'` still creates locally and still runs the Series A connector wait.
- Remote create does not put `qemu-guest-agent` or `install.sh` in the seed.
- `local:` osId is refused and `call` is not invoked.
- Member `isOwner` false → `FORBIDDEN` on remote create, start, and `updateOptions`. Local create with the same `isOwner` still succeeds.
- `installConnector` on a remote guest does not call `qemu-agent-command`.
- Snapshot, hibernate, and `addDisk` on a remote guest throw the “isn’t available there yet” sentence and do not call `vm-*` or local `virsh`.
- Console open with `guest` uses ability `vms` and connects to `vms/<id>/vnc.sock`. Desktop open without `guest` still uses ability `desktop` and `vnc_start`.
- `npx tsc --noEmit -p web` is clean.

## 15. Series C handoff

Do not implement these. Leave the seams:

- `createQemuAgent({run, domain})` unchanged. A later caller passes `run` that performs `vm-ga-ping` / `vm-ga-exec` / `vm-ga-status`.
- Remote create sets `options.agent: true` and does not start an install task.
- `installConnector` returns the precondition in section 10.10 for `hostId !== 'server'` before any guest-exec.
