# Remote guest connector install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the guest connector on a virtual machine that runs on a joined Linux computer, from the Install connector button and after create, through that computer’s `vm-ga-*` calls.

**Architecture:** `createQemuAgent` stays as it is. A `run` wrapper turns its `virsh qemu-agent-command` JSON into `vm-ga-ping`, `vm-ga-exec`, and `vm-ga-status`. `installConnector` drops the Series B refuse and uses that wrapper when `hostOf` is not `server`. Remote create starts the same `waitForGuestConnector` after a successful start, and its cloud seed gains `connectorCloudInit` so `guest-ping` can succeed. The helper accepts the basenames those commands already use.

**Tech Stack:** Node 20+ ESM, omarchyd JSON-RPC, existing Python VM helper, `node --test`, `python3` unittest.

**Spec:** `docs/superpowers/specs/2026-11-24-remote-guest-connector-design.md`

## Global Constraints

- Work from `/home/joseph/.worktrees/omarchy-server-remote-guest-connector` on `feat/remote-guest-connector-install`. `node_modules` is a symlink; do not npm install.
- Tabs, no semicolons, single quotes in JS. Python in `connector/` is 4-space. Commit messages are sentence case, no `feat:` prefix, no trailing period.
- Do not bump `package.json` version, `OMARCHYD_VERSION`, `web/src/changelog.ts`, or host `install.sh` `INSTALLER_REVISION`.
- Do not mix isolation overlay (`OMARCHY_SERVER_SOURCE`, `~/code` paths). Do not edit `helper/helper.mjs`, `omarchyd/qemu-agent.mjs`, `omarchyd/guest-install.mjs`, `connector/agent.py`, or the SPA.
- Do not add `vms` to `LINUX_CONNECTOR_ALLOW` or `WINDOWS_CONNECTOR_ALLOW`. Do not add a host shell or a new `vm-*` verb.
- Owner-only stays the `server.mjs` wrapper. Do not call `requireRemote` or `assertOwner` from `installConnector` or the create wait.
- `sudoPassword` is discarded. Never print it, and never put it on `vm-ga-exec` `input`.
- `--server` / `-Server` comes from `guestReachableUrl` only.
- Tests: fake `connector.call`. No real remote VM. `node --test --test-concurrency=1` on the task’s files. Known host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) are not this branch’s bugs.
- `test/swarm-vms.test.mjs` `readyHarness` must keep returning `'ok'` for names it does not special-case. That string is not a successful guest-ping. Do not “fix” it or the new create wait will hold the file open for `connectorEnrollTimeoutMs`.
- Execution is already subagent-driven. Do not ask which execution style to use.

## File map

Create:

- `omarchyd/remote-guest-agent.mjs` — `run` wrapper
- `test/remote-guest-agent.test.mjs` — wrapper plus the real `createQemuAgent`
- `test/remote-guest-connector.test.mjs` — remote button and create-time wait

Modify:

- `connector/vm-helper.py` — basename alternative on `GA_PATH`
- `connector/test_vm_helper.py` — basename cases
- `omarchyd/machines.mjs` — `qemuAgentFor`, host gate, remove the refuse, create wait, cloud `connectorCloudInit`
- `test/swarm-vms.test.mjs` — drop the old refuse assertion; expect qemu-guest-agent in the remote cloud seed

Do not modify `omarchyd/qemu-agent.mjs`, `omarchyd/guest-install.mjs`, `connector/agent.py`, `helper/helper.mjs`, root `install.sh`, or `web/`.

---

### Task 1: Accept guest-exec command names

**Files:**
- Modify: `connector/vm-helper.py`
- Modify: `connector/test_vm_helper.py`

**Interfaces:**
- Consumes: `handle` and `GA_PATH`
- Produces: `ga-exec` accepts `loginctl`, `bash`, `runuser`, `powershell.exe`, and the existing absolute paths

- [ ] **Step 1: Write the failing test**

Append to `connector/test_vm_helper.py`:

