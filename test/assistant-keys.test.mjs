import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {RpcError} from '../omarchyd/rpc.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const tmp = async () => mkdtemp(join(os.tmpdir(), 'ask-'))

test('addKey stores the secret on disk and listPublic never returns it', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir, now: () => 1_700_000_000_000})
		const row = await keys.add({userId: 'owner', role: 'owner'}, {name: 'My xAI', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		assert.equal(row.provider, 'spacexai')
		assert.equal(row.baseUrl, 'https://api.x.ai/v1')
		assert.equal(row.last4, 'abcd')
		assert.equal(row.mine, true)
		assert.equal(row.apiKey, undefined)
		const listed = await keys.listPublic('owner')
		assert.equal(listed.length, 1)
		assert.equal(listed[0].apiKey, undefined)
		assert.equal(listed[0].last4, 'abcd')
		const raw = JSON.parse(await readFile(join(dataDir, 'assistant', 'keys.json'), 'utf8'))
		assert.equal(raw.keys[0].apiKey, 'xai-secret-abcd')
		assert.equal((await stat(join(dataDir, 'assistant', 'keys.json'))).mode & 0o777, 0o600)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('openai-compatible accepts an empty API key', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add({userId: 'owner', role: 'owner'}, {
			name: 'Local Ollama',
			provider: 'openai-compatible',
			apiKey: '',
			model: 'spark-x2.5-4b',
			baseUrl: 'http://127.0.0.1:11434/v1',
		})
		assert.equal(row.last4, '')
		assert.equal(row.apiKey, undefined)
		const raw = JSON.parse(await readFile(join(dataDir, 'assistant', 'keys.json'), 'utf8'))
		assert.equal(raw.keys[0].apiKey, '')
		await assert.rejects(
			() => keys.add({userId: 'owner', role: 'owner'}, {name: 'x', provider: 'spacexai', apiKey: '', model: 'grok-4.7'}),
			/API key/,
		)
		await assert.rejects(
			() => keys.add({userId: 'owner', role: 'owner'}, {name: 'x', provider: 'openai', apiKey: '', model: 'gpt-x'}),
			/API key/,
		)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('openai-compatible adds /v1 when the base URL has no path', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add({userId: 'owner', role: 'owner'}, {
			name: 'Local Ollama',
			provider: 'openai-compatible',
			apiKey: 'ollama',
			model: 'spark-x2.5-4b',
			baseUrl: 'http://127.0.0.1:11434',
		})
		assert.equal(row.baseUrl, 'http://127.0.0.1:11434/v1')
		const already = await keys.add({userId: 'owner', role: 'owner'}, {
			name: 'with v1',
			provider: 'openai-compatible',
			apiKey: 'ollama',
			model: 'llama',
			baseUrl: 'http://127.0.0.1:11434/v1/',
		})
		assert.equal(already.baseUrl, 'http://127.0.0.1:11434/v1')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a member cannot use or list a key another person added', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'secret-key-1', model: 'grok-4.7'})
		assert.deepEqual(await keys.listPublic('sam'), [])
		await assert.rejects(() => keys.resolveForUser('sam', row.id), /isn.t/)
		await assert.rejects(() => keys.update({userId: 'owner', role: 'owner'}, {id: row.id, sharedWith: ['sam']}), /Offer/)
		assert.deepEqual(await keys.listPublic('sam'), [])
		await assert.rejects(() => keys.resolveForUser('sam', row.id), /isn.t/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a person who is not the owner can add only the loopback model address', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		await assert.rejects(() => keys.add({userId: 'sam', role: 'member'}, {name: 'b', provider: 'openai-compatible', apiKey: '', model: 'llama', baseUrl: 'http://127.0.0.1:2021/v1'}), /Only the server’s owner can add a custom endpoint/)
		const here = await keys.add({userId: 'sam', role: 'member'}, {name: 'Here', provider: 'openai-compatible', apiKey: '', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1'})
		assert.equal(here.baseUrl, 'http://127.0.0.1:11434/v1')
		assert.equal((await keys.listPublic('owner')).some((k) => k.id === here.id), false)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('only the server owner can set systemDefault, and only on a key they own', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const a = await keys.add({userId: 'owner', role: 'owner'}, {name: 'a', provider: 'spacexai', apiKey: 'aaaa', model: 'grok-4.7'})
		// A member can't point omarchyd at an arbitrary address, but can add a key for a known provider.
		await assert.rejects(() => keys.add({userId: 'sam', role: 'member'}, {name: 'b', provider: 'openai-compatible', apiKey: 'bbbb', model: 'llama', baseUrl: 'http://192.168.1.1/v1'}), /Only the server’s owner can add a custom endpoint/)
		const b = await keys.add({userId: 'sam', role: 'member'}, {name: 'b', provider: 'openai', apiKey: 'bbbb', model: 'gpt-x', baseUrl: 'http://192.168.1.1/v1'})
		assert.equal(b.baseUrl, 'https://api.openai.com/v1')
		const leftover = await keys.add({userId: 'pat', role: 'owner'}, {name: 'lan', provider: 'openai-compatible', apiKey: '', model: 'llama', baseUrl: 'http://127.0.0.1:11434/v1'})
		await assert.rejects(() => keys.update({userId: 'pat', role: 'member'}, {id: leftover.id, baseUrl: 'http://192.168.1.1/v1'}), /Only the server’s owner can change a custom endpoint/)
		assert.equal((await keys.getSecret(leftover.id)).baseUrl, 'http://127.0.0.1:11434/v1')
		await assert.rejects(() => keys.update({userId: 'sam', role: 'member'}, {id: b.id, systemDefault: true}), /owner/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: a.id, systemDefault: true})
		await assert.rejects(() => keys.update({userId: 'owner', role: 'owner'}, {id: b.id, systemDefault: true}), /own/)
		const second = await keys.add({userId: 'owner', role: 'owner'}, {name: 'c', provider: 'spacexai', apiKey: 'cccc', model: 'grok-4.7'})
		await keys.update({userId: 'owner', role: 'owner'}, {id: second.id, systemDefault: true})
		const listed = await keys.listPublic('owner')
		assert.equal(listed.find((k) => k.id === a.id).systemDefault, false)
		assert.equal(listed.find((k) => k.id === second.id).systemDefault, true)
		// Own key beats the system default. Someone with neither gets the current default.
		assert.equal((await keys.resolveForUser('sam')).id, b.id)
		assert.equal((await keys.resolveForUser('lee')).id, second.id)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('assistant key RPCs: member cannot set default; secret stays off the wire', async () => {
	const root = await tmp()
	const data = join(root, 'data')
	try {
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const file = join(data, 'accounts.json')
		const state = JSON.parse(await readFile(file, 'utf8'))
		state.users.push({userId: 'sam', name: 'Sam', role: 'member', language: 'en', salt: state.users[0].salt, hash: state.users[0].hash, createdAt: Date.now()})
		await writeFile(file, JSON.stringify(state, null, '\t'))
		const d = await startOmarchyd({port: 0, dataDir: data, home: root})
		try {
			const login = async (userId) => {
				const r = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})).json()
				return {authorization: `Bearer ${r.result.data.accessToken}`, 'content-type': 'application/json'}
			}
			const owner = await login('owner')
			const member = await login('sam')
			const added = await (await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers: owner, body: JSON.stringify({name: 'x', provider: 'spacexai', apiKey: 'sk-live-9999', model: 'grok-4.7'})})).json()
			assert.equal(added.result.data.last4, '9999')
			assert.equal(added.result.data.apiKey, undefined)
			assert.match(JSON.stringify(added), /^(?!.*sk-live-9999).*$/)
			const def = await fetch(`${d.url}/trpc/assistant.updateKey`, {method: 'POST', headers: member, body: JSON.stringify({id: added.result.data.id, systemDefault: true})})
			assert.equal(def.status, 403)
			const custom = await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers: member, body: JSON.stringify({name: 'lan', provider: 'openai-compatible', apiKey: 'x', model: 'llama', baseUrl: 'http://192.168.1.1/v1'})})
			assert.equal(custom.status, 403)
			const openai = await (await fetch(`${d.url}/trpc/assistant.addKey`, {method: 'POST', headers: member, body: JSON.stringify({name: 'oai', provider: 'openai', apiKey: 'sk-live-openai', model: 'gpt-x'})})).json()
			assert.equal(openai.result.data.provider, 'openai')
			assert.equal(openai.result.data.baseUrl, 'https://api.openai.com/v1')
			assert.equal(openai.result.data.apiKey, undefined)
		} finally {
			await d.close()
		}
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

async function captureErrors(fn) {
	const lines = []
	const orig = console.error
	console.error = (...args) => lines.push(args.map(String).join(' '))
	try {
		return await fn(lines)
	} finally {
		console.error = orig
	}
}

function assertSafeKeysError(err, dataDir, file) {
	assert.ok(err instanceof RpcError, `expected RpcError, got ${err?.constructor?.name}`)
	assert.equal(err.code, 'PRECONDITION_FAILED')
	assert.match(err.message, /keys\.json/)
	assert.equal(err.message.includes(dataDir), false)
	assert.equal(err.message.includes(file), false)
	assert.equal(err.message.includes('xai-super-secret-9999'), false)
}

test('damaged or non-object keys.json logs basename once, starts empty, and refuses saves', async () => {
	const cases = [
		['empty', ''],
		['truncated', '{"keys":[{"id":"k1","apiKey":"xai-super-secret-9999"'],
		['bom', '\uFEFF{"keys":[]}'],
		['null', 'null'],
		['string', '"x"'],
		['number', '5'],
		['array', '[]'],
		['missing keys', '{}'],
		['keys null', '{"keys":null}'],
		['keys string', '{"keys":"bad"}'],
	]
	for (const [name, contents] of cases) {
		const dataDir = await tmp()
		const dir = join(dataDir, 'assistant')
		const file = join(dir, 'keys.json')
		try {
			await mkdir(dir, {recursive: true})
			await writeFile(file, contents)
			const before = await readFile(file)
			await captureErrors(async (lines) => {
				const keys = createKeyStore({dataDir})
				assert.deepEqual(await keys.listPublic('owner'), [], name)
				assert.equal(await keys.getSecret('k1'), null, name)
				await assert.rejects(
					() => keys.resolveForUser('owner'),
					(err) => err instanceof RpcError && err.code === 'PRECONDITION_FAILED' && /Add an API key/.test(err.message),
					name,
				)
				for (const attempt of [
					() => keys.add({userId: 'owner', role: 'owner'}, {name: 'New', provider: 'spacexai', apiKey: 'sk-new-1234', model: 'grok-4.7'}),
					() => keys.update({userId: 'owner', role: 'owner'}, {id: 'k1', name: 'Renamed'}),
					() => keys.remove({userId: 'owner', role: 'owner'}, 'k1'),
					() => keys.recordCheck('k1', {ok: true, status: 'ok', message: 'ok'}),
				]) {
					await assert.rejects(attempt, (err) => {
						assertSafeKeysError(err, dataDir, file)
						return true
					}, name)
				}
				assert.deepEqual(await readFile(file), before, name)
				const notes = lines.filter((l) => l.includes('keys.json'))
				assert.equal(notes.length, 1, `${name}: logged once (${JSON.stringify(lines)})`)
				assert.equal(notes[0].includes(dataDir), false, `${name}: no dataDir`)
				assert.equal(notes[0].includes(file), false, `${name}: no file path`)
				if (contents.length > 0) assert.equal(notes[0].includes(contents), false, `${name}: no contents`)
				assert.equal(notes[0].includes('xai-super-secret-9999'), false, `${name}: no secret`)
			})
		} finally {
			await rm(dataDir, {recursive: true, force: true})
		}
	}
})

test('EISDIR or EACCES on keys.json logs basename once and refuses saves without touching disk', async (t) => {
	const root = await tmp()
	try {
		const dirData = join(root, 'dir')
		const dirFile = join(dirData, 'assistant', 'keys.json')
		await mkdir(dirFile, {recursive: true})
		await captureErrors(async (lines) => {
			const keys = createKeyStore({dataDir: dirData})
			assert.deepEqual(await keys.listPublic('owner'), [])
			assert.equal(lines.length, 1)
			assert.match(lines[0], /keys\.json/)
			assert.equal(lines[0].includes(dirData), false)
			await assert.rejects(
				() => keys.add({userId: 'owner', role: 'owner'}, {name: 'x', provider: 'spacexai', apiKey: 'sk-1234', model: 'grok-4.7'}),
				(err) => {
					assertSafeKeysError(err, dirData, dirFile)
					return true
				},
			)
			assert.equal((await stat(dirFile)).isDirectory(), true)
		})

		if (process.getuid?.() === 0) return t.skip('root ignores file mode')
		const accData = join(root, 'eacces')
		const accFile = join(accData, 'assistant', 'keys.json')
		await mkdir(join(accData, 'assistant'), {recursive: true})
		await writeFile(accFile, '{"keys":[]}', {mode: 0o600})
		await chmod(accFile, 0o000)
		try {
			await captureErrors(async (lines) => {
				const keys = createKeyStore({dataDir: accData})
				assert.deepEqual(await keys.listPublic('owner'), [])
				assert.equal(lines.length, 1)
				assert.match(lines[0], /keys\.json/)
				assert.equal(lines[0].includes(accData), false)
				await assert.rejects(
					() => keys.add({userId: 'owner', role: 'owner'}, {name: 'x', provider: 'spacexai', apiKey: 'sk-1234', model: 'grok-4.7'}),
					(err) => {
						assertSafeKeysError(err, accData, accFile)
						return true
					},
				)
			})
		} finally {
			await chmod(accFile, 0o600)
		}
		assert.equal(await readFile(accFile, 'utf8'), '{"keys":[]}')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('valid keys.json drops non-object rows and normalizes sharedWith to an array', async () => {
	const dataDir = await tmp()
	const file = join(dataDir, 'assistant', 'keys.json')
	try {
		await mkdir(join(dataDir, 'assistant'), {recursive: true})
		await writeFile(
			file,
			JSON.stringify({
				keys: [
					null,
					'bad',
					42,
					[],
					{id: 'k1', ownerUserId: 'owner', name: 'Good', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-good', last4: 'good', systemDefault: false, createdAt: 1, updatedAt: 1},
					{id: 'k2', ownerUserId: 'owner', name: 'NullShared', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'sk-two', last4: 'two', sharedWith: null, systemDefault: false, createdAt: 2, updatedAt: 2},
				],
			}),
		)
		await captureErrors(async (lines) => {
			const keys = createKeyStore({dataDir})
			const ownerList = await keys.listPublic('owner')
			assert.deepEqual(ownerList.map((k) => k.id), ['k2', 'k1'])
			assert.deepEqual(ownerList.map((k) => k.sharedWith), [[], []])
			assert.deepEqual(await keys.listPublic('sam'), [])
			assert.equal((await keys.resolveForUser('owner')).id, 'k2')
			assert.equal((await keys.resolveForUser('owner', 'k1')).id, 'k1')
			assert.deepEqual(lines, [])
			const added = await keys.add({userId: 'owner', role: 'owner'}, {name: 'Three', provider: 'spacexai', apiKey: 'sk-three', model: 'grok-4.7'})
			const saved = JSON.parse(await readFile(file, 'utf8'))
			assert.deepEqual(saved.keys.map((k) => k.id), ['k1', 'k2', added.id])
		})
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
