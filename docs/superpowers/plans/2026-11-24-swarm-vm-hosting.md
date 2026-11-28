# Swarm VM Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner create and run a virtual machine on a joined Linux computer, recorded in this server’s `machines.json` with `hostId`, without installing the guest connector.

**Architecture:** A user-session Python helper (`connector/vm-helper.py`, `qemu:///session`, passt) speaks a closed verb list. The connector agent exposes `vm-*` calls only when pairing ability `vms` is on. `machines.mjs` keeps one inventory and dispatches local `virsh` or `connector.call(hostId, 'vm-*')`. The console URL stays `/api/console?machineId=<guest>`; omarchyd opens a VNC channel keyed by that guest id. Series C (remote `installConnector`) is not this plan.

**Tech Stack:** Node 20+ ESM, omarchyd JSON-RPC, React + TanStack Query, Python 3.8+ connector stdlib, `node --test`, `python3` unittest.

**Spec:** `docs/superpowers/specs/2026-11-24-swarm-vm-hosting-design.md`

## Global Constraints

- Work from `/home/joseph/.worktrees/omarchy-server-swarm-vm-hosting` on `feat/swarm-vm-hosting`. `node_modules` is a symlink; do not npm install.
- Tabs, no semicolons, single quotes in JS. Python in `connector/` is 4-space. Commit messages are sentence case, no `feat:` prefix, no trailing period.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `web/src/changelog.ts`, or host `install.sh` `INSTALLER_REVISION`.
- Do not mix isolation overlay (`OMARCHY_SERVER_SOURCE`, `~/code` paths). Do not edit `helper/helper.mjs` or `omarchyd/qemu-agent.mjs`.
- RpcError codes: `PRECONDITION_FAILED`, `CONFLICT`, `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`, `BAD_GATEWAY`.
- Remote create, power, options, seed, hardware, and uninstall are owner-only. Local `machines.create` auth does not change. `machines.installConnector` stays owner-only and refuses `hostId !== 'server'`.
- VM helper runs as the connector user, never sudo. `NoNewPrivileges` stays tied to Storage only.
- v1 does not scan leftover domains, does not import Unraid onto a joined computer, and does not copy a Home-folder ISO.
- Remote create does not call `waitForGuestConnector` and does not embed connector install in the seed.
- Tests: fake helper and fake `call`. No real remote VM. `node --test --test-concurrency=1` on the task’s files. `npx tsc --noEmit -p web` after SPA edits. Known host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) are not this branch’s bugs.
- Execution is already subagent-driven. Do not ask which execution style to use.

## File map

Create:

- `connector/vm-helper.py` — closed verbs, session libvirt, passt, disks under the connector data dir
- `connector/test_vm_helper.py` — unittest with fake `run` / `fetch`
- `connector/test_vm_agent.py` — agent dispatch, progress, guest VNC socket
- `test/swarm-vms.test.mjs` — fleet is not here; omarchyd create/list/power/options/seed/refuse
- `test/swarm-vm-console.test.mjs` — openChannel guest id and the console upgrade choice

Modify:

- `connector/agent.py` — `ABILITY_NAMES`, `VM_ACTIONS`, `info().libvirt`, guest VNC channel
- `connector/install.sh` — packages and `$DIR/vm-helper.py` when `vms` is allowed
- `omarchyd/connector.mjs` — `ABILITIES`, `cleanInfo.libvirt`, `swarm.vms.status`, channel ability
- `omarchyd/server.mjs` — swarm procedure list, `createMachines` connector `call` / `progress` / `isOwner`
- `omarchyd/machines.mjs` — `hostId`, remote dispatch, `assertLocal`
- `server/app.mjs` — `ALLOWED['swarm.vms.status']`
- `web/src/fleet/list.ts` — grant `vms`
- `web/src/api.ts` — `Machine.hostId`
- `web/src/swarm/Swarm.tsx` — checkbox, default off, hidden for a guest
- `web/src/CreateMachine.tsx` — real remote form
- `web/src/screens/Machines.tsx`, `web/src/screens/Home.tsx`, `web/src/fleet/ServerSheet.tsx` callers — filter by `hostId`
- `web/src/machines/api.ts` — `useNode(machineId)`
- `test/fleet-list.test.mjs`, `test/connector.test.mjs`, `test/connector-install-noint.test.mjs`

Do not modify `omarchyd/qemu-agent.mjs`, `omarchyd/guest-install.mjs` allow lists, `helper/helper.mjs`, or `install.sh` at the repo root.

Slice map: Tasks 1–6 are tracker slice 7. Tasks 7–10 are slice 8. Tasks 11–12 are slice 9.

---

### Task 1: VM helper status and argv rejection

**Files:**
- Create: `connector/vm-helper.py`
- Create: `connector/test_vm_helper.py`

**Interfaces:**
- Consumes: nothing
- Produces: `handle(verb, args, stdin=None, run=None, fetch=None, data_dir=None, kvm_path=None, uid=None, uname=None, meminfo=None)` → stdout string or raises `SystemExit`-compatible `HelperError` with `.message`

- [ ] **Step 1: Write the failing test**

Create `connector/test_vm_helper.py`:

```python
import json
import os
import tempfile
import unittest

from vm_helper import HelperError, handle


class Status(unittest.TestCase):
    def test_status_and_rejections(self):
        log = []

        def run(cmd, args, input=None):
            log.append([cmd, *args])
            if cmd == "virsh" and args == ["--version"]:
                return "10.0.0\n"
            if cmd == "qemu-img" and args == ["--version"]:
                return "qemu-img version 9.0.0\n"
            if cmd == "qemu-system-x86_64":
                return '"bochs-display"\n'
            return ""

        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "vm-images"))
            out = handle("status", [], run=run, data_dir=d, kvm_path=os.path.join(d, "no-kvm"), uid=1000, uname="x86_64", meminfo="MemTotal: 8000000 kB\n")
        body = json.loads(out)
        self.assertEqual(body["libvirt"], True)
        self.assertEqual(body["kvm"], False)
        self.assertEqual(body["arch"], "amd64")
        self.assertIn("vga", body["videoModels"])
        self.assertIn("bochs", body["videoModels"])
        self.assertTrue(all(c[0] != "sh" for c in log))

        with self.assertRaises(HelperError):
            handle("status", [], uid=0)
        with self.assertRaises(HelperError) as unk:
            handle("rm", ["-rf", "/"])
        self.assertIn("Unknown action", str(unk.exception))
        with self.assertRaises(HelperError):
            handle("fetch", ["../etc/passwd", "https://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "http://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "https://user:pw@example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("start", ["not-an-id"], uid=1000)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 connector/test_vm_helper.py`
Expected: FAIL, `vm_helper` not found

- [ ] **Step 3: Write minimal implementation**

`connector/vm-helper.py` defines `HelperError(Exception)` and `handle`. Refuse `uid == 0` with `Run this as the person who installed the connector, not root`. Verb set is exactly the names in spec section 7 (`status`, `fetch`, `disk-create`, `seed`, `define`, `start`, `shutdown`, `reboot`, `destroy`, `suspend`, `resume`, `undefine`, `state`, `vnc-path`, `inspect`, `stats`, `ga-ping`, `ga-exec`, `ga-status`). Anything else, or extra args for `status`, raises `HelperError("Unknown action")`.

`status` runs `virsh --version`, `qemu-img --version`, and on non-ARM `qemu-system-x86_64 -device help`. `libvirt` is true only when both version commands return. `kvm` is `os.access(kvm_path, os.R_OK | os.W_OK)`. `arch` is `arm64` when `uname` is `aarch64` or `arm64`, else `amd64`. Parse `MemTotal` from `meminfo`. `freeGb` from `os.statvfs(data_dir)`. `videoModels` starts `["vga", "virtio", "none"]` and adds `bochs` / `qxl` / `cirrus` when the help text contains `"bochs-display"`, `"qxl-vga"`, `"cirrus-vga"`. ARM returns `["virtio", "none"]`. `fetch` in this task only validates argv (`^[a-z0-9][a-z0-9.-]{1,63}$`, `https://` without `@` or whitespace) and raises `HelperError("Not implemented")` after validation so the rejection tests pass and later tasks replace the body. `start` validates `^[a-f0-9]{8}$` or raises `HelperError("Not a virtual machine: …")`.

