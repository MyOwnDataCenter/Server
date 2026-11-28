// A store whose apps depend on each other in many overlapping ways is listed at once. Checking one
// app for a dependency loop used to walk every path through the graph, so a chain of apps that
// each need the next two took longer than anyone would wait and the server stopped answering.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'
import {gitArgv} from './git-nosign.mjs'

const git = (args, cwd) => execFileSync('git', gitArgv(args), {cwd, stdio: 'pipe'}).toString()

test('a store of overlapping dependencies lists at once, and a real loop is still found', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'dep-diamond-'))
	const prev = process.env.DOCKER_HOST
	const sock = join(root, 'podman.sock')
	await writeFile(sock, '')
	process.env.DOCKER_HOST = `unix://${sock}`
	const store = join(root, 'store')
	const total = 38
	for (let i = 0; i < total; i++) {
		const deps = [i + 1, i + 2].filter((n) => n < total).map((n) => `  - app-${n}\n`).join('')
		await mkdir(join(store, `app-${i}`), {recursive: true})
		await writeFile(join(store, `app-${i}/omarchy-app.yml`), `manifestVersion: 1\nid: app-${i}\nname: App ${i}\nport: ${30000 + i}\n${deps ? `dependencies:\n${deps}` : ''}`)
		await writeFile(join(store, `app-${i}/docker-compose.yml`), 'services:\n  web:\n    image: x\n')
	}
	// Two apps that need each other, off to one side.
	for (const [id, other] of [['loop-a', 'loop-b'], ['loop-b', 'loop-a']]) {
		await mkdir(join(store, id), {recursive: true})
		await writeFile(join(store, `${id}/omarchy-app.yml`), `manifestVersion: 1\nid: ${id}\nname: ${id}\nport: 31000\ndependencies:\n  - ${other}\n`)
		await writeFile(join(store, `${id}/docker-compose.yml`), 'services:\n  web:\n    image: x\n')
	}
	git(['init', '-q', '-b', 'main'], store)
	git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], store)
	git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'store'], store)
	const run = async (cmd, args) => (cmd === 'git' ? git(args, store) : cmd === 'podman' && args[0] === 'info' ? '{}' : '')
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, gatewayHost: '127.0.0.1', defaultStores: [{url: `file://${store}`}], run, systemApps: null})
	try {
		await apps.ready
		const started = Date.now()
		const registry = await apps.procedures['appStore.registry'].run()
		const took = Date.now() - started
		const listed = registry.flatMap((s) => s.apps)
		assert.equal(listed.length, total + 2)
		assert.ok(took < 2000, `listing took ${took} ms`)
		assert.match(listed.find((a) => a.id === 'loop-a').unsupported, /loop/)
		assert.equal(listed.find((a) => a.id === 'app-0').unsupported, undefined)
	} finally {
		apps.close()
		if (prev === undefined) delete process.env.DOCKER_HOST
		else process.env.DOCKER_HOST = prev
		await rm(root, {recursive: true, force: true})
	}
})
