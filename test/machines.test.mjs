// omarchyd machines: catalog, verified downloads, cloud-init seed, libvirt calls, port forwards and
// the VNC console bridge. libvirt, qemu-img and xorriso are simulated; openssl is real.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import WebSocket from 'ws'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {cloudUserData, isWindowsClientLabel, omarchyConfiguration, windowsAnswerFile} from '../omarchyd/machine-media.mjs'
import {backupProgress, createMachines, findChecksum} from '../omarchyd/machines.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

test('catalog: reads a local file:// catalog without GitHub', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-cat-'))
	after(() => rm(root, {recursive: true, force: true}))
	const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [{id: 'local-os', familyId: 'debian', name: 'LocalOS', version: '1', arch, kind: 'cloud', url: 'https://example.test/os.qcow2', checksums: {url: 'https://example.test/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	let fetched = 0
	const m = createMachines({
		dataDir: join(root, 'data'),
		catalogUrl: `file://${catalog}`,
		fetchImpl: async () => {
			fetched++
			return new Response('', {status: 503})
		},
		run: async () => '',
		kvmDevice: join(root, 'kvm'),
	})
	await m.ready
	const images = await m.procedures['machines.osImages'].run()
	assert.equal(fetched, 0, 'must not call GitHub')
	assert.equal(images.length, 1)
	assert.equal(images[0].id, 'local-os')
	assert.equal(images[0].name, 'LocalOS')
})

test('findChecksum reads GNU and BSD checksum lists', () => {
	const h = 'a'.repeat(64)
	assert.equal(findChecksum(`${'b'.repeat(64)}  other.img\n${h} *disk.img\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`SHA256 (disk.img) = ${h}\n`, 'disk.img', 'sha256'), h)
	assert.equal(findChecksum(`${h}  disk.img\n`, 'disk.img', 'sha512'), null) // wrong length for sha512
	assert.equal(findChecksum(`${h}  disk.img.part\n`, 'disk.img', 'sha256'), null)
})

test('install media: desktop cloud-init, Omarchy disk layout, Windows answer file', () => {
	const ud = cloudUserData({host: 'box', username: 'chris', hash: '$6$x', cloudInit: {packages: ['ubuntu-desktop-minimal', 'bad;rm -rf /'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true}})
	assert.match(ud, /packages:\n  - 'ubuntu-desktop-minimal'\n/)
	assert.ok(!ud.includes('rm -rf'), 'unsafe package names dropped')
	assert.match(ud, /runcmd:\n  - \["systemctl","set-default","graphical.target"\]/)
	assert.match(ud, /power_state:\n  mode: reboot/)
	const cfg = omarchyConfiguration({host: 'om', diskSizeGb: 40})
	const parts = cfg.disk_config.device_modifications[0].partitions
	assert.equal(cfg.disk_config.device_modifications[0].device, '/dev/vda')
	assert.equal(parts[0].start.value + parts[0].size.value + parts[1].size.value + 1024 ** 2, 40 * 1024 ** 3)
	assert.equal(isWindowsClientLabel('CCCOMA_X64FRE_EN-US_DV9'), true)
	assert.equal(isWindowsClientLabel('ARCH_202611'), false)
	const xml = windowsAnswerFile({computerName: 'MY-PC & stuff', username: 'chris', password: 'hunter2 secret'})
	assert.ok(!xml.includes('hunter2'), 'password not in plain text')
	assert.match(xml, /<ComputerName>MY-PCstuff<\/ComputerName>/)
	assert.match(xml, /BypassTPMCheck/)
	assert.match(xml, /<Name>chris<\/Name>/)
	assert.equal(Buffer.from(/<Value>([^<]+)<\/Value>/.exec(xml)[1], 'base64').toString('utf16le'), 'hunter2 secretPassword')
})

test('backup progress converts the units virsh prints before dividing', () => {
	const job = (done, total) => `Job type:         Unbounded   \nOperation:        Backup\nData processed:   ${done}\nData remaining:   1.000 GiB\nData total:       ${total}\n`
	assert.equal(backupProgress(job('300.000 MiB', '4.000 GiB')), 7)
	assert.equal(backupProgress(job('1.000 GiB', '4.000 GiB')), 23)
	assert.equal(backupProgress(job('2.000 GiB', '2.000 GiB')), 90)
	assert.equal(backupProgress(job('0.000 B', '2.000 GiB')), 0)
	assert.equal(backupProgress('Job type:         None\n'), null)
})

describe('omarchyd machines', () => {
	let root, data, d, fixture, fixtureUrl, auth
	const doms = new Map()
	const seen = {userData: '', xml: '', media: {}, calls: []}
	const image = randomBytes(256 * 1024)

	const run = async (cmd, args, opts = {}) => {
		if (cmd === 'virsh' || cmd === 'qemu-img') seen.calls.push([cmd, ...(args[0] === '-c' ? args.slice(2) : args)].join(' '))
		if (cmd === 'virsh') {
			const a = args[0] === '-c' ? args.slice(2) : args
			switch (a[0]) {
				case 'suspend':
					doms.set(a[1], 'paused')
					return ''
				case 'resume':
					doms.set(a[1], 'running')
					return ''
				case 'managedsave':
					doms.set(a[1], 'shut off')
					return ''
				case 'managedsave-remove':
					return ''
				case 'blockresize':
				case 'change-media':
				case 'domstats':
				case 'domifaddr':
					return ''
				case 'version':
					return 'Compiled against library: libvirt 10.0.0\nUsing library: libvirt 10.0.0\nUsing API: QEMU 10.0.0\nRunning hypervisor: QEMU 9.0.0\n'
				case 'qemu-monitor-command':
					return `VM status: running (${a.at(-1)})\n`
				case 'backup-begin': {
					const bx = await readFile(a[3], 'utf8')
					for (const [, f] of bx.matchAll(/<target file='([^']+)'/g)) await writeFile(f, 'live-copy')
					return 'Backup started\n'
				}
				case 'domjobinfo':
					return a.includes('--completed') ? 'Job type:         Completed\n' : 'Job type:         None\n'
				case '--version':
					return '10.0.0\n'
				case 'list':
					if (seen.failList) throw new Error('virsh list: error: failed to connect to the hypervisor')
					return ` Id   Name   State\n------------------\n${[...doms].map(([n, s]) => ` -    ${n}   ${s}`).join('\n')}\n`
				case 'domuuid':
					throw new Error(`virsh domuuid: error: failed to get domain '${a[1]}'`)
				case 'define': {
					if (seen.failDefine) throw new Error("virsh define: error: unsupported configuration: domain configuration does not support video model 'virtio'")
					seen.xml = await readFile(a[1], 'utf8')
					const name = /<name>(.+?)<\/name>/.exec(seen.xml)[1]
					if (!doms.has(name)) doms.set(name, 'shut off')
					return ''
				}
				case 'start':
					doms.set(a[1], 'running')
					return ''
				case 'shutdown':
					doms.set(a[1], 'shut off')
					return ''
				case 'destroy':
					if (seen.failDestroy) throw new Error('virsh destroy: error: Failed to terminate domain')
					doms.set(a[1], 'shut off')
					return ''
				case 'reboot':
					return ''
				case 'undefine':
					if (seen.failUndefine) throw new Error('virsh undefine: error: Failed to undefine domain')
					doms.delete(a[1])
					return ''
			}
			throw new Error(`virsh ${a[0]} not simulated`)
		}
		if (cmd === 'qemu-img') {
			if (args[0] === 'info' && seen.virtualGb) return JSON.stringify({format: 'qcow2', 'virtual-size': seen.virtualGb * 1024 ** 3, 'actual-size': 4096})
			if (args[0] === 'convert') await copyFile(args.at(-2), args.at(-1))
			if (args[0] === 'create') await writeFile(args[3], 'blank')
			return 'qemu-img version 9.0\n'
		}
		if (cmd === 'xorriso') {
			if (args.includes('-pvd_info')) return `Volume Id    : ${/Win11/.test(args[1]) ? 'CCCOMA_X64FRE_EN-US_DV9' : 'ARCH_202611'}\n`
			for (const f of args.slice(args.indexOf('-rock') + 1)) seen.media[f] = await readFile(join(opts.cwd, f), 'utf8')
			seen.userData = seen.media['user-data'] ?? seen.userData
			await writeFile(args[args.indexOf('-output') + 1], 'iso')
			return ''
		}
		if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
		throw new Error(`${cmd} not simulated`)
	}

	before(async () => {
		root = await mkdtemp('/tmp/om-m-')
		data = join(root, 'data')
		const sum = createHash('sha256').update(image).digest('hex')
		fixture = http.createServer((req, res) => {
			const files = {
				'/catalog.json': JSON.stringify({
					version: 1,
					images: [
						{id: 'testos-amd64', familyId: 'debian', name: 'TestOS', variantName: 'Server', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://fixture.test/img/test.qcow2', checksums: {url: 'https://fixture.test/img/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1, adminGroup: 'sudo', cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true}},
						{id: 'bados-amd64', familyId: 'debian', name: 'BadOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://fixture.test/img/bad.qcow2', checksums: {url: 'https://fixture.test/img/SHA256SUMS', algorithm: 'sha256'}, sizeMb: 1},
						{id: 'omarchy-9-amd64', familyId: 'omarchy', name: 'Omarchy', version: '9', arch: 'amd64', kind: 'iso', install: 'omarchy', url: 'https://fixture.test/img/omarchy.iso', sha256: createHash('sha256').update(image).digest('hex'), sizeMb: 1},
						{id: 'insecure', name: 'Plain HTTP', version: '1', arch: 'amd64', kind: 'cloud', url: 'http://fixture.test/x.img', checksums: {url: 'https://fixture.test/s', algorithm: 'sha256'}},
					],
				}),
				'/img/test.qcow2': image,
				'/img/omarchy.iso': image,
				'/img/bad.qcow2': randomBytes(1000),
				'/img/SHA256SUMS': `${sum} *test.qcow2\n${'0'.repeat(64)} *bad.qcow2\n`,
			}
			const body = files[req.url]
			if (body === undefined) return res.writeHead(404).end()
			res.writeHead(200, {'content-length': Buffer.byteLength(body)}).end(body)
		})
		await new Promise((r) => fixture.listen(0, '127.0.0.1', r))
		fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
		await mkdir(join(root, 'home/Downloads'), {recursive: true})
		await writeFile(join(root, 'home/Downloads/Win11_25H2_English_x64.iso'), 'win')
		await writeFile(join(root, 'home/Downloads/archlinux.iso'), 'arch')
		const kvm = join(root, 'kvm')
		await writeFile(kvm, '')
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home: join(root, 'home'),
			machineOptions: {run, kvmDevice: kvm, catalogUrl: 'https://fixture.test/catalog.json', fetchImpl: (u, init) => fetch(String(u).replace('https://fixture.test', fixtureUrl), init)},
		})
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 't'}})})).json()
		auth = {authorization: `Bearer ${login.result.data.accessToken}`}
	})
	after(async () => {
		await d?.close()
		fixture?.close()
		if (root) await rm(root, {recursive: true, force: true})
	})
	const call = async (path, input, kind = 'mutation') => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...auth}}
		if (kind === 'mutation') Object.assign(init.headers, {'content-type': 'application/json'}), (init.body = JSON.stringify(input ?? null))
		else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		const body = await r.json()
		if (body.error) {
			const e = new Error(body.error.message)
			e.status = r.status
			throw e
		}
		return body.result.data
	}
	const q = (path, input) => call(path, input, 'query')
	const until = async (fn, ms = 5000) => {
		const end = Date.now() + ms
		for (;;) {
			const v = await fn()
			if (v) return v
			if (Date.now() > end) throw new Error('timed out')
			await new Promise((r) => setTimeout(r, 50))
		}
	}
	const spec = {cores: 1, memoryGb: 1, diskSizeGb: 10, arch: 'amd64', username: 'chris', password: 'hunter2 secret'}
	let id

	test('capabilities and catalog (plain-HTTP entries are dropped)', async () => {
		const caps = await q('machines.capabilities')
		assert.equal(caps.libvirtAvailable, true)
		assert.equal(caps.kvmAvailable, true)
		const imgs = await q('machines.osImages')
		assert.deepEqual(imgs.map((i) => [i.id, i.state]), [['testos-amd64', 'available'], ['bados-amd64', 'available'], ['omarchy-9-amd64', 'available']])
	})

	test('create: verifies the download, hashes the password, defines and starts the machine', async () => {
		await assert.rejects(call('machines.create', {...spec, name: 'Box', osId: 'testos-amd64', username: 'root'}), /lower-case username/)
		;({id} = await call('machines.create', {...spec, name: 'Box', osId: 'testos-amd64'}))
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === id && x.state === 'running'))
		assert.equal(m.name, 'Box')
		assert.match(seen.userData, /passwd: '\$6\$/)
		assert.ok(!seen.userData.includes('hunter2'), 'plaintext password never written')
		assert.match(seen.xml, /<backend type='passt'\/>/)
		assert.match(seen.xml, /<graphics type='vnc' socket='[^']+vnc\.sock'\/>/)
		assert.match(seen.xml, /<domain type='kvm'>/)
		assert.match(seen.xml, /<channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'\/>/)
		assert.match(seen.userData, /qemu-guest-agent/)
		assert.match(seen.userData, /python3/)
		assert.match(seen.userData, /\["systemctl","enable","--now","qemu-guest-agent"\]/)
		assert.match(seen.userData, /task-gnome-desktop/)
		assert.match(seen.userData, /power_state/)
		assert.ok(!/\b[0-9a-f]{64}\b/.test(seen.userData), 'pairing fingerprint is not written into cloud-init')
		assert.equal((await q('machines.details', {id})).options.agent, true)
		assert.equal((await stat(join(data, 'machines/vms', id, 'disk.qcow2'))).size, image.length)
		assert.equal((await q('machines.osImages'))[0].state, 'downloaded')
		await assert.rejects(call('machines.create', {...spec, name: 'box', osId: 'testos-amd64'}), /already exists/)
	})

	test('create: a checksum mismatch fails and keeps nothing', async () => {
		const {id: bad} = await call('machines.create', {...spec, name: 'Bad', osId: 'bados-amd64'})
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === bad && x.state === 'error'))
		assert.match(m.errorMessage, /checksum/)
		assert.equal((await q('machines.osImages')).find((i) => i.id === 'bados-amd64').state, 'failed')
		await call('machines.uninstall', {id: bad})
	})

	test('port forwards: validated, then written into the definition', async () => {
		await assert.rejects(call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 8080, guestPort: 80}]}), /between 40000/)
		await assert.rejects(call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 42222, guestPort: 22}, {protocol: 'tcp', hostPort: 42222, guestPort: 23}]}), /already forwarded/)
		await call('machines.updateSettings', {id, portForwards: [{protocol: 'tcp', hostPort: 42222, guestPort: 22}]})
		assert.match(seen.xml, /<portForward proto='tcp'><range start='42222' to='22'\/><\/portForward>/)
		assert.equal((await q('machines.list')).find((x) => x.id === id).portForwards[0].hostPort, 42222)
	})

	test('console: a ticket opens the VNC socket once; no ticket, no screen', async () => {
		const sockPath = join(data, 'machines/vms', id, 'vnc.sock')
		const vnc = net.createServer((s) => {
			s.write('RFB 003.008\n')
			s.on('data', (x) => s.write(x))
		})
		try {
			await new Promise((resolve, reject) => {
				vnc.once('error', reject)
				vnc.listen(sockPath, () => {
					vnc.off('error', reject)
					resolve()
				})
			})
			const wsUrl = `${d.url.replace('http', 'ws')}/machines/console?machineId=${id}`
			const refused = new WebSocket(`${wsUrl}&ticket=nope`, ['binary'])
			await new Promise((r) => refused.on('error', r))
			const termTicket = await call('user.createWebSocketTicket', {target: 'terminal'})
			const wrongKind = new WebSocket(`${wsUrl}&ticket=${termTicket}`, ['binary'])
			await new Promise((r) => wrongKind.on('error', r)) // a terminal ticket can't open a screen
			const ticket = await call('user.createWebSocketTicket', {target: 'machines'})
			const ws = new WebSocket(`${wsUrl}&ticket=${ticket}`, ['binary'])
			const first = await new Promise((r, j) => (ws.once('message', (m) => r(m.toString())), ws.once('error', j)))
			assert.equal(first, 'RFB 003.008\n')
			ws.send(Buffer.from('ping'))
			assert.equal(await new Promise((r) => ws.once('message', (m) => r(m.toString()))), 'ping')
			ws.close()
			const reused = new WebSocket(`${wsUrl}&ticket=${ticket}`, ['binary'])
			await new Promise((r) => reused.on('error', r))
		} finally {
			vnc.close()
		}
	})

	test('Omarchy installs itself from its ISO with a cidata drive (hash only)', async () => {
		const {id: om} = await call('machines.create', {...spec, name: 'Omarchy', osId: 'omarchy-9-amd64', diskSizeGb: 40})
		await until(async () => (await q('machines.list')).find((x) => x.id === om && x.state === 'running'))
		const creds = JSON.parse(seen.media['user_credentials.json'])
		assert.equal(creds.users[0].username, 'chris')
		assert.match(creds.users[0].enc_password, /^\$6\$/)
		assert.ok(!seen.media['user_credentials.json'].includes('hunter2'))
		const omCfg = JSON.parse(seen.media['user_configuration.json'])
		assert.equal(omCfg.hostname, 'omarchy')
		assert.deepEqual(omCfg.packages, ['qemu-guest-agent'])
		assert.deepEqual(omCfg.services, ['qemu-guest-agent'])
		assert.equal((await q('machines.details', {id: om})).cloudInit.username, 'chris')
		await assert.rejects(call('machines.updateCloudInit', {id: om, username: 'chris', hostname: 'omarchy', password: 'secret'}), /doesn’t use cloud-init/)
		assert.match(seen.xml, /<os firmware='efi'>/)
		assert.match(seen.xml, /omarchy-9-amd64\.iso'\/><target dev='sda' bus='sata'\/><boot order='2'\/>/)
		assert.match(seen.xml, /disk\.qcow2'\/><target dev='vda' bus='virtio'\/><boot order='1'\/>/)
		assert.match(seen.xml, /seed\.iso'\/><target dev='sdb' bus='sata'\/><readonly\/>/)
		await call('machines.uninstall', {id: om})
	})

	test('your own ISOs: Windows installs itself with an answer file that is removed after; others boot to install by hand', async () => {
		const isos = await q('machines.localIsos')
		const win = isos.find((i) => /Win11/.test(i.id))
		const arch = isos.find((i) => /archlinux/.test(i.id))
		assert.deepEqual([win.platform, win.requiresCredentials, win.manualSetup], ['windows', true, false])
		assert.deepEqual([arch.platform, arch.requiresCredentials, arch.manualSetup], ['linux', false, true])
		await assert.rejects(call('machines.create', {...spec, name: 'Win', osId: win.id, diskSizeGb: 40}), /between 64/)
		const {id: w} = await call('machines.create', {...spec, name: 'Win', osId: win.id, diskSizeGb: 64})
		await until(async () => (await q('machines.list')).find((x) => x.id === w && x.state === 'running'))
		assert.match(seen.media['autounattend.xml'], /<Name>chris<\/Name>/)
		assert.match(seen.xml, /<model type='e1000e'\/>/)
		assert.match(seen.xml, /<model type='vga'\/>/)
		assert.match(seen.xml, /disk\.qcow2'\/><target dev='sda' bus='sata'\/><boot order='1'\/>/)
		assert.match(seen.xml, /answer\.iso/)
		await call('machines.forceStop', {id: w})
		assert.ok(!seen.xml.includes('answer.iso'), 'answer file detached')
		await assert.rejects(stat(join(data, 'machines/vms', w, 'answer.iso')))
		await call('machines.uninstall', {id: w})
		const {id: a} = await call('machines.create', {name: 'Arch ISO', osId: arch.id, cores: 1, memoryGb: 1, diskSizeGb: 10})
		await until(async () => (await q('machines.list')).find((x) => x.id === a && x.state === 'running'))
		assert.match(seen.xml, /archlinux\.iso'\/><target dev='sda' bus='sata'\/><boot order='2'\/>/)
		assert.ok(!/seed\.iso|answer\.iso/.test(seen.xml))
		await call('machines.uninstall', {id: a})
	})

	test('a setup that failed at the last step is finished by Start; displays use standard VGA', async () => {
		seen.failDefine = true
		const {id: f} = await call('machines.create', {...spec, name: 'Flaky', osId: 'testos-amd64'})
		const m = await until(async () => (await q('machines.list')).find((x) => x.id === f && x.state === 'error'))
		assert.match(m.errorMessage, /video model/)
		seen.failDefine = false
		await call('machines.start', {id: f})
		await until(async () => (await q('machines.list')).find((x) => x.id === f && x.state === 'running'))
		assert.match(seen.xml, /<video><model type='vga'\/><\/video>/)
		await call('machines.uninstall', {id: f})
	})

	test('details: hardware, drives, boot order and options of a machine', async () => {
		const det = await q('machines.details', {id})
		assert.equal(det.vmid >= 100, true)
		assert.deepEqual([det.hardware.sockets, det.hardware.cores, det.hardware.memoryMb, det.hardware.cpuType, det.hardware.machineType], [1, 1, 1024, 'host', 'q35'])
		assert.deepEqual(det.hardware.disks.map((x) => [x.id, x.device, x.bus, x.target, x.role]), [['disk0', 'disk', 'virtio', 'vda', null], ['seed', 'cdrom', 'sata', 'sda', 'seed']])
		assert.deepEqual(det.boot, ['disk0'])
		assert.equal(det.cloudInit.username, 'chris')
		assert.match(det.hardware.mac, /^52:54:00:/)
		const node = await q('machines.node')
		assert.ok(node.threads >= 1 && node.memoryTotalMb > 0)
		assert.equal(node.libvirtVersion, '10.0.0')
		assert.equal(node.qemuVersion, '9.0.0', 'the QEMU version is the running hypervisor, not the libvirt API line')
		assert.ok(node.videoModels.includes('vga'))
	})

	test('hardware: changes while running are kept for the next start; Restart applies them', async () => {
		await assert.rejects(call('machines.updateHardware', {id, sockets: 1, cores: 9999}), /Sockets × cores/)
		await assert.rejects(call('machines.updateHardware', {id, mac: '01:00:5e:00:00:01'}), /unicast MAC/)
		await call('machines.updateHardware', {id, memoryMb: 1536, cpuType: 'qemu64', nic: 'e1000', linkDown: true, mac: '52:54:00:aa:bb:cc'})
		assert.match(seen.xml, /<memory unit='MiB'>1536<\/memory>/)
		assert.match(seen.xml, /<model fallback='allow'>qemu64<\/model><topology sockets='1' dies='1' cores='1' threads='1'\/>/)
		assert.match(seen.xml, /<mac address='52:54:00:aa:bb:cc'\/><model type='e1000'\/><link state='down'\/>/)
		assert.equal((await q('machines.list')).find((x) => x.id === id).pending, true)
		seen.calls.length = 0
		await call('machines.restart', {id})
		assert.ok(seen.calls.includes(`virsh shutdown omarchy-${id}`) && seen.calls.includes(`virsh start omarchy-${id}`), 'a full stop and start')
		await until(async () => !(await q('machines.list')).find((x) => x.id === id).pending)
		await call('machines.updateHardware', {id, memoryMb: 1024, cpuType: 'host', nic: 'virtio', linkDown: false})
		await call('machines.forceStop', {id})
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
	})

	test('drives: the IDE bus is refused on a q35 machine before anything is saved', async () => {
		const before = (await q('machines.details', {id})).hardware.disks.map((x) => [x.id, x.bus])
		await assert.rejects(call('machines.addDisk', {id, sizeGb: 1, bus: 'ide'}), /IDE is only available on the i440fx/)
		await assert.rejects(call('machines.updateDisk', {id, diskId: 'disk0', bus: 'ide'}), /IDE is only available on the i440fx/)
		assert.deepEqual((await q('machines.details', {id})).hardware.disks.map((x) => [x.id, x.bus]), before)
	})

	test('options: notes, protection, guest agent, boot menu', async () => {
		await call('machines.updateOptions', {id, notes: 'Web <server>', protection: true, agent: true, bootMenu: true, onBoot: true, startupOrder: 2, startupDelay: 10})
		assert.match(seen.xml, /<description>Web &lt;server&gt;<\/description>/)
		assert.equal((await q('machines.list')).find((x) => x.id === id).notes, 'Web <server>', 'the list carries the notes, so the assistant can search them (#1110)')
		assert.match(seen.xml, /org\.qemu\.guest_agent\.0/)
		assert.match(seen.xml, /<bootmenu enable='yes'/)
		await assert.rejects(call('machines.uninstall', {id}), /protected/)
		await assert.rejects(call('machines.updateOptions', {id, name: 'Renamed', startupDelay: 9999}), /Start delay/)
		assert.equal((await q('machines.details', {id})).name, 'Box', 'a rejected request does not rename the machine')
		await call('machines.updateOptions', {id, protection: false, agent: false, bootMenu: false, onBoot: false, notes: ''})
		assert.ok(!seen.xml.includes('guest_agent'))
		assert.equal('notes' in (await q('machines.list')).find((x) => x.id === id), false, 'no notes, no field')
	})

	test('drives: add a SCSI disk, grow it live, CD/DVD media, boot order; removing needs a shut-down machine', async () => {
		const {diskId} = await call('machines.addDisk', {id, sizeGb: 8, bus: 'scsi', cache: 'writeback'})
		assert.equal(diskId, 'disk1')
		assert.match(seen.xml, /<controller type='scsi' model='virtio-scsi'><driver iothread='1'\/><\/controller>/)
		assert.match(seen.xml, /cache='writeback' discard='unmap'\/><source file='[^']+disk1\.qcow2'\/><target dev='sdb' bus='scsi'\/>/)
		await assert.rejects(call('machines.resizeDisk', {id, diskId, sizeGb: 4}), /only grow/)
		await call('machines.resizeDisk', {id, diskId, sizeGb: 16})
		assert.ok(seen.calls.includes(`virsh blockresize omarchy-${id} sdb 16G`))
		await assert.rejects(call('machines.removeDisk', {id, diskId}), /Shut down/)
		await assert.rejects(call('machines.addCdrom', {id}), /Shut down/)
		await call('machines.forceStop', {id})
		const {diskId: cd} = await call('machines.addCdrom', {id})
		const arch = (await q('machines.localIsos')).find((i) => /archlinux/.test(i.id))
		await call('machines.setMedia', {id, diskId: cd, iso: arch.id})
		assert.match(seen.xml, new RegExp(`archlinux\\.iso'/><target dev='sdc' bus='sata'/><readonly/>`))
		await call('machines.setBootOrder', {id, order: [cd, 'disk0', 'net']})
		assert.match(seen.xml, /archlinux\.iso'\/><target dev='sdc' bus='sata'\/><boot order='1'\/>/)
		assert.match(seen.xml, /<boot order='3'\/><\/interface>/)
		await assert.rejects(call('machines.setBootOrder', {id, order: ['nope']}), /boot device/)
		await call('machines.setMedia', {id, diskId: cd, iso: null})
		assert.ok(!seen.xml.includes('archlinux.iso'))
		await call('machines.removeDisk', {id, diskId, deleteFile: true})
		await assert.rejects(stat(join(data, 'machines/vms', id, 'disk1.qcow2')))
		await call('machines.removeDisk', {id, diskId: cd})
		await assert.rejects(call('machines.removeDisk', {id, diskId: 'disk0'}), /only disk/)
		assert.deepEqual((await q('machines.details', {id})).boot, ['disk0', 'net'])
		await call('machines.setBootOrder', {id, order: ['disk0']})
	})

	test('cloud-init: new SSH keys and password (hash only) for the next boot; private keys refused', async () => {
		await assert.rejects(call('machines.updateCloudInit', {id, sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----']}), /private key/)
		const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl chris@laptop'
		await call('machines.updateCloudInit', {id, username: 'chris', hostname: 'web-1', sshKeys: [key], password: 'new secret pw'})
		assert.match(seen.userData, /ssh_authorized_keys:\n {6}- 'ssh-ed25519 AAAAC3/)
		assert.match(seen.userData, /chpasswd:[\s\S]*password: '\$6\$/)
		assert.match(seen.userData, /hostname: web-1/)
		assert.ok(!seen.userData.includes('new secret pw'))
		assert.match(seen.userData, /qemu-guest-agent/)
		assert.match(seen.userData, /python3/)
		assert.ok(!seen.userData.includes('task-gnome-desktop'), 'a later cloud-init edit must not replay catalog desktop packages')
		assert.ok(!seen.userData.includes('power_state'), 'a later cloud-init edit must not replay graphical power_state')
		assert.ok(!seen.userData.includes('enable-linger'), 'a later cloud-init edit must not replay linger')
		assert.deepEqual((await q('machines.details', {id})).cloudInit, {username: 'chris', hostname: 'web-1', sshKeys: [key]})
	})

	test('snapshots: taken, restored and deleted while shut down, with the settings of the moment', async () => {
		await call('machines.start', {id})
		await assert.rejects(call('machines.snapshot', {id, name: 'before'}), /Shut down/)
		await call('machines.forceStop', {id})
		await assert.rejects(call('machines.snapshot', {id, name: 'bad name!'}), /Name the snapshot/)
		await call('machines.snapshot', {id, name: 'before', description: 'clean install'})
		assert.ok(seen.calls.some((c) => /^qemu-img snapshot -c before .+disk\.qcow2$/.test(c)))
		await call('machines.updateHardware', {id, memoryMb: 2048})
		await call('machines.revertSnapshot', {id, name: 'before'})
		assert.ok(seen.calls.some((c) => /^qemu-img snapshot -a before /.test(c)))
		assert.equal((await q('machines.details', {id})).hardware.memoryMb, 1024)
		const before = (await q('machines.list')).find((x) => x.id === id).diskSizeGb
		await call('machines.resizeDisk', {id, diskId: 'disk0', sizeGb: before + 5})
		assert.equal((await q('machines.list')).find((x) => x.id === id).diskSizeGb, before + 5)
		seen.virtualGb = before
		await call('machines.revertSnapshot', {id, name: 'before'})
		seen.virtualGb = undefined
		assert.equal((await q('machines.list')).find((x) => x.id === id).diskSizeGb, before, 'the list shows the size the image has after the rollback')
		await call('machines.deleteSnapshot', {id, name: 'before'})
		assert.deepEqual((await q('machines.details', {id})).snapshots, [])
	})

	test('backups: to Home → Backups → Machines (stopped and live), restored as a new machine; clone', async () => {
		const {backupId} = await call('machines.backup', {id, notes: 'nightly'})
		await until(async () => (await q('machines.backups', {id})).some((b) => b.id === backupId))
		const dir = join(root, 'home/Backups/Machines', backupId)
		assert.equal(await readFile(join(dir, 'disk0.qcow2')).then((b) => b.length), image.length)
		const meta = JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8'))
		assert.equal(meta.machine.name, 'Box')
		assert.equal(meta.machine.tasks, undefined)
		assert.ok(!JSON.stringify(meta).includes('hunter2'))
		const list = await q('machines.backups', {id})
		assert.equal(list[0].id, backupId)
		assert.equal(list[0].notes, 'nightly')
		const {id: restored} = await call('machines.restoreBackup', {backupId})

		const r = await until(async () => (await q('machines.list')).find((x) => x.id === restored && x.state === 'stopped'))
		assert.equal(r.name, 'Box (2)')
		assert.equal((await stat(join(data, 'machines/vms', restored, 'disk.qcow2'))).size, image.length)
		const {id: copy} = await call('machines.clone', {id, name: 'Box clone'})
		await until(async () => (await q('machines.list')).find((x) => x.id === copy && x.state === 'stopped'))
		assert.notEqual((await q('machines.details', {id: copy})).hardware.mac, (await q('machines.details', {id})).hardware.mac)
		// A live backup: QEMU copies the running machine's disks.
		await call('machines.start', {id})
		const {backupId: live} = await call('machines.backup', {id})
		await until(async () => (await q('machines.backups', {id})).some((b) => b.id === live))
		assert.ok(seen.calls.some((c) => c.startsWith(`virsh backup-begin omarchy-${id} --backupxml`)))
		assert.equal(await readFile(join(root, 'home/Backups/Machines', live, 'disk0.qcow2'), 'utf8'), 'live-copy')
		assert.equal((await q('machines.backups', {id})).find((b) => b.id === live).live, true)
		for (const b of [backupId, live]) await call('machines.deleteBackup', {backupId: b})
		assert.deepEqual(await q('machines.backups', {id}), [])
		await call('machines.uninstall', {id: restored})
		await call('machines.uninstall', {id: copy})
	})

	test('pause, resume, hibernate; monitor; task history', async () => {
		await call('machines.pause', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'suspended')
		await call('machines.resume', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		assert.match((await call('machines.monitor', {id, command: 'info status'})).output, /VM status: running \(info status\)/)
		await assert.rejects(call('machines.monitor', {id, command: 'migrate "exec:touch /tmp/x"'}), /isn’t available here/)
		await assert.rejects(call('machines.monitor', {id, command: 'drive_add 0 file=/etc/shadow'}), /isn’t available here/)
		await call('machines.hibernate', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'hibernated')
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		const tasks = (await q('machines.details', {id})).tasks.map((t) => t.type)
		for (const t of ['create', 'hardware', 'snapshot', 'backup', 'pause', 'hibernate']) assert.ok(tasks.includes(t), `task ${t} recorded`)
		assert.ok((await q('machines.tasks')).every((t) => t.machineName))
	})

	test('uninstall leaves the machine when its state cannot be read', async () => {
		const disk = join(data, 'machines/vms', id, 'disk.qcow2')
		seen.failList = true
		try {
			const before = seen.calls.length
			await assert.rejects(call('machines.uninstall', {id}), /was not deleted because its state could not be read/)
			assert.equal(seen.calls.slice(before).some((c) => /^virsh (destroy|undefine) /.test(c)), false)
			await stat(disk)
			assert.ok((await q('machines.list')).some((x) => x.id === id), 'the list still loads, and the machine is still on it')
			const saved = JSON.parse(await readFile(join(data, 'machines/machines.json'), 'utf8'))
			assert.ok(saved.machines.some((x) => x.id === id))
			assert.equal(doms.get(`omarchy-${id}`), 'running')
		} finally {
			seen.failList = false
		}
	})

	test('uninstall leaves the disk when the machine will not shut down', async () => {
		const disk = join(data, 'machines/vms', id, 'disk.qcow2')
		seen.failDestroy = true
		try {
			const before = seen.calls.length
			await assert.rejects(call('machines.uninstall', {id}), /was not deleted because it could not be shut down/)
			assert.equal(seen.calls.slice(before).some((c) => c.startsWith('virsh undefine ')), false)
			await stat(disk)
			assert.ok((await q('machines.list')).some((x) => x.id === id))
			assert.equal(doms.get(`omarchy-${id}`), 'running')
		} finally {
			seen.failDestroy = false
		}
		seen.failUndefine = true
		try {
			await assert.rejects(call('machines.uninstall', {id}), /was not deleted because it could not be removed from libvirt/)
			await stat(disk)
			assert.ok((await q('machines.list')).some((x) => x.id === id))
			assert.equal(doms.has(`omarchy-${id}`), true)
		} finally {
			seen.failUndefine = false
		}
	})

	test('stop, start, uninstall', async () => {
		await call('machines.forceStop', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'stopped')
		await call('machines.start', {id})
		await until(async () => (await q('machines.list')).find((x) => x.id === id).state === 'running')
		await call('machines.uninstall', {id})
		assert.deepEqual(await q('machines.list'), [])
		assert.equal(doms.size, 0)
		await assert.rejects(stat(join(data, 'machines/vms', id)))
	})
})

describe('machines.json registry', () => {
	const open = (dataDir) => createMachines({dataDir, run: async () => '', kvmDevice: join(dataDir, 'kvm'), catalogUrl: 'https://example.invalid/catalog.json', fetchImpl: async () => ({ok: false})})

	test('a truncated machines.json is unchanged after ready/list, and the machine list is empty', async (t) => {
		const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-m-bad-'))
		const logs = []
		t.mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')))
		try {
			const file = join(root, 'machines', 'machines.json')
			const damaged = '{"machines":[{"id":"abcd1234","name":"Kept","secret":"do-not-log"'
			await mkdir(join(root, 'machines'), {recursive: true})
			await writeFile(file, damaged)
			const machines = open(root)
			await machines.ready
			assert.deepEqual(await machines.procedures['machines.list'].run(), [])
			assert.equal(await readFile(file, 'utf8'), damaged)
			assert.equal(logs.length, 1)
			assert.match(logs[0], /machines\.json/)
			assert.equal(logs[0].includes(root), false)
			assert.equal(logs[0].includes('do-not-log'), false)
			assert.equal(logs[0].includes('abcd1234'), false)
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	})

	test('a valid machines.json still loads its machines', async () => {
		const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-m-ok-'))
		try {
			const file = join(root, 'machines', 'machines.json')
			await mkdir(join(root, 'machines'), {recursive: true})
			await writeFile(file, JSON.stringify({machines: [{id: 'abcd1234', name: 'Kept', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, state: 'stopped', portForwards: [], createdAt: 1, layout: {video: 'virtio', disks: []}}]}))
			const machines = open(root)
			await machines.ready
			const listed = await machines.procedures['machines.list'].run()
			assert.equal(listed.length, 1)
			assert.equal(listed[0].id, 'abcd1234')
			assert.equal(listed[0].name, 'Kept')
			const saved = JSON.parse(await readFile(file, 'utf8'))
			assert.equal(saved.machines[0].id, 'abcd1234')
			assert.equal(saved.machines[0].name, 'Kept')
			assert.equal(saved.machines[0].layout.video, 'vga')
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	})
})

test('Start on a failed clone does not boot the original machine\'s disks', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-clone-'))
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const disk1 = join(vm, 'disk1.qcow2')
	const defined = []
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(disk0, 'disk-zero')
		await writeFile(disk1, 'disk-one')
		await mkdir(join(dataDir, 'machines'), {recursive: true})
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Source',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					state: 'stopped',
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:33',
					boot: ['disk0', 'disk1'],
					layout: {
						firmware: 'bios',
						machineType: 'q35',
						nic: 'virtio',
						video: 'vga',
						disks: [
							{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10},
							{id: 'disk1', file: disk1, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10},
						],
					},
				}],
			}),
		)
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		const run = async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
				if (a[0] === 'define') {
					defined.push(await readFile(a[1], 'utf8'))
					return ''
				}
				if (a[0] === 'start') return ''
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				const src = args.at(-2)
				const dst = args.at(-1)
				if (src === disk1) {
					await writeFile(dst, 'partial')
					throw new Error('qemu-img: No space left on device')
				}
				await copyFile(src, dst)
				return ''
			}
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice})
		await machines.ready
		const {id: copyId} = await machines.procedures['machines.clone'].run({id, name: 'Source copy'})
		const end = Date.now() + 5000
		let copy
		for (;;) {
			copy = (await machines.procedures['machines.list'].run()).find((m) => m.id === copyId)
			if (copy?.state === 'error') break
			if (Date.now() > end) throw new Error(`clone did not reach error (state ${copy?.state})`)
			await new Promise((r) => setTimeout(r, 20))
		}
		assert.match(copy.errorMessage, /No space left on device/)
		await assert.rejects(
			() => machines.procedures['machines.start'].run({id: copyId}),
			(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && err.message === 'Source copy didn’t finish setting up. Delete it and create it again.',
		)
		assert.equal(defined.some((xml) => xml.includes(disk0) || xml.includes(disk1)), false)
		const after = (await machines.procedures['machines.list'].run()).find((m) => m.id === copyId)
		assert.equal(after.state, 'error')
		assert.equal(await readFile(disk0, 'utf8'), 'disk-zero')
		assert.equal(await readFile(disk1, 'utf8'), 'disk-one')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('Start still finishes an error machine whose disks are already in its folder', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-own-'))
	const dataDir = join(root, 'data')
	const id = 'b1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const defined = []
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(disk0, 'own-disk')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Almost',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					state: 'error',
					errorMessage: 'define failed',
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:44',
					boot: ['disk0'],
					layout: {
						firmware: 'bios',
						machineType: 'q35',
						nic: 'virtio',
						video: 'vga',
						disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}],
					},
				}],
			}),
		)
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		let started = false
		const run = async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') defined.push(await readFile(a[1], 'utf8'))
				if (a[0] === 'start') started = true
				if (a[0] === 'list') return started ? ' Id   Name   State\n------------------\n -    omarchy-b1b2c3d4   running\n' : ' Id   Name   State\n------------------\n'
				return ''
			}
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice})
		await machines.ready
		assert.equal(await machines.procedures['machines.start'].run({id}), true)
		assert.equal(started, true)
		assert.equal(defined.length, 1)
		assert.ok(defined[0].includes(disk0))
		const saved = JSON.parse(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8'))
		const rec = saved.machines.find((m) => m.id === id)
		assert.equal(rec.state, undefined)
		assert.equal(rec.errorMessage, undefined)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('A partial disk.qcow2.part left installing is not booted', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-part-'))
	const dataDir = join(root, 'data')
	const id = 'c1d2e3f4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const virsh = []
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(join(vm, 'disk.qcow2.part'), 'partial')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'CutOff',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					diskSizeGb: 10,
					state: 'installing',
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:55',
					boot: ['disk0'],
					layout: {
						firmware: 'bios',
						machineType: 'q35',
						nic: 'virtio',
						video: 'vga',
						disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}],
					},
				}],
			}),
		)
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		const run = async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				virsh.push(a[0])
				if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
			}
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice})
		await machines.ready
		const listed = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
		assert.equal(listed.state, 'error')
		assert.equal(listed.errorMessage, 'Setup was interrupted. Delete this machine and create it again.')
		await assert.rejects(
			() => machines.procedures['machines.start'].run({id}),
			(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && err.message === 'CutOff didn’t finish setting up. Delete it and create it again.',
		)
		assert.equal(virsh.includes('define') || virsh.includes('start'), false)
		assert.equal(await readFile(join(vm, 'disk.qcow2.part'), 'utf8'), 'partial')
		await assert.rejects(() => stat(disk0))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

async function cloudCreate({root, run}) {
	const dataDir = join(root, 'data')
	const catalog = join(root, 'catalog.json')
	await writeFile(
		catalog,
		JSON.stringify({
			version: 1,
			images: [{id: 'testos-amd64', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/test.qcow2', sha256: 'a'.repeat(64), sizeMb: 1, adminGroup: 'sudo'}],
		}),
	)
	const kvmDevice = join(root, 'kvm')
	await writeFile(kvmDevice, '')
	const machines = createMachines({
		dataDir,
		catalogUrl: `file://${catalog}`,
		fetchImpl: async () => {
			throw new Error('catalog image should already be on disk')
		},
		run,
		kvmDevice,
	})
	await machines.ready
	await mkdir(join(dataDir, 'machines', 'images'), {recursive: true})
	await writeFile(join(dataDir, 'machines', 'images', 'testos-amd64.qcow2'), 'cloud-image-bytes')
	return machines
}

const untilMachine = async (machines, id, state) => {
	const end = Date.now() + 5000
	for (;;) {
		const m = (await machines.procedures['machines.list'].run()).find((x) => x.id === id)
		if (m?.state === state) return m
		if (Date.now() > end) throw new Error(`machine did not reach ${state} (state ${m?.state})`)
		await new Promise((r) => setTimeout(r, 20))
	}
}

test('qemu-img convert failure keeps a partial disk off disk.qcow2', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-conv-'))
	const defined = []
	try {
		const run = async (cmd, args, opts = {}) => {
			if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await writeFile(args.at(-1), 'partial')
				throw new Error('qemu-img: No space left on device')
			}
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') defined.push(await readFile(a[1], 'utf8'))
				if (a[0] === 'list') return ' Id   Name   State\n------------------\n'
				return ''
			}
			return ''
		}
		const machines = await cloudCreate({root, run})
		const {id} = await machines.procedures['machines.create'].run({name: 'Half', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'})
		const m = await untilMachine(machines, id, 'error')
		assert.match(m.errorMessage, /No space left on device/)
		const vm = join(root, 'data', 'machines', 'vms', id)
		await assert.rejects(() => stat(join(vm, 'disk.qcow2')))
		assert.equal(await readFile(join(vm, 'disk.qcow2.part'), 'utf8'), 'partial')
		await assert.rejects(
			() => machines.procedures['machines.start'].run({id}),
			(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && err.message === 'Half didn’t finish setting up. Delete it and create it again.',
		)
		assert.equal(defined.length, 0)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('Start finishes when define fails after the disk is no longer a partial disk', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-def-'))
	const defined = []
	let started = false
	let defines = 0
	try {
		const run = async (cmd, args, opts = {}) => {
			if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await writeFile(args.at(-1), 'finished-disk')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'resize') return ''
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') {
					defines++
					if (defines === 1) throw new Error('virsh define: unsupported configuration')
					defined.push(await readFile(a[1], 'utf8'))
					return ''
				}
				if (a[0] === 'start') {
					started = true
					return ''
				}
				if (a[0] === 'list') return started ? ' Id   Name   State\n------------------\n -    placeholder   running\n' : ' Id   Name   State\n------------------\n'
				return ''
			}
			return ''
		}
		const machines = await cloudCreate({root, run})
		const {id} = await machines.procedures['machines.create'].run({name: 'Almost', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'})
		const m = await untilMachine(machines, id, 'error')
		assert.match(m.errorMessage, /unsupported configuration/)
		const vm = join(root, 'data', 'machines', 'vms', id)
		const disk0 = join(vm, 'disk.qcow2')
		assert.equal(await readFile(disk0, 'utf8'), 'finished-disk')
		await assert.rejects(() => stat(join(vm, 'disk.qcow2.part')))
		assert.equal(await machines.procedures['machines.start'].run({id}), true)
		assert.equal(started, true)
		assert.equal(defined.length, 1)
		assert.ok(defined[0].includes(disk0))
		assert.equal(defined[0].includes('disk.qcow2.part'), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

const busyConflict = (name) => (err) => err instanceof RpcError && err.code === 'CONFLICT' && err.message === `${name} is busy`

test('revert drops a hibernated machine’s saved memory', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-revert-'))
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const calls = []
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(disk0, 'disk')
		await writeFile(join(root, 'kvm'), '')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Sleeper',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					memoryMb: 1024,
					diskSizeGb: 10,
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:33',
					boot: ['disk0'],
					hibernated: true,
					snapshots: [{name: 'before', description: '', createdAt: 1, config: {sockets: 1, cores: 1, memoryMb: 1024, cpuType: 'host', layout: {firmware: 'bios', machineType: 'q35', video: 'vga', nic: 'virtio'}, disks: ['disk0'], files: [disk0]}}],
					layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]},
				}],
			}),
		)
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'virsh' || cmd === 'qemu-img') calls.push([cmd, ...a].join(' '))
			if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    omarchy-${id}   shut off\n`
			if (cmd === 'virsh' && a[0] === 'managedsave-remove') throw new Error('error: Requested operation is not valid: domain does not have a managed save image')
			if (cmd === 'virsh' && a[0] === 'define') return ''
			if (cmd === 'qemu-img' && args[0] === 'snapshot' && args[1] === '-l') return `Snapshot list:\nID        TAG               VM SIZE                DATE     VM CLOCK\n1         before                  0  2024-01-01 00:00:00   00:00:00.000\n`
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm')})
		await machines.ready
		await machines.procedures['machines.revertSnapshot'].run({id, name: 'before'})
		assert.ok(calls.includes(`virsh managedsave-remove omarchy-${id}`))
		const saved = JSON.parse(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8')).machines.find((m) => m.id === id)
		assert.equal(saved.hibernated ?? false, false)
		const listed = (await machines.procedures['machines.list'].run()).find((m) => m.id === id)
		assert.notEqual(listed.state, 'hibernated')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('clone keeps the source busy until the copy finishes', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-busy-'))
	const dataDir = join(root, 'data')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	let release
	let copying = false
	const gate = new Promise((r) => {
		release = r
	})
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(disk0, 'disk')
		await writeFile(join(root, 'kvm'), '')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Source',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					memoryMb: 1024,
					diskSizeGb: 10,
					portForwards: [{id: 'pf1', protocol: 'tcp', hostPort: 2200, guestPort: 22}],
					createdAt: 1,
					mac: '52:54:00:11:22:33',
					boot: ['disk0'],
					options: {onBoot: false},
					usbDevices: [{id: 'stick-1', vendorId: '10c4', productId: 'ea60', serial: 'ABC'}],
					usbLive: ['stick-1'],
					lastUsbError: 'stuck',
					layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]},
				}],
			}),
		)
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				copying = true
				await gate
				await copyFile(args.at(-2), args.at(-1))
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 10 * 1024 ** 3, 'actual-size': 4096})
			if (cmd === 'virsh' && a[0] === 'list') return ` Id   Name   State\n------------------\n -    omarchy-${id}   shut off\n`
			if (cmd === 'virsh' && a[0] === 'define') return ''
			if (cmd === 'virsh' && a[0] === 'start') return ''
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm')})
		await machines.ready
		await machines.procedures['machines.updateOptions'].run({id, onBoot: true})
		const pending = machines.procedures['machines.clone'].run({id, name: 'Source copy'})
		const end = Date.now() + 5000
		while (!copying) {
			if (Date.now() > end) throw new Error('clone did not start copying')
			await new Promise((r) => setTimeout(r, 10))
		}
		await assert.rejects(() => machines.procedures['machines.start'].run({id}), busyConflict('Source'))
		await assert.rejects(() => machines.procedures['machines.uninstall'].run({id}), busyConflict('Source'))
		release()
		const {id: copyId} = await pending
		const deadline = Date.now() + 5000
		for (;;) {
			const copy = (await machines.procedures['machines.list'].run()).find((m) => m.id === copyId)
			if (copy?.state === 'stopped') break
			if (Date.now() > deadline) throw new Error(`clone did not finish (state ${copy?.state})`)
			await new Promise((r) => setTimeout(r, 10))
		}
		assert.equal(await machines.procedures['machines.start'].run({id}), true)
		const saved = JSON.parse(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8'))
		const source = saved.machines.find((m) => m.id === id)
		const copy = saved.machines.find((m) => m.id === copyId)
		assert.deepEqual(source.usbDevices.map((d) => d.id), ['stick-1'])
		assert.deepEqual(source.usbLive, ['stick-1'])
		assert.equal(source.lastUsbError, 'stuck')
		assert.deepEqual(copy.usbDevices, [])
		assert.equal(copy.usbLive, undefined)
		assert.equal(copy.lastUsbError, undefined)
		assert.equal(copy.options.onBoot, true)
		assert.deepEqual(copy.portForwards, [])
	} finally {
		release()
		await rm(root, {recursive: true, force: true})
	}
})

test('paused and stopping machines resize and back up on the live path', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-pause-'))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const calls = []
	let domainState = 'paused'
	try {
		await mkdir(vm, {recursive: true})
		await mkdir(home, {recursive: true})
		await writeFile(disk0, 'disk')
		await writeFile(join(root, 'kvm'), '')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Paused',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					memoryMb: 1024,
					diskSizeGb: 10,
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:33',
					boot: ['disk0'],
					layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]},
				}],
			}),
		)
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'virsh' || cmd === 'qemu-img') calls.push([cmd, ...a].join(' '))
			if (cmd === 'virsh' && a[0] === 'list') {
				if (!domainState) return ' Id   Name   State\n------------------\n'
				return ` Id   Name   State\n------------------\n -    omarchy-${id}   ${domainState}\n`
			}
			if (cmd === 'virsh' && a[0] === 'backup-begin') {
				const bx = await readFile(a[3], 'utf8')
				for (const [, f] of bx.matchAll(/<target file='([^']+)'/g)) await writeFile(f, 'live-copy')
				return 'Backup started\n'
			}
			if (cmd === 'virsh' && a[0] === 'domjobinfo') return a.includes('--completed') ? 'Job type:         Completed\n' : 'Job type:         None\n'
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await copyFile(args.at(-2), args.at(-1))
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 10 * 1024 ** 3, 'actual-size': 4096})
			return ''
		}
		const files = {resolve: async () => ({real: home})}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm'), files})
		await machines.ready
		await machines.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 12})
		assert.ok(calls.includes(`virsh blockresize omarchy-${id} vda 12G`))
		assert.equal(calls.some((c) => c.startsWith('qemu-img resize ')), false)
		calls.length = 0
		domainState = 'in shutdown'
		await machines.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 13})
		assert.ok(calls.includes(`virsh blockresize omarchy-${id} vda 13G`))
		calls.length = 0
		domainState = 'shut off'
		await machines.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 14})
		assert.ok(calls.some((c) => c.startsWith('qemu-img resize ')))
		assert.equal(calls.some((c) => c.includes('blockresize')), false)
		calls.length = 0
		domainState = null
		await machines.procedures['machines.resizeDisk'].run({id, diskId: 'disk0', sizeGb: 15})
		assert.ok(calls.some((c) => c.startsWith('qemu-img resize ')))
		assert.equal(calls.some((c) => c.includes('blockresize')), false)
		calls.length = 0
		domainState = 'paused'
		const {backupId} = await machines.procedures['machines.backup'].run({id})
		const deadline = Date.now() + 5000
		for (;;) {
			const listed = await machines.procedures['machines.backups'].run({id})
			if (listed.some((b) => b.id === backupId)) break
			if (Date.now() > deadline) throw new Error('paused backup did not finish')
			await new Promise((r) => setTimeout(r, 20))
		}
		assert.ok(calls.some((c) => c.startsWith(`virsh backup-begin omarchy-${id} `)))
		assert.equal(calls.some((c) => /must be running/.test(c)), false)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('hardware and drive changes are refused while a backup is busy', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-set-'))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const id = 'a1b2c3d4'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	let release
	let copying = false
	const gate = new Promise((r) => {
		release = r
	})
	try {
		await mkdir(vm, {recursive: true})
		await mkdir(home, {recursive: true})
		await writeFile(disk0, 'disk')
		await writeFile(join(root, 'kvm'), '')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Box',
					osId: 'testos-amd64',
					cores: 1,
					memoryGb: 1,
					memoryMb: 1024,
					diskSizeGb: 10,
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:33',
					boot: ['disk0'],
					layout: {firmware: 'bios', machineType: 'q35', nic: 'virtio', video: 'vga', disks: [{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10}]},
				}],
			}),
		)
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				copying = true
				await gate
				await copyFile(args.at(-2), args.at(-1))
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 10 * 1024 ** 3, 'actual-size': 4096})
			if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
			if (cmd === 'virsh' && a[0] === 'define') return ''
			return ''
		}
		const files = {resolve: async () => ({real: home})}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm'), files})
		await machines.ready
		const pending = machines.procedures['machines.backup'].run({id})
		const end = Date.now() + 5000
		while (!copying) {
			if (Date.now() > end) throw new Error('backup did not start copying')
			await new Promise((r) => setTimeout(r, 10))
		}
		const before = await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8')
		await assert.rejects(() => machines.procedures['machines.updateHardware'].run({id, nic: 'e1000'}), busyConflict('Box'))
		await assert.rejects(() => machines.procedures['machines.updateDisk'].run({id, diskId: 'disk0', bus: 'sata'}), busyConflict('Box'))
		assert.equal(await readFile(join(dataDir, 'machines', 'machines.json'), 'utf8'), before)
		release()
		await pending
	} finally {
		release()
		await rm(root, {recursive: true, force: true})
	}
})

test('a machine saved before drive layouts lists the cloud drives', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-layout-'))
	const dataDir = join(root, 'data')
	const oldId = 'aaaaaaaa'
	const keptId = 'bbbbbbbb'
	const oldVm = join(dataDir, 'machines', 'vms', oldId)
	const keptVm = join(dataDir, 'machines', 'vms', keptId)
	try {
		await mkdir(oldVm, {recursive: true})
		await mkdir(keptVm, {recursive: true})
		await writeFile(join(oldVm, 'disk.qcow2'), 'old-disk')
		await writeFile(join(oldVm, 'seed.iso'), 'old-seed')
		await writeFile(join(keptVm, 'disk.qcow2'), 'kept-disk')
		await writeFile(join(root, 'kvm'), '')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [
					{id: oldId, name: 'Old', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, portForwards: [], createdAt: 1, mac: '52:54:00:00:00:01'},
					{id: keptId, name: 'Kept', osId: 'testos-amd64', cores: 1, memoryGb: 1, memoryMb: 1024, diskSizeGb: 8, portForwards: [], createdAt: 1, mac: '52:54:00:00:00:02', boot: ['disk0'], layout: {firmware: 'efi', machineType: 'q35', nic: 'e1000e', video: 'vga', disks: [{id: 'disk0', file: join(keptVm, 'disk.qcow2'), device: 'disk', bus: 'sata', format: 'qcow2', sizeGb: 8}]}},
				],
			}),
		)
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
			if (cmd === 'virsh' && a[0] === 'define') return ''
			if (cmd === 'qemu-img' && args[0] === 'info') return JSON.stringify({format: 'qcow2', 'virtual-size': 10 * 1024 ** 3, 'actual-size': 4096})
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm')})
		await machines.ready
		const old = await machines.procedures['machines.details'].run({id: oldId})
		assert.deepEqual(
			old.hardware.disks.map((d) => [d.id, d.device, d.bus, d.format, d.role]),
			[['disk0', 'disk', 'virtio', 'qcow2', null], ['seed', 'cdrom', 'sata', 'raw', 'seed']],
		)
		assert.deepEqual([old.hardware.firmware, old.hardware.nic, old.hardware.video, old.hardware.machineType], ['bios', 'virtio', 'vga', 'q35'])
		await machines.procedures['machines.updateHardware'].run({id: oldId, nic: 'e1000'})
		const kept = await machines.procedures['machines.details'].run({id: keptId})
		assert.deepEqual(kept.hardware.disks.map((d) => [d.id, d.device, d.bus]), [['disk0', 'disk', 'sata']])
		assert.equal(kept.hardware.nic, 'e1000e')
		assert.equal(kept.hardware.firmware, 'efi')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('backup folders without machine.json are removed on start and by delete', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-bak-'))
	const dataDir = join(root, 'data')
	const home = join(root, 'home')
	const backups = join(home, 'Backups', 'Machines')
	const orphan = join(backups, 'cut-short')
	const good = join(backups, 'kept-backup')
	const photos = join(home, 'Photos')
	const meta = JSON.stringify({format: 1, machine: {name: 'Kept'}})
	try {
		await mkdir(orphan, {recursive: true})
		await mkdir(good, {recursive: true})
		await mkdir(photos, {recursive: true})
		await writeFile(join(orphan, 'disk0.qcow2'), 'partial')
		await writeFile(join(good, 'machine.json'), meta)
		await writeFile(join(good, 'disk0.qcow2'), 'full')
		await writeFile(join(backups, 'notes.txt'), 'keep')
		await writeFile(join(photos, 'pic.txt'), 'keep')
		await writeFile(join(root, 'kvm'), '')
		const files = {resolve: async (virtual) => (virtual === '/Home' ? {real: home} : Promise.reject(new Error('no')))}
		const machines = createMachines({dataDir, run: async () => '', kvmDevice: join(root, 'kvm'), files})
		await machines.ready
		await assert.rejects(() => stat(orphan))
		assert.equal(await readFile(join(good, 'machine.json'), 'utf8'), meta)
		assert.equal(await readFile(join(backups, 'notes.txt'), 'utf8'), 'keep')
		assert.equal(await readFile(join(photos, 'pic.txt'), 'utf8'), 'keep')
		await assert.rejects(() => machines.procedures['machines.deleteBackup'].run({backupId: 'cut-short'}), (err) => err instanceof RpcError && err.code === 'NOT_FOUND')
		const late = join(backups, 'late-cut')
		await mkdir(late, {recursive: true})
		await writeFile(join(late, 'disk0.qcow2'), 'partial')
		assert.equal(await machines.procedures['machines.deleteBackup'].run({backupId: 'late-cut'}), true)
		await assert.rejects(() => stat(late))
		assert.equal(await readFile(join(good, 'machine.json'), 'utf8'), meta)
		await assert.rejects(() => machines.procedures['machines.deleteBackup'].run({backupId: 'not-there'}), (err) => err instanceof RpcError && err.code === 'NOT_FOUND')
		const names = await readdir(home)
		assert.ok(names.includes('Photos'))
		assert.ok(names.includes('Backups'))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an imported raw disk is defined as qcow2 only when the copy is qcow2', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-imp-'))
	const dataDir = join(root, 'data')
	const raw0 = join(root, 'vdisk1.img')
	const raw1 = join(root, 'vdisk2.img')
	const defined = []
	try {
		await writeFile(raw0, 'raw-one')
		await writeFile(raw1, 'raw-two')
		await writeFile(join(root, 'kvm'), '')
		const run = async (cmd, args) => {
			const a = args[0] === '-c' ? args.slice(2) : args
			if (cmd === 'qemu-img' && args[0] === 'convert') {
				await writeFile(args.at(-1), 'copied')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'info') {
				const format = String(args.at(-1)).endsWith('disk1.qcow2') ? 'raw' : 'qcow2'
				return JSON.stringify({format, 'virtual-size': 1024 ** 3, 'actual-size': 4096})
			}
			if (cmd === 'virsh' && a[0] === 'define') {
				defined.push(await readFile(a[1], 'utf8'))
				return ''
			}
			if (cmd === 'virsh' && a[0] === 'list') return ' Id   Name   State\n------------------\n'
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice: join(root, 'kvm')})
		await machines.ready
		const {id} = await machines.importVm({name: 'Win11', firmware: 'bios', disks: [{file: raw0, bus: 'virtio', format: 'raw'}, {file: raw1, bus: 'sata', format: 'raw'}]})
		const end = Date.now() + 5000
		for (;;) {
			const state = machines.importState(id)
			if (state.done) {
				assert.equal(state.error, null)
				break
			}
			if (Date.now() > end) throw new Error('import did not finish')
			await new Promise((r) => setTimeout(r, 10))
		}
		const xml = defined.at(-1)
		assert.match(xml, /type='qcow2'[^>]*\/><source file='[^']*disk\.qcow2'/)
		assert.match(xml, /type='raw'[^>]*\/><source file='[^']*disk1\.qcow2'/)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('Pause and Resume report "pausing" and "resuming", then the libvirt state straight away', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-pause-'))
	try {
		let name = ''
		let libvirt = 'shut off'
		let hold = null
		const run = async (cmd, args, opts = {}) => {
			if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
			if (cmd === 'xorriso') {
				await writeFile(args[args.indexOf('-output') + 1], 'iso')
				return ''
			}
			if (cmd === 'qemu-img' && args[0] === 'convert') await writeFile(args.at(-1), 'disk')
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') name = /<name>([^<]+)<\/name>/.exec(await readFile(a[1], 'utf8'))[1]
				if (a[0] === 'start') libvirt = 'running'
				if (a[0] === 'suspend' || a[0] === 'resume') {
					await hold
					libvirt = a[0] === 'suspend' ? 'paused' : 'running'
				}
				if (a[0] === 'list') return ` Id   Name   State\n------------------\n${libvirt === 'shut off' && !name ? '' : ` -    ${name}   ${libvirt}\n`}`
			}
			return ''
		}
		const machines = await cloudCreate({root, run})
		const {id} = await machines.procedures['machines.create'].run({name: 'Napper', osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'})
		await untilMachine(machines, id, 'running')
		const state = async () => (await machines.procedures['machines.list'].run()).find((m) => m.id === id).state
		for (const [verb, during, after] of [['pause', 'pausing', 'suspended'], ['resume', 'resuming', 'running']]) {
			let release
			hold = new Promise((r) => (release = r))
			const done = machines.procedures[`machines.${verb}`].run({id})
			await new Promise((r) => setTimeout(r, 50))
			assert.equal(await state(), during)
			release()
			await done
			assert.equal(await state(), after, `${verb} shows the real state at once`)
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('your own ISOs: a folder with more than 50 ISOs lists only 50', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-isos-'))
	try {
		await mkdir(join(root, 'home'), {recursive: true})
		for (let i = 0; i < 70; i++) await writeFile(join(root, 'home', `disc-${String(i).padStart(2, '0')}.iso`), 'iso')
		const machines = createMachines({dataDir: join(root, 'data'), run: async (cmd) => (cmd === 'xorriso' ? 'Volume Id    : DISC\n' : ''), kvmDevice: join(root, 'kvm'), files: {resolve: async (p) => ({real: p.replace('/Home', join(root, 'home')), top: 'Home'})}})
		await machines.ready
		assert.equal((await machines.procedures['machines.localIsos'].run()).length, 50)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a second machine made from an image that is already downloading follows its progress', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-share-'))
	try {
		const bytes = Buffer.alloc(100_000, 7)
		const catalog = join(root, 'catalog.json')
		await writeFile(catalog, JSON.stringify({version: 1, images: [{id: 'testos-amd64', name: 'TestOS', version: '1', arch: 'amd64', kind: 'cloud', url: 'https://example.test/test.qcow2', sha256: createHash('sha256').update(bytes).digest('hex'), sizeMb: 1, adminGroup: 'sudo'}]}))
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		const run = async (cmd, args, opts = {}) => {
			if (cmd === 'openssl') return execFileSync('openssl', args, {input: opts.input}).toString()
			if (cmd === 'xorriso') await writeFile(args[args.indexOf('-output') + 1], 'iso')
			if (cmd === 'qemu-img' && args[0] === 'convert') await writeFile(args.at(-1), 'disk')
			return ''
		}
		const fetchImpl = async () => {
			let sent = 0
			const body = new ReadableStream({
				async pull(controller) {
					if (sent >= bytes.length) return controller.close()
					await new Promise((r) => setTimeout(r, 40))
					controller.enqueue(bytes.subarray(sent, (sent += 10_000)))
				},
			})
			return new Response(body, {headers: {'content-length': String(bytes.length)}})
		}
		const machines = createMachines({dataDir: join(root, 'data'), catalogUrl: `file://${catalog}`, fetchImpl, run, kvmDevice})
		await machines.ready
		const make = (name) => machines.procedures['machines.create'].run({name, osId: 'testos-amd64', cores: 1, memoryGb: 1, diskSizeGb: 10, username: 'chris', password: 'hunter2'})
		const {id: a} = await make('a')
		await new Promise((r) => setTimeout(r, 120))
		const {id: b} = await make('b')
		let seenB = []
		for (;;) {
			const list = await machines.procedures['machines.list'].run()
			const mb = list.find((m) => m.id === b)
			if (mb.state === 'installing' && mb.installProgress !== undefined) seenB.push(mb.installProgress)
			if (list.every((m) => m.state === 'running' || m.state === 'stopped') && mb.state !== 'installing') break
			if (list.some((m) => m.state === 'error')) throw new Error(`a machine failed: ${list.map((m) => m.errorMessage)}`)
			await new Promise((r) => setTimeout(r, 15))
		}
		assert.ok(
			seenB.some((p) => p > 5 && p < 82),
			`b should move while the shared download runs, saw ${seenB.join(',')}`,
		)
		assert.ok(a)
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a machine set to the VirtIO display keeps it across a restart when this server has virtio-vga', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-video-'))
	try {
		const dataDir = join(root, 'data')
		await mkdir(join(dataDir, 'machines'), {recursive: true})
		const stateFile = join(dataDir, 'machines', 'machines.json')
		const entry = (id, video) => ({id, vmid: 100, name: id, osId: 'x', cores: 1, memoryGb: 1, diskSizeGb: 10, portForwards: [], createdAt: 1, layout: {firmware: 'efi', machineType: 'q35', nic: 'virtio', video, disks: []}})
		await writeFile(stateFile, JSON.stringify({machines: [entry('abcdef01', 'virtio')]}))
		const open = (devices) => createMachines({dataDir, run: async (cmd) => (cmd === 'qemu-system-x86_64' ? devices : ''), kvmDevice: join(root, 'kvm')})
		const videoAfterRestart = async (devices) => {
			const machines = open(devices)
			await machines.ready
			return JSON.parse(await readFile(stateFile, 'utf8')).machines[0].layout.video
		}
		assert.equal(await videoAfterRestart('name "virtio-vga", bus PCI'), 'virtio', 'virtio-vga is available: the owner’s choice stays')
		assert.equal(await videoAfterRestart('name "virtio-vga", bus PCI'), 'virtio', 'and stays on every later start')
		assert.equal(await videoAfterRestart(''), 'vga', 'without virtio-vga the old display is still replaced')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a Windows Server ISO you install by hand gets the SATA disk and e1000e network card Setup can see', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-winiso-'))
	try {
		const dataDir = join(root, 'data')
		await mkdir(join(root, 'home'), {recursive: true})
		await writeFile(join(root, 'home', 'Win_Server_2022.iso'), 'iso')
		await writeFile(join(root, 'home', 'archlinux.iso'), 'iso')
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		let xml = ''
		let name = ''
		let started = false
		const run = async (cmd, args) => {
			if (cmd === 'qemu-img' && args[0] === 'create') await writeFile(args[3], 'blank')
			if (cmd === 'xorriso') return `Volume Id    : ${/Win_Server/.test(args[1]) ? 'SSS_X64FREE_EN-US_DV9' : 'ARCH_202611'}\n`
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') (xml = await readFile(a[1], 'utf8')), (name = /<name>([^<]+)<\/name>/.exec(xml)[1])
				if (a[0] === 'start') started = true
				if (a[0] === 'list') return started ? ` Id   Name   State\n------------------\n -    ${name}   running\n` : ' Id   Name   State\n------------------\n'
				return ''
			}
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice, files: {resolve: async (p) => ({real: p.replace('/Home', join(root, 'home')), top: 'Home'})}})
		await machines.ready
		const isos = await machines.procedures['machines.localIsos'].run()
		const server = isos.find((i) => /Win_Server/.test(i.id))
		const arch = isos.find((i) => /archlinux/.test(i.id))
		assert.deepEqual([server.platform, server.requiresCredentials, server.manualSetup], ['windows', false, true])
		const spec = {cores: 1, memoryGb: 1, diskSizeGb: 10}
		const {id} = await machines.procedures['machines.create'].run({...spec, name: 'Server', osId: server.id})
		await untilMachine(machines, id, 'running')
		assert.match(xml, /<model type='e1000e'\/>/)
		assert.ok(!/bus='virtio'/.test(xml), 'Setup has no virtio storage driver')
		const {id: other} = await machines.procedures['machines.create'].run({...spec, name: 'Arch', osId: arch.id})
		await untilMachine(machines, other, 'running')
		assert.match(xml, /<target dev='vda' bus='virtio'\/>/, 'other ISOs keep the virtio layout')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('on an ARM server (Omarchy on Apple Silicon) a machine is an aarch64 "virt" machine with UEFI, SCSI for its seed drive and virtio graphics', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-arm-'))
	const dataDir = join(root, 'data')
	const id = 'a9b8c7d6'
	const vm = join(dataDir, 'machines', 'vms', id)
	const disk0 = join(vm, 'disk.qcow2')
	const seed = join(vm, 'seed.iso')
	const defined = []
	try {
		await mkdir(vm, {recursive: true})
		await writeFile(disk0, 'disk')
		await writeFile(seed, 'seed')
		await writeFile(
			join(dataDir, 'machines', 'machines.json'),
			JSON.stringify({
				machines: [{
					id,
					name: 'Arm box',
					osId: 'ubuntu-24.04-server-arm64',
					cores: 2,
					memoryGb: 2,
					diskSizeGb: 10,
					portForwards: [],
					createdAt: 1,
					mac: '52:54:00:11:22:66',
					boot: ['disk0'],
					// The layout a cloud machine gets: BIOS, q35, a SATA seed drive and VGA (all x86 things).
					layout: {
						firmware: 'bios',
						machineType: 'q35',
						nic: 'virtio',
						video: 'vga',
						disks: [
							{id: 'disk0', file: disk0, device: 'disk', bus: 'virtio', format: 'qcow2', sizeGb: 10},
							{id: 'seed', role: 'seed', file: seed, device: 'cdrom', bus: 'sata', format: 'raw'},
						],
					},
				}],
			}),
		)
		const kvmDevice = join(root, 'kvm')
		await writeFile(kvmDevice, '')
		let started = false
		const run = async (cmd, args) => {
			if (cmd === 'virsh') {
				const a = args[0] === '-c' ? args.slice(2) : args
				if (a[0] === 'define') defined.push(await readFile(a[1], 'utf8'))
				if (a[0] === 'start') started = true
				if (a[0] === 'list') return started ? ` Id   Name   State\n------------------\n -    omarchy-${id}   running\n` : ' Id   Name   State\n------------------\n'
			}
			return ''
		}
		const machines = createMachines({dataDir, run, kvmDevice, arch: 'arm64', catalogUrl: 'https://example.invalid/catalog.json', fetchImpl: async () => new Response('', {status: 503})})
		await machines.ready
		await machines.procedures['machines.start'].run({id})
		const xml = defined[0]
		assert.match(xml, /<os firmware='efi'><type arch='aarch64' machine='virt'>hvm<\/type>/)
		assert.doesNotMatch(xml, /x86_64|q35|<apic\/>|bus='sata'|bus='ide'/)
		assert.match(xml, /disk\.qcow2'\/><target dev='vda' bus='virtio'\/>/)
		assert.match(xml, /seed\.iso'\/><target dev='sda' bus='scsi'\/>/)
		// Disk I/O runs on its own thread, not QEMU's main loop: the virtio disk and the SCSI controller use it, the CD drive does not.
		assert.match(xml, /<vcpu>2<\/vcpu>\n  <iothreads>1<\/iothreads>/)
		assert.match(xml, /<driver name='qemu' type='qcow2' discard='unmap' iothread='1'\/><source file='[^']*disk\.qcow2'\/>/)
		assert.match(xml, /<controller type='scsi' model='virtio-scsi'><driver iothread='1'\/><\/controller>/)
		assert.match(xml, /device='cdrom'><driver name='qemu' type='raw'\/>/)
		assert.match(xml, /<video><model type='virtio'\/><\/video>/)
		// The catalog query keeps both architectures. The form filters to the host.
		const images = await machines.procedures['machines.osImages'].run()
		assert.ok(images.some((i) => i.arch === 'arm64' && i.id === 'ubuntu-24.04-server-arm64'))
		assert.ok(images.some((i) => i.arch === 'amd64'))
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('an x86 server’s machines are unchanged', async () => {
	const {readFile: rf} = await import('node:fs/promises')
	const catalog = JSON.parse(await rf(new URL('../omarchyd/machine-catalog.json', import.meta.url), 'utf8'))
	const ids = catalog.images.map((i) => i.id)
	for (const id of ['ubuntu-26.04-desktop-amd64', 'debian-13-server-amd64', 'debian-12-server-amd64', 'ubuntu-22.04-server-amd64', 'opensuse-leap-16.1-amd64', 'rocky-10-server-amd64', 'omarchy-4.5.0-amd64', 'cachyos-desktop-amd64', 'linuxmint-22.3-cinnamon-amd64']) assert.ok(ids.includes(id))
	for (const i of catalog.images.filter((x) => x.arch === 'arm64')) {
		assert.match(i.url, /arm64/)
		assert.equal(i.firmware, 'efi')
		assert.match(i.checksums.url, /^https:\/\/(cloud-images\.ubuntu\.com|cloud\.debian\.org)\//)
	}
})