`main()` uses `os.geteuid()` and prints `handle` stdout. `HelperError` goes to stderr and exit 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 connector/test_vm_helper.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add connector/vm-helper.py connector/test_vm_helper.py
git commit -m "Add a session libvirt helper that rejects bad verbs"
```

---

### Task 2: Helper fetch, disk, seed, define, power, ga

**Files:**
- Modify: `connector/vm-helper.py`
- Modify: `connector/test_vm_helper.py`

**Interfaces:**
- Consumes: `handle` from Task 1
- Produces: the verbs in spec sections 7.2–7.7. `define` writes `domain.xml` and calls `virsh -c qemu:///session define`. `ga-exec` emits one JSON argv element.

- [ ] **Step 1: Write the failing test**

Append to `connector/test_vm_helper.py`:

```python
class Lifecycle(unittest.TestCase):
    def test_fetch_disk_seed_define_power_and_ga(self):
        log = []
        files = {}

        def run(cmd, args, input=None):
            log.append([cmd, *args])
            if cmd == "virsh" and args[:2] == ["-c", "qemu:///session"] and args[2] == "list":
                return " Id   Name              State\n---------------------------------\n -    omarchy-abcd1234   shut off\n -    win11             shut off\n"
            if cmd == "virsh" and "domuuid" in args:
                raise HelperError("no domain")
            if cmd == "virsh" and "qemu-agent-command" in args:
                return args[-1]
            return ""

        with tempfile.TemporaryDirectory() as d:
            # checksum of b"image-bytes"
            import hashlib
            digest = hashlib.sha256(b"image-bytes").hexdigest()
            catalog = json.dumps({"version": 1, "images": [{"id": "debian-12", "arch": "amd64", "kind": "cloud", "url": "https://example.test/os.qcow2", "sha256": digest}]}).encode()

            def fetch_ok(url):
                if url.endswith("catalog.json"):
                    return catalog
                return b"image-bytes"

            path = handle("fetch", ["debian-12", "https://example.test/catalog.json"], run=run, fetch=fetch_ok, data_dir=d, uid=1000, uname="x86_64")
            self.assertTrue(path.endswith("/vm-images/debian-12"))
            bad = json.dumps({"version": 1, "images": [{"id": "debian-12", "arch": "amd64", "kind": "cloud", "url": "https://example.test/os.qcow2", "sha256": "00" * 32}]}).encode()
            with self.assertRaises(HelperError) as mismatch:
                handle("fetch", ["debian-12", "https://example.test/catalog.json"], run=run, fetch=lambda url: bad if url.endswith("catalog.json") else b"image-bytes", data_dir=d, uid=1000)
            self.assertIn("checksum", str(mismatch.exception))

            handle("disk-create", ["abcd1234", "8", "debian-12"], run=run, data_dir=d, uid=1000)
            self.assertTrue(any(c[0] == "qemu-img" and "convert" in c for c in log))
            self.assertTrue(os.path.exists(os.path.join(d, "vms", "abcd1234", "disk.qcow2")))
            seed = json.dumps({"label": "cidata", "files": {"user-data": "#cloud-config\n", "meta-data": "instance-id: abcd1234\n"}})
            handle("seed", ["abcd1234", "seed"], stdin=seed, run=run, data_dir=d, uid=1000)
            self.assertTrue(any(c[0] == "xorriso" and "cidata" in c for c in log))
            spec = {
                "id": "abcd1234", "name": "Box", "memoryMb": 2048, "sockets": 1, "cores": 2,
                "cpuType": "host", "mac": "52:54:00:11:22:33", "firmware": "bios", "arch": "amd64",
                "machineType": "q35", "nic": "virtio", "video": "vga", "kvm": False, "tablet": True,
                "acpi": True, "agent": True, "bootMenu": False, "notes": "", "linkDown": False,
                "boot": ["disk0"],
                "disks": [
                    {"id": "disk0", "device": "disk", "bus": "virtio", "format": "qcow2", "file": "disk.qcow2"},
                    {"id": "seed", "device": "cdrom", "bus": "sata", "format": "raw", "role": "seed", "file": "seed.iso"},
                ],
                "portForwards": [{"protocol": "tcp", "hostPort": 40022, "guestPort": 22}],
            }
            # seed.iso is the xorriso output; fake run doesn't write it
            open(os.path.join(d, "vms", "abcd1234", "seed.iso"), "wb").close()
            handle("define", ["abcd1234"], stdin=json.dumps(spec), run=run, data_dir=d, uid=1000, uname="x86_64", kvm_path=os.path.join(d, "no-kvm"))
            xml = open(os.path.join(d, "vms", "abcd1234", "domain.xml"), encoding="utf-8").read()
            self.assertIn("<backend type='passt'/>", xml)
            self.assertIn("vnc.sock", xml)
            self.assertNotIn("port=", xml.split("<graphics")[1].split("/>")[0])
            self.assertIn("org.qemu.guest_agent.0", xml)
            define = [c for c in log if c[0] == "virsh" and "define" in c][-1]
            self.assertEqual(define[1:3], ["-c", "qemu:///session"])
            listed = json.loads(handle("state", [], run=run, data_dir=d, uid=1000))
            self.assertEqual(listed, {"omarchy-abcd1234": "shut off"})
            self.assertNotIn("win11", listed)
            secret = "sudo-secret"
            payload = json.dumps({"path": "/usr/bin/sudo", "args": ["-S", "true"], "input": secret, "capture": True})
            out = handle("ga-exec", ["abcd1234"], stdin=payload, run=run, data_dir=d, uid=1000)
            ga = [c for c in log if "qemu-agent-command" in c][-1]
            blob = ga[-1]
            self.assertNotIn(secret, " ".join(ga[:-1]))
            self.assertNotIn(secret, blob)
            body = json.loads(blob)
            self.assertEqual(body["execute"], "guest-exec")
            import base64
            self.assertEqual(base64.b64decode(body["arguments"]["input-data"]).decode(), secret)
```

`fetch_ok` is the only fetch double. Its catalog `sha256` is `hashlib.sha256(b"image-bytes").hexdigest()`, the digest of the bytes it returns for the image URL.

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 connector/test_vm_helper.py`
Expected: FAIL, `fetch` raises `Not implemented` or `disk-create` is unknown to the test’s expectations

- [ ] **Step 3: Write minimal implementation**

Implement spec 7.2–7.7 inside `handle`. `fetch` writes `vm-images/<id>.part` then renames. Compare the hash to the catalog `sha256` or to the digest `find` in the checksum file (GNU `hash  name` and BSD `SHA256 (name) = hash`, same rules as `findChecksum` in `machines.mjs`). `disk-create` uses a `.part` rename. `seed` rejects a password-looking debug print: stdout is `ok` only. `define` builds the XML from spec section 7.5 and the ARM rules in `domainXml`. `state` parses `virsh -c qemu:///session list --all` and keeps only `^omarchy-[0-9a-f]{8}$`. `ga-exec` / `ga-status` / `ga-ping` pass one JSON argument to `virsh`. `vnc-path` returns the socket path only when `stat` says socket and the realpath is `vms/<id>/vnc.sock`.

