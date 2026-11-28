import assert from 'node:assert/strict'
import {copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createFiles} from '../omarchyd/files.mjs'
import {inspectDiskImage} from '../omarchyd/machine-disk-image.mjs'
import {createMachines} from '../omarchyd/machines.mjs'
import {openAccounts} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'
import {ALLOWED} from '../server/app.mjs'

function qcowHeader({backing = false, external = false, encrypted = false} = {}) {
	const bytes = Buffer.alloc(512)
	bytes.writeUInt32BE(0x514649fb, 0)
	bytes.writeUInt32BE(3, 4)
	if (backing) bytes.writeBigUInt64BE(104n, 8)
	if (external) bytes.writeBigUInt64BE(4n, 72)
	if (encrypted) bytes.writeUInt32BE(1, 32)
	return bytes
}

async function setup(t, {failConvert = false, owner = true} = {}) {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'modc-disk-import-')))
	t.after(() => rm(root, {recursive: true, force: true}))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home)
	const raw = join(home, 'reefy.raw')
	await writeFile(raw, Buffer.alloc(1024, 7))
	await writeFile(join(home, 'standalone.qcow2'), qcowHeader())
	const calls = []
	const run = async (cmd, args) => {
		calls.push([cmd, args])
		if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: args.includes('-f') ? args[args.indexOf('-f') + 1] : 'qcow2', 'virtual-size': 1024 ** 3})
		if (cmd === 'qemu-img' && args[0] === 'convert') {
			await copyFile(args.at(-2), args.at(-1))
			if (failConvert) throw new Error('conversion interrupted')
		}
		const a = args[0] === '-c' ? args.slice(2) : args
		if (cmd === 'virsh' && a[0] === 'domuuid') throw new Error('not defined')
		if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
		return ''
	}
	const files = createFiles({home, dataDir})
	const machines = createMachines({dataDir, files, run, isOwner: () => owner})
	await machines.ready
	const call = (name, input) => machines.procedures[`machines.${name}`].run(input, {})
	return {root, home, dataDir, raw, run, calls, machines, call}
}