```python
class GuestExecPath(unittest.TestCase):
    def test_basename_commands_and_rejections(self):
        log = []

        def run(cmd, args, input=None):
            log.append(args[-1] if args else "")
            if cmd == "virsh" and "qemu-agent-command" in args:
                return '{"return":{"pid":7}}'
            return ""

        with tempfile.TemporaryDirectory() as d:
            for path in ("loginctl", "bash", "runuser", "powershell.exe", "/usr/bin/sudo"):
                out = handle(
                    "ga-exec",
                    ["abcd1234"],
                    stdin=json.dumps({"path": path, "args": ["-n"]}),
                    run=run,
                    data_dir=d,
                    uid=1000,
                )
                self.assertEqual(json.loads(out)["pid"], 7)
                body = json.loads(log[-1])
                self.assertEqual(body["arguments"]["path"], path)
            for path in ("../bin/sh", "bash -c", "", "/tmp/foo bar", ".", "..", "C:\\Windows\\System32\\powershell.exe"):
                with self.assertRaises(HelperError) as err:
                    handle("ga-exec", ["abcd1234"], stdin=json.dumps({"path": path}), run=run, data_dir=d, uid=1000)
                self.assertIn("Invalid path", str(err.exception))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 connector/test_vm_helper.py`
Expected: FAIL on `loginctl` with `Invalid path`

- [ ] **Step 3: Write minimal implementation**

In `connector/vm-helper.py`, replace `GA_PATH` with the regex in spec section 9. Do not change absolute-path behavior, args limits, or the sudo `input-data` test.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 connector/test_vm_helper.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add connector/vm-helper.py connector/test_vm_helper.py
git commit -m "Accept guest-exec command names in the VM helper"
```

---

### Task 2: Translate qemu-agent virsh calls into vm-ga calls

**Files:**
- Create: `omarchyd/remote-guest-agent.mjs`
- Create: `test/remote-guest-agent.test.mjs`

**Interfaces:**
- Consumes: `createQemuAgent` from `omarchyd/qemu-agent.mjs` (do not edit it)
- Produces: `remoteGuestAgentRun({call, guestId})` → `run(cmd, args)` as spec section 4

- [ ] **Step 1: Write the failing test**

Create `test/remote-guest-agent.test.mjs`:

```js
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createQemuAgent} from '../omarchyd/qemu-agent.mjs'
import {remoteGuestAgentRun} from '../omarchyd/remote-guest-agent.mjs'

const ID = 'abcd1234'
const DOMAIN = `omarchy-${ID}`
const SECRET = 'secret-pw'

test('ping, exec, and status go through vm-ga and nowhere else', async () => {
	const calls = []
	const run = remoteGuestAgentRun({
		guestId: ID,
		call: async (name, args) => {
			calls.push({name, args})
			if (name === 'vm-ga-ping') return '{"return":{}}'
			if (name === 'vm-ga-exec') return JSON.stringify({pid: 42})
			if (name === 'vm-ga-status') return JSON.stringify({exited: true, exitcode: 0, out: 'hello', err: 'nope'})
			throw new Error(`unexpected ${name}`)
		},
	})
	const agent = createQemuAgent({run, domain: DOMAIN})
	await agent.ping()
	const started = await agent.exec({path: 'loginctl', args: ['enable-linger', 'chris'], input: SECRET})
	assert.deepEqual(started, {pid: 42})
	assert.deepEqual(await agent.status(42), {exited: true, exitcode: 0, out: 'hello', err: 'nope'})
	assert.deepEqual(calls.map((c) => c.name), ['vm-ga-ping', 'vm-ga-exec', 'vm-ga-status'])
	assert.deepEqual(calls[0].args, {guestId: ID})
	assert.equal(calls[1].args.path, 'loginctl')
	assert.deepEqual(calls[1].args.args, ['enable-linger', 'chris'])
	assert.equal(calls[1].args.input, SECRET)
	assert.equal(calls[1].args.capture, undefined)
	assert.deepEqual(calls[2].args, {guestId: ID, pid: '42'})
	const execReturn = await run('virsh', ['-c', 'qemu:///session', 'qemu-agent-command', DOMAIN, JSON.stringify({execute: 'guest-exec', arguments: {path: 'true', 'input-data': Buffer.from(SECRET, 'utf8').toString('base64')}})])
	assert.equal(String(execReturn).includes(SECRET), false)
	await assert.rejects(() => run('sh', ['-c', 'virsh']), /qemu-agent-command/)
	await assert.rejects(
		() => run('virsh', ['-c', 'qemu:///session', 'qemu-agent-command', 'omarchy-ffffffff', '{}']),
		/qemu-agent-command/,
	)
	assert.equal(calls.some((c) => c.name === 'sh'), false)
	assert.equal(calls.filter((c) => c.name === 'vm-ga-exec').length, 2)
})