Boot CD: a disk `file` of `image:<image id>` resolves to `vm-images/<image id>` and nowhere else.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 connector/test_vm_helper.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add connector/vm-helper.py connector/test_vm_helper.py
git commit -m "Teach the VM helper to fetch, define, and power a guest"
```

---

### Task 3: Agent ability and vm-* calls

**Files:**
- Modify: `connector/agent.py` (`ABILITY_NAMES`, `supported_abilities` inputs, `info`, `Connection.call`)
- Create: `connector/test_vm_agent.py`

**Interfaces:**
- Consumes: helper verbs from Task 2
- Produces: `VM_ACTIONS` keys listed in spec section 8. `info()["libvirt"]` is bool. `call` rejects `vms` off before spawn.

- [ ] **Step 1: Write the failing test**

`connector/test_vm_agent.py` imports `ABILITY_NAMES`, `VM_ACTIONS`, `supported_abilities`, `info` is heavy; test the dispatch function instead. Export `vm_call(name, args, allowed, spawn, stdin=None)` from `agent.py` that `Connection.call` uses, so the test does not open a socket.

```python
import json
import unittest

from agent import ABILITY_NAMES, supported_abilities, vm_call


class VmAgent(unittest.TestCase):
    def test_ability_and_dispatch(self):
        self.assertIn("vms", ABILITY_NAMES)
        win = supported_abilities({"vms": True, "terminal": True}, windows=True)
        self.assertFalse(win["vms"])
        mac = supported_abilities({"vms": True}, mac=True)
        self.assertFalse(mac["vms"])
        spawned = []

        def spawn(argv, stdin=None):
            spawned.append((argv, stdin))
            if argv[-2] == "fetch":
                return "PROGRESS 40\nPROGRESS 100\n", "/data/vm-images/debian-12"
            return "", "ok"

        progress = []
        with self.assertRaises(RuntimeError) as off:
            vm_call("vm-status", {}, allowed={"vms": False}, spawn=spawn, progress=progress.append)
        self.assertIn("doesn’t allow virtual machines", str(off.exception))
        self.assertEqual(spawned, [])
        out = vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://example.test/catalog.json"}, allowed={"vms": True}, spawn=spawn, progress=progress.append)
        self.assertEqual(out, "/data/vm-images/debian-12")
        self.assertEqual(progress, [0.4, 1.0])
        argv = spawned[-1][0]
        self.assertNotIn("sh", argv)
        self.assertNotIn("sudo", argv)
        self.assertEqual(argv[-3:], ["fetch", "debian-12", "https://example.test/catalog.json"])
        with self.assertRaises(RuntimeError):
            vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://evil.test/a b"}, allowed={"vms": True}, spawn=spawn)
        with self.assertRaises(RuntimeError):
            vm_call("vm-nope", {}, allowed={"vms": True}, spawn=spawn)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 connector/test_vm_agent.py`
Expected: FAIL, `vm_call` missing or `vms` not in `ABILITY_NAMES`

- [ ] **Step 3: Write minimal implementation**

Add `"vms"` to `ABILITY_NAMES` only. Leave `WINDOWS_ABILITIES` and `MAC_ABILITIES` unchanged.

`vm_call` looks up `VM_ACTIONS`. It rejects when `allowed.get("vms")` is not true. It builds argv `[python, VM_HELPER, verb, *positionals]` from the arg dict keys in spec section 8 (`imageId`+`catalogUrl` for fetch, `guestId`+`sizeGb`+optional `imageId` for disk-create, and so on). Reject any positional containing whitespace or longer than 500 characters. JSON verbs (`seed`, `define`, `ga-exec`) pass `json.dumps` of the remaining object on stdin. Split stderr/stdout on `PROGRESS n` lines. `Connection.call` routes `name in VM_ACTIONS or str(name).startswith("vm-")` before the storage and manage branches, using `vm_call`.

`info()` sets `"libvirt"` by running `vm-status` only when the process ability set includes `vms`. On any failure set `False`. Do not raise.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 connector/test_vm_agent.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add connector/agent.py connector/test_vm_agent.py
git commit -m "Call the VM helper only when virtual machines were allowed"
```

---

### Task 4: Connector install packages

**Files:**
- Modify: `connector/install.sh` (package loop, download `vm-helper.py`, macOS keep-list stays without `vms`)
- Modify: `test/connector-install-noint.test.mjs` (the fake `curl` must also copy `vm-helper.py` when the URL contains it)

**Interfaces:**
- Consumes: `connector/vm-helper.py` on disk
- Produces: `$DIR/vm-helper.py` mode `0700` when `--allow` contains `vms` and `--user-enroll-only` is absent. No sudoers line for it.

- [ ] **Step 1: Write the failing test**

In the fake `curl` of `stubs()`, extend the case so `*vm-helper.py*` copies `FAKE_VM_HELPER` (the real `connector/vm-helper.py`). Add `FAKE_VM_HELPER` to `install()`’s env. Add tests:

```js
test('--allow vms installs the helper as the user and qemu packages, and keeps NoNewPrivileges when storage is off', {skip}, async () => {
	const home = join(root, 'vms-allow')
	await mkdir(home)
	const bin = await stubs()
	const arch = spawnSync('uname', ['-m'], {encoding: 'utf8'}).stdout.trim()
	const qemuPkg = arch === 'aarch64' || arch === 'arm64' ? 'qemu-system-arm' : 'qemu-system-x86'
	const r = install(home, bin, ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,vms'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, new RegExp(`apt-get install -y ${qemuPkg}`))
	assert.match(log, /apt-get install -y passt/)
	assert.match(log, /apt-get install -y xorriso/)
	const helper = join(home, '.local/share/omarchy-connector/vm-helper.py')
	const st = await stat(helper)
	assert.equal(st.mode & 0o777, 0o700)
	assert.equal(/libexec\/omarchy-connector\/vm-helper/.test(log), false)
	const unit = await readFile(join(home, '.config/systemd/user/omarchy-connector.service'), 'utf8')
	assert.match(unit, /NoNewPrivileges=yes/)
})

test('--allow terminal does not install qemu', {skip}, async () => {
	const home = join(root, 'no-vms')
	await mkdir(home)
	const r = install(home, await stubs(), ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.equal(/qemu-base|qemu-system|libvirt/.test(log), false)
	await assert.rejects(stat(join(home, '.local/share/omarchy-connector/vm-helper.py')))
})
```

`stubs()` already writes `apt-get` into `bin`, and `install()` puts that `bin` first on `PATH`, so the script’s `for p in apt-get dnf pacman zypper` loop selects apt-get even when `/usr/bin/pacman` exists. Import `stat` from `node:fs/promises`. `spawnSync` is already imported.

In the curl stub, change the case line to:

```bash
case "$*" in *ca.crt*) printf '%s' "$FAKE_PEM" >"$out" ;; *vm-helper.py*) cp "$FAKE_VM_HELPER" "$out" ;; *agent.py*) cp "$FAKE_AGENT" "$out" ;; esac
```

Add `FAKE_VM_HELPER: fileURLToPath(new URL('../connector/vm-helper.py', import.meta.url))` to the `env` object inside `install()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/connector-install-noint.test.mjs`
Expected: FAIL, helper file missing or qemu not in the log

- [ ] **Step 3: Write minimal implementation**

After the storage-helper block, if `has vms` and `USER_ENROLL_ONLY` is not 1 and `MAC` is not 1: `fetch_connector` `vm-helper.py`, `python_ok`, `install -m 700` to `$DIR/vm-helper.py`. Always append every package from spec section 9 for the selected package manager and `uname -m`. Do not skip a package because `qemu-img` or `virsh` is already on `PATH`; `apt-get install -y` and `pacman -S --needed` are the idempotent step. Use the same `as_root` / `omarchy pkg add` loop as storage, one package at a time, warn and continue on failure. Do not change the `nnp` line: it stays `has storage || nnp="NoNewPrivileges=yes"`. macOS keep-list stays `terminal|files|manage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/connector-install-noint.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add connector/install.sh test/connector-install-noint.test.mjs
git commit -m "Install libvirt with the connector when virtual machines are allowed"
```

---

### Task 5: Pairing ability, hello libvirt, swarm.vms.status

**Files:**
- Modify: `omarchyd/connector.mjs` (`ABILITIES`, `cleanInfo`, `view`, procedures)
- Modify: `omarchyd/server.mjs` (swarm name list and query-kind list)
- Modify: `server/app.mjs` (`ALLOWED`)
- Modify: `test/connector.test.mjs`

