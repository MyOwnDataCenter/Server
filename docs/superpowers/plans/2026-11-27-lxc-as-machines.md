# LXC as machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat Incus/LXC system containers as Machines: flat fleet list, Online/Offline language, LXC-aware connector with install-from-page, Files/clip/Apps via swarm once connected, assistant `containers_*` tools with the same permission rules as the UI.

**Architecture:** Add fleet kind `container` beside server/computer/guest. Wire Incus instances into `fleetList` and MachineManager; drop the separate LXC appendix. Pair connectors with a new `containerOf` link (LXC name), detect LXC in the agent and strip Desktop/Storage/VMs. Install via `incus exec` from `containers.installConnector`. Member-readable `containers.list` / `containers.status`; mutations stay owner-only. Files/clips reuse swarm `::computer/{agentId}` once the agent is online. Assistant tools wrap `containers.*` with `ownerOnly` where the RPC is owner-only.

**Tech Stack:** Node 20+ ESM, React/TypeScript web UI, omarchyd JSON-RPC, Python connector agent, `node --test` / `node --experimental-strip-types --test`, `tsc --noEmit -p web`.

**Spec:** `docs/superpowers/specs/2026-11-27-lxc-as-machines-design.md`

## Global Constraints

- Work in an isolated git worktree (create via `using-git-worktrees` at execution time) on branch `feat/lxc-as-machines` (spec commit `2db4bbe` is already on this branch name in `/tmp/omarchy-merge/omarchy-server`).
- Tabs, no semicolons, single quotes in new JS/TS. Python in `connector/` is 4-space. Commit subjects are sentence case, no `feat:` prefix, no trailing period.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `web/src/changelog.ts`, or `INSTALLER_REVISION`.
- Do not build a parallel Incus `::container/…` transfer stack. Do not add a second connector package. Do not offer Desktop/Storage/VMs on LXC.
- TDD: failing test before each behavior change. Focused tests only; do not require full `npm test`.
- Founder-only edits to `docs/vision.md` and `docs/style-guide.md` are part of Task 8 (this branch is Joe’s).

## File map

Create:

- `omarchyd/lxc-install.mjs` — prep/exec helpers to install the connector inside an LXC via `incus`
- `test/lxc-install.test.mjs` — install command shaping and pairing wait
- `test/lxc-connector-abilities.test.mjs` — optional if Python tests cover detection; else Node mirror of ability matrix expectations in UI logic

Modify:

- `web/src/fleet/list.ts` — `FleetKind` + `container` members + abilities
- `web/src/fleet/machineManagerLogic.ts` — `ManagerKind` includes `container`; Virtual filter; reachLabel for frozen→Paused
- `test/fleet-list.test.mjs`, `test/machine-manager.test.mjs` — new kind expectations
- `web/src/fleet/MachineManager.tsx` — peer rows for containers; Add → Container; remove `ContainersInList` appendix
- `web/src/containers/Containers.tsx` — Online/Offline pills; Install connector CTA; keep Incus sections; export row/frame pieces MachineManager needs
- `web/src/screens/Machines.tsx` — feed containers into `fleetList`; exclude `containerOf` agents from computer rows; open container detail in Compact/Flat
- `web/src/fleet/filePlaces.ts` / Files wiring — ensure container-linked agents remain Files places (as computers) while hidden from Machines computer rows
- `omarchyd/connector.mjs` — `containerOf` on pair/list; resolve helpers
- `connector/agent.py` — `in_lxc()` / `supported_abilities` LXC matrix; report `environment: lxc` in info
- `connector/test_*.py` or new unittest — LXC ability stripping
- `omarchyd/containers.mjs` — `containers.installConnector`; map status to Online/Offline facts if needed for list consumers
- `omarchyd/server.mjs` — member-readable list/status; owner-only mutations; wire install
- `omarchyd/assistant/tools.mjs` + `test/assistant-loop.test.mjs` — `containers_*` tools
- `docs/vision.md`, `docs/style-guide.md` — system vs application containers

---

### Task 1: Fleet kind `container` in list and filter logic