test('vm-ga-exec may already be an object', async () => {
	const run = remoteGuestAgentRun({
		guestId: ID,
		call: async () => ({pid: 9}),
	})
	const agent = createQemuAgent({run, domain: DOMAIN})
	assert.deepEqual(await agent.exec({path: 'true'}), {pid: 9})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/remote-guest-agent.test.mjs`
Expected: FAIL, module missing

- [ ] **Step 3: Write minimal implementation**

Implement spec section 4. `call` is not a shell. Do not import `machines.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-concurrency=1 test/remote-guest-agent.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/remote-guest-agent.mjs test/remote-guest-agent.test.mjs
git commit -m "Translate qemu-agent virsh calls into vm-ga calls"
```

---

### Task 3: Install a remote guest connector through the host

**Files:**
- Modify: `omarchyd/machines.mjs`
- Modify: `test/swarm-vms.test.mjs`
- Create: `test/remote-guest-connector.test.mjs`

**Interfaces:**
- Consumes: `remoteGuestAgentRun`, `guestConnectorPrep`, `guestConnectorExec`, `guestReachableUrl`, `hostAgent`
- Produces: `installConnector` on `hostId !== 'server'` returns `started`, `needs-agent`, or `unsupported`, or the host-gate errors in spec section 5

- [ ] **Step 1: Write the failing test**

Create `test/remote-guest-connector.test.mjs`:

```js
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'

const HOST = 'abc123abc123'
const ID = 'abcd1234'
const CA = 'a'.repeat(64)
const TOKEN = 'pair-token'
const LAN = '192.168.84.81'
const SECRET = 'secret-pw'

function machine(extra = {}) {
	return {
		id: ID,
		name: 'Box',
		osId: 'ubuntu-24.04-server-amd64',
		hostId: HOST,
		cores: 1,
		memoryGb: 1,
		memoryMb: 1024,
		diskSizeGb: 8,
		mac: '52:54:00:11:22:33',
		cloudInit: {username: 'chris', hostname: 'box'},
		layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: []},
		options: {agent: true},
		portForwards: [],
		...extra,
	}
}

async function openRemote({state = 'running', online = true, vms = true, present = true, osId, pingError = false} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'remote-guest-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [machine(osId ? {osId} : {})]}))
	const calls = []
	const pairCalls = []
	let execs = 0
	const machines = createMachines({
		dataDir: data,
		run: async () => {
			throw new Error('local virsh')
		},
		kvmDevice: join(root, 'no-kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
		connectorEnrollTimeoutMs: 400,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return {token: TOKEN, ca: CA, source: 'https://example.test', port: 7780, addresses: [{address: LAN}, {address: '127.0.0.1'}, {address: 'localhost'}]}
			},
			list: async () => {
				if (!present) return []
				const joined = execs > 0 ? [{guestOf: ID}] : []
				return [{id: HOST, name: 'PC', online, allowed: {vms}, on: {vms}}, ...joined]
			},
			progress: () => null,
			call: async (id, name, args) => {
				calls.push({id, name, args})
				if (name === 'vm-state') return {[`omarchy-${ID}`]: state}
				if (name === 'vm-ga-ping') {
					if (pingError) throw new Error('Guest agent not available for now')
					return '{"return":{}}'
				}
				if (name === 'vm-ga-exec') {
					execs += 1
					return JSON.stringify({pid: 42})
				}
				if (name === 'vm-ga-status') return JSON.stringify({exited: true, exitcode: 0, out: '', err: ''})
				return 'ok'
			},
		},
	})
	await machines.ready
	return {root, data, machines, calls, pairCalls}
}

const until = async (fn, ms = 2000) => {
	const end = Date.now() + ms
	let last = null
	while (Date.now() < end) {
		last = await fn()
		if (last) return last
		await new Promise((r) => setTimeout(r, 20))
	}
	return last
}