**Interfaces:**
- Consumes: agent `vm-status` via `call`
- Produces: `ABILITIES` includes `'vms'`. `cleanInfo` returns `libvirt: boolean`. Procedure `swarm.vms.status` `{id}` → `{vmsAllowed, libvirt, kvm?, arch?, threads?, memoryMb?, freeGb?, videoModels?, performanceWarning?}`

- [ ] **Step 1: Write the failing test**

`swarm.pair` returns `{token, abilities, …}` and does not create an agent. The file’s `pair` helper is `call('swarm.pair', abilities)`. Do not enroll a second computer into the shared `agentHome`.

Place this test immediately after `pairing can allow storage`:

```js
test('pairing can allow virtual machines', async () => {
	const on = await pair({terminal: false, desktop: false, manage: false, vms: true})
	assert.equal(on.abilities.vms, true)
	const off = await pair({terminal: true})
	assert.equal(off.abilities.vms, false)
})
```

In `a computer joins with the code`, both deep-equal objects are currently:

```js
{terminal: true, desktop: false, manage: true, storage: false, backup: false, services: false, files: false}
```

Add `vms: false` to both. After Task 3 the agent writes that key into `cfg.abilities`. After this task the server’s `allowed` map includes it too.

Place this test immediately after that join test. It uses the one agent that test enrolled (`terminal,manage` only). `--test-concurrency=1` keeps that order.

```js
test('setAbilities cannot grant vms that was not allowed at join', async () => {
	const [a] = await q('swarm.list')
	assert.equal(a.allowed.vms, false)
	await assert.rejects(call('swarm.setAbilities', {id: a.id, vms: true}), /wasn’t allowed vms/)
})

test('swarm.vms.status refuses an unknown computer', async () => {
	await assert.rejects(q('swarm.vms.status', {id: 'abcdefabcdef'}), /isn’t in your swarm/)
})
```

`swarm.vms.status` is a query. The unknown-id path does not spawn a helper. Mapping a live `vm-status` JSON is covered by the fake `call` in Task 8. Do not export `cleanInfo` for this test.

Place this test after `withAgent` is defined (next to the other `withAgent` tests). It writes its own `swarm.json` and does not touch `agentHome`:

```js
test('vms allowed at join can be switched off and back on', async () => {
	const allowed = {terminal: false, desktop: false, manage: false, storage: false, backup: false, services: false, files: false, vms: true}
	await withAgent({name: 'pc', allowed, on: {...allowed}}, async ({c, id}) => {
		await c.procedures['swarm.setAbilities'].run({id, vms: false})
		let row = (await c.procedures['swarm.list'].run()).find((a) => a.id === id)
		assert.equal(row.on.vms, false)
		await c.procedures['swarm.setAbilities'].run({id, vms: true})
		row = (await c.procedures['swarm.list'].run()).find((a) => a.id === id)
		assert.equal(row.on.vms, true)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/connector.test.mjs`
Expected: FAIL, `vms` not stored or `swarm.vms.status` missing

- [ ] **Step 3: Write minimal implementation**

Append `'vms'` to `ABILITIES`. `cleanInfo` adds `libvirt: i.libvirt === true`. `view` adds `libvirt: a.info?.libvirt === true`.

`swarm.vms.status` uses `requireAgent` without requiring storage. If `!may(a, 'vms')` return `{vmsAllowed: false, libvirt: false}`. Else `call(a.id, 'vm-status', {}, 30_000)` and map the JSON. Offline is `requireAgent`’s existing `PRECONDITION_FAILED`. Unknown id is `NOT_FOUND`.

Add `'swarm.vms.status'` to the name array in `server.mjs` and to the query-kind array next to `'swarm.storage.status'`. Add `'swarm.vms.status': 'query'` in `server/app.mjs` `ALLOWED` beside `swarm.storage.status`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/connector.test.mjs`
Expected: PASS (pre-existing theme-set failure, if it still fails on this host, is not this task; quote it and continue only if the new assertions passed)

- [ ] **Step 5: Commit**

```bash
git add omarchyd/connector.mjs omarchyd/server.mjs server/app.mjs test/connector.test.mjs
git commit -m "Add the virtual machines pairing ability"
```

---

### Task 6: Fleet grant and the pairing checkbox

**Files:**
- Modify: `web/src/fleet/list.ts`
- Modify: `web/src/swarm/Swarm.tsx`
- Modify: `test/fleet-list.test.mjs`

**Interfaces:**
- Consumes: `ComputerFleetInput.libvirt` and `allowed.vms` / `on.vms`
- Produces: `fleetAbility(computer, 'vms').granted` is true only when `online && allowed.vms && on.vms && libvirt`. Reason when false: `` `${name} can’t host its own virtual machines.` ``

- [ ] **Step 1: Write the failing test**

Add to `test/fleet-list.test.mjs`:

```js
test('vms is granted only when the computer is online, allowed, on, and libvirt is there', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [
			computerFleetInput({id: 'kitchen', name: 'Kitchen', online: true, allowed: {vms: true}, on: {vms: true}, libvirt: true}),
			computerFleetInput({id: 'loft', name: 'Loft', online: true, allowed: {vms: true}, on: {vms: true}, libvirt: false}),
			computerFleetInput({id: 'garage', name: 'Garage', online: false, allowed: {vms: true}, on: {vms: true}, libvirt: true}),
			computerFleetInput({id: 'nook', name: 'Nook', online: true, allowed: {vms: true}, on: {vms: false}, libvirt: true}),
		],
		guests: [guestFleetInput({id: 'box', name: 'Box', state: 'running', hostId: 'kitchen'})],
	})
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').granted, true)
	assert.equal(fleetAbility(members.find((m) => m.id === 'kitchen'), 'vms').reason, '')
	for (const id of ['loft', 'garage', 'nook', 'box']) {
		const ability = fleetAbility(members.find((m) => m.id === id), 'vms')
		assert.equal(ability.granted, false, id)
		assert.match(ability.reason, /can’t host its own virtual machines/)
	}
	assert.equal(members.find((m) => m.id === 'box').hostId, 'kitchen')
})
```

The existing kitchen assertion `granted === false` used a computer without `libvirt`. Leave that test’s input unchanged so it still expects the can’t-host sentence.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 test/fleet-list.test.mjs`
Expected: FAIL, kitchen `vms` still false

- [ ] **Step 3: Write minimal implementation**

`pair()`’s key union includes `'vms'`. `computerAbilities` uses `grant('vms', !!(row.online && pair(row, 'vms') && row.libvirt), \`${name} can’t host its own virtual machines.\`)`. `guestAbilities` keeps `granted: false` and that sentence. `computerFleetInput` copies `libvirt: row.libvirt === true`.

In `Swarm.tsx`, add `vms: boolean` to `Abilities`. Add `ABILITY.vms` with label `Virtual machines`, icon `machine`, and the what-string from the spec. Physical default in `AddComputer` sets `vms: false`. When `guest` is set, do not show the `vms` checkbox (`shown` filters it out) and the pair mutation sends `vms: false`. `agentMay` works without a special case.

Pass `libvirt: a.libvirt === true` from `Home.tsx` and `Machines.tsx` when building `computerFleetInput` rows. `swarm.list` view now has `libvirt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 test/fleet-list.test.mjs`
Then: `npx tsc --noEmit -p web`
Expected: PASS and tsc exit 0

- [ ] **Step 5: Commit**

```bash
git add web/src/fleet/list.ts web/src/swarm/Swarm.tsx web/src/screens/Home.tsx web/src/screens/Machines.tsx test/fleet-list.test.mjs
git commit -m "Grant virtual machines when the joined computer can run libvirt"
```

---

### Task 7: hostId on the inventory

**Files:**
- Modify: `omarchyd/machines.mjs` (`normalize`, `list`)
- Modify: `web/src/api.ts` (`Machine`)
- Test: `test/swarm-vms.test.mjs`