**Files:**
- Modify: `web/src/fleet/list.ts`
- Modify: `web/src/fleet/machineManagerLogic.ts`
- Modify: `test/fleet-list.test.mjs`
- Modify: `test/machine-manager.test.mjs`

**Interfaces:**
- Consumes: existing `fleetList`, `passesFilter`, `reachLabel`
- Produces: `FleetKind` / `ManagerKind` include `'container'`; `containerFleetInput`; Virtual filter matches `guest` **or** `container`; container Online when Incus status is `running`, Paused when `frozen`

- [ ] **Step 1: Write the failing tests**

Append to `test/fleet-list.test.mjs`:

```js
test('fleetList includes containers hosted on this server', () => {
	const members = fleetList({
		server: {name: 'Den'},
		computers: [],
		guests: [],
		containers: [containerFleetInput({id: 'web', name: 'web', state: 'running', connector: true})],
	})
	const c = members.find((m) => m.kind === 'container')
	assert.ok(c)
	assert.equal(c.id, 'web')
	assert.equal(c.online, true)
	assert.equal(c.hostId, SERVER_FLEET_ID)
	assert.match(c.meta, /Container/i)
	assert.equal(fleetAbility(c, 'desktop').granted, false)
	assert.equal(fleetAbility(c, 'storage').granted, false)
	assert.equal(fleetAbility(c, 'files').granted, true)
})
```

Append to `test/machine-manager.test.mjs` (logic imports):

```js
test('Virtual filter includes containers and guests', () => {
	assert.equal(passesFilter('container', 'virtual'), true)
	assert.equal(passesFilter('container', 'physical'), false)
	assert.equal(passesFilter('guest', 'virtual'), true)
	assert.deepEqual(reachLabel('container', true, 'running'), {kind: 'running', label: 'Online'})
	assert.deepEqual(reachLabel('container', false, 'stopped'), {kind: 'stopped', label: 'Offline'})
	assert.deepEqual(reachLabel('container', false, 'frozen'), {kind: 'stopped', label: 'Paused'})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/fleet-list.test.mjs test/machine-manager.test.mjs`

Expected: FAIL — `containerFleetInput` / kind not defined or Virtual filter false for container

- [ ] **Step 3: Minimal implementation**

In `list.ts`:

- Extend `FleetKind` with `'container'`
- Add `ContainerFleetInput` `{id, name, state, hostId?, connector?}`
- `containerFleetInput` helper
- Abilities: apps/files/terminal/backups when `connector` and running (same shape as guest but `desktop`/`storage`/`vms` always false with reasons from the spec)
- Append containers to `fleetList` input; meta `Container · online|offline` (use Online/Offline words, not running/stopped)
- Online = `state === 'running'`

In `machineManagerLogic.ts`:

- `ManagerKind` includes `'container'`
- `passesFilter`: `virtual` → `kind === 'guest' || kind === 'container'`
- `reachLabel`: treat `container` like guest for state mapping; map Incus `frozen` → Paused (accept `frozen` in the switch)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test test/fleet-list.test.mjs test/machine-manager.test.mjs`

Expected: PASS (fix any pre-existing assertions that assumed Virtual === guest only)

- [ ] **Step 5: Commit**

```bash
git add web/src/fleet/list.ts web/src/fleet/machineManagerLogic.ts test/fleet-list.test.mjs test/machine-manager.test.mjs
git commit -m "$(cat <<'EOF'
Add container as a fleet machine kind

