// Containers (LXC through per-user Incus): the library, the list, and what reaches `incus`.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {containerFrom, createContainers, libraryFrom, setupCommand} from '../omarchyd/containers.mjs'

const img = (os, release, alias, {arch = 'x86_64', type = 'container', variant = 'default'} = {}) => ({
	type,
	size: 120e6,
	aliases: [{name: alias}, {name: `${alias}/default`}, {name: `${alias}/default/amd64`}],
	properties: {os, release, variant, architecture: arch, description: `${os} ${release}`},
})

test('the library reads images as the image server lists them (architecture x86_64, properties amd64)', () => {
	// Shaped like `incus image list images: --format json` for Debian 12.
	const real = [
		{
			type: 'container',
			architecture: 'x86_64',
			size: 98765432,
			aliases: [{name: 'debian/12/default/amd64'}, {name: 'debian/bookworm/default/amd64'}, {name: 'debian/12/amd64'}, {name: 'debian/bookworm'}, {name: 'debian/12/default'}, {name: 'debian/12'}],
			properties: {architecture: 'amd64', description: 'Debian bookworm amd64 (20261126_05:24)', os: 'Debian', release: 'bookworm', serial: '20261126_05:24', type: 'squashfs', variant: 'default'},
		},
		{type: 'virtual-machine', architecture: 'x86_64', aliases: [{name: 'debian/12'}], properties: {architecture: 'amd64', os: 'Debian', release: 'bookworm', variant: 'default'}},
		{type: 'container', architecture: 'aarch64', aliases: [{name: 'debian/12/arm64'}], properties: {architecture: 'arm64', os: 'Debian', release: 'bookworm', variant: 'default'}},
	]
	const lib = libraryFrom(real, 'x86_64')
	assert.deepEqual(lib.map((d) => d.os), ['debian'])
	assert.deepEqual(lib[0].releases.map((r) => r.alias), ['debian/12'])
	assert.deepEqual(libraryFrom(real, 'aarch64'), [], 'an arm64 image with only an arch-specific alias is skipped')
	// Old rule (properties.architecture === 'x86_64') found nothing here: the library was empty.
	assert.equal(real.filter((i) => i.properties.architecture === 'x86_64').length, 0)
})

test('the library keeps the listed systems for this architecture, newest first, containers only', () => {
	const lib = libraryFrom(
		[
			img('Debian', '12', 'debian/12'),
			img('Debian', '13', 'debian/13'),
			img('Debian', '11', 'debian/11'),
			img('Debian', '12', 'debian/12', {arch: 'aarch64'}),
			img('Debian', '12', 'debian/12/cloud', {variant: 'cloud'}),
			img('Ubuntu', '24.04', 'ubuntu/24.04', {type: 'virtual-machine'}),
			img('Alpine', 'edge', 'alpine/edge'),
			img('Alpine', '3.21', 'alpine/3.21'),
			img('Gentoo', 'current', 'gentoo/current'),
			img('Slackware', '15.0', 'slackware/15.0'),
		],
		'x86_64',
	)
	assert.deepEqual(
		lib.map((d) => d.os),
		['debian', 'alpine', 'gentoo'],
		'Slackware is not offered; the Ubuntu entry was a VM image',
	)
	assert.deepEqual(
		lib[0].releases.map((r) => r.alias),
		['debian/13', 'debian/12', 'debian/11'],
	)
	assert.deepEqual(
		lib[1].releases.map((r) => r.alias),
		['alpine/3.21', 'alpine/edge'],
	)
})