**Interfaces:**
- Consumes: `createMachines`
- Produces: every `machines.list` row has `hostId: 'server' | <12 hex>`. Missing file values become `'server'`. `hostOf(m)` is local to the module.

- [ ] **Step 1: Write the failing test**

Create `test/swarm-vms.test.mjs`:

```js
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'

test('machines.list reports hostId server when the file has none', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-vms-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [{id: 'abcd1234', name: 'Old', osId: 'debian', cores: 1, memoryGb: 1, diskSizeGb: 8, state: 'stopped'}]}))
	const m = createMachines({dataDir: data, run: async () => '', kvmDevice: join(root, 'no-kvm')})
	await m.ready
	const rows = await m.procedures['machines.list'].run()
	assert.equal(rows[0].hostId, 'server')
	const saved = JSON.parse(await readFile(join(data, 'machines', 'machines.json'), 'utf8'))
	assert.equal(saved.machines[0].hostId, 'server')
	await rm(root, {recursive: true, force: true})
})
```

`normalize` runs on load only if the current code normalizes on read. If `hostId` is applied in `list` without saving, change the assertion to the list row only and save inside `normalize` on the next `save()`. The test requires the list field. Persisting on load is allowed if `loaded` stays true and a damaged file is still not rewritten; do not `save()` during `ready` if that would rewrite a file you only read. Set `hostId` in memory in `normalize` and assert the list row. Drop the saved-file assertion if `ready` must not write.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs`
Expected: FAIL, `hostId` undefined

- [ ] **Step 3: Write minimal implementation**

In `normalize`, `m.hostId = m.hostId === 'server' || /^[0-9a-f]{12}$/.test(String(m.hostId ?? '')) ? m.hostId : 'server'`. A non-matching value becomes `'server'` so a corrupt field cannot dispatch to an arbitrary agent. `list` includes `hostId: m.hostId` on the returned object. Add `hostId?: string` to `Machine` in `web/src/api.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs web/src/api.ts test/swarm-vms.test.mjs
git commit -m "Record which computer hosts each virtual machine"
```

---

### Task 8: Remote create

**Files:**
- Modify: `omarchyd/machines.mjs` (`create`, connector facade usage)
- Modify: `omarchyd/server.mjs` (pass `call`, `progress`, `isOwner`)
- Modify: `test/swarm-vms.test.mjs`

**Interfaces:**
- Consumes: `connector.call(id, 'vm-fetch'|'vm-seed'|'vm-disk-create'|'vm-define'|'vm-start', args, timeout)`, `connector.progress(id)`, `isOwner(ctx)`
- Produces: `machines.create({hostId, ...})` returns `{id}` and persists `hostId`. Failure sets `state: 'error'`. No local `virsh` on that path.

- [ ] **Step 1: Write the failing test**

Append tests that build `createMachines` with:

```js
async function readyHarness(calls, {fail} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-create-'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	const catalog = {version: 1, images: [{id: 'debian-12', familyId: 'debian', name: 'Debian', version: '12', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'ab'.repeat(32), sizeMb: 1, adminGroup: 'sudo'}]}
	const seen = []
	const machines = createMachines({
		dataDir: join(root, 'data'),
		catalogUrl: 'https://example.test/catalog.json',
		fetchImpl: async () => ({ok: true, json: async () => catalog}),
		run: async (cmd, args) => {
			seen.push([cmd, ...(args ?? [])])
			if (cmd === 'openssl') return '$6$salt$hash\n'
			if (cmd === 'virsh') throw new Error('local virsh')
			return ''
		},
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: true, allowed: {vms: true}, on: {vms: true}}],
			progress: () => ({percent: 0.5, step: 'download'}),
			call: async (id, name, args) => {
				if (name === fail) throw new Error('define failed')
				calls.push({id, name, args})
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch, threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga', 'virtio', 'none']}
				if (name === 'vm-fetch') return '/images/debian-12'
				return 'ok'
			},
		},
	})
	await machines.ready
	return {root, machines, seen, arch}
}
```

`mkdtemp` comes from `node:fs/promises`. `catalogUrl` is `https://example.test/catalog.json`. `vm-fetch`’s catalog argument is that same string. `fetchImpl` returns the catalog JSON so `images()` resolves `debian-12` without GitHub. `list` must include the host so create can read its name for error sentences.

Assertions:

```js
test('remote create stores hostId and does not define locally', async () => {
	const calls = []
	const {machines, seen, arch} = await readyHarness(calls)
	const {id} = await machines.procedures['machines.create'].run(
		{hostId: 'abc123abc123', name: 'Box', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
		{auth: {role: 'owner', userId: 'owner'}},
	)
	assert.match(id, /^[a-f0-9]{8}$/)
	await waitUntil(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state !== 'installing')
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.equal(row.hostId, 'abc123abc123')
	assert.notEqual(row.state, 'error')
	assert.ok(calls.some((c) => c.name === 'vm-fetch' && c.id === 'abc123abc123'))
	assert.ok(calls.some((c) => c.name === 'vm-define'))
	const seed = calls.find((c) => c.name === 'vm-seed')
	assert.ok(seed)
	assert.equal(JSON.stringify(seed.args).includes('qemu-guest-agent'), false)
	assert.equal(JSON.stringify(seed.args).includes('install.sh'), false)
	assert.equal(seen.some((c) => c[0] === 'virsh' && c.includes('define')), false)
})

test('remote create failure is an error row and not a local domain', async () => {
	const calls = []
	const {machines, seen} = await readyHarness(calls, {fail: 'vm-define'})
	const {id} = await machines.procedures['machines.create'].run(
		{hostId: 'abc123abc123', name: 'Bad', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
		{auth: {role: 'owner'}},
	)
	await waitUntil(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state === 'error')
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.match(row.errorMessage, /define failed/)
	assert.equal(seen.some((c) => c[0] === 'virsh'), false)
})

test('a Home ISO is refused and a member cannot create remotely', async () => {
	const calls = []
	const {machines} = await readyHarness(calls)
	await assert.rejects(
		machines.procedures['machines.create'].run({hostId: 'abc123abc123', name: 'Iso', osId: 'local:/Home/win.iso', cores: 1, memoryGb: 1, diskSizeGb: 64, username: 'chris', password: 'hunter2'}, {auth: {role: 'owner'}}),
		(e) => e.code === 'PRECONDITION_FAILED' && /ISO is on this server/.test(e.message),
	)
	await assert.rejects(
		machines.procedures['machines.create'].run({hostId: 'abc123abc123', name: 'Nope', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'}, {auth: {role: 'member'}}),
		(e) => e.code === 'FORBIDDEN',
	)
	assert.equal(calls.some((c) => c.name === 'vm-fetch'), false)
})

test('hostId server still creates locally', async () => {
	const calls = []
	const {machines, seen} = await readyHarness(calls)
	const {id} = await machines.procedures['machines.create'].run({hostId: 'server', name: 'Here', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'}, {auth: {role: 'member'}})
	assert.match(id, /^[a-f0-9]{8}$/)
	assert.equal(calls.some((c) => String(c.name).startsWith('vm-')), false)
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
	assert.equal(row.hostId, 'server')
})

test('an interrupted remote install is an error and is not resumed', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-cut-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [{id: 'abcd1234', name: 'Cut', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, state: 'installing'}]}))
	const machines = createMachines({dataDir: data, run: async () => '', kvmDevice: join(root, 'no-kvm'), connector: {pair: async () => { throw new Error('no pair') }, list: async () => [], call: async () => 'ok', progress: () => null}})
	await machines.ready
	const row = (await machines.procedures['machines.list'].run()).find((m) => m.id === 'abcd1234')
	assert.equal(row.state, 'error')
	assert.equal(row.errorMessage, 'Creating it was interrupted. Delete it and create it again.')
	await rm(root, {recursive: true, force: true})
})
```

