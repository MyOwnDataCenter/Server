// Live machines.installConnector: qemu-ga ping/exec, a pairing token, then a connector task.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createMachines} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const CA = 'a'.repeat(64)
const TOKEN = 'pair-token'
const LAN = '192.168.84.81'

function record(id, extra = {}) {
	return {
		id,
		name: extra.name ?? 'Box',
		osId: extra.osId ?? 'ubuntu-24.04-server-amd64',
		cores: 1,
		memoryGb: 1,
		memoryMb: 1024,
		diskSizeGb: 10,
		portForwards: [],
		createdAt: 1,
		mac: '52:54:00:11:22:33',
		vmid: 100,
		options: {agent: true},
		tasks: [],
		snapshots: [],
		...(extra.cloudInit !== undefined ? (extra.cloudInit ? {cloudInit: extra.cloudInit} : {}) : {cloudInit: {username: 'chris'}}),
		layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: []},
	}
}

function virshList(stateByDomain = new Map()) {
	return async (cmd, args) => {
		if (cmd === 'qemu-system-x86_64') return ''
		if (cmd === 'virsh' && args.includes('list')) {
			const rows = [...stateByDomain].map(([name, state]) => ` -    ${name}   ${state}`).join('\n')
			return ` Id   Name   State\n------------------\n${rows}\n`
		}
		throw new Error(`unexpected ${cmd} ${(args ?? []).join(' ')}`)
	}
}

function fakePair(extra = {}) {
	return {
		token: TOKEN,
		ca: CA,
		source: 'https://example.test',
		port: 7780,
		addresses: [{address: LAN}],
		...extra,
	}
}

function fakeAgent() {
	const execs = []
	let pingCalls = 0
	const domains = []
	const qemuAgent = ({domain}) => {
		domains.push(domain)
		return {
			ping: async () => {
				pingCalls++
			},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}
	}
	return {
		qemuAgent,
		execs,
		domains,
		pingCount: () => pingCalls,
	}
}

