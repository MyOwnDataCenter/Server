import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
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

test('a member cannot use or list a key until it is shared or default', async () => {
	const dataDir = await tmp()
	try {
		const keys = createKeyStore({dataDir})
		const row = await keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'secret-key-1', model: 'grok-4.7'})
		assert.deepEqual(await keys.listPublic('sam'), [])
		await assert.rejects(() => keys.resolveForUser('sam', row.id), /isn.t/)
		await keys.update({userId: 'owner', role: 'owner'}, {id: row.id, sharedWith: ['sam']})
		assert.equal((await keys.listPublic('sam'))[0].id, row.id)
		assert.equal((await keys.resolveForUser('sam', row.id)).apiKey, 'secret-key-1')
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