`fail: 'vm-define'` throws `Error('define failed')` before that call is recorded. `waitUntil` polls at most 2 seconds. The remote tests’ `run` throws on `virsh`, so a fallback define fails `seen.some((c) => c[0] === 'virsh') === false`. The `hostId: 'server'` test does not require `qemu-img` or `virsh` to succeed: member auth must not throw, the returned id is 8 hex, no `vm-*` call is made, and the row’s `hostId` is `server`. A local row may still be `installing` or `error` under this fake. Keep the existing local interrupted message `Setup was interrupted. Delete this machine and create it again.` for `hostId` `server`. The remote interrupted message is only for `hostId` other than `server`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs`
Expected: FAIL, remote create still throws `has to host this virtual machine itself`

- [ ] **Step 3: Write minimal implementation**

Replace the early `hostId !== 'server'` throw with the steps in spec section 10.5. `isOwner` default `() => true`. Server passes the real check. Wire `call` and `progress` on the facade in `server.mjs` next to `pair` and `list`.

Build the seed with `cloudUserData` / `hashPassword` and not `connectorCloudInit`. Background order: `vm-seed`, `vm-fetch`, `vm-disk-create`, `vm-define`, `vm-start`. Poll `progress` between awaits and set `busy` `installProgress` to `Math.round((progress.percent ?? 0) * 100)`. On throw, set `state: 'error'` and `errorMessage`. Do not call `waitForGuestConnector` when `hostOf` is not `server`.

On `ready`, rewrite remote `state: 'installing'` to the interrupted error from spec 10.1.

`vm-define` args are `{guestId, spec}` and the agent stdin is the spec. Match `vm_call` from Task 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs omarchyd/server.mjs test/swarm-vms.test.mjs
git commit -m "Create a guest on the joined computer that was asked"
```

---

### Task 9: List, power, options, seed, uninstall, and the local-only wall

**Files:**
- Modify: `omarchyd/machines.mjs`
- Modify: `test/swarm-vms.test.mjs`

**Interfaces:**
- Consumes: `vm-state`, `vm-start`, `vm-shutdown`, `vm-reboot`, `vm-destroy`, `vm-suspend`, `vm-resume`, `vm-define`, `vm-seed`, `vm-undefine`, `vm-inspect`, `vm-stats`, `vm-status`
- Produces: remote power and options call those names. `assertLocal` message: `` `${name} is on another computer. That action isn’t available there yet.` `` `installConnector` message: `Install the connector from the computer that hosts this virtual machine once that is available.`

- [ ] **Step 1: Write the failing test**

```js
const box = {id: 'abcd1234', name: 'Box', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 8, mac: '52:54:00:11:22:33', cloudInit: {username: 'chris', hostname: 'box'}, layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: 'disk.qcow2', device: 'disk', bus: 'virtio', format: 'qcow2'}, {id: 'seed', role: 'seed', file: 'seed.iso', device: 'cdrom', bus: 'sata', format: 'raw'}]}, options: {agent: true}, boot: ['disk0'], portForwards: []}

async function readyWithBox(calls, {offline = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-box-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: !offline, allowed: {vms: true}, on: {vms: true}}],
			progress: () => null,
			call: async (id, name, args) => {
				if (offline) throw new Error('offline')
				calls.push({id, name, args})
				if (name === 'vm-state') return {'omarchy-abcd1234': 'running'}
				if (name === 'vm-inspect') return {state: 'running', disks: []}
				if (name === 'vm-stats') return ''
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch: 'amd64', threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga']}
				return 'ok'
			},
		},
	})
	await machines.ready
	return {machines, root}
}

test('remote power, options, and uninstall use the host, and snapshots do not', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	const auth = {auth: {role: 'owner'}}
	await machines.procedures['machines.start'].run({id: 'abcd1234'}, auth)
	assert.equal(calls.at(-1).name, 'vm-start')
	assert.equal(calls.at(-1).args.guestId, 'abcd1234')
	await machines.procedures['machines.updateOptions'].run({id: 'abcd1234', notes: 'hi'}, auth)
	assert.ok(calls.some((c) => c.name === 'vm-define'))
	await machines.procedures['machines.updateCloudInit'].run({id: 'abcd1234', username: 'chris', hostname: 'box', sshKeys: []}, auth)
	assert.ok(calls.some((c) => c.name === 'vm-seed'))
	await assert.rejects(machines.procedures['machines.snapshot'].run({id: 'abcd1234', name: 's'}, auth), /isn’t available there yet/)
	await assert.rejects(machines.procedures['machines.hibernate'].run({id: 'abcd1234'}, auth), /isn’t available there yet/)
	await assert.rejects(machines.procedures['machines.addDisk'].run({id: 'abcd1234', sizeGb: 2}, auth), /isn’t available there yet/)
	await assert.rejects(machines.procedures['machines.installConnector'].run({id: 'abcd1234', username: 'chris'}, auth), /hosts this virtual machine/)
	assert.equal(calls.some((c) => String(c.name).startsWith('vm-ga-')), false)
	calls.length = 0
	await machines.procedures['machines.uninstall'].run({id: 'abcd1234'}, auth)
	assert.equal(calls[0].name, 'vm-undefine')
	const left = await machines.procedures['machines.list'].run()
	assert.equal(left.some((m) => m.id === 'abcd1234'), false)
})

test('remote list reads virsh state from the host and keeps the row when the host is offline', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls, {offline: true})
	const rows = await machines.procedures['machines.list'].run()
	assert.equal(rows[0].state, 'stopped')
	assert.equal(calls.some((c) => c.name === 'vm-state'), false)
})
```

```js
test('remote list reads running from the host', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	const rows = await machines.procedures['machines.list'].run()
	assert.equal(rows.find((m) => m.id === 'abcd1234').state, 'running')
	assert.ok(calls.some((c) => c.name === 'vm-state'))
})

test('a member cannot start a remote guest', async () => {
	const {machines} = await readyWithBox([])
	await assert.rejects(
		machines.procedures['machines.start'].run({id: 'abcd1234'}, {auth: {role: 'member'}}),
		(e) => e.code === 'FORBIDDEN' && /owner/.test(e.message),
	)
})

test('uninstall while the host is offline keeps the row', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls, {offline: true})
	await assert.rejects(
		machines.procedures['machines.uninstall'].run({id: 'abcd1234'}, {auth: {role: 'owner'}}),
		(e) => e.code === 'PRECONDITION_FAILED' && /was not deleted/.test(e.message),
	)
	const left = await machines.procedures['machines.list'].run()
	assert.equal(left.some((m) => m.id === 'abcd1234'), true)
	assert.equal(calls.some((c) => c.name === 'vm-undefine'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs`
Expected: FAIL, start hits local virsh or installConnector tries qemu-agent

- [ ] **Step 3: Write minimal implementation**

`hostOf(m)` is `'server'` when `hostId` is missing or `'server'`, otherwise the 12-hex id. `assertLocal(m)` throws `PRECONDITION_FAILED` `` `${m.name} is on another computer. That action isn’t available there yet.` `` Call it before any `virsh` in hibernate, snapshots, backups, clone, monitor, add/update/resize/remove disk, cdrom, setMedia, and USB. `installConnector` checks `hostOf` before `liveState` and before `createQemuAgent`, and throws the section 10.10 sentence.

`requireRemote(m, ctx)` throws `FORBIDDEN` with the owner sentence when `isOwner(ctx)` is false, then requires the agent online via `connector.list()`. Offline uninstall throws `PRECONDITION_FAILED` `` `${hostName} is offline, so ${m.name} was not deleted.` `` and does not splice `machines`.

`list` does not call `domainStates` for a remote row. Online: `call(hostId, 'vm-state')` and map with the existing `STATE` table (`running` stays `running`). Persist `hostState` on success. Offline with no `hostState`: `stopped`. `details` calls `vm-inspect` when online and returns saved layout with null sizes when offline. `sample` calls `vm-stats` per online host and parses with the existing block parser. USB listing skips `hostOf(m) !== 'server'`.