EOF
)"
```

---

### Task 2: Member-readable container list; owner-only mutations

**Files:**
- Modify: `omarchyd/server.mjs` (containers procedure wrapping)
- Modify: `test/containers.test.mjs` (or add role cases)

**Interfaces:**
- Consumes: `ownerOnly`, `containers.procedures`
- Produces: `containers.list` and `containers.status` callable by members; all other `containers.*` still owner-only

- [ ] **Step 1: Write the failing test**

In `test/containers.test.mjs` (or a thin server wrapper test if procedures are tested via createContainers only — then add an assertion file that imports the wrap pattern). Prefer extending how other RPCs test member vs owner in `test/server.test.mjs` if that is where `ownerOnly` is exercised for containers.

```js
test('members can list containers; members cannot start them', async () => {
	// Use the same harness the file already uses for owner RPC calls.
	// Member auth on containers.list succeeds.
	// Member auth on containers.start throws /manage containers/ or FORBIDDEN.
})
```

If `containers.test.mjs` only tests `createContainers` without server wrap, add a focused test next to existing `ownerOnly` coverage in `test/server.test.mjs` by grepping for `manage containers` and mirroring that pattern for list vs start.

- [ ] **Step 2: Run test to verify it fails**

Run the chosen test file. Expected: FAIL — list still owner-only for members

- [ ] **Step 3: Minimal implementation**

In `server.mjs`, replace the blanket:

```js
...Object.fromEntries(Object.entries(containers.procedures).map(([name, p]) => [name, {kind: p.kind, run: (input, {auth}) => (ownerOnly(auth, 'manage containers'), p.run(input))}])),
```

with a split: for `containers.list` and `containers.status`, run without `ownerOnly`; for every other containers procedure, keep `ownerOnly(auth, 'manage containers')`. HTTP download/upload for container files stay owner-only.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/server.mjs test/containers.test.mjs test/server.test.mjs
git commit -m "$(cat <<'EOF'
Let members list containers; keep Incus mutations owner-only

EOF
)"
```

---

### Task 3: Flat Machines list wires containers; remove LXC appendix

**Files:**
- Modify: `web/src/screens/Machines.tsx`
- Modify: `web/src/fleet/MachineManager.tsx`
- Modify: `web/src/containers/Containers.tsx`
- Modify: `test/machine-manager.test.mjs` (source assertions)

**Interfaces:**
- Consumes: `fleetList` containers input; `useContainers` / `useContainerStatus`; Task 1 kinds
- Produces: No `<ContainersInList>` section; Add menu label `Container`; each container is a `MotionSlot` row like guests; agents with `containerOf` excluded from computer fleet rows

- [ ] **Step 1: Write the failing source assertions**

In `test/machine-manager.test.mjs`:

```js
test('Machines list has no LXC containers appendix and Add offers Container', async () => {
	const ui = await read('../web/src/fleet/MachineManager.tsx')
	assert.doesNotMatch(ui, /ContainersInList/)
	assert.doesNotMatch(ui, />\s*LXC container\s*</)
	assert.match(ui, />\s*Container\s*</)
	const machines = await read('../web/src/screens/Machines.tsx')
	assert.match(machines, /containers:/)
	assert.match(machines, /containerOf/)
})
```

- [ ] **Step 2: Run to verify fail**

Run: `node --experimental-strip-types --test test/machine-manager.test.mjs`

Expected: FAIL on ContainersInList still present

- [ ] **Step 3: Implementation**

`Machines.tsx`:

- Query containers when owner **or** member (list is readable).
- Pass `containers: (containers.data ?? []).map((c) => containerFleetInput({id: c.name, name: c.name, state: c.status === 'frozen' ? 'frozen' : c.status === 'running' ? 'running' : 'stopped', connector: !!agents.find((a) => a.containerOf === c.name)}))`
- Computers: `agents.filter((a) => !isGuestAgent(a) && !a.containerOf)`
- `openMember` / selection state gain `'container'`; Compact detail opens the existing LXC page/frame for that name

`MachineManager.tsx`:

- Remove `ContainersInList` render
- Render `container` members with a row component (reuse/adapt `LxcRow` / `RowFrame`): reach from `reachLabel('container', …)`; health not hard-coded `LXC`
- Add menu: `Container` instead of `LXC container`
- Members still do not see Add → Container if they cannot create (keep owner gate on create)

`Containers.tsx`:

- Export whatever the manager needs for the peer row
- Replace reach pills that say `running`/`stopped` with Online/Offline/Paused via shared `reachLabel` or equivalent labels
- Keep Incus detail page body

- [ ] **Step 4: Run tests + tsc**

Run:

```bash
node --experimental-strip-types --test test/machine-manager.test.mjs test/fleet-list.test.mjs
npx tsc --noEmit -p web
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Machines.tsx web/src/fleet/MachineManager.tsx web/src/containers/Containers.tsx test/machine-manager.test.mjs
git commit -m "$(cat <<'EOF'
Show LXC in the flat Machines list

EOF
)"
```