test('installConnector on a remote guest uses vm-ga and a guest-reachable server', async () => {
	const {root, data, machines, calls, pairCalls} = await openRemote()
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID, username: 'chris', sudoPassword: SECRET})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'linux')
		assert.equal(out.status === 'needs-password', false)
		const ping = calls.find((c) => c.name === 'vm-ga-ping')
		assert.equal(ping.id, HOST)
		assert.deepEqual(ping.args, {guestId: ID})
		const execs = calls.filter((c) => c.name === 'vm-ga-exec')
		assert.equal(execs[0].args.path, 'loginctl')
		assert.deepEqual(execs[0].args.args, ['enable-linger', 'chris'])
		assert.equal(execs.some((c) => c.args.path === 'bash'), true)
		const enroll = execs.find((c) => c.args.path === 'runuser')
		assert.equal(enroll.args.args[1], 'chris')
		assert.match(enroll.args.args[5], /--server https:\/\/192\.168\.84\.81:7780/)
		assert.equal(enroll.args.args[5].includes('127.0.0.1'), false)
		assert.equal(enroll.args.args[5].includes('localhost'), false)
		assert.equal(pairCalls[0].machineId, ID)
		assert.equal(JSON.stringify(calls).includes(SECRET), false)
		const done = await until(async () => {
			const task = (await machines.procedures['machines.tasks'].run()).find((row) => row.id === out.taskId)
			return task && task.status !== 'running' ? task : null
		})
		assert.equal(done.status, 'ok')
		assert.equal(JSON.stringify(done).includes(SECRET), false)
		const saved = await readFile(join(data, 'machines', 'machines.json'), 'utf8')
		assert.equal(saved.includes(SECRET), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a remote Windows guest enrolls with powershell and this server’s address', async () => {
	const {root, machines, calls} = await openRemote({osId: 'windows-11'})
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID, sudoPassword: SECRET})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'windows')
		const enroll = calls.filter((c) => c.name === 'vm-ga-exec').find((c) => c.args.path === 'powershell.exe')
		assert.equal(enroll.args.args[0], '-NoProfile')
		assert.match(enroll.args.args[2], /-Server 'https:\/\/192\.168\.84\.81:7780'/)
		assert.equal(enroll.args.args[2].includes('127.0.0.1'), false)
		assert.equal(JSON.stringify(calls).includes(SECRET), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a remote guest with no qemu-ga needs the agent and does not exec', async () => {
	const {root, machines, calls} = await openRemote({pingError: true})
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID, username: 'chris'})
		assert.equal(out.status, 'needs-agent')
		assert.equal(out.os, 'linux')
		assert.equal(calls.some((c) => c.name === 'vm-ga-exec'), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an offline host is refused before vm-ga and before start-the-machine', async () => {
	const {root, machines, calls} = await openRemote({online: false, state: 'shut off'})
	try {
		await assert.rejects(
			() => machines.procedures['machines.installConnector'].run({id: ID, username: 'chris'}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && e.message === 'PC is offline right now',
		)
		assert.equal(calls.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('vms off is the pair-again forbid and does not call', async () => {
	const {root, machines, calls} = await openRemote({vms: false})
	try {
		await assert.rejects(
			() => machines.procedures['machines.installConnector'].run({id: ID, username: 'chris'}),
			(e) => e instanceof RpcError && e.code === 'FORBIDDEN' && e.message === 'Pair PC again with Virtual machines switched on.',
		)
		assert.equal(calls.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an unknown host is not found', async () => {
	const {root, machines, calls} = await openRemote({present: false})
	try {
		await assert.rejects(
			() => machines.procedures['machines.installConnector'].run({id: ID, username: 'chris'}),
			(e) => e instanceof RpcError && e.code === 'NOT_FOUND' && /isn’t in your swarm/.test(e.message),
		)
		assert.equal(calls.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a stopped remote guest asks to be started and does not ping', async () => {
	const {root, machines, calls} = await openRemote({state: 'shut off'})
	try {
		await assert.rejects(
			() => machines.procedures['machines.installConnector'].run({id: ID, username: 'chris'}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /Start the machine first/.test(e.message),
		)
		assert.equal(calls.some((c) => String(c.name).startsWith('vm-ga-')), false)
		assert.equal(calls.some((c) => c.name === 'vm-state'), true)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an unsupported remote guest does not ask the host', async () => {
	const {root, machines, calls} = await openRemote({osId: 'alpine-3.24.1-amd64', present: false})
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID})
		assert.equal(out.status, 'unsupported')
		assert.equal(out.os, 'other')
		assert.equal(calls.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
```

In `test/swarm-vms.test.mjs`, delete only this line from the power test:

```js
	await assert.rejects(machines.procedures['machines.installConnector'].run({id: 'abcd1234', username: 'chris'}, auth), /hosts this virtual machine/)
```

Leave the following `vm-ga-` assertion in place. That test does not call `installConnector`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-concurrency=1 test/remote-guest-connector.test.mjs test/swarm-vms.test.mjs`
Expected: FAIL, remote install still throws the Series B sentence, or the new cases fail

- [ ] **Step 3: Write minimal implementation**

In `machines.mjs`, spec sections 5 and 6 only. Add `qemuAgentFor` (spec section 4) and use it from `installConnector`. Do not call `requireRemote`. Do not start the create wait yet. Do not edit `guest-install.mjs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 test/remote-guest-connector.test.mjs test/swarm-vms.test.mjs test/guest-connector-install.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs test/remote-guest-connector.test.mjs test/swarm-vms.test.mjs
git commit -m "Install a remote guest connector through the host"
```

---

### Task 4: Start remote guest connector install after create

**Files:**
- Modify: `omarchyd/machines.mjs` (`createOnHost` seed and the post-success wait)
- Modify: `test/remote-guest-connector.test.mjs`
- Modify: `test/swarm-vms.test.mjs` (seed assertions in `remote create stores hostId and does not define locally`)

**Interfaces:**
- Consumes: `waitForGuestConnector`, `connectorCloudInit`, `qemuAgentFor`
- Produces: remote cloud user-data includes the agent package and linger; successful create calls the wait without blocking `{id}`

- [ ] **Step 1: Write the failing test**

Append to `test/remote-guest-connector.test.mjs`:

```js
async function openCreate(calls, {fail} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'remote-guest-create-'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	const catalog = {version: 1, images: [
		{id: 'debian-12', familyId: 'debian', name: 'Debian', version: '12', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'ab'.repeat(32), sizeMb: 1, adminGroup: 'sudo'},
		{id: 'alpine-3.24.1-amd64', familyId: 'alpine', name: 'Alpine', version: '3.24.1', arch, kind: 'cloud', url: 'https://example.test/alpine.qcow2', sha256: 'cd'.repeat(32), sizeMb: 1, adminGroup: 'wheel'},
	]}
	let createResolved = false
	let pingAfterCreate = false
	let pingBeforeCreate = false
	const pairCalls = []
	const machines = createMachines({
		dataDir: join(root, 'data'),
		catalogUrl: 'https://example.test/catalog.json',
		fetchImpl: async () => ({ok: true, json: async () => catalog}),
		run: async (cmd) => {
			if (cmd === 'openssl') return '$6$salt$hash\n'
			if (cmd === 'virsh') throw new Error('local virsh')
			return ''
		},
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
		connectorEnrollTimeoutMs: 400,
		connectorAgentWaitMs: 400,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return {token: TOKEN, ca: CA, source: 'https://example.test', port: 7780, addresses: [{address: LAN}]}
			},
			list: async () => {
				const joined = pairCalls.length ? [{guestOf: pairCalls[0].machineId}] : []
				return [{id: HOST, name: 'PC', online: true, allowed: {vms: true}, on: {vms: true}}, ...joined]
			},
			progress: () => null,
			call: async (id, name, args) => {
				if (name === fail) throw new Error('define failed')
				calls.push({id, name, args})
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch, threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga']}
				if (name === 'vm-ga-ping') {
					if (createResolved) pingAfterCreate = true
					else pingBeforeCreate = true
					return '{"return":{}}'
				}
				if (name === 'vm-ga-exec') return JSON.stringify({pid: 42})
				if (name === 'vm-ga-status') return JSON.stringify({exited: true, exitcode: 0, out: '', err: ''})
				if (name === 'vm-state') return {}
				return 'ok'
			},
		},
	})
	await machines.ready
	return {
		root,
		machines,
		pairCalls,
		flags: () => ({pingAfterCreate, pingBeforeCreate}),
		resolveCreate: () => {
			createResolved = true
		},
	}
}

const auth = {auth: {role: 'owner'}}

test('remote cloud create returns before enroll and then installs through vm-ga', async () => {
	const calls = []
	const opened = await openCreate(calls)
	const {root, machines, pairCalls, flags, resolveCreate} = opened
	try {
		const pending = machines.procedures['machines.create'].run(
			{hostId: HOST, name: 'Box', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
			auth,
		)
		pending.then(() => resolveCreate(), () => {})
		const {id} = await pending
		assert.match(id, /^[a-f0-9]{8}$/)
		// create() resolved while the background function was still on its first await, so enroll has not started.
		assert.equal(pairCalls.length, 0)
		const done = await until(async () => {
			const task = (await machines.procedures['machines.tasks'].run()).find((row) => row.machineId === id && row.type === 'connector' && row.status === 'ok')
			return task ?? null
		}, 3000)
		assert.equal(done?.type, 'connector')
		const seedText = JSON.stringify(calls.find((c) => c.name === 'vm-seed').args)
		assert.match(seedText, /qemu-guest-agent/)
		assert.match(seedText, /python3/)
		assert.match(seedText, /\["loginctl","enable-linger","chris"\]/)
		assert.equal(seedText.includes('install.sh'), false)
		assert.equal(seedText.includes('--token'), false)
		assert.equal(seedText.includes('hunter2'), false)
		assert.equal(flags().pingBeforeCreate, false)
		assert.equal(flags().pingAfterCreate, true)
		assert.equal(pairCalls[0].machineId, id)
		const enroll = calls.filter((c) => c.name === 'vm-ga-exec').find((c) => c.args.path === 'runuser')
		assert.match(enroll.args.args[5], /--server https:\/\/192\.168\.84\.81:7780/)
		assert.equal(calls.some((c) => c.name === 'vm-ga-ping' && c.id === HOST), true)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a failed remote create does not ping the guest agent', async () => {
	const calls = []
	const {root, machines} = await openCreate(calls, {fail: 'vm-start'})
	try {
		const {id} = await machines.procedures['machines.create'].run(
			{hostId: HOST, name: 'Bad', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
			auth,
		)
		await until(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state === 'error')
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(calls.some((c) => c.name === 'vm-ga-ping'), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('remote Alpine create does not enroll', async () => {
	const calls = []
	const {root, machines} = await openCreate(calls)
	try {
		const {id} = await machines.procedures['machines.create'].run(
			{hostId: HOST, name: 'Al', osId: 'alpine-3.24.1-amd64', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
			auth,
		)
		await until(async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id)?.state !== 'installing')
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(calls.some((c) => c.name === 'vm-ga-ping'), false)
		const seedText = JSON.stringify(calls.find((c) => c.name === 'vm-seed')?.args ?? {})
		assert.match(seedText, /qemu-guest-agent/)
		assert.equal(seedText.includes('install.sh'), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
```

In `test/swarm-vms.test.mjs`, replace the two seed assertions:

```js
	assert.equal(JSON.stringify(seed.args).includes('qemu-guest-agent'), false)
	assert.equal(JSON.stringify(seed.args).includes('install.sh'), false)
```

with:

```js
	const seedText = JSON.stringify(seed.args)
	assert.match(seedText, /qemu-guest-agent/)
	assert.match(seedText, /python3/)
	assert.match(seedText, /\["loginctl","enable-linger","chris"\]/)
	assert.equal(seedText.includes('install.sh'), false)
	assert.equal(seedText.includes('--token'), false)
	assert.equal(seedText.includes('hunter2'), false)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-concurrency=1 test/remote-guest-connector.test.mjs test/swarm-vms.test.mjs`
Expected: FAIL, remote seed has no `qemu-guest-agent`, or no connector task starts

- [ ] **Step 3: Write minimal implementation**

Spec sections 7 and 8. Point `waitForGuestConnector` at `qemuAgentFor`. Pass `username` into `connectorCloudInit` the same way local `seed()` does. Do not pass `windowsCommand`. Do not change `readyHarness`’s `'ok'` fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-concurrency=1 test/remote-guest-connector.test.mjs test/remote-guest-agent.test.mjs test/swarm-vms.test.mjs test/guest-connector-install.test.mjs`

Expected: PASS

Run: `python3 connector/test_vm_helper.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add omarchyd/machines.mjs test/remote-guest-connector.test.mjs test/swarm-vms.test.mjs
git commit -m "Start remote guest connector install after create"
```
