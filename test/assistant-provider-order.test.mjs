import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {visibleProviderName} from '../omarchyd/assistant/loop.mjs'

const tmp = async () => mkdtemp(join(os.tmpdir(), 'apo-'))
const owner = {userId: 'owner', role: 'owner'}
const sam = {userId: 'sam', role: 'member'}

async function store() {
	const dataDir = await tmp()
	const keys = createKeyStore({dataDir, now: (() => {
		let t = 1_700_000_000_000
		return () => t++
	})()})
	return {
		dataDir,
		keys,
		async close() {
			await rm(dataDir, {recursive: true, force: true})
		},
	}
}

test('another account does not hear the private name of a provider someone else added', () => {
	const key = {ownerUserId: 'owner', name: 'Personal Grok', provider: 'spacexai'}
	assert.equal(visibleProviderName('owner', key), 'Personal Grok')
	assert.equal(visibleProviderName('sam', key), 'Grok')
	assert.equal(visibleProviderName('sam', {ownerUserId: 'owner', name: 'Ollama', provider: 'openai-compatible'}), 'Custom')
})

test('a new provider is added at the bottom and reorder is the order chat tries', async () => {
	const box = await store()
	try {
		const grok = await box.keys.add(owner, {name: 'Grok', provider: 'spacexai', apiKey: 'xai-secret-1111', model: 'grok-4.7'})
		const openai = await box.keys.add(owner, {name: 'OpenAI', provider: 'openai', apiKey: 'sk-openai-2222', model: 'gpt-5'})
		assert.deepEqual((await box.keys.listPublic('owner')).map((k) => k.id), [grok.id, openai.id])
		assert.equal((await box.keys.resolveForUser('owner')).id, grok.id)
		await box.keys.reorder(owner, [openai.id, grok.id])
		assert.deepEqual((await box.keys.candidatesForUser('owner')).map((k) => k.id), [openai.id, grok.id])
		assert.equal((await box.keys.resolveForUser('owner')).id, openai.id)
		await assert.rejects(() => box.keys.reorder(owner, [openai.id]), /order/)
	} finally {
		await box.close()
	}
})

test('sharing a key with one account does not let them list it or chat with it', async () => {
	const box = await store()
	try {
		const grok = await box.keys.add(owner, {name: 'Grok', provider: 'spacexai', apiKey: 'xai-secret-1111', model: 'grok-4.7'})
		await assert.rejects(() => box.keys.update(owner, {id: grok.id, sharedWith: ['sam']}), /Offer/)
		assert.deepEqual(await box.keys.listPublic('sam'), [])
		await assert.rejects(() => box.keys.resolveForUser('sam', grok.id), /isn.t/)
	} finally {
		await box.close()
	}
})

test('the offer is the only provider another account can use, and they can refuse it', async () => {
	const box = await store()
	try {
		const grok = await box.keys.add(owner, {name: 'Personal Grok', provider: 'spacexai', apiKey: 'xai-secret-1111', model: 'grok-4.7'})
		const local = await box.keys.add(owner, {name: 'Ollama', provider: 'openai-compatible', apiKey: '', model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1'})
		await box.keys.update(owner, {id: local.id, systemDefault: true})
		const own = await box.keys.add(sam, {name: 'Mine', provider: 'openai', apiKey: 'sk-sam-3333', model: 'gpt-5'})
		const chain = await box.keys.candidatesForUser('sam')
		assert.deepEqual(chain.map((k) => k.id), [own.id, local.id])
		const listed = await box.keys.listPublic('sam')
		const offer = listed.at(-1)
		assert.equal(offer.offered, true)
		assert.equal(offer.mine, false)
		assert.equal(offer.provider, 'openai-compatible')
		assert.equal(offer.model, 'llama3.2')
		assert.equal(offer.name, '')
		assert.equal(offer.baseUrl, '')
		assert.equal(offer.last4, '')
		assert.equal(JSON.stringify(offer).includes('Personal'), false)
		assert.equal(JSON.stringify(offer).includes('11434'), false)
		await box.keys.useServerDefault(sam, false)
		assert.deepEqual((await box.keys.candidatesForUser('sam')).map((k) => k.id), [own.id])
		assert.equal((await box.keys.listPublic('sam')).find((k) => k.offered)?.declined, true)
		await box.keys.remove(sam, own.id)
		await assert.rejects(() => box.keys.resolveForUser('sam'), /Add an API key/)
		await box.keys.useServerDefault(sam, true)
		assert.equal((await box.keys.resolveForUser('sam')).id, local.id)
		assert.equal((await box.keys.resolveForUser('owner')).id, grok.id)
		await box.keys.clearDefault(owner)
		await assert.rejects(() => box.keys.resolveForUser('lee'), /Add an API key/)
		await assert.rejects(() => box.keys.clearDefault(sam), /owner/)
	} finally {
		await box.close()
	}
})

test('Hermes answers only when its row is first, and then nothing under it is tried', async () => {
	const box = await store()
	try {
		const grok = await box.keys.add(owner, {name: 'Grok', provider: 'spacexai', apiKey: 'xai-secret-1111', model: 'grok-4.7'})
		await box.keys.upsertHermes(owner, {baseUrl: 'http://127.0.0.1:8642/v1', apiKey: 'hermes-key-1', model: 'hermes-agent'})
		const hermes = (await box.keys.listPublic('owner')).find((k) => k.provider === 'hermes')
		await box.keys.reorder(owner, [hermes.id, grok.id])
		assert.deepEqual((await box.keys.candidatesForUser('owner')).map((k) => k.provider), ['hermes'])
		await box.keys.update(owner, {id: grok.id, systemDefault: true})
		const lee = await box.keys.candidatesForUser('lee')
		assert.deepEqual(lee.map((k) => k.id), [grok.id])
		await box.keys.reorder(owner, [grok.id, hermes.id])
		assert.deepEqual((await box.keys.candidatesForUser('owner')).map((k) => k.provider), ['spacexai'])
	} finally {
		await box.close()
	}
})

test('a signed-out ChatGPT row above Hermes does not make Hermes the only assistant', async () => {
	const box = await store()
	try {
		const grok = await box.keys.add(owner, {name: 'Grok', provider: 'spacexai', apiKey: 'xai-secret-1111', model: 'grok-4.7'})
		const chat = await box.keys.saveChatGpt('owner', {
			sub: 'user-1',
			email: 'a@b.c',
			clientId: 'client',
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			model: 'gpt-5',
		})
		await box.keys.upsertHermes(owner, {baseUrl: 'http://127.0.0.1:8642/v1', apiKey: 'hermes-key-1', model: 'hermes-agent'})
		const hermes = (await box.keys.listPublic('owner')).find((k) => k.provider === 'hermes')
		const saved = await box.keys.getSecret(chat.id)
		saved.chatgpt.refreshToken = ''
		await box.keys.reorder(owner, [chat.id, hermes.id, grok.id])
		assert.deepEqual((await box.keys.candidatesForUser('owner')).map((k) => k.provider), ['spacexai'])
	} finally {
		await box.close()
	}
})