---

### Task 4: Connector detects LXC and strips unsafe abilities

**Files:**
- Modify: `connector/agent.py`
- Modify: `connector/test_helper.py` or add `connector/test_lxc_env.py`
- Modify: `omarchyd/connector.mjs` (persist/publish `containerOf` and optional `info.environment`)

**Interfaces:**
- Consumes: `supported_abilities`, `ABILITY_NAMES`, `info()`
- Produces: `in_lxc()` true in Incus/LXC; `supported_abilities` forces desktop/storage/vms false; `info()` includes `environment: 'lxc'`; `pair({containerOf: name, ...abilities})` stores link; `list()` exposes `containerOf`

- [ ] **Step 1: Write the failing Python test**

```python
class LxcAbilities(unittest.TestCase):
    def test_lxc_strips_desktop_storage_vms(self):
        raw = {k: True for k in ("terminal", "desktop", "manage", "storage", "backup", "services", "files", "vms")}
        out = supported_abilities(raw, windows=False, mac=False, lxc=True)
        self.assertTrue(out["terminal"])
        self.assertTrue(out["files"])
        self.assertTrue(out["backup"])
        self.assertTrue(out["manage"])
        self.assertFalse(out["desktop"])
        self.assertFalse(out["storage"])
        self.assertFalse(out["vms"])
```

- [ ] **Step 2: Run to verify fail**

Run: `python3 connector/test_helper.py` (or the new file)

Expected: FAIL — `lxc` kw unsupported

- [ ] **Step 3: Implementation**

In `agent.py`:

```python
LXC_ABILITIES = ("terminal", "files", "manage", "backup", "services")

def in_lxc(...):
    # True when /proc/1/environ has container=lxc, or path markers Incus sets,
    # or an install-time flag file under the connector data dir.
    ...

def supported_abilities(abilities, windows=None, mac=None, lxc=None):
    ...
    if lxc is None:
        lxc = in_lxc()
    only = WINDOWS_ABILITIES if windows else MAC_ABILITIES if mac else LXC_ABILITIES if lxc else None
    ...
```

Include `environment: "lxc"` in `info()` when `in_lxc()`.

In `connector.mjs`:

- Extend `pair` to accept `containerOf` (validate with same NAME regex as containers: `/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/`)
- Persist on agent; expose on `list()` next to `guestOf`
- `guestOf` stays hex-only; do not overload it

- [ ] **Step 4: Run Python + existing connector Node tests that touch pair**

Expected: PASS for new cases; no regression on guestOf

- [ ] **Step 5: Commit**

```bash
git add connector/agent.py connector/test_*.py omarchyd/connector.mjs test/connector*.mjs
git commit -m "$(cat <<'EOF'
Detect LXC in the connector and link with containerOf

EOF
)"
```

---

### Task 5: Install connector into an LXC from the host

**Files:**
- Create: `omarchyd/lxc-install.mjs`
- Create: `test/lxc-install.test.mjs`
- Modify: `omarchyd/containers.mjs` — `containers.installConnector`
- Modify: `omarchyd/server.mjs` — procedure already wrapped owner-only
- Modify: `web/src/containers/Containers.tsx` — Install connector button + polling

**Interfaces:**
- Consumes: `incus exec` / file push; `connector.pair({containerOf, terminal, files, backup, manage})`; guest-install style curl|bash against `guestReachableUrl`
- Produces: `containers.installConnector({name, username})` → `{status, …}`; UI CTA when running and no `containerOf` agent; Alpine/systemd supported, clear unsupported message otherwise

- [ ] **Step 1: Write the failing test**

```js
test('lxc install pairs with containerOf and runs exec', async () => {
	const calls = []
	const pair = async (input) => {
		calls.push(['pair', input])
		return {token: 't', ca: 'ca', source: 'https://example.test', port: 7780, addresses: ['127.0.0.1']}
	}
	const run = async (args) => {
		calls.push(['incus', args])
		return ''
	}
	// invoke install helper with fakes
	await installLxcConnector({name: 'web', username: 'joseph', run, pair, listAgents: async () => [{containerOf: 'web'}]})
	assert.equal(calls[0][0], 'pair')
	assert.equal(calls[0][1].containerOf, 'web')
	assert.equal(calls[0][1].desktop, undefined) // or false
	assert.ok(calls.some((c) => c[0] === 'incus'))
})
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/lxc-install.test.mjs`

