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
		assert.match(enroll.args.args[5], /--server '?https:\/\/192\.168\.84\.81:7780'?/)
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

test('a remote Windows guest does not run the connector', async () => {
	const {root, machines, calls} = await openRemote({osId: 'windows-11'})
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID, sudoPassword: SECRET})
		assert.equal(out.status, 'unsupported')
		assert.equal(calls.some((c) => c.name === 'vm-ga-exec'), false)
		assert.equal(JSON.stringify(calls).includes(SECRET), false)
		assert.equal(JSON.stringify(out).includes('powershell'), false)
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
	const {root, machines, calls} = await openRemote({osId: 'haos', present: false})
	try {
		const out = await machines.procedures['machines.installConnector'].run({id: ID})
		assert.equal(out.status, 'unsupported')
		assert.equal(out.os, 'other')
		assert.equal(calls.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

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
		const seed = calls.find((c) => c.name === 'vm-seed')
		const seedText = JSON.stringify(seed.args)
		assert.match(seedText, /qemu-guest-agent/)
		assert.match(seedText, /python3/)
		assert.match(seed.args.files['user-data'], /\["loginctl","enable-linger","chris"\]/)
		assert.equal(seedText.includes('install.sh'), false)
		assert.equal(seedText.includes('--token'), false)
		assert.equal(seedText.includes('hunter2'), false)
		assert.equal(flags().pingBeforeCreate, false)
		assert.equal(flags().pingAfterCreate, true)
		assert.equal(pairCalls[0].machineId, id)
		const enroll = calls.filter((c) => c.name === 'vm-ga-exec').find((c) => c.args.path === 'runuser')
		assert.match(enroll.args.args[5], /--server '?https:\/\/192\.168\.84\.81:7780'?/)
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

test('remote Alpine create enrolls through OpenRC without linger', async () => {
	const calls = []
	const opened = await openCreate(calls)
	const {root, machines, pairCalls, resolveCreate} = opened
	try {
		const pending = machines.procedures['machines.create'].run(
			{hostId: HOST, name: 'Al', osId: 'alpine-3.24.1-amd64', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'},
			auth,
		)
		pending.then(() => resolveCreate(), () => {})
		const {id} = await pending
		const done = await until(async () => {
			const task = (await machines.procedures['machines.tasks'].run()).find((row) => row.machineId === id && row.type === 'connector' && row.status === 'ok')
			return task ?? null
		}, 3000)
		assert.equal(done?.type, 'connector')
		assert.equal(pairCalls[0].machineId, id)
		const seed = calls.find((c) => c.name === 'vm-seed')
		const seedText = JSON.stringify(seed.args)
		assert.match(seedText, /qemu-guest-agent/)
		assert.match(seedText, /python3/)
		assert.match(seedText, /bash/)
		assert.match(seed.args.files['user-data'], /rc-update/)
		assert.doesNotMatch(seed.args.files['user-data'], /loginctl/)
		assert.equal(seedText.includes('install.sh'), false)
		assert.equal(calls.some((c) => c.name === 'vm-ga-ping'), true)
		const enroll = calls.filter((c) => c.name === 'vm-ga-exec').find((c) => {
			const text = [c.args.path, ...(c.args.args ?? [])].join(' ')
			return text.includes('runuser') && text.includes('--user-enroll-only')
		})
		assert.ok(enroll, 'enrolls as the guest user')
		const text = [enroll.args.path, ...(enroll.args.args ?? [])].join(' ')
		assert.equal(text.includes('DBUS_SESSION_BUS_ADDRESS'), false)
		assert.match(text, /\/etc\/init\.d\/omarchy-connector/)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