test('a container from incus list: addresses, opened ports, limits and snapshots', () => {
	const c = containerFrom({
		name: 'web',
		type: 'container',
		status: 'Running',
		config: {'image.os': 'Debian', 'image.release': 'bookworm', 'limits.cpu': '2', 'limits.memory': '1024MiB'},
		devices: {'port-tcp-8080': {type: 'proxy', listen: 'tcp:0.0.0.0:8080', connect: 'tcp:127.0.0.1:80'}, other: {type: 'disk'}},
		expanded_devices: {root: {type: 'disk', path: '/', size: '8GiB'}},
		state: {memory: {usage: 512 * 1024 ** 2}, network: {lo: {addresses: [{family: 'inet', address: '127.0.0.1', scope: 'local'}]}, eth0: {addresses: [{family: 'inet', address: '10.20.30.4', scope: 'global'}, {family: 'inet6', address: 'fe80::1', scope: 'link'}]}}},
		snapshots: [{name: 'web/before', created_at: '2026-11-26T10:00:00Z'}],
	})
	assert.equal(c.status, 'running')
	assert.equal(c.cpus, 2)
	assert.equal(c.memory, '1024MiB')
	assert.equal(c.disk, '8GiB')
	assert.equal(c.memoryUsedGiB, 0.5)
	assert.deepEqual(c.addresses, [{family: 'IPv4', address: '10.20.30.4'}])
	assert.deepEqual(c.ports, [{protocol: 'tcp', hostPort: 8080, containerPort: 80}])
	assert.deepEqual(c.snapshots, [{name: 'before', createdAt: '2026-11-26T10:00:00Z'}])
})

function fakeIncus({list = [], images = [img('Debian', '12', 'debian/12')], fail = null} = {}) {
	const calls = []
	const run = async (args) => {
		calls.push(args)
		if (fail && fail(args)) throw Object.assign(new Error('Command failed'), {stderr: 'Error: Not allowed by project restrictions'})
		if (args[0] === 'list') return JSON.stringify(list)
		if (args[0] === 'image') return JSON.stringify(images)
		if (args[0] === 'query' && args[1] === '/1.0') return JSON.stringify({environment: {server_version: '6.8', project: 'user-1000'}})
		return ''
	}
	return {run, calls}
}

test('create launches the picked system with its limits, and refuses bad names and systems not in the library', async () => {
	const f = fakeIncus()
	const ct = createContainers({run: f.run})
	const p = ct.procedures
	await assert.rejects(p['containers.create'].run({name: 'Bad Name', image: 'debian/12'}), /lowercase/)
	await assert.rejects(p['containers.create'].run({name: 'web', image: 'evil/latest'}), /isn’t in the library/)
	await assert.rejects(p['containers.create'].run({name: 'web', image: 'debian/12; rm -rf /'}), /Pick a system/)
	assert.deepEqual(await p['containers.create'].run({name: 'web', image: 'debian/12', cpus: 1, memoryMiB: 512, diskGiB: 4}), {name: 'web'})
	await new Promise((r) => setTimeout(r, 10))
	assert.deepEqual(
		f.calls.find((a) => a[0] === 'launch'),
		['launch', 'images:debian/12', 'web', '--config', 'limits.cpu=1', '--config', 'limits.memory=512MiB', '--device', 'root,size=4GiB'],
	)
})

test('a container that is still being created shows in the list, and a failed one shows why', async () => {
	let finish
	const f = fakeIncus()
	const run = async (args) => (args[0] === 'launch' ? new Promise((_r, reject) => (finish = () => reject(Object.assign(new Error('x'), {stderr: 'Error: Failed instance creation: no space left'})))) : f.run(args))
	const p = createContainers({run}).procedures
	await p['containers.create'].run({name: 'db', image: 'debian/12'})
	assert.equal((await p['containers.list'].run()).find((c) => c.name === 'db').status, 'creating')
	finish()
	await new Promise((r) => setTimeout(r, 10))
	const failed = (await p['containers.list'].run()).find((c) => c.name === 'db')
	assert.equal(failed.status, 'error')
	assert.match(failed.error, /no space left/)
	await p['containers.delete'].run({name: 'db'})
	assert.equal((await p['containers.list'].run()).length, 0, 'deleting a failed creation just clears it')
})

