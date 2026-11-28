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

async function waitUntil(fn, ms = 2000) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		if (await fn()) return
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error('timed out')
}

async function readyHarness(calls, {fail} = {}) {
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-create-'))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	const other = arch === 'arm64' ? 'amd64' : 'arm64'
	const catalog = {version: 1, images: [
		{id: 'debian-12', familyId: 'debian', name: 'Debian', version: '12', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', sha256: 'ab'.repeat(32), sizeMb: 1, adminGroup: 'sudo'},
		{id: 'debian-12-other', familyId: 'debian', name: 'Debian', version: '12', arch: other, kind: 'cloud', url: 'https://example.test/os-other.qcow2', sha256: 'cd'.repeat(32), sizeMb: 1, adminGroup: 'sudo'},
	]}
	const seen = []
	const machines = createMachines({
		dataDir: join(root, 'data'),
		catalogUrl: 'https://example.test/catalog.json',
		fetchImpl: async () => ({ok: true, json: async () => catalog}),
		run: async (cmd, args) => {
			seen.push([cmd, ...(args ?? [])])
			if (cmd === 'openssl') return '$6$salt$hash\n'
			if (cmd === 'qemu-img' && args?.[0] === '--version') return 'qemu-img version 9\n'
			if (cmd === 'virsh' && args?.[0] === '--version') {
				if (fail === 'virsh-version') throw new Error('virsh missing')
				return '10.0.0\n'
			}
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
	const seedText = JSON.stringify(seed.args)
	assert.match(seedText, /qemu-guest-agent/)
	assert.match(seedText, /python3/)
	assert.match(seed.args.files['user-data'], /\["loginctl","enable-linger","chris"\]/)
	assert.equal(seedText.includes('install.sh'), false)
	assert.equal(seedText.includes('--token'), false)
	assert.equal(seedText.includes('hunter2'), false)
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
	assert.ok(seen.some((c) => c[0] === 'virsh' && c[1] === '--version'))
})

test('local create still throws when virsh --version fails', async () => {
	const calls = []
	const {machines} = await readyHarness(calls, {fail: 'virsh-version'})
	await assert.rejects(
		machines.procedures['machines.create'].run({hostId: 'server', name: 'Here', osId: 'debian-12', cores: 1, memoryGb: 1, diskSizeGb: 8, username: 'chris', password: 'hunter2'}, {auth: {role: 'member'}}),
		(e) => e.code === 'PRECONDITION_FAILED' && /libvirt and QEMU/.test(e.message),
	)
	assert.equal(calls.some((c) => String(c.name).startsWith('vm-')), false)
})

test('osImages returns both catalog architectures and the form keeps the host’s', async () => {
	const {machines, arch} = await readyHarness([])
	const images = await machines.procedures['machines.osImages'].run()
	const other = arch === 'arm64' ? 'amd64' : 'arm64'
	assert.ok(images.some((i) => i.id === 'debian-12' && i.arch === arch))
	assert.ok(images.some((i) => i.id === 'debian-12-other' && i.arch === other))
	const form = await readFile(new URL('../web/src/CreateMachine.tsx', import.meta.url), 'utf8')
	assert.match(form, /i\.arch === hostArch/)
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

test('remote list reads running from the host', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	const rows = await machines.procedures['machines.list'].run()
	assert.equal(rows.find((m) => m.id === 'abcd1234').state, 'running')
	assert.ok(calls.some((c) => c.name === 'vm-state'))
})

test('remote define keeps linkDown', async () => {
	const calls = []
	const {machines} = await readyWithBox(calls)
	await machines.procedures['machines.updateHardware'].run({id: 'abcd1234', linkDown: true}, {auth: {role: 'owner'}})
	const spec = calls.find((c) => c.name === 'vm-define')?.args?.spec
	assert.equal(spec.linkDown, true)
})

test('port forwards conflict only on the same host', async () => {
	const calls = []
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-ports-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	const same = {...box, id: 'bbbb2222', name: 'Same', mac: '52:54:00:11:22:44', portForwards: [{id: 'p1', protocol: 'tcp', hostPort: 40023, guestPort: 22}]}
	const other = {...box, id: 'cccc3333', name: 'Other', hostId: 'def456def456', mac: '52:54:00:11:22:55', portForwards: [{id: 'p2', protocol: 'tcp', hostPort: 40022, guestPort: 22}]}
	const here = {...box, id: 'dddd4444', name: 'Here', hostId: 'server', mac: '52:54:00:11:22:66', portForwards: [{id: 'p3', protocol: 'tcp', hostPort: 40022, guestPort: 22}]}
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [box, same, other, here]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: true, allowed: {vms: true}, on: {vms: true}}],
			progress: () => null,
			call: async (id, name, args) => {
				calls.push({id, name, args})
				if (name === 'vm-state') return {}
				if (name === 'vm-status') return {libvirt: true, kvm: true, arch: 'amd64', threads: 4, memoryMb: 8192, freeGb: 40, videoModels: ['vga']}
				return 'ok'
			},
		},
	})
	await machines.ready
	const auth = {auth: {role: 'owner'}}
	await machines.procedures['machines.updateSettings'].run({id: 'abcd1234', portForwards: [{protocol: 'tcp', hostPort: 40022, guestPort: 22}]}, auth)
	await assert.rejects(
		machines.procedures['machines.updateSettings'].run({id: 'abcd1234', portForwards: [{protocol: 'tcp', hostPort: 40023, guestPort: 22}]}, auth),
		(e) => e.code === 'CONFLICT' && /already forwarded/.test(e.message),
	)
	await rm(root, {recursive: true, force: true})
})

test('a host coming online starts its onBoot guests and treats already active as success', async () => {
	const calls = []
	const root = await mkdtemp(join(os.tmpdir(), 'swarm-boot-'))
	const data = join(root, 'data')
	await mkdir(join(data, 'machines'), {recursive: true})
	const boot = {...box, options: {...box.options, onBoot: true}}
	const quiet = {...box, id: 'bbbb2222', name: 'Quiet', mac: '52:54:00:11:22:44', options: {agent: true}}
	await writeFile(join(data, 'machines', 'machines.json'), JSON.stringify({machines: [boot, quiet]}))
	const machines = createMachines({
		dataDir: data,
		run: async () => { throw new Error('local virsh') },
		kvmDevice: join(root, 'no-kvm'),
		isOwner: (ctx) => ctx?.auth?.role === 'owner',
		connector: {
			pair: async () => { throw new Error('no pair') },
			list: async () => [{id: 'abc123abc123', name: 'PC', online: true, allowed: {vms: true}, on: {vms: true}}],
			progress: () => null,
			call: async (id, name, args) => {
				calls.push({id, name, args})
				if (name === 'vm-start') throw new Error('Domain is already active')
				return 'ok'
			},
		},
	})
	await machines.ready
	await machines.bootRemote('abc123abc123')
	assert.deepEqual(calls.filter((c) => c.name === 'vm-start').map((c) => c.args.guestId), ['abcd1234'])
	await machines.bootRemote('server')
	assert.equal(calls.filter((c) => c.name === 'vm-start').length, 1)
	const text = await readFile(new URL('../omarchyd/connector.mjs', import.meta.url), 'utf8')
	assert.match(text, /onOnline\(a\.id\)/)
	const server = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	assert.match(server, /onOnline: \(id\) => machines\.bootRemote\(id\)/)
	await rm(root, {recursive: true, force: true})
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