Expected: FAIL — module missing

- [ ] **Step 3: Implementation**

`lxc-install.mjs`: build allow list without desktop/storage/vms; `incus exec <name> --` run prep + installer (mirror `guestConnectorExec` / `guestConnectorPrep` where possible, without qemu-ga). Poll `connector.list` for `containerOf === name`.

`containers.mjs`: export mutation `containers.installConnector` requiring running instance + username for Linux.

UI: on limited LXC page, **Install connector** calls the mutation; show progress from job/task; when agent appears, show Terminal/Pin and stop offering Install.

- [ ] **Step 4: Run tests**

```bash
node --test test/lxc-install.test.mjs test/containers.test.mjs
npx tsc --noEmit -p web
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/lxc-install.mjs omarchyd/containers.mjs omarchyd/server.mjs web/src/containers/Containers.tsx test/lxc-install.test.mjs test/containers.test.mjs
git commit -m "$(cat <<'EOF'
Install the connector into an LXC from the host

EOF
)"
```

---

### Task 6: Files, clip book, and Apps treat connected LXC as a swarm computer

**Files:**
- Modify: `web/src/screens/Files.tsx` (and/or `filePlaces` callers) only if container-linked agents were excluded too aggressively
- Modify: App Store target picker if it filters `guestOf` only — include agents with `containerOf` when online
- Test: extend an existing Files/swarm filter test or add `test/file-places-lxc.test.mjs` as source/logic assertions

**Interfaces:**
- Consumes: agents with `containerOf`, Files grant, online
- Produces: Files place via `::computer/{agentId}`; clips `scope: 'swarm'`; App install target when online — **no new path scheme**

- [ ] **Step 1: Write failing assertion**

Document in a small test that:

1. An agent with `containerOf: 'web'` and files granted appears in `filePlaces` computer inputs (or Files computer list).
2. The same agent does **not** appear as a Machines `computer` row (Task 3).
3. Store/install target list includes that agent id when online.

- [ ] **Step 2: Run to verify fail** (if current code already satisfies Files because `!guestOf`, the test should PASS for Files and only guide App Store — adjust implementation only where gaps exist)

- [ ] **Step 3: Fix gaps only**

- Do not invent `::container/`
- Ensure App Store “which machine” includes connector-online LXC agents
- Ensure Home pin / install rules use fleet abilities from Task 1