test('ports: 1024 and up, never this server’s own, never twice; added as an Incus proxy device', async () => {
	const f = fakeIncus({list: [{name: 'a', type: 'container', status: 'Running', devices: {'port-tcp-9000': {type: 'proxy', connect: 'tcp:127.0.0.1:9000'}}}, {name: 'b', type: 'container', status: 'Running'}]})
	const p = createContainers({run: f.run, reservedPorts: [2021, 7780]}).procedures
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 80, containerPort: 80}), /1024 or higher/)
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 7780, containerPort: 80}), /own/)
	await assert.rejects(p['containers.addPort'].run({name: 'b', hostPort: 9000, containerPort: 80}), /a already uses port 9000/)
	await p['containers.addPort'].run({name: 'b', hostPort: 8080, containerPort: 80})
	assert.deepEqual(f.calls.at(-1), ['config', 'device', 'add', 'b', 'port-tcp-8080', 'proxy', 'listen=tcp:0.0.0.0:8080', 'connect=tcp:127.0.0.1:80'])
	await p['containers.removePort'].run({name: 'b', protocol: 'udp', hostPort: 8080})
	assert.deepEqual(f.calls.at(-1), ['config', 'device', 'remove', 'b', 'port-udp-8080'])
})

test('Incus errors come back in plain words, and a slow shutdown offers Force stop', async () => {
	const f = fakeIncus({fail: (a) => a[0] === 'stop' && a.includes('--timeout')})
	const p = createContainers({run: f.run}).procedures
	await assert.rejects(p['containers.stop'].run({name: 'web'}), /STOP_TIMED_OUT: web didn’t shut down.*Not allowed by project restrictions/)
	await p['containers.forceStop'].run({name: 'web'})
	assert.deepEqual(f.calls.at(-1), ['stop', 'web', '--force'])
})

test('not set up yet: the status says why and gives the one-time setup (sudo is run by the owner, never by MODC)', async () => {
	const missing = createContainers({run: async () => Promise.reject(Object.assign(new Error('spawn incus ENOENT'), {code: 'ENOENT'})), user: 'chris'}).procedures
	const s = await missing['containers.status'].run()
	assert.equal(s.available, false)
	assert.match(s.reason, /isn’t installed/)
	assert.equal(s.setupCommand, 'machines-add-lxc')
	assert.equal(setupCommand(), 'machines-add-lxc')
	const {readFile} = await import('node:fs/promises')
	const script = await readFile(new URL('../bin/machines-add-lxc', import.meta.url), 'utf8')
	assert.match(script, /usermod -aG incus "\$USER_NAME"/)
	assert.doesNotMatch(script, /usermod[^\n]*incus-admin/, 'never the admin group: that is root-equivalent')
	assert.match(script, /systemctl enable incus\.socket incus\.service incus-user\.socket/, 'Incus itself starts at boot, so containers set to start with the server do')
	assert.match(script, /start --no-block/, 'starting never blocks on systemd')
	assert.match(script, /timeout \d+ sudo incus admin waitready/, 'waiting for Incus has a time limit, so the script can’t hang')
	assert.doesNotMatch(script, /incus-startup/, 'Arch’s incus package has no incus-startup.service')
	assert.match(script, /setfacl -m "u:\$USER_NAME:rw" "\$SOCKET"/, 'the account can reach Incus’s per-user socket straight away, without a restart')
	assert.match(script, /incus-user\.socket\.d\/modc-/, 'and again each time the socket is created (a systemd drop-in)')
	const src = await readFile(new URL('../omarchyd/containers.mjs', import.meta.url), 'utf8')
	assert.doesNotMatch(src, /'sg'/, 'never through sg: Arch doesn’t ship it, and it failed as if Incus weren’t installed')
	const denied = createContainers({run: async () => Promise.reject(Object.assign(new Error('x'), {stderr: 'Error: permission denied'}))}).procedures
	assert.match((await denied['containers.status'].run()).reason, /Run the setup/)
	const ok = createContainers({run: fakeIncus().run}).procedures
	assert.deepEqual(await ok['containers.status'].run(), {available: true, version: '6.8', project: 'user-1000'})
})