async function open({machines, run, qemuAgent, connector, connectorEnrollTimeoutMs = 200}) {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-install-rpc-'))
	const dataDir = join(root, 'data')
	await mkdir(join(dataDir, 'machines'), {recursive: true})
	if (machines?.length) await writeFile(join(dataDir, 'machines', 'machines.json'), JSON.stringify({machines}))
	const api = createMachines({
		dataDir,
		catalogUrl: 'https://example.invalid/catalog.json',
		fetchImpl: async () => ({ok: false}),
		run: run ?? (async () => ''),
		kvmDevice: join(root, 'no-kvm'),
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
		qemuAgent,
		connector,
		connectorEnrollTimeoutMs,
	})
	await api.ready
	return {root, dataDir, api, call: (name, input) => api.procedures[name].run(input)}
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

test('haos and macos are unsupported and never ping the guest agent', async () => {
	const agent = fakeAgent()
	const virsh = []
	const run = async (cmd, args) => {
		if (cmd === 'virsh') virsh.push(args)
		return ''
	}
	const {root, call} = await open({
		machines: [
			record('aaaa0002', {osId: 'haos', name: 'HAOS'}),
			record('aaaa0003', {osId: 'macos', name: 'Mac'}),
		],
		run,
		qemuAgent: agent.qemuAgent,
	})
	try {
		for (const id of ['aaaa0002', 'aaaa0003']) {
			const out = await call('machines.installConnector', {id})
			assert.equal(out.status, 'unsupported')
			assert.equal(out.os, 'other')
			assert.equal(typeof out.message, 'string')
			assert.ok(out.message.length > 0)
		}
		assert.equal(agent.pingCount(), 0)
		assert.deepEqual(virsh, [])
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('alpine cloud running with qemu-ga enrolls as the user then starts OpenRC', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const pairCalls = []
	const {root, call} = await open({
		machines: [record(id, {osId: 'alpine-3.24.1-amd64'})],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'linux')
		assert.equal(pairCalls.length, 1)
		assert.equal(agent.execs.some((cmd) => cmd.path === 'loginctl'), false)
		const python = agent.execs.find((cmd) => cmd.path === 'bash' && cmd.args?.[1]?.includes?.('apk add --no-cache python3'))
		assert.ok(python, 'prep installs python through apk')
		const enroll = agent.execs.find((cmd) => {
			const text = [cmd.path, ...(cmd.args ?? [])].join(' ')
			return text.includes('runuser') && text.includes('--user-enroll-only')
		})
		assert.ok(enroll, 'enrolls as the guest user')
		const text = [enroll.path, ...(enroll.args ?? [])].join(' ')
		assert.match(text, /-u chris/)
		assert.equal(text.includes('DBUS_SESSION_BUS_ADDRESS'), false)
		assert.match(text, /\/etc\/init\.d\/omarchy-connector/)
		assert.match(text, /rc-service omarchy-connector start/)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('a stopped machine is PRECONDITION_FAILED before ping', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'shut off']])),
		qemuAgent: agent.qemuAgent,
	})
	try {
		await assert.rejects(
			() => call('machines.installConnector', {id}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && /Start the machine first/.test(e.message),
		)
		assert.equal(agent.pingCount(), 0)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('a running machine whose guest agent does not answer needs-agent', async () => {
	const id = 'abcd1234'
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: () => ({
			ping: async () => {
				throw new Error('Guest agent not available for now')
			},
			exec: async () => {
				throw new Error('exec must not run')
			},
		}),
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'needs-agent')
		assert.equal(out.os, 'linux')
		assert.equal(out.taskId, undefined)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('linux cloud running with qemu-ga starts a connector task through runuser', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const pairCalls = []
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'started')
		assert.equal(out.os, 'linux')
		assert.equal(typeof out.taskId, 'string')
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
		assert.equal(pairCalls[0].terminal, true)
		assert.equal(pairCalls[0].desktop, true)
		assert.equal(pairCalls[0].manage, true)
		assert.equal(pairCalls[0].files, true)
		assert.deepEqual(agent.domains, [`omarchy-${id}`])
		assert.equal(agent.execs.length >= 2, true)
		const lingerAt = agent.execs.findIndex((cmd) => cmd.path === 'loginctl' && cmd.args[0] === 'enable-linger' && cmd.args[1] === 'chris')
		const enrollAt = agent.execs.findIndex((cmd) => cmd.path === 'runuser')
		assert.equal(lingerAt >= 0 && enrollAt > lingerAt, true)
		assert.equal(agent.execs[enrollAt].args[0], '-u')
		assert.equal(agent.execs[enrollAt].args[1], 'chris')
		assert.deepEqual(agent.execs[enrollAt].args.slice(2, 5), ['--', 'bash', '-lc'])
		const command = agent.execs[enrollAt].args[5]
		assert.match(command, /--server '?https:\/\/192\.168\.84\.81:7780'?/)
		assert.equal(command.includes('127.0.0.1'), false)
		assert.match(command, new RegExp(`--token '?${TOKEN}'?`))
		assert.match(command, new RegExp(`--ca '?${CA}'?`))
		assert.match(command, /--allow '?terminal,desktop,manage,files'?/)
		assert.equal(command.includes('--user-enroll-only'), true)
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.id === out.taskId)
			return t?.status === 'ok' ? t : null
		})
		assert.equal(done?.type, 'connector')
		assert.equal(done.status, 'ok')
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('installConnector skips the guest’s own LAN address and uses the passt gateway', async () => {
	const id = 'abcd1234'
	const execs = []
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: () => ({
			ping: async () => {},
			interfaces: async () => [{name: 'enp1s0', 'ip-addresses': [{'ip-address': LAN}]}],
			routes: async () => [{version: 4, destination: '0.0.0.0', gateway: '192.168.86.1'}],
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}),
		connector: {
			pair: async () => fakePair({
				addresses: [{address: '100.64.1.2', tailscale: true}, {address: LAN}],
			}),
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'started')
		const enroll = execs.find((cmd) => cmd.path === 'runuser')
		assert.ok(enroll, 'enroll runs as the guest user')
		assert.match(enroll.args[5], /--server '?https:\/\/192\.168\.86\.1:7780'?/)
		assert.equal(enroll.args[5].includes('192.168.84.81'), false)
		assert.equal(enroll.args[5].includes('100.64.1.2'), false)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('windows guests do not run the connector', async () => {
	const id = 'abcd1234'
	const agent = fakeAgent()
	const pairCalls = []
	const {root, call} = await open({
		machines: [record(id, {osId: 'windows-11', cloudInit: null})],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id})
		assert.equal(out.status, 'unsupported')
		assert.equal(pairCalls.length, 0)
		assert.equal(agent.execs.length, 0)
		assert.equal(JSON.stringify(out).includes('powershell'), false)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('guest-exec exit 4 does not start enroll and does not return needs-password', async () => {
	const id = 'abcd1234'
	const secret = 'secret-pw'
	const execs = []
	let listed = false
	const {root, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: () => ({
			ping: async () => {},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: execs.at(-1)?.path === 'runuser' ? 4 : 0, out: '', err: ''}),
		}),
		connector: {
			pair: async () => fakePair(),
			list: async () => {
				listed = true
				throw new Error('enroll must not start')
			},
		},
	})
	try {
		await assert.rejects(
			() => call('machines.installConnector', {id, sudoPassword: secret}),
			(e) => e instanceof RpcError && e.code === 'PRECONDITION_FAILED' && !String(e.message).includes(secret),
		)
		assert.equal(listed, false)
		assert.equal(execs.some((cmd) => cmd.path === 'loginctl' && cmd.args[0] === 'enable-linger' && cmd.args[1] === 'chris'), true)
		assert.equal(execs.some((cmd) => cmd.path === 'runuser'), true)
		const tasks = await call('machines.tasks')
		assert.equal(tasks.some((row) => row.type === 'connector'), false)
		assert.equal(JSON.stringify(execs).includes(secret), false)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('sudoPassword is dropped and never written to tasks or machines.json', async () => {
	const id = 'abcd1234'
	const secret = 'secret-pw'
	const agent = fakeAgent()
	const {root, dataDir, call} = await open({
		machines: [record(id)],
		run: virshList(new Map([[`omarchy-${id}`, 'running']])),
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async () => fakePair(),
			list: async () => [{guestOf: id}],
		},
	})
	try {
		const out = await call('machines.installConnector', {id, sudoPassword: secret})
		assert.equal(out.status, 'started')
		assert.equal(out.status === 'needs-password', false)
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.id === out.taskId)
			return t && t.status !== 'running' ? t : null
		})
		assert.equal(done.status, 'ok')
		assert.equal(JSON.stringify(done).includes(secret), false)
		assert.equal(JSON.stringify(agent.execs).includes(secret), false)
		const saved = await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8')
		assert.equal(saved.includes(secret), false)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('a member cannot call machines.installConnector', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-install-auth-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	await mkdir(home, {recursive: true})
	await writeFile(join(root, 'kvm'), '')
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
	state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
	await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))
	const d = await startOmarchyd({
		port: 0,
		dataDir: data,
		home,
		machineOptions: {run: async () => '', kvmDevice: join(root, 'kvm')},
		appOptions: {run: async () => '', defaultStores: [], systemApps: null},
		updaterOptions: {autoCheck: false},
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	})
	const login = async (userId) => {
		const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
		const body = await r.json()
		return {authorization: `Bearer ${body.result.data.accessToken}`}
	}
	const member = await login('member')
	const r = await fetch(`${d.url}/trpc/machines.installConnector`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...member},
		body: JSON.stringify({id: 'abcd1234'}),
	})
	const body = await r.json()
	assert.equal(r.status, 403)
	assert.match(body.error.message, /Only the server’s owner can install a guest connector/)
})

