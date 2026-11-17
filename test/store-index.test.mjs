// loadStore prefers catalog.json (version 1, apps array) over walking every listing YAML.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {cwd, stdio: 'pipe'}).toString()

function mockRun() {
	const up = new Set()
	return async (cmd, args, opts = {}) => {
		if (cmd === 'git') return execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString()
		if (cmd === 'docker-compose') {
			if (args[0] === 'version') return 'Docker Compose version v2.30.0'
			const verb = args[4]
			if (verb === 'up' || verb === 'restart') up.add(args[1])
			if (verb === 'stop' || verb === 'down') up.delete(args[1])
			if (verb === 'ps') return JSON.stringify([{Service: 'web', State: up.has(args[1]) ? 'running' : 'exited'}])
			return ''
		}
		if (cmd === 'podman') {
			if (args[1] === 'rm') execFileSync('rm', args.slice(2))
			return ''
		}
		if (cmd === 'setfacl') return ''
		throw new Error(`${cmd} not simulated`)
	}
}

async function writeApp(store, id, {description = `yaml ${id}`, compose = 'services:\n  web:\n    image: x\n'} = {}) {
	await mkdir(join(store, id), {recursive: true})
	await writeFile(join(store, id, 'omarchy-app.yml'), `manifestVersion: 1\nid: ${id}\nname: ${id}\ndescription: ${description}\nicon: https://example.com/yaml-${id}.svg\n`)
	await writeFile(join(store, id, 'docker-compose.yml'), compose)
}

async function commitStore(store, {id = 'demo', name = 'Demo Store', catalog} = {}) {
	await writeFile(join(store, 'omarchy-app-store.yml'), `id: ${id}\nname: ${name}\n`)
	if (catalog !== undefined) await writeFile(join(store, 'catalog.json'), typeof catalog === 'string' ? catalog : JSON.stringify(catalog))
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '-A')
	git(store, 'commit', '-qm', 'store')
	return `file://${store}`
}

async function startApps(root) {
	await mkdir(join(root, 'home'), {recursive: true})
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [], run: mockRun(), gatewayHost: '127.0.0.1'})
	await apps.ready
	return apps
}

const until = async (fn, ms = 8000) => {
	const end = Date.now() + ms
	for (;;) {
		const v = await fn()
		if (v) return v
		if (Date.now() > end) throw new Error('timed out')
		await new Promise((r) => setTimeout(r, 40))
	}
}