test('the terminal opens a root shell only in a running container', async () => {
	const f = fakeIncus({list: [{name: 'up', type: 'container', status: 'Running'}, {name: 'down', type: 'container', status: 'Stopped'}]})
	const ct = createContainers({run: f.run})
	assert.deepEqual((await ct.shellFor('up')).command, ['incus', 'exec', 'up', '--env', 'TERM=xterm-256color', '--', 'su', '-l'])
	await assert.rejects(ct.shellFor('down'), /isn’t running/)
	await assert.rejects(ct.shellFor('missing'), /No such container/)
	await assert.rejects(ct.shellFor('../etc'), /lowercase/)
})

test('omarchyd: members can list containers; Incus mutations stay owner-only', async () => {
	const {mkdtemp, readFile, rm, writeFile} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const {ALLOWED} = await import('../server/app.mjs')
	for (const name of ['containers.status', 'containers.list', 'containers.images', 'containers.create', 'containers.delete', 'containers.addPort']) assert.ok(ALLOWED[name], name)
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-ct-'))
	const data = join(root, 'd')
	const accounts = await openAccounts(data)
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
	state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
	await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))
	const d = await startOmarchyd({port: 0, dataDir: data, home: root, containerOptions: {run: fakeIncus({list: [{name: 'web', type: 'container', status: 'Running'}]}).run}})
	try {
		const login = async (userId) => {
			const body = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 's'}})})).json()
			return `Bearer ${body.result.data.accessToken}`
		}
		const owner = await login('owner')
		const member = await login('member')
		const ownerList = await (await fetch(`${d.url}/trpc/containers.list`, {headers: {authorization: owner}})).json()
		assert.equal(ownerList.result.data[0].name, 'web')
		const memberList = await (await fetch(`${d.url}/trpc/containers.list`, {headers: {authorization: member}})).json()
		assert.equal(memberList.result.data[0].name, 'web')
		const memberStatus = await (await fetch(`${d.url}/trpc/containers.status`, {headers: {authorization: member}})).json()
		assert.equal(memberStatus.result.data.available, true)
		const start = await (await fetch(`${d.url}/trpc/containers.start`, {method: 'POST', headers: {authorization: member, 'content-type': 'application/json'}, body: JSON.stringify({name: 'web'})})).json()
		assert.match(start.error?.json?.message || start.error?.message || JSON.stringify(start), /owner|manage containers/i)
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

// A fake incus that keeps state, for the newer actions.
function statefulIncus() {
	const calls = []
	const cts = new Map([['web', {name: 'web', type: 'container', status: 'Running', config: {'limits.cpu': '1'}, devices: {}, expanded_devices: {root: {size: '8GiB'}}, state: {cpu: {usage: 0}, network: {eth0: {counters: {bytes_received: 0, bytes_sent: 0}}}}}]])
	const images = []
	const run = async (args, opts = {}) => {
		calls.push({args, input: opts.input === undefined ? undefined : String(opts.input)})
		const [cmd, ...rest] = args
		if (cmd === 'list') return JSON.stringify([...cts.values()])
		if (cmd === 'image' && rest[0] === 'list') return JSON.stringify(rest[1] === 'images:' ? [img('Debian', '12', 'debian/12')] : images)
		if (cmd === 'launch') cts.set(rest[1], {name: rest[1], type: 'container', status: 'Running', config: {}})
		if (cmd === 'copy') cts.set(rest[1], {...cts.get(rest[0]), name: rest[1]})
		if (cmd === 'import') cts.set(rest[1], {name: rest[1], type: 'container', status: 'Stopped'})
		if (cmd === 'publish') images.push({type: 'container', aliases: [{name: rest[2]}], properties: {os: 'debian', release: '12'}})
		if (cmd === 'export') {
			const {writeFile} = await import('node:fs/promises')
			await writeFile(rest[1], 'backup')
		}
		if (cmd === 'config' && rest[0] === 'set') for (const kv of rest.slice(2)) cts.get(rest[1]).config[kv.split('=')[0]] = kv.slice(kv.indexOf('=') + 1)
		if (cmd === 'exec' && rest.some((a) => a.includes('cd "$1"'))) return 'd\t0\tetc\nf\t12\thello.txt\n'
		if (cmd === 'file' && rest[0] === 'pull') return Buffer.from('hello')
		return ''
	}
	return {run, calls, cts}
}
const settle = () => new Promise((r) => setTimeout(r, 20))