const CLOUD_IMAGE = {
	id: 'testos-amd64',
	familyId: 'debian',
	name: 'TestOS',
	version: '1',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/test.qcow2',
	sha256: 'a'.repeat(64),
	sizeMb: 1,
	adminGroup: 'sudo',
}
const ALPINE_IMAGE = {
	id: 'alpine-3.24.1-amd64',
	familyId: 'alpine',
	name: 'Alpine',
	version: '3.24.1',
	arch: 'amd64',
	kind: 'cloud',
	url: 'https://example.test/alpine.qcow2',
	sha256: 'b'.repeat(64),
	sizeMb: 1,
	adminGroup: 'wheel',
}

async function openCreate({qemuAgent, connector, connectorEnrollTimeoutMs = 200, connectorAgentWaitMs = 200, images = [CLOUD_IMAGE], files} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'guest-install-create-'))
	const dataDir = join(root, 'data')
	const catalog = join(root, 'catalog.json')
	await mkdir(join(dataDir, 'machines', 'images'), {recursive: true})
	await writeFile(catalog, JSON.stringify({version: 1, images}))
	for (const img of images) await writeFile(join(dataDir, 'machines', 'images', `${img.id}.qcow2`), 'cloud-image-bytes')
	const kvmDevice = join(root, 'kvm')
	await writeFile(kvmDevice, '')
	const domains = new Map()
	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'qemu-system-x86_64') return ''
		if (cmd === 'openssl') return '$6$salt$fakehash\n'
		if (cmd === 'xorriso') {
			if (args.includes('-pvd_info')) return `Volume Id    : ${/Win11/i.test(args[1] ?? '') ? 'CCCOMA_X64FRE_EN-US_DV9' : 'ARCH_202611'}\n`
			await writeFile(args[args.indexOf('-output') + 1], 'iso')
			if (opts.cwd) {
				try {
					run.unattend = await readFile(join(opts.cwd, 'autounattend.xml'), 'utf8')
				} catch {}
				try {
					run.userData = await readFile(join(opts.cwd, 'user-data'), 'utf8')
				} catch {}
			}
			return ''
		}
		if (cmd === 'qemu-img') {
			if (args[0] === '--version') return 'qemu-img version 9.0\n'
			if (args[0] === 'convert') await writeFile(args.at(-1), 'disk')
			if (args[0] === 'create') await writeFile(args[3], 'blank')
			return ''
		}
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (a[0] === '--version') return '10.0.0\n'
			if (a[0] === 'qemu-agent-command') throw new Error('Guest agent not available for now')
			if (a[0] === 'list') {
				const rows = [...domains].map(([name, state]) => ` -    ${name}   ${state}`).join('\n')
				return ` Id   Name   State\n------------------\n${rows}\n`
			}
			if (a[0] === 'define') {
				const xml = await readFile(a[1], 'utf8')
				const name = /<name>(.+?)<\/name>/.exec(xml)[1]
				if (!domains.has(name)) domains.set(name, 'shut off')
				return ''
			}
			if (a[0] === 'start') {
				domains.set(a[1], 'running')
				return ''
			}
			if (a[0] === 'domuuid') throw new Error(`failed to get domain '${a[1]}'`)
			return ''
		}
		throw new Error(`unexpected ${cmd}`)
	}
	const api = createMachines({
		dataDir,
		catalogUrl: `file://${catalog}`,
		fetchImpl: async () => {
			throw new Error('catalog image should already be on disk')
		},
		run,
		kvmDevice,
		arch: 'amd64',
		statsIntervalMs: 60_000,
		watchIdleMs: 1,
		qemuAgent,
		connector,
		connectorEnrollTimeoutMs,
		connectorAgentWaitMs,
		files,
	})
	await api.ready
	return {root, dataDir, api, run, call: (name, input) => api.procedures[name].run(input)}
}