Remote `start` / `shutdown` / `reboot` / `forceStop` / `pause` / `resume` call `vm-start`, `vm-shutdown`, `vm-reboot`, `vm-destroy`, `vm-suspend`, `vm-resume` with `{guestId: m.id}`. `updateOptions`, `updateSettings`, `updateHardware`, and `setBootOrder` validate, save, and `vm-define` the spec from section 7.5. `updateCloudInit` calls `vm-seed` then `vm-define`, and does not call `connectorCloudInit`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/swarm-vms.test.mjs test/machines.test.mjs`
Expected: PASS. `machines.test.mjs` must stay green because local create did not gain an owner check.

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs test/swarm-vms.test.mjs
git commit -m "Power and edit guests on the computer that hosts them"
```

---

### Task 10: Create form and glance filtering

**Files:**
- Modify: `web/src/CreateMachine.tsx`
- Modify: `web/src/screens/Machines.tsx`
- Modify: `web/src/fleet/ServerSheet.tsx` only if it receives an unfiltered list; filter in `Machines.tsx` before the prop
- Modify: `web/src/machines/api.ts` (`useNode`)
- Modify: `web/src/screens/Home.tsx` if guest rows omit `hostId`

**Interfaces:**
- Consumes: `Machine.hostId`, `machines.capabilities` input `{hostId}`, `machines.create` input `hostId`, `machines.node` input `{id}`
- Produces: remote create submits `hostId`. Local ISO block is absent. Glance `vms` for a computer is `list.filter(m => (m.hostId || 'server') === memberId)`.

- [ ] **Step 1: Write the failing test**

There is no component test runner for sheets. Add a pure helper `web/src/fleet/hostedVms.ts`:

```ts
import type {Machine} from '../api'

export function hostedVms(list: readonly {id: string; hostId?: string}[], hostId: string) {
	return list.filter((m) => (m.hostId || 'server') === hostId)
}
```

`test/fleet-list.test.mjs` (or `test/swarm-vms-ui.test.mjs`):

```js
import {hostedVms} from '../web/src/fleet/hostedVms.ts'

test('hostedVms splits this server from a joined computer', () => {
	const list = [
		{id: 'a', hostId: 'server'},
		{id: 'b'},
		{id: 'c', hostId: 'abc123abc123'},
	]
	assert.deepEqual(hostedVms(list, 'server').map((m) => m.id), ['a', 'b'])
	assert.deepEqual(hostedVms(list, 'abc123abc123').map((m) => m.id), ['c'])
})
```

And a string test that the remote stub is gone:

```js
test('CreateMachine does not keep the remote stub copy', async () => {
	const text = await readFile(new URL('../web/src/CreateMachine.tsx', import.meta.url), 'utf8')
	assert.equal(text.includes('can’t host a virtual machine yet'), false)
	assert.equal(text.includes('function RemoteVmHost'), false)
	assert.match(text, /hostId: host\.id/)
	assert.match(text, /The operating system is downloaded on/)
	assert.match(text, /ISO from this server/)
})
```