test('start with the server, order, protection, notes and tags are Incus settings; protection stops delete', async () => {
	const f = statefulIncus()
	const p = createContainers({run: f.run}).procedures
	await p['containers.setOptions'].run({name: 'web', autostart: true, bootOrder: 10, bootDelay: 5, protected: true, notes: 'Pi-hole for the house', tags: ['dns', 'Home']})
	const c = (await p['containers.list'].run())[0]
	assert.equal(c.autostart, true)
	assert.equal(c.bootOrder, 10)
	assert.equal(c.bootDelay, 5)
	assert.equal(c.protected, true)
	assert.equal(c.notes, 'Pi-hole for the house')
	assert.deepEqual(c.tags, ['dns', 'home'])
	await assert.rejects(p['containers.delete'].run({name: 'web'}), /protected/)
	await assert.rejects(p['containers.setOptions'].run({name: 'web', tags: ['not a tag!']}), /Tags/)
})

test('resources change live, and the disk only grows', async () => {
	const f = statefulIncus()
	const p = createContainers({run: f.run}).procedures
	await p['containers.setResources'].run({name: 'web', cpus: 1, cpuAllowance: 50, cpuPriority: 3, memoryMiB: 512, swap: false, diskGiB: 16})
	assert.deepEqual(f.calls.find((c) => c.args[1] === 'set').args, ['config', 'set', 'web', 'limits.cpu=1', 'limits.cpu.allowance=50%', 'limits.cpu.priority=3', 'limits.memory=512MiB', 'limits.memory.swap=false'])
	assert.deepEqual(f.calls.at(-1).args, ['config', 'device', 'set', 'web', 'root', 'size=16GiB'])
	await assert.rejects(p['containers.setResources'].run({name: 'web', diskGiB: 4}), /grow but not shrink/)
})

test('a root password and SSH key go in on stdin after the container starts, never in the arguments', async () => {
	const f = statefulIncus()
	const p = createContainers({run: f.run}).procedures
	await assert.rejects(p['containers.create'].run({name: 'db', image: 'debian/12', rootPassword: 'short'}), /8 to 128/)
	await assert.rejects(p['containers.create'].run({name: 'db', image: 'debian/12', sshKey: 'not a key'}), /SSH public key/)
	const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq chris@laptop'
	await p['containers.create'].run({name: 'db', image: 'debian/12', rootPassword: 'correct horse battery', sshKey: key, autostart: true})
	await settle()
	const launch = f.calls.find((c) => c.args[0] === 'launch').args
	assert.ok(launch.includes('boot.autostart=true'))
	assert.ok(!f.calls.some((c) => c.args.join(' ').includes('correct horse')), 'the password never appears in a command line')
	assert.equal(f.calls.find((c) => c.args.includes('chpasswd')).input, 'root:correct horse battery\n')
	assert.equal(f.calls.find((c) => c.args.some((a) => a.includes('authorized_keys'))).input, `${key}\n`)
})

test('clone, save as a template, and create from the template', async () => {
	const f = statefulIncus()
	const p = createContainers({run: f.run}).procedures
	await p['containers.clone'].run({name: 'web', as: 'web-2'})
	await settle()
	assert.ok((await p['containers.list'].run()).some((c) => c.name === 'web-2'))
	await assert.rejects(p['containers.clone'].run({name: 'web', as: 'web-2'}), /already/)
	await p['containers.saveTemplate'].run({name: 'web', template: 'base'})
	await settle()
	const publish = f.calls.find((c) => c.args[0] === 'publish').args
	assert.match(publish[1], /^web\/modc-template-\d+$/, 'published from a snapshot, so it can stay running')
	assert.ok(f.calls.some((c) => c.args[0] === 'snapshot' && c.args[1] === 'delete'), 'the temporary snapshot is removed')
	assert.deepEqual((await p['containers.templates'].run()).map((t) => t.name), ['base'])
	await p['containers.create'].run({name: 'web-3', image: 'template:modc/base'})
	await settle()
	assert.equal(f.calls.findLast((c) => c.args[0] === 'launch').args[1], 'modc/base')
	await assert.rejects(p['containers.create'].run({name: 'web-4', image: 'template:modc/nope'}), /template isn’t on this server/)
})