const createSpec = {cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'}

test('creating testos-amd64 starts a connector install after the machine boots', async () => {
	const agent = fakeAgent()
	const pairCalls = []
	let id
	const {root, call, run} = await openCreate({
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => (id && agent.execs.length ? [{guestOf: id}] : []),
		},
	})
	try {
		;({id} = await call('machines.create', {...createSpec, name: 'Box', osId: 'testos-amd64'}))
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.machineId === id && row.type === 'connector')
			return t?.status === 'ok' ? t : null
		})
		assert.equal(done?.type, 'connector')
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
		assert.equal(agent.pingCount() >= 1, true)
		assert.equal(agent.execs.length >= 2, true)
		const lingerAt = agent.execs.findIndex((cmd) => cmd.path === 'loginctl' && cmd.args[1] === 'chris')
		const enroll = agent.execs.find((cmd) => cmd.path === 'runuser')
		assert.equal(lingerAt >= 0 && lingerAt < agent.execs.findIndex((cmd) => cmd.path === 'runuser'), true)
		assert.equal(enroll.args[1], 'chris')
		assert.match(enroll.args[5], /--server '?https:\/\/192\.168\.84\.81:7780'?/)
		assert.match(run.userData, /\["loginctl","enable-linger","chris"\]/)
		assert.match(run.userData, /qemu-guest-agent/)
		assert.match(run.userData, /python3/)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating testos-amd64 pairs after the guest agent misses the first pings', async () => {
	const execs = []
	const pairCalls = []
	let pings = 0
	let id
	const {root, call} = await openCreate({
		connectorAgentWaitMs: 500,
		qemuAgent: () => ({
			ping: async () => {
				pings++
				if (pings < 3) throw new Error('Guest agent not available for now')
			},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}),
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => (id && execs.length ? [{guestOf: id}] : []),
		},
	})
	try {
		;({id} = await call('machines.create', {...createSpec, name: 'Late', osId: 'testos-amd64'}))
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.machineId === id && row.type === 'connector')
			return t?.status === 'ok' ? t : null
		}, 3000)
		assert.equal(done?.type, 'connector')
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
		assert.equal(pings >= 3, true)
		assert.equal(execs.length >= 1, true)
		assert.equal(execs.some((cmd) => cmd.path === 'runuser' && cmd.args[1] === 'chris'), true)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating testos-amd64 still succeeds when the guest agent never answers', async () => {
	const execs = []
	const pairCalls = []
	let pings = 0
	const {root, call} = await openCreate({
		connectorAgentWaitMs: 80,
		qemuAgent: () => ({
			ping: async () => {
				pings++
				throw new Error('Guest agent not available for now')
			},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}),
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [],
		},
	})
	try {
		const {id} = await call('machines.create', {...createSpec, name: 'Quiet', osId: 'testos-amd64'})
		const running = await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		assert.equal(running.state, 'running')
		const settled = await until(async () => {
			const seen = pings
			await new Promise((r) => setTimeout(r, 40))
			return pings === seen && pings > 1 ? pings : null
		}, 2000)
		assert.equal(settled > 1, true)
		assert.deepEqual(pairCalls, [])
		assert.deepEqual(execs, [])
		const tasks = await call('machines.tasks')
		assert.equal(tasks.some((row) => row.machineId === id && row.type === 'connector' && row.status === 'running'), false)
		const failed = tasks.find((row) => row.machineId === id && row.type === 'connector')
		assert.equal(failed?.status, 'error')
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating testos-amd64 shows a running connector task while the guest agent is down', async () => {
	const {root, call} = await openCreate({
		connectorAgentWaitMs: 800,
		qemuAgent: () => ({
			ping: async () => {
				throw new Error('Guest agent not available for now')
			},
			exec: async () => ({pid: 42}),
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}),
		connector: {pair: async () => fakePair(), list: async () => []},
	})
	try {
		const {id} = await call('machines.create', {...createSpec, name: 'Trying', osId: 'testos-amd64'})
		const trying = await until(async () => {
			const tasks = await call('machines.tasks')
			return tasks.find((row) => row.machineId === id && row.type === 'connector' && row.status === 'running') ?? null
		})
		assert.equal(trying?.type, 'connector')
		assert.equal(trying?.status, 'running')
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating testos-amd64 records a connector error when install fails', async () => {
	const execs = []
	const pairCalls = []
	const {root, call} = await openCreate({
		connectorAgentWaitMs: 200,
		connectorEnrollTimeoutMs: 80,
		qemuAgent: () => ({
			ping: async () => {},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: execs.length}
			},
			status: async (pid) => {
				const cmd = execs[pid - 1]
				if (cmd?.path === 'loginctl') return {exited: true, exitcode: 1, out: '', err: 'Linger failed'}
				return {exited: true, exitcode: 0, out: '', err: ''}
			},
		}),
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [],
		},
	})
	try {
		const {id} = await call('machines.create', {...createSpec, name: 'FailPrep', osId: 'testos-amd64'})
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		const failed = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.machineId === id && row.type === 'connector' && row.status !== 'running')
			return t ?? null
		}, 3000)
		assert.equal(failed?.status, 'error')
		assert.match(String(failed?.message ?? ''), /couldn’t prepare|didn’t join|guest agent/i)
		assert.deepEqual(pairCalls, [])
		const running = (await call('machines.list')).find((x) => x.id === id)
		assert.equal(running.state, 'running')
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating testos-amd64 waits until the guest account exists', async () => {
	const execs = []
	const pairCalls = []
	let readyTries = 0
	let id
	const {root, call} = await openCreate({
		connectorAgentWaitMs: 800,
		qemuAgent: () => ({
			ping: async () => {},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: execs.length}
			},
			status: async (pid) => {
				const cmd = execs[pid - 1]
				const text = [cmd?.path, ...(cmd?.args ?? [])].join(' ')
				if (text.includes('/run/archiso') || /\bid chris\b/.test(text)) {
					readyTries++
					return {exited: true, exitcode: readyTries >= 3 ? 0 : 1, out: '', err: ''}
				}
				return {exited: true, exitcode: 0, out: '', err: ''}
			},
		}),
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => (id && pairCalls.length ? [{guestOf: id}] : []),
		},
	})
	try {
		;({id} = await call('machines.create', {...createSpec, name: 'LateUser', osId: 'testos-amd64'}))
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.machineId === id && row.type === 'connector')
			return t?.status === 'ok' ? t : null
		}, 3000)
		assert.equal(done?.status, 'ok')
		assert.equal(readyTries >= 3, true)
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating a guest that already enrolled does not mint another token', async () => {
	const execs = []
	const pairCalls = []
	let id
	const {root, call} = await openCreate({
		qemuAgent: () => ({
			ping: async () => {},
			exec: async (cmd) => {
				execs.push(cmd)
				return {pid: 42}
			},
			status: async () => ({exited: true, exitcode: 0, out: '', err: ''}),
		}),
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => (id ? [{guestOf: id}] : []),
		},
	})
	try {
		;({id} = await call('machines.create', {...createSpec, name: 'Joined', osId: 'testos-amd64'}))
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		await new Promise((r) => setTimeout(r, 150))
		assert.deepEqual(pairCalls, [])
		assert.deepEqual(execs, [])
		const tasks = await call('machines.tasks')
		assert.equal(tasks.some((row) => row.machineId === id && row.type === 'connector'), false)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('creating an alpine guest starts a connector install through OpenRC', async () => {
	const agent = fakeAgent()
	const pairCalls = []
	let id
	const {root, call, run} = await openCreate({
		images: [ALPINE_IMAGE],
		qemuAgent: agent.qemuAgent,
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => (id && agent.execs.length ? [{guestOf: id}] : []),
		},
	})
	try {
		;({id} = await call('machines.create', {...createSpec, name: 'Alpine', osId: 'alpine-3.24.1-amd64'}))
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		const done = await until(async () => {
			const tasks = await call('machines.tasks')
			const t = tasks.find((row) => row.machineId === id && row.type === 'connector')
			return t?.status === 'ok' ? t : null
		})
		assert.equal(done?.type, 'connector')
		assert.equal(pairCalls.length, 1)
		assert.equal(pairCalls[0].machineId, id)
		assert.equal(agent.pingCount() >= 1, true)
		assert.equal(agent.execs.some((cmd) => cmd.path === 'loginctl'), false)
		const enroll = agent.execs.find((cmd) => {
			const text = [cmd.path, ...(cmd.args ?? [])].join(' ')
			return text.includes('runuser') && text.includes('--user-enroll-only')
		})
		assert.ok(enroll, 'enrolls as the guest user')
		const text = [enroll.path, ...(enroll.args ?? [])].join(' ')
		assert.match(text, /\/etc\/init\.d\/omarchy-connector/)
		assert.match(run.userData, /qemu-guest-agent/)
		assert.match(run.userData, /python3/)
		assert.match(run.userData, /bash/)
		assert.match(run.userData, /rc-update/)
		assert.doesNotMatch(run.userData, /loginctl/)
		assert.doesNotMatch(run.userData, /systemctl/)
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
	}
})