Import `readFile` in that test file. The footer sentence is the full spec section 13 line, including the computer’s name.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test --test-concurrency=1 test/fleet-list.test.mjs`
Expected: FAIL, helper missing or stub text still present

- [ ] **Step 3: Write minimal implementation**

`CreateMachine` calls `LocalCreateMachine` for every host, passing `host`. `LocalCreateMachine` / `ConfigureForm` take `host: {id: string; name: string}`. Capabilities query:

```ts
query<MachineCapabilities & {threads?: number; memoryTotalMb?: number}>('machines.capabilities', host.id === 'server' ? undefined : {hostId: host.id})
```

When `host.id !== 'server'`, stepper max cores is `caps.threads` and max memory is `Math.max(1, Math.floor((caps.memoryTotalMb ?? 2048) / 1024) - 1)`, not `useCpu` / `useMemory`. Omit the “Your own ISO” section. Footer sentence from spec section 13. `machines.create` input includes `hostId: host.id` only when it is not `server` (local input stays without a spurious host, or with `hostId: 'server'`; both are valid).

`Machines.tsx` `glanceFor` passes `hostedVms(list, memberId)` when `vmsAbility.granted`, else `null`. Server sheet `vms={hostedVms(list, SERVER_FLEET_ID)}`.

`useNode(id?: string)` query key `['machines.node', id ?? 'server']` and input `id ? {id} : undefined`. The hardware sheet passes the open machine id. `machines.node` implements spec 10.4.

Home `guestFleetInput` includes `hostId: m.hostId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test --test-concurrency=1 test/fleet-list.test.mjs`
Then: `npx tsc --noEmit -p web`
Expected: PASS and tsc exit 0

- [ ] **Step 5: Commit**

```bash
git add web/src/CreateMachine.tsx web/src/fleet/hostedVms.ts web/src/screens/Machines.tsx web/src/screens/Home.tsx web/src/machines/api.ts web/src/machines/panels.tsx omarchyd/machines.mjs test/fleet-list.test.mjs
git commit -m "Open the create form on a computer that can host guests"
```

`panels.tsx` is the hardware sheet that calls `useNode`. Pass the machine id there. If the sheet has no machine yet, call `useNode()` with no id.

---

### Task 11: Guest VNC channel on the connector

**Files:**
- Modify: `connector/agent.py` (`Connection` open handler, new socket class)
- Modify: `connector/test_vm_agent.py`
- Modify: `omarchyd/connector.mjs` (`openChannel`, `setAbilities` close rule)

**Interfaces:**
- Consumes: `vm-helper.py vnc-path <guest>` stdout
- Produces: open message `{op:'open', kind:'vnc', guest:'<8 hex>'}` connects only to `data/vms/<guest>/vnc.sock`. Desktop VNC without `guest` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `connector/test_vm_agent.py`. Build a `socket.socket(AF_UNIX)` temp socket, write the path the helper would print, and call the extracted `open_guest_vnc(conn, ch, guest, data_dir, run)` function.

```python
def test_guest_vnc_uses_the_helper_socket_not_the_desktop(self):
    import socket
    import tempfile
    d = tempfile.mkdtemp()
    guest = "abcd1234"
    sock_dir = os.path.join(d, "vms", guest)
    os.makedirs(sock_dir)
    path = os.path.join(sock_dir, "vnc.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(1)
    seen = []

    def run(argv, stdin=None):
        seen.append(argv)
        return "", path + "\n"

    class Conn:
        sent = []
        def send(self, msg):
            self.sent.append(msg)

    conn = Conn()
    # open_guest_vnc returns the connected client socket or raises
    client = open_guest_vnc(conn, 7, "abcd1234", d, run)
    self.assertTrue(any(a[-2:] == ["vnc-path", "abcd1234"] for a in seen))
    self.assertFalse(any("wayvnc" in " ".join(a) for a in seen))
    with self.assertRaises(RuntimeError):
        open_guest_vnc(conn, 8, "../abcd1234", d, run)
    client.close()
    srv.close()
```

Add this test in `test/connector.test.mjs` after `withAgent` and `browserSocket` exist. It uses the same open-message wait as `a long connector close reason is forwarded without throwing`.

```js
test('a guest console channel asks for vms and passes the guest id', async () => {
	const allowed = {...abilities, vms: true, desktop: false}
	await withAgent({name: 'pc', allowed, on: {...allowed}}, async ({c, id, agentWs}) => {
		const bad = await browserSocket()
		try {
			const badClosed = closedAs(bad.client)
			c.openChannel(id, 'vnc', bad.serverSide, {guest: '../etc'})
			const badGot = await badClosed
			assert.equal(badGot.code, 1011)
		} finally {
			await bad.close()
		}
		const browser = await browserSocket()
		try {
			const opened = new Promise((r) => agentWs.on('message', function onOpen(d) {
				const m = JSON.parse(String(d))
				if (m.op === 'open') (agentWs.off('message', onOpen), r(m))
			}))
			c.openChannel(id, 'vnc', browser.serverSide, {guest: 'abcd1234'})
			const open = await opened
			assert.equal(open.kind, 'vnc')
			assert.equal(open.guest, 'abcd1234')
		} finally {
			await browser.close()
		}
	})
	const desktopOnly = {...abilities, desktop: true, vms: false}
	await withAgent({name: 'pc', allowed: desktopOnly, on: {...desktopOnly}}, async ({c, id}) => {
		const browser = await browserSocket()
		try {
			const closed = closedAs(browser.client)
			c.openChannel(id, 'vnc', browser.serverSide, {guest: 'abcd1234'})
			const got = await closed
			assert.equal(got.code, 1011)
			assert.equal(got.reason.toString('utf8'), 'Virtual machines isn’t switched on for pc')
		} finally {
			await browser.close()
		}
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 connector/test_vm_agent.py`
Run: `node --test --test-concurrency=1 test/connector.test.mjs`
Expected: FAIL, guest open closed because ability `desktop` is off

- [ ] **Step 3: Write minimal implementation**

`open_guest_vnc` runs the helper, checks the printed path’s realpath equals `os.path.join(data_dir, 'vms', guest, 'vnc.sock')`, and connects. `Connection` open handler: if `kind == 'vnc'` and `'guest' in msg`, call this on a thread instead of `_open_vnc`. Require `self.allowed.get('vms')`.

`switchedOff`: `ability === 'vms'` uses the words `Virtual machines`, so the close text is `Virtual machines isn’t switched on for ${name}`.

`openChannel`: if `kind === 'vnc'` and `opts.guest` is a string that fails `/^[a-f0-9]{8}$/`, `closeSocket(browserWs, 1011, 'That virtual machine isn’t valid')` and return without `send`. If it matches, ability is `vms`, `openMsg.guest = opts.guest`, and the channel record is `{ws: browserWs, kind, guest: opts.guest}`. If `kind === 'vnc'` and `guest` is absent, ability stays `desktop` and the channel record stays `{ws, kind}`.

`setAbilities` close rule: a channel with `guest` set uses ability `vms`. A vnc channel without `guest` still uses `desktop`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 connector/test_vm_agent.py && node --test --test-concurrency=1 test/connector.test.mjs`
Expected: PASS, aside from the known theme-set host failure if it reproduces

- [ ] **Step 5: Commit**

```bash
git add connector/agent.py connector/test_vm_agent.py omarchyd/connector.mjs test/connector.test.mjs
git commit -m "Tunnel a guest console to that guest's VNC socket"
```

---

### Task 12: omarchyd proxies the same console URL

**Files:**
- Modify: `omarchyd/machines.mjs` (`vncSocket`)
- Modify: `omarchyd/server.mjs` (upgrade handler around the `machines.vncSocket` call)
- Create: `test/swarm-vm-console.test.mjs`

**Interfaces:**
- Consumes: `openChannel(agentId, 'vnc', ws, {guest})` from Task 11. `vncSocket(id)` returns a string path or `{agentId, guest}`.
- Produces: `/machines/console?machineId=<8 hex>` for a remote guest calls `openChannel` and does not `net.connect` a local path. Local guests still return a path.

- [ ] **Step 1: Write the failing test**

Define this helper in `test/swarm-vm-console.test.mjs`. Do not import it from another test file.

```js
const box = {id: 'abcd1234', name: 'Box', hostId: 'abc123abc123', osId: 'debian-12', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 8, mac: '52:54:00:11:22:33', cloudInit: {username: 'chris', hostname: 'box'}, layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: 'disk.qcow2', device: 'disk', bus: 'virtio', format: 'qcow2'}, {id: 'seed', role: 'seed', file: 'seed.iso', device: 'cdrom', bus: 'sata', format: 'raw'}]}, options: {agent: true}, boot: ['disk0'], portForwards: []}

async function readyWithBox(calls, {offline = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-box-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: !offline, allowed: {vms: true}, on: {vms: true}}],
			progress: () => null,
			call: async (id, name, args) => {
				if (offline) throw new Error('offline')
				calls.push({id, name, args})
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch: 'amd64', threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga']}
				return 'ok'
			},
		},
	})
	await machines.ready
	return {machines, root}
}

test('vncSocket for a remote guest names the agent and does not touch a local path', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	const target = await machines.vncSocket('abcd1234')
	assert.deepEqual(target, {agentId: 'abc123abc123', guest: 'abcd1234'})
	assert.equal(calls.some((c) => c.name === 'vm-vnc-path'), false)
})
```

Add a local machine without `hostId` whose socket is absent and assert `vncSocket` throws `/isn’t running/` and the message does not mention another computer.

In `server.mjs` the branch is the assertion target via a comment-free code read in the test:

```js
test('the console upgrade branches on agentId', async () => {
	const text = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	assert.match(text, /openChannel\(target\.agentId, 'vnc', ws, \{guest: target\.guest\}\)/)
})
```

That locks the call shape. Keep it.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/swarm-vm-console.test.mjs`
Expected: FAIL, `vncSocket` throws or returns a local path

- [ ] **Step 3: Write minimal implementation**

Remote `vncSocket(id)` loads the row, reads `await connector.list()`, and finds `id === hostId`. Missing or `online !== true` throws `PRECONDITION_FAILED` `` `${name} is offline right now` ``. `allowed.vms && on.vms` false throws `FORBIDDEN` `` `Pair ${name} again with Virtual machines switched on.` ``. Success returns `{agentId: hostId, guest: id}` and does not call `vm-vnc-path`. Local `vncSocket` still returns the socket path string.

In the `/machines/console` upgrade, keep the desktop branch as it is. For a machine id:

```js
const raw = await machines.vncSocket(machineId).catch(() => null)
if (!raw) return refuse('409 Conflict')
if (typeof raw === 'object' && raw.agentId) return wss.handleUpgrade(req, socket, head, (ws) => connector.openChannel(raw.agentId, 'vnc', ws, {guest: raw.guest}))
const vnc = net.connect(typeof raw === 'string' ? {path: raw} : raw)
```

`test/console.test.mjs` and `test/machines.test.mjs` keep receiving a string from a local `vncSocket`. Do not change those assertions.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/swarm-vm-console.test.mjs test/console.test.mjs test/machines.test.mjs test/swarm-vms.test.mjs`
Then: `npx tsc --noEmit -p web`
Then: `python3 connector/test_vm_helper.py && python3 connector/test_vm_agent.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs omarchyd/server.mjs test/swarm-vm-console.test.mjs
git commit -m "Proxy a guest console to the computer that hosts it"
```

---

## Self-review

Spec coverage:

| Spec section | Task |
|---|---|
| Ability `vms`, no widen, Windows/mac force off | 3, 5, 6 |
| Fleet grant sentence | 6 |
| Helper verbs and argv | 1, 2 |
| Install packages, no sudoers, NNP | 4 |
| `hostId` inventory | 7 |
| Remote create, no fallback, no connector seed | 8 |
| List, power, options, seed, uninstall | 9 |
| Refused snapshots, USB, hibernate, installConnector | 9 |
| SPA form and glance | 10 |
| Console channel and URL | 11, 12 |
| `qemu-agent.mjs` untouched | no task edits it |
| Series C not started | no task calls `vm-ga-*` from `installConnector` |

Placeholder scan: no TBD, no “similar to task”, no step that only says “handle edge cases”. Task 4’s package assertion is apt-get because `stubs()` puts `apt-get` first on `PATH`. Task 5 names `pair`, `q`, and `withAgent` and the exact ability objects. Task 12 defines its own `readyWithBox`.

Type consistency: call args use `guestId`, `imageId`, `catalogUrl`, `sizeGb`, and stdin objects `{label, files}` / define spec / `{path, args, input, capture}`. `vncSocket` local return stays a string; remote return is `{agentId, guest}`. `hostId` is `'server'` or 12 hex. Fleet `libvirt` is strict `=== true`.
