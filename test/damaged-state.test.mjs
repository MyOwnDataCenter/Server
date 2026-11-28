// A damaged apps.json or swarm.json is the list of installed apps, or every enrolled
// computer's key hash. Startup must leave those bytes alone and keep running.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'
import {createConnector} from '../omarchyd/connector.mjs'

const logsOf = (t) => {
	const logs = []
	t.mock.method(console, 'error', (...args) => logs.push(args.map(String).join(' ')))
	return logs
}
// What the connector reads from the WebSocket handshake. 401 makes it delete its own key.
const answerHandshake = async (swarm, authorization) => {
	const chunks = []
	const socket = {write: (s) => (chunks.push(String(s)), true), destroy() {}}
	await swarm.upgradeAgent({headers: {authorization}}, socket, Buffer.alloc(0))
	return chunks.join('')
}

test('a damaged apps.json is left unchanged, and the app list stays empty', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-apps-bad-'))
	const logs = logsOf(t)
	try {
		const data = join(root, 'data')
		const file = join(data, 'apps', 'apps.json')
		await mkdir(join(data, 'apps'), {recursive: true})
		const cases = [
			'{"stores":[{"url":"https://x/y","syncedAt":1}],"apps":[{"id":"nextcloud","defaultPassword":"secret-pass"},{"id":"gitea"}],"recen',
			'"hello"',
			'{"stores":"oops"}',
		]
		for (const damaged of cases) {
			logs.length = 0
			await writeFile(file, damaged)
			const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: []})
			try {
				await apps.ready
				assert.deepEqual((await apps.procedures['apps.list'].run()).map((a) => a.id), [])
				assert.equal(await readFile(file, 'utf8'), damaged)
				await assert.rejects(apps.revokePasses('owner'), /apps\.json is damaged/)
				assert.equal(await readFile(file, 'utf8'), damaged)
				assert.equal(logs.length, 1)
				assert.match(logs[0], /couldn’t load apps\.json/)
				assert.equal(logs[0].includes(root), false)
				assert.equal(logs[0].includes('secret-pass'), false)
				assert.equal(logs[0].includes('nextcloud'), false)
			} finally {
				apps.close()
			}
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a valid apps.json still loads its apps', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-apps-ok-'))
	try {
		const data = join(root, 'data')
		const file = join(data, 'apps', 'apps.json')
		await mkdir(join(data, 'apps'), {recursive: true})
		const saved = JSON.stringify({
			defaultsAdded: true,
			umbrelStoreRemoved: true,
			permissionsVersion: 2,
			stores: [],
			apps: [{id: 'nextcloud', name: 'Nextcloud', state: 'error'}],
			recent: [],
		})
		await writeFile(file, saved)
		const apps = createApps({dataDir: data, home: join(root, 'home'), run: async () => '', defaultStores: []})
		try {
			await apps.ready
			assert.deepEqual((await apps.procedures['apps.list'].run()).map((a) => a.id), ['nextcloud'])
			assert.equal(await readFile(file, 'utf8'), saved)
		} finally {
			apps.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a damaged swarm.json is left unchanged, and the swarm stays empty', async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-swarm-bad-'))
	const logs = logsOf(t)
	try {
		const file = join(root, 'swarm.json')
		execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=t'], {cwd: root, stdio: 'ignore'})
		const cases = [
			'',
			'\uFEFF{"agents":[]}',
			'{"agents":[{"id":"abc","name":"Kept","keyHash":"secret-hash"',
			'{"agents":[null]}',
			'{"agents":[{"id":"abc","name":"Kept"}]}',
		]
		for (const damaged of cases) {
			logs.length = 0
			await writeFile(file, damaged)
			const swarm = createConnector({dataDir: root, tlsDir: root})
			try {
				assert.deepEqual(await swarm.procedures['swarm.list'].run(), [])
				assert.equal(await readFile(file, 'utf8'), damaged)
				const {token} = await swarm.procedures['swarm.pair'].run({})
				const joined = await swarm.enroll({token, info: {hostname: 'pc'}, abilities: {}})
				assert.equal(joined.status, 503)
				assert.equal(joined.body.error, 'swarm.json is damaged and was left unchanged.')
				const handshake = await answerHandshake(swarm, `Bearer aabbccddeeff:${'a'.repeat(43)}`)
				assert.match(handshake, /HTTP\/1\.1 503 /)
				assert.equal(handshake.includes('401'), false)
				assert.deepEqual(await swarm.procedures['swarm.list'].run(), [])
				assert.equal(await readFile(file, 'utf8'), damaged)
				assert.equal(logs.length, 1)
				assert.match(logs[0], /couldn’t load swarm\.json/)
				assert.equal(logs[0].includes(root), false)
				assert.equal(logs[0].includes('secret-hash'), false)
				assert.equal(logs[0].includes('Kept'), false)
			} finally {
				swarm.close()
			}
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('a valid swarm.json still loads its computers', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-swarm-ok-'))
	try {
		const file = join(root, 'swarm.json')
		const saved = JSON.stringify({
			agents: [{id: 'aabbccddeeff', name: 'Study PC', keyHash: 'ab', allowed: {terminal: true}, on: {terminal: true}, enrolledAt: 1}],
		})
		await writeFile(file, saved)
		const swarm = createConnector({dataDir: root, tlsDir: root})
		try {
			const listed = await swarm.procedures['swarm.list'].run()
			assert.deepEqual(listed.map((a) => a.id), ['aabbccddeeff'])
			assert.equal(await readFile(file, 'utf8'), saved)
			const handshake = await answerHandshake(swarm, `Bearer aabbccddeeff:${'a'.repeat(43)}`)
			assert.match(handshake, /HTTP\/1\.1 401 /)
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

// remote-apps.json lists the apps installed on joined computers. A damaged file is not an empty list:
// removing a computer must not overwrite it.
const twoComputers = JSON.stringify({
	agents: [
		{id: 'aabbccddeeff', name: 'Study PC', keyHash: 'ab', allowed: {}, on: {}, enrolledAt: 1},
		{id: '112233445566', name: 'Garage PC', keyHash: 'cd', allowed: {}, on: {}, enrolledAt: 2},
	],
})

test('a damaged remote-apps.json is left unchanged when a computer is removed', async (t) => {
	const logs = logsOf(t)
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-remote-apps-bad-'))
	try {
		await writeFile(join(root, 'swarm.json'), twoComputers)
		const file = join(root, 'remote-apps.json')
		await writeFile(file, '{"apps": [')
		const swarm = createConnector({dataDir: root, tlsDir: root})
		try {
			assert.deepEqual(await swarm.remoteApps(), [])
			await swarm.procedures['swarm.remove'].run({id: 'aabbccddeeff'})
			assert.equal(await readFile(file, 'utf8'), '{"apps": [')
			assert.ok(logs.some((l) => /remote-apps\.json/.test(l)), 'the damaged file is reported')
		} finally {
			swarm.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