test('a Windows create does not install the connector', async () => {
	const pairCalls = []
	const rootHome = await mkdtemp(join(os.tmpdir(), 'guest-install-win-home-'))
	const home = join(rootHome, 'Home')
	await mkdir(join(home, 'Downloads'), {recursive: true})
	await writeFile(join(home, 'Downloads', 'Win11_25H2_English_x64.iso'), 'win')
	const {root, call, run} = await openCreate({
		images: [],
		connector: {
			pair: async (input) => {
				pairCalls.push(input)
				return fakePair()
			},
			list: async () => [],
		},
		qemuAgent: () => ({
			ping: async () => {
				throw new Error('Guest agent not available for now')
			},
			exec: async () => {
				throw new Error('exec must not run')
			},
		}),
		files: {
			resolve: async (p) => ({real: join(home, String(p).replace(/^\/Home\/?/, ''))}),
		},
	})
	try {
		const isos = await call('machines.localIsos')
		const win = isos.find((i) => /Win11/.test(i.id))
		assert.ok(win, 'the Windows ISO is offered')
		const {id} = await call('machines.create', {...createSpec, name: 'Win', osId: win.id, diskSizeGb: 64})
		await until(async () => (await call('machines.list')).find((x) => x.id === id && x.state === 'running'))
		assert.equal(pairCalls.length, 0)
		assert.doesNotMatch(run.unattend, /install\.ps1/)
		assert.doesNotMatch(run.unattend, /powershell/i)
		assert.doesNotMatch(run.unattend, /FirstLogonCommands/)
		assert.doesNotMatch(run.unattend, /SkipCertificateCheck/)
		assert.ok(!run.unattend.includes('hunter2'), 'password is not plaintext in the answer file')
	} finally {
		await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})
		await rm(rootHome, {recursive: true, force: true})
	}
})

