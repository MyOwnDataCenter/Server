# Guest connector auto-install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On this server, install the Linux or Windows connector into a virtual machine at create time and when the owner presses Install connector, without pasting into a guest terminal.

**Architecture:** qemu-guest-agent is the live host→guest channel (passt blocks SSH). New Linux cloud seeds install qemu-ga and python; enroll is `guest-exec` after `guest-ping` with a 6-hour machine-bound pairing token. Windows create uses FirstLogonCommands plus the same qemu-ga path when the agent answers. Missing agent keeps today’s copy-paste sheet. Sudo password is a one-shot SPA field only when exec is not root.

**Tech Stack:** Node omarchyd, libvirt session `virsh qemu-agent-command`, existing `connector/install.sh` and `install.ps1`, React SPA.

**Spec:** `docs/plans/guest-connector-auto-install.md` (approved A → B → C). This plan is **Series A only** (this server). Series B (swarm VM hosting) and C (remote auto-install) get their own spec/plan later.

## Global Constraints

- Worktree `/home/joseph/.worktrees/omarchy-server-guest-connector-install` on `feat/guest-connector-auto-install` from `upstream/main`. `node_modules` is a symlink; do not npm install a second copy.
- Tabs, no semicolons, single quotes. Commits: sentence case, no `feat:` prefix, no trailing period.
- Do not bump version, changelog, or `INSTALLER_REVISION`.
- Do not mix isolation overlay (`OMARCHY_SERVER_SOURCE`, `~/code` paths).
- Owner-only for `machines.installConnector`. Members keep copy-paste only if they can already open the guest sheet.
- qemu-ga `guest-exec` argv is a generated installer, never owner-supplied shell.
- `sudoPassword` never lands in logs, task messages, or `machines.json`.
- Physical Add-a-computer pairing stays 15 minutes.
- Targeted tests + `npx tsc --noEmit -p web`. Do not treat full `npm test` host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) as this branch’s bugs.

---

### Task 1: Guest URL picker and pairing TTL

**Files:**
- Create: `omarchyd/guest-install.mjs`
- Modify: `omarchyd/connector.mjs` (`pair` TTL when `guestOf` is set)
- Test: `test/guest-install.test.mjs`, extend `test/guest-connector.test.mjs`

**Interfaces:**
- Produces: `guestReachableUrl({addresses, port})` → `https://…` or `''`; `GUEST_PAIR_TTL = 6 * 60 * 60_000`; `connectorKind(osId)` → `'linux' | 'windows' | 'unsupported'`

- [ ] **Step 1: Write the failing tests**

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {connectorKind, guestReachableUrl} from '../omarchyd/guest-install.mjs'

test('guestReachableUrl skips loopback and prefers a LAN address', () => {
	assert.equal(guestReachableUrl({addresses: [], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: '127.0.0.1'}], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: 'localhost'}], port: 7780}), '')
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}, {address: '192.168.84.81'}], port: 7780}),
		'https://192.168.84.81:7780',
	)
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}], port: 7780}),
		'https://100.64.1.2:7780',
	)
})

test('connectorKind matches Linux systemd and Windows guests', () => {
	assert.equal(connectorKind('ubuntu-24.04-server-amd64'), 'linux')
	assert.equal(connectorKind('omarchy-4.0.4-amd64'), 'linux')
	assert.equal(connectorKind('windows-11'), 'windows')
	assert.equal(connectorKind('macos'), 'unsupported')
	assert.equal(connectorKind('haos'), 'unsupported')
	assert.equal(connectorKind('alpine-3.24.1-amd64'), 'unsupported')
})
```

Guest pairing test: `swarm.pair({machineId})` `expiresAt` is about 6 hours ahead; physical pair stays ~15 minutes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/guest-install.test.mjs test/guest-connector.test.mjs`
Expected: FAIL, module missing / TTL still 15 minutes

- [ ] **Step 3: Implement**

`guest-install.mjs`: loopback names/addresses refused; IPv4 LAN (not `tailscale`) first, else first non-loopback. `connectorKind`: windows if `/win/`; unsupported if `/macos|osx|darwin|haos|home-?assistant|alpine/`; else linux.

`connector.mjs`: `GUEST_PAIR_TTL = 6 * 60 * 60_000`. In `pair`, `const ttl = linked ? GUEST_PAIR_TTL : PAIR_TTL`.

- [ ] **Step 4: Run tests to verify they pass**
- [ ] **Step 5: Commit**

```
git add omarchyd/guest-install.mjs omarchyd/connector.mjs test/guest-install.test.mjs test/guest-connector.test.mjs
git commit -m "Give a guest a longer pairing code and a reachable server URL"
```

---

### Task 2: Default qemu-ga channel and Linux seed packages

**Files:**
- Modify: `omarchyd/machines.mjs` (`HARDWARE_OPTION_DEFAULTS.agent`, `seed`)
- Modify: `omarchyd/machine-media.mjs` if seed packages are easier as a `cloudUserData` option
- Test: `test/machines.test.mjs` (XML contains guest-agent channel; user-data contains `qemu-guest-agent` and no pairing token)