async function finished(machines, id) {
	for (let n = 0; n < 200; n++) {
		const state = machines.importState(id)
		if (state.done) return state
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error('import timed out')
}

const input = {path: '/Home/reefy.raw', name: 'Reefy', firmware: 'efi', cores: 1, memoryGb: 1, diskSizeGb: 32}

test('local RAW import preserves the source, grows a private copy, and creates a stopped UEFI machine without a seed', async (t) => {
	const s = await setup(t)
	const before = await readFile(s.raw)
	const {id} = await s.call('importDiskImage', input)
	assert.equal((await finished(s.machines, id)).error, null)
	assert.deepEqual(await readFile(s.raw), before)
	const saved = JSON.parse(await readFile(join(s.dataDir, 'machines/machines.json'))).machines[0]
	assert.equal(saved.layout.firmware, 'efi')
	assert.equal(saved.layout.disks.length, 1)
	assert.equal(saved.diskSizeGb, 32)
	assert.equal(saved.options.agent, false)
	assert.equal(saved.cloudInit, undefined)
	assert.ok(s.calls.some(([cmd, args]) => cmd === 'qemu-img' && args[0] === 'resize' && args.at(-1) === '32G'))
	assert.ok(!s.calls.some(([cmd, args]) => cmd === 'virsh' && args.includes('start')))
	assert.deepEqual(await readdir(join(s.dataDir, 'machines/vms', id)), ['disk.qcow2', 'domain.xml'])
})

test('standalone QCOW2 imports with BIOS and is found alongside RAW files', async (t) => {
	const s = await setup(t)
	assert.deepEqual((await s.call('localDiskImages')).map((x) => x.name), ['reefy.raw', 'standalone.qcow2'])
	const {id} = await s.call('importDiskImage', {...input, path: '/Home/standalone.qcow2', firmware: 'bios'})
	assert.equal((await finished(s.machines, id)).error, null)
})

test('QCOW2 backing, encryption and external data are refused before QEMU opens them', async (t) => {
	const s = await setup(t)
	for (const option of ['backing', 'external', 'encrypted']) {
		const path = join(s.home, `${option}.qcow2`)
		await writeFile(path, qcowHeader({[option]: true}))
		const count = s.calls.length
		await assert.rejects(inspectDiskImage(path, s.run), /not supported/)
		assert.equal(s.calls.length, count)
	}
})

test('refuses outside paths, hidden files, escaping symlinks, directories and format mismatches', async (t) => {
	const s = await setup(t)
	await writeFile(join(s.root, 'outside.raw'), Buffer.alloc(512))
	await symlink(join(s.root, 'outside.raw'), join(s.home, 'escape.raw'))
	await writeFile(join(s.home, 'wrong.raw'), qcowHeader())
	await mkdir(join(s.home, 'folder.raw'))
	for (const path of ['/etc/passwd', '/Home/../outside.raw', '/Home/.hidden.raw', '/Home/escape.raw', '/Home/wrong.raw', '/Home/folder.raw']) await assert.rejects(s.call('inspectDiskImage', {path}))
})

test('validates capacity, firmware, remote targets and names before creating a machine', async (t) => {
	const s = await setup(t)
	for (const patch of [{diskSizeGb: 0}, {diskSizeGb: 4097}, {firmware: 'other'}, {cores: 0}, {memoryGb: 0}, {name: ''}, {hostId: 'remote'}]) await assert.rejects(s.call('importDiskImage', {...input, ...patch}))
	assert.deepEqual(await readdir(join(s.dataDir, 'machines/vms')), [])
})

test('members cannot import a local image', async (t) => {
	const s = await setup(t, {owner: false})
	await assert.rejects(s.call('importDiskImage', input), (e) => e.code === 'FORBIDDEN')
})

test('failed conversion removes incomplete output and preserves the source', async (t) => {
	const s = await setup(t, {failConvert: true})
	const before = await readFile(s.raw)
	const {id} = await s.call('importDiskImage', input)
	assert.match((await finished(s.machines, id)).error, /conversion interrupted/)
	assert.deepEqual(await readFile(s.raw), before)
	assert.deepEqual(await readdir(join(s.dataDir, 'machines/vms')), [])
})

test('concurrent imports cannot create duplicate names', async (t) => {
	const s = await setup(t)
	const results = await Promise.allSettled([s.call('importDiskImage', input), s.call('importDiskImage', input)])
	assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1)
	const result = results.find((x) => x.status === 'fulfilled')
	await finished(s.machines, result.value.id)
})

test('disk import routes are exposed through the web proxy and enforce authentication and owner permissions', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'modc-disk-auth-')))
	t.after(() => rm(root, {recursive: true, force: true}))
	const home = join(root, 'home')
	const dataDir = join(root, 'data')
	await mkdir(home)
	const accounts = await openAccounts(dataDir)
	await accounts.createOwner({name: 'Member', password: 'fixture-password'})
	const accountPath = join(dataDir, 'accounts.json')
	const state = JSON.parse(await readFile(accountPath, 'utf8'))
	state.users[0].role = 'member'
	await writeFile(accountPath, JSON.stringify(state))
	const backend = await startOmarchyd({port: 0, home, dataDir, machineOptions: {run: async () => ''}})
	t.after(() => backend.close())
	const login = await fetch(`${backend.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'fixture-password', client: {id: 'test'}})}).then((r) => r.json())
	const token = login.result.data.accessToken
	for (const [route, kind] of [['machines.localDiskImages', 'query'], ['machines.inspectDiskImage', 'query'], ['machines.importDiskImage', 'mutation']]) {
		assert.equal(ALLOWED[route], kind)
		const options = kind === 'query' ? {} : {method: 'POST', body: '{}', headers: {'content-type': 'application/json'}}
		const url = `${backend.url}/trpc/${route}`
		assert.equal((await fetch(url, options)).status, 401)
		assert.equal((await fetch(url, {...options, headers: {...options.headers, authorization: `Bearer ${token}`}})).status, 403)
	}
})