- [ ] **Step 4: Run focused tests + tsc**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Files.tsx web/src/screens/Store.tsx web/src/fleet/filePlaces.ts test/*.mjs
git commit -m "$(cat <<'EOF'
Use swarm Files and Apps paths for connected LXC

EOF
)"
```

---

### Task 7: Assistant `containers_*` tools

**Files:**
- Modify: `omarchyd/assistant/tools.mjs`
- Modify: `test/assistant-loop.test.mjs`
- Modify: assistant system/facts builder if it lists machine kinds (search for `machines_list` / swarm names in `omarchyd/assistant/`)

**Interfaces:**
- Consumes: `tool` / `mutation` / `toolsFor`
- Produces: read tools `containers_status`, `containers_list` (`ownerOnly: false`); write tools `containers_start`, `containers_stop`, `containers_restart`, `containers_create`, `containers_delete`, `containers_installConnector` (`ownerOnly: true`); facts text mentions system containers vs apps

- [ ] **Step 1: Write failing assertions in `test/assistant-loop.test.mjs`**

```js
assert.equal(READ_TOOLS.find((t) => t.name === 'containers_list').rpc, 'containers.list')
assert.equal(READ_TOOLS.find((t) => t.name === 'containers_list').ownerOnly, false)
assert.equal(WRITE_TOOLS.find((t) => t.name === 'containers_start').ownerOnly, true)
assert.equal(toolsFor('member').some((t) => t.name === 'containers_list'), true)
assert.equal(toolsFor('member').some((t) => t.name === 'containers_start'), false)
assert.equal(toolsFor('owner').some((t) => t.name === 'containers_installConnector'), true)
```

Update the frozen `READ_TOOLS.map((t) => t.name)` deepEqual list in the same file to include the new names in order.

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/assistant-loop.test.mjs`

Expected: FAIL — tools missing / snapshot list wrong

- [ ] **Step 3: Add tools**

```js
tool('containers_status', 'containers.status', 'Whether LXC/Incus containers are set up on this server'),
tool('containers_list', 'containers.list', 'System containers (LXC) on this server — not App Store apps'),
mutation('containers_start', 'containers.start', 'Start a system container', {name: {type: 'string'}}, true, ['name']),
mutation('containers_stop', 'containers.stop', 'Shut down a system container', {name: {type: 'string'}}, true, ['name']),
mutation('containers_restart', 'containers.restart', 'Restart a system container', {name: {type: 'string'}}, true, ['name']),
mutation('containers_create', 'containers.create', 'Create a system container (LXC)', {/* fields the UI sends */}, true, ['name']),
mutation('containers_delete', 'containers.delete', 'Delete a system container', {name: {type: 'string'}}, true, ['name']),
mutation('containers_installConnector', 'containers.installConnector', 'Install the connector inside a system container', {name: {type: 'string'}, username: {type: 'string'}}, true, ['name', 'username']),
```

Trim create properties to what `containers.create` actually accepts (read `containers.mjs` / CreateContainer form). Add a one-line facts note: system containers are machines; Apps are application containers.

- [ ] **Step 4: Run assistant-loop test**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/assistant/tools.mjs omarchyd/assistant/*.mjs test/assistant-loop.test.mjs
git commit -m "$(cat <<'EOF'
Give the assistant containers tools with role filters

EOF
)"
```

---

### Task 8: Vision, style guide, and Home nesting check

**Files:**
- Modify: `docs/vision.md`
- Modify: `docs/style-guide.md`
- Modify: Home gauge aggregation only if guests are nested today and containers are missing (search Home / serverGauges for guest CPU nesting)

**Interfaces:**
- Produces: docs distinguish system containers vs application containers; style Online/Offline + Container add label; Home does not double-count LXC

- [ ] **Step 1: Doc edits (founder branch)**

In `vision.md`:

- Under fleet / physical / virtual: add a short **System containers** subsection matching the spec (hosted on this server; page keeps Incus controls; connector unlocks Files/Apps; no Desktop).
- Change “What this is not” line so it clearly means **application** containers, not LXC.

In `style-guide.md`:

- Machines: Container in Add; Online/Offline; Incus export backups named distinctly from connector folder backups; no Desktop on LXC.
- Soften “A container is different from a machine” so it applies to application containers / component boundaries, not LXC fleet membership.

- [ ] **Step 2: Home nesting**

If guest CPU is excluded from host double-count, apply the same for container samples (or confirm Incus usage is already only on the container page and not added into Home peer gauges). Add a unit test only if there is an existing pure function to extend.

- [ ] **Step 3: Commit**

```bash
git add docs/vision.md docs/style-guide.md web/src/fleet/*.tsx web/src/fleet/*.ts test/*.mjs
git commit -m "$(cat <<'EOF'
Document system containers as machines in vision and style

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Flat list, no LXC appendix | 3 |
| Online/Offline/Paused language | 1, 3 |
| Virtual includes LXC | 1 |
| Add → Container | 3 |
| Members see list; owner Incus mutations | 2, 3 |
| LXC page keeps Incus controls | 3, 5 (CTA only) |
| LXC-aware connector abilities | 4 |
| containerOf link | 4, 5 |
| Install connector via host | 5 |
| Files/clips/Apps via swarm | 6 |
| Assistant tools + permissions | 7 |
| Vision/style | 8 |
| No Desktop/Storage/VMs; no dual file stack | Constraints + 4–6 |
| Home no double-count | 8 |

## Self-review notes

- No `::container/` path; Files use existing swarm computer addressing for `containerOf` agents.
- `guestOf` remains VM hex ids; `containerOf` is the LXC name.
- Member list read is required for “see in Machines”; do not open Incus mutations to members.