**Interfaces:**
- Consumes: `connectorKind`, catalog `familyId`
- Produces: new machines have `options.agent === true`; cloud user-data lists `qemu-guest-agent` and `python3` (or `python` on Arch)

- [ ] **Step 1: Failing tests** in `test/machines.test.mjs` after a `testos-amd64` create: `seen.xml` matches `org.qemu.guest_agent.0`; `seen.userData` matches `qemu-guest-agent` and `python3`; does not match a 64-char hex fingerprint used as a token stand-in.

- [ ] **Step 2: Run to see fail** (`agent` channel absent, packages missing)

- [ ] **Step 3: Implement** `HARDWARE_OPTION_DEFAULTS.agent = true`. In `seed`, merge packages `qemu-guest-agent` + python name for the image family, and `runcmd` `systemctl enable --now qemu-guest-agent`. Never write the pairing token into user-data.

- [ ] **Step 4: Tests pass**
- [ ] **Step 5: Commit** “Turn on the QEMU guest agent for new machines.”

---

### Task 3: virsh qemu-agent wrapper

**Files:**
- Create: `omarchyd/qemu-agent.mjs`
- Test: `test/qemu-agent.test.mjs`

**Interfaces:**
- Produces: `createQemuAgent({run, domain})` with `ping()`, `exec({path, args, input, capture})` → `{pid}`, `status(pid)` → `{exited, exitcode, out, err}`

Parse `virsh qemu-agent-command` JSON. `guest-exec` with `capture-output: true`. Do not put secrets on the virsh argv; pass `input` via a guest file or `guest-exec` env only if stdin is unsupported — prefer writing a temp script with `guest-file-open` / `guest-file-write` / `guest-exec bash script` so `sudoPassword` is not in `ps`. For v1 ping+exec without password, `guest-exec` argv of the installer command is enough (token is already in the pairing command today).

- [ ] Tests with fake `run` that records commands and returns JSON.
- [ ] Commit “Talk to a guest through the QEMU guest agent.”

---

### Task 4: `machines.installConnector`

**Files:**
- Modify: `omarchyd/machines.mjs` (procedure + task type `connector`)
- Modify: `omarchyd/server.mjs` (ownerOnly wrap)
- Modify: `server/app.mjs` ALLOWED + SLOW
- Modify: `web/src/machines/api.ts` task label
- Test: `test/guest-connector-install.test.mjs`, `test/allowed.test.mjs` (auto)

**Interfaces:**
- Consumes: qemu-agent wrapper, `swarm.pair({machineId})`, `guestReachableUrl`, `connectorKind`, `connectorInstallCommand` / `Windows`
- Produces: `{status: 'started'|'needs-agent'|'unsupported'|'needs-password', os, message?, taskId?}`

Flow: find machine; kind unsupported → `unsupported`; not running → `PRECONDITION_FAILED` “Start the machine first.”; ping fail → `needs-agent`; else mint pair, build command, `guest-exec`, begin task that polls status until enroll appears on `swarm.list` `guestOf === id` or timeout.

Wire `createMachines` with optional `connector` and `qemuAgent` for tests.

Default abilities: linux `{terminal, desktop, manage, files}`; windows `{terminal, files, manage}`.

- [ ] Commit “Install a guest connector through the QEMU guest agent.”

---

### Task 5: Create-time starts the same task

**Files:**
- Modify: `omarchyd/machines.mjs` `create` after define/start for `connectorKind !== 'unsupported'`
- Test: create `testos-amd64` records a connector task / calls install once qemu-ga fake pings

Windows create: FirstLogonCommands that run `install.ps1` when `windowsCommand` is passed into `windowsAnswerFile`. Token minted at create (6h). Unattend already holds the account password; this is the Windows create channel because retail ISOs have no qemu-ga.

- [ ] Commit “Install the connector when a supported virtual machine is created.”

---

### Task 6: UI — button, password sheet, Windows guests, paste fallback

**Files:**
- Modify: `web/src/fleet/GuestLive.tsx`, `web/src/swarm/guestLink.ts` (`windowsConnectorOs` or use `connectorKind` via a small TS mirror), `web/src/swarm/Swarm.tsx` `AddComputer`
- Test: `test/guest-connector.test.mjs` for kind helpers; UI source-contract if the repo uses them

Button calls `mutate('machines.installConnector', {id})`. `started` → wait for `guestAgent`. `needs-agent` / error with no agent → existing `AddComputer` paste sheet (Windows command when Windows). `needs-password` → password sheet, retry with `sudoPassword`. `unsupported` keeps the quiet message.

Show Install connector for Windows guests too.

- [ ] Commit “Run Install connector from the machine page.”

---

### Task 7: `install.sh` noninteractive / user-enroll-only

**Files:**
- Modify: `connector/install.sh`
- Test: existing fake-sudo style in `test/connector-uninstall.test.mjs` or a new `test/connector-install-noint.test.mjs`

`--user-enroll-only` skips package/helper sudo when those are already done. `sudo -n` first; if it fails in noninteractive mode, exit with a distinct code the RPC maps to `needs-password`.

- [ ] Commit “Let the guest installer run without a terminal.”

Series B and C are not in this plan.