test('backups: export to the backups folder, list, restore under a new name, delete', async () => {
	const {mkdtemp, rm, readdir} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const dir = await mkdtemp(join(os.tmpdir(), 'ct-backups-'))
	try {
		const f = statefulIncus()
		const p = createContainers({run: f.run, backupsDir: dir, now: () => Date.UTC(2026, 10, 26, 18, 0, 0)}).procedures
		const {file} = await p['containers.backup'].run({name: 'web'})
		assert.equal(file, 'web--20261126T180000Z.tar.gz')
		await settle()
		assert.deepEqual(f.calls.find((c) => c.args[0] === 'export').args, ['export', 'web', join(dir, file), '--instance-only'])
		assert.deepEqual((await p['containers.backups'].run({name: 'web'})).map((b) => [b.file, b.createdAt]), [[file, '2026-11-26T18:00:00Z']])
		await assert.rejects(p['containers.restoreBackup'].run({file}), /already a container named web/)
		await p['containers.restoreBackup'].run({file, as: 'web-old'})
		await settle()
		assert.ok((await p['containers.list'].run()).some((c) => c.name === 'web-old'))
		await assert.rejects(p['containers.restoreBackup'].run({file: '../../etc/passwd'}), /No such backup/)
		await p['containers.deleteBackup'].run({file})
		assert.deepEqual(await readdir(dir), [])
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('live graphs: CPU share and network speed between samples', async () => {
	const f = statefulIncus()
	let t = 0
	const ct = createContainers({run: f.run, now: () => t})
	const p = ct.procedures
	await p['containers.stats'].run()
	t = 5000
	const web = f.cts.get('web')
	web.state = {cpu: {usage: 2.5e9}, network: {eth0: {counters: {bytes_received: 512 * 1024 * 5, bytes_sent: 0}}}}
	const s = await p['containers.stats'].run()
	assert.deepEqual(s.web, {cpu: [50], rxKBs: [512], txKBs: [0]})
})

test('files: list a folder, copy a file to the server, and refuse paths that climb out', async () => {
	const {mkdtemp, rm, readFile, mkdir} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const home = await mkdtemp(join(os.tmpdir(), 'ct-files-'))
	try {
		await mkdir(join(home, 'Downloads'))
		const f = statefulIncus()
		const files = {resolve: async (v) => ({real: join(home, v.replace(/^\/Home/, ''))})}
		const p = createContainers({run: f.run, files}).procedures
		const dir = await p['containers.files'].run({name: 'web', path: '/root'})
		assert.deepEqual(dir.entries, [{name: 'etc', type: 'folder', size: null}, {name: 'hello.txt', type: 'file', size: 12}])
		assert.deepEqual(f.calls.at(-1).args.slice(-2), ['sh', '/root'], 'the path is an argument, not part of the script')
		await assert.rejects(p['containers.files'].run({name: 'web', path: '/root/../etc'}), /full path/)
		const res = await p['containers.copyToServer'].run({name: 'web', path: '/root/hello.txt'})
		assert.equal(res.path, '/Home/Downloads/hello.txt')
		assert.equal(await readFile(join(home, 'Downloads/hello.txt'), 'utf8'), 'hello')
		await assert.rejects(p['containers.copyToServer'].run({name: 'web', path: '/root/hello.txt'}), /already in/)
	} finally {
		await rm(home, {recursive: true, force: true})
	}
})

test('Machines → Add offers a computer, a virtual machine, and an LXC container, and the container item opens setup or the library', async () => {
	const {readFile} = await import('node:fs/promises')
	const manager = await readFile(new URL('../web/src/fleet/MachineManager.tsx', import.meta.url), 'utf8')
	const menu = manager.slice(manager.indexOf('role="menu"'), manager.indexOf('{newContainer && <NewContainerSheet'))
	for (const item of ['Add a computer', 'Create a virtual machine', 'Add a container']) assert.match(menu, new RegExp(`>\\s*${item}\\s*<`), item)
	const ui = await readFile(new URL('../web/src/containers/Containers.tsx', import.meta.url), 'utf8')
	assert.match(ui, /export function NewContainerSheet[\s\S]*<SetUp [\s\S]*<CreateContainer /)
})

test('status asks Incus for /1.0 (incus info has no --format), and clearing the CPU cap unsets it', async () => {
	const f = statefulIncus()
	const p = createContainers({run: f.run}).procedures
	await p['containers.status'].run()
	assert.deepEqual(f.calls[0].args, ['query', '/1.0'])
	await p['containers.setResources'].run({name: 'web', cpuAllowance: null})
	assert.ok(f.calls.some((c) => c.args.join(' ') === 'config unset web limits.cpu.allowance'))
})

test('incus gets a closed stdin unless something is sent: incus launch reads a config from an open stdin and waited forever', async () => {
	const {execIncus} = await import('../omarchyd/containers.mjs')
	// `cat` stands in for incus launch reading stdin: with stdin closed it ends straight away.
	const out = await execIncus('sh', ['-c', 'cat; echo done'], {timeout: 3000})
	assert.equal(out.trim(), 'done')
	assert.equal((await execIncus('sh', ['-c', 'cat'], {input: 'secret\n', timeout: 3000})).trim(), 'secret')
	const seen = []
	await execIncus('sh', ['-c', 'printf "Retrieving image: rootfs: 45%% (12MB/s)\\r"; echo ok'], {timeout: 3000, onOutput: (t) => seen.push(t)})
	assert.match(seen.join(''), /45%/)
})

test('a container still being created shows Incus’s progress and is marked pending', async () => {
	let progress
	const f = statefulIncus()
	const run = async (args, opts) => {
		if (args[0] === 'launch') {
			opts.onOutput('Retrieving image: rootfs: 45% (12.3MB/s)\r')
			return new Promise((r) => (progress = r))
		}
		return f.run(args, opts)
	}
	const p = createContainers({run}).procedures
	await p['containers.create'].run({name: 'db', image: 'debian/12'})
	const row = (await p['containers.list'].run()).find((c) => c.name === 'db')
	assert.equal(row.pending, true)
	assert.equal(row.status, 'creating')
	assert.equal(row.progress, 'Downloading rootfs: 45% (12.3MB/s)')
	progress()
})

test('a new container Incus already lists stays “creating” until launch finishes, so Start can’t race it', async () => {
	let done
	const f = statefulIncus()
	const run = async (args, opts) => {
		if (args[0] === 'launch') {
			// Incus has created it (stopped) and is about to start it.
			f.cts.set('fresh', {name: 'fresh', type: 'container', status: 'Stopped', config: {'image.os': 'Ubuntu'}})
			return new Promise((r) => (done = r))
		}
		return f.run(args, opts)
	}
	const p = createContainers({run}).procedures
	await p['containers.create'].run({name: 'fresh', image: 'debian/12'})
	await new Promise((r) => setTimeout(r, 10))
	const row = (await p['containers.list'].run()).find((c) => c.name === 'fresh')
	assert.equal(row.job, 'creating')
	done()
	await new Promise((r) => setTimeout(r, 10))
	assert.equal((await p['containers.list'].run()).find((c) => c.name === 'fresh').job, null)
})

test('Console opens the container’s own console; Root shell opens a shell; a root password goes in on stdin', async () => {
	const f = statefulIncus()
	const ct = createContainers({run: f.run})
	assert.deepEqual((await ct.shellFor('web', 'console')).command, ['incus', 'console', 'web'])
	assert.deepEqual((await ct.shellFor('web')).command, ['incus', 'exec', 'web', '--env', 'TERM=xterm-256color', '--', 'su', '-l'])
	await assert.rejects(ct.procedures['containers.setRootPassword'].run({name: 'web', password: 'short'}), /8 to 128/)
	await ct.procedures['containers.setRootPassword'].run({name: 'web', password: 'correct horse'})
	const call = f.calls.find((c) => c.args.includes('chpasswd'))
	assert.equal(call.input, 'root:correct horse\n')
	assert.ok(!f.calls.some((c) => c.args.join(' ').includes('correct horse')))
})

test('Show every system lists Incus’s whole library; creating accepts any of them', async () => {
	const {libraryFrom} = await import('../omarchyd/containers.mjs')
	const imgs = [img('Debian', '12', 'debian/12'), img('Kali', 'current', 'kali/current'), img('Slackware', '15.0', 'slackware/15.0')]
	assert.deepEqual(libraryFrom(imgs, 'x86_64').map((d) => d.os), ['debian'])
	assert.deepEqual(libraryFrom(imgs, 'x86_64', {all: true}).map((d) => d.os), ['debian', 'kali', 'slackware'])
})

test('template files: an Incus image imports as is; a plain root filesystem (a Proxmox template) gets a description first', async () => {
	const {mkdtemp, rm, mkdir, writeFile} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {execFileSync} = await import('node:child_process')
	const home = await mkdtemp(join(os.tmpdir(), 'ct-tpl-'))
	try {
		await mkdir(join(home, 'Downloads'))
		const big = (await import('node:crypto')).randomBytes(3 * 1024 * 1024)
		// An Incus image (metadata.yaml at the top) and a root filesystem (no metadata).
		await writeFile(join(home, 'metadata.yaml'), 'architecture: x86_64\n')
		await writeFile(join(home, 'filler'), big)
		execFileSync('tar', ['-czf', join(home, 'Downloads', 'my-image.tar.gz'), '-C', home, 'metadata.yaml', 'filler'])
		await mkdir(join(home, 'root', 'etc'), {recursive: true})
		await writeFile(join(home, 'root', 'etc', 'hostname'), 'x')
		await writeFile(join(home, 'root', 'filler'), big)
		execFileSync('tar', ['-cJf', join(home, 'Downloads', 'debian-12-standard_12.7-1_amd64.tar.xz'), '-C', join(home, 'root'), '.'])
		const f = statefulIncus()
		const files = {resolve: async (v) => ({real: join(home, v.replace(/^\/Home\/?/, ''))})}
		const p = createContainers({run: f.run, files}).procedures
		const list = await p['containers.templateFiles'].run()
		assert.deepEqual(list.files.map((x) => x.name), ['debian-12-standard_12.7-1_amd64.tar.xz', 'my-image.tar.gz'])
		await p['containers.importTemplate'].run({path: '/Home/Downloads/my-image.tar.gz'})
		await p['containers.importTemplate'].run({path: '/Home/Downloads/debian-12-standard_12.7-1_amd64.tar.xz'})
		await new Promise((r) => setTimeout(r, 1500))
		const imports = f.calls.filter((c) => c.args[0] === 'image' && c.args[1] === 'import').map((c) => c.args)
		assert.deepEqual(imports.find((a) => a.includes('modc/my-image')), ['image', 'import', join(home, 'Downloads', 'my-image.tar.gz'), '--alias', 'modc/my-image'])
		const rootfs = imports.find((a) => a.at(-1) === 'modc/debian-12-standard-12-7-1-amd64')
		assert.ok(rootfs, JSON.stringify(imports))
		assert.match(rootfs[2], /meta\.tar\.gz$/, 'a generated metadata tarball goes first')
		assert.equal(rootfs[3], join(home, 'Downloads', 'debian-12-standard_12.7-1_amd64.tar.xz'))
		await assert.rejects(p['containers.importTemplate'].run({path: '/Home/../etc/passwd.tar.gz'}), /Home|template file|No such/)
		await assert.rejects(p['containers.importTemplate'].run({path: '/Home/Downloads/notes.txt'}), /template file/)
	} finally {
		await rm(home, {recursive: true, force: true})
	}
})