test('a catalog.json store lists its apps from the catalog, not YAML, and never sends folder', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-'))
	try {
		const store = join(root, 'store')
		await writeApp(store, 'alpha')
		await writeApp(store, 'beta')
		await writeApp(store, 'gamma')
		const url = await commitStore(store, {
			id: 'cat',
			name: 'Catalog Store',
			catalog: {
				version: 1,
				apps: [
					{
						id: 'alpha',
						name: 'Alpha',
						description: 'from catalog alpha',
						icon: 'https://example.com/alpha.svg',
						website: 'https://example.com/alpha',
						gallery: ['https://example.com/a.png', 'http://insecure.example/x.png'],
						path: '',
						permissions: ['privileged'],
						compose: 'secret',
						folder: '/etc',
					},
					{
						id: 'beta',
						name: 'Beta',
						description: 'from catalog beta',
						icon: 'javascript:alert(1)',
						website: 'http://example.com/beta',
						gallery: ['https://example.com/b.png'],
						folder: '/etc',
					},
				],
			},
		})
		const apps = await startApps(root)
		try {
			await apps.procedures['appStore.addRepository'].run({url})
			const repo = (await apps.procedures['appStore.registry'].run())[0]
			assert.equal(repo.meta.name, 'Catalog Store')
			assert.deepEqual(repo.apps.map((a) => a.id).sort(), ['alpha', 'beta'])
			const by = Object.fromEntries(repo.apps.map((a) => [a.id, a]))
			assert.equal(by.alpha.description, 'from catalog alpha')
			assert.equal(by.beta.description, 'from catalog beta')
			assert.equal(by.alpha.folder, undefined, 'server paths stay private')
			assert.equal(by.beta.folder, undefined, 'server paths stay private')
			assert.equal(by.alpha.icon, 'https://example.com/alpha.svg')
			assert.equal(by.alpha.website, 'https://example.com/alpha')
			assert.deepEqual(by.alpha.gallery, ['https://example.com/a.png'])
			assert.equal(by.beta.icon, undefined)
			assert.equal(by.beta.website, undefined)
			assert.equal(by.alpha.permissions, undefined)
			assert.equal(by.alpha.compose, undefined)
			assert.ok(!JSON.stringify(repo.apps).includes('/etc'))
			assert.ok(!JSON.stringify(repo.apps).includes(store))
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a catalog entry whose folder is missing is dropped, even if it names /etc', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-evil-missing-'))
	try {
		const store = join(root, 'store')
		await writeApp(store, 'ok')
		const url = await commitStore(store, {
			catalog: {
				version: 1,
				apps: [
					{id: 'ok', name: 'Ok', description: 'from catalog'},
					{id: 'evil', name: 'Evil', description: 'should not appear', folder: '/etc'},
				],
			},
		})
		const apps = await startApps(root)
		try {
			await apps.procedures['appStore.addRepository'].run({url})
			const listed = (await apps.procedures['appStore.registry'].run())[0].apps
			assert.deepEqual(listed.map((a) => a.id), ['ok'])
			assert.ok(!JSON.stringify(listed).includes('/etc'))
			assert.ok(!JSON.stringify(listed).includes('evil'))
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a catalog folder:/etc is ignored; install copies compose from the store subdir', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-evil-dir-'))
	try {
		const store = join(root, 'store')
		await mkdir(join(store, 'evil'), {recursive: true})
		await writeFile(join(store, 'evil', 'docker-compose.yml'), 'services:\n  web:\n    image: from-store-not-etc\n')
		const url = await commitStore(store, {
			catalog: {
				version: 1,
				apps: [{id: 'evil', name: 'Evil', description: 'from catalog', folder: '/etc', permissions: ['privileged']}],
			},
		})
		const apps = await startApps(root)
		try {
			await apps.procedures['appStore.addRepository'].run({url})
			const listed = (await apps.procedures['appStore.registry'].run())[0].apps
			assert.deepEqual(listed.map((a) => a.id), ['evil'])
			assert.equal(listed[0].folder, undefined, 'server paths stay private')
			assert.ok(!JSON.stringify(listed).includes('/etc'))
			await apps.procedures['apps.install'].run({appId: 'evil'})
			const app = await until(async () => (await apps.procedures['apps.list'].run()).find((a) => a.id === 'evil' && a.state !== 'installing'))
			assert.notEqual(app.state, 'error', app.error)
			const copied = await readFile(join(root, 'data', 'apps', 'installed', 'evil', 'docker-compose.yml'), 'utf8')
			assert.match(copied, /from-store-not-etc/)
			await assert.rejects(readFile(join(root, 'data', 'apps', 'installed', 'evil', 'passwd')), /ENOENT/, 'did not copy /etc')
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('catalog ids that are not a matching app dir are skipped', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-skip-'))
	try {
		const store = join(root, 'store')
		await writeApp(store, 'ok')
		const url = await commitStore(store, {
			catalog: {
				version: 1,
				apps: [
					{id: '../x', name: 'Escape', description: 'nope'},
					{id: 'nope', name: 'Nope', description: 'no dir'},
					{id: 'ok', name: 'Ok', description: 'from catalog'},
				],
			},
		})
		const apps = await startApps(root)
		try {
			await apps.procedures['appStore.addRepository'].run({url})
			const listed = (await apps.procedures['appStore.registry'].run())[0].apps
			assert.deepEqual(listed.map((a) => a.id), ['ok'])
			assert.equal(listed[0].description, 'from catalog')
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a store without catalog.json still lists YAML apps', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-yaml-'))
	try {
		const store = join(root, 'store')
		await writeApp(store, 'notes', {description: 'from yaml'})
		await writeApp(store, 'files', {description: 'yaml files'})
		const url = await commitStore(store)
		const apps = await startApps(root)
		try {
			await apps.procedures['appStore.addRepository'].run({url})
			const listed = (await apps.procedures['appStore.registry'].run())[0].apps
			assert.deepEqual(listed.map((a) => a.id).sort(), ['files', 'notes'])
			assert.equal(listed.find((a) => a.id === 'notes').description, 'from yaml')
			assert.equal(listed[0].folder, undefined, 'server paths stay private')
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('invalid catalog.json falls back to the YAML walk without throwing', async () => {
	const root = await mkdtemp(join(tmpdir(), 'store-catalog-bad-'))
	try {
		const cases = [
			'not json',
			JSON.stringify({version: 2, apps: [{id: 'notes', description: 'from catalog'}]}),
			JSON.stringify({version: 1, apps: []}),
			JSON.stringify({version: 1, apps: {id: 'notes'}}),
		]
		for (const [i, catalog] of cases.entries()) {
			const store = join(root, `store-${i}`)
			await writeApp(store, 'notes', {description: 'from yaml'})
			const url = await commitStore(store, {catalog})
			const apps = await startApps(join(root, `data-${i}`))
			try {
				await apps.procedures['appStore.addRepository'].run({url})
				const listed = (await apps.procedures['appStore.registry'].run())[0].apps
				assert.deepEqual(listed.map((a) => a.id), ['notes'], `case ${i}`)
				assert.equal(listed[0].description, 'from yaml', `case ${i}`)
			} finally {
				apps.close()
			}
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
