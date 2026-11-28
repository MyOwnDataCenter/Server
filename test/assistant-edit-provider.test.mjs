import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createKeyStore, normalizeBaseUrl} from '../omarchyd/assistant/keys.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const SAM = {userId: 'sam', role: 'member'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? SAM : null)})
const json = (status, body) => ({ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body)})

async function setup() {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aep-'))
	const seen = []
	const fetchImpl = async (url, opts) => {
		seen.push({url, auth: opts.headers.authorization})
		return json(200, {data: [{id: 'm'}]})
	}
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 5, fetchImpl})
	const verify = (input, userId = 'owner') => asst.procedures['assistant.verifyKey'].run(input, {auth: {userId}})
	return {dataDir, seen, asst, verify}
}

test('editing a key checks a newly typed key with the saved address, and records nothing until it is saved', async () => {
	const {dataDir, seen, asst, verify} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai', apiKey: 'sk-old-key', model: 'm'})
		const r = await verify({id: k.id, apiKey: 'sk-new-key'})
		assert.equal(r.ok, true)
		assert.equal(seen.at(-1).url, 'https://api.openai.com/v1/models')
		assert.equal(seen.at(-1).auth, 'Bearer sk-new-key')
		const [listed] = await asst.keys.listPublic('owner')
		assert.equal(listed.check, null, 'a check of unsaved details is not recorded')
		// A preset's address can't be changed by checking.
		await verify({id: k.id, apiKey: 'sk-new-key', baseUrl: 'http://10.0.0.9/v1'})
		assert.equal(seen.at(-1).url, 'https://api.openai.com/v1/models')
		// The saved key is used when none is typed, and that check is recorded.
		await verify({id: k.id, apiKey: '  '})
		assert.equal(seen.at(-1).auth, 'Bearer sk-old-key')
		assert.equal((await asst.keys.listPublic('owner'))[0].check.ok, true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a custom endpoint’s new address is checked with its saved key; only the owner may, and only the key’s owner may try new details', async () => {
	const {dataDir, seen, asst, verify} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: 'local-key', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1'})
		await verify({id: k.id, baseUrl: 'http://127.0.0.1:8000'})
		assert.equal(seen.at(-1).url, 'http://127.0.0.1:8000/v1/models')
		assert.equal(seen.at(-1).auth, 'Bearer local-key')
		await assert.rejects(() => verify({id: k.id, baseUrl: 'ftp://x'}), /base URL/)
		await asst.keys.update(OWNER, {id: k.id, systemDefault: true})
		const before = seen.length
		await assert.rejects(() => verify({id: k.id, apiKey: 'sam-key'}, 'sam'), /Only the person who added/)
		await assert.rejects(() => verify({id: k.id, baseUrl: 'http://10.0.0.5'}, 'sam'), /Only the person who added/)
		assert.equal(seen.length, before)
		// Sam can still check the offered key as it is.
		assert.equal((await verify({id: k.id}, 'sam')).ok, true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('another account does not hear the address when an offered provider cannot be reached', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aep-'))
	const fetchImpl = async () => {
		throw new Error('connect ECONNREFUSED 10.1.2.3:8443')
	}
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 5, fetchImpl})
		const k = await asst.keys.add(OWNER, {name: 'Personal', provider: 'openai-compatible', apiKey: 'local-key', model: 'm', baseUrl: 'http://10.1.2.3:8443/v1'})
		await asst.keys.update(OWNER, {id: k.id, systemDefault: true})
		const seen = await asst.procedures['assistant.verifyKey'].run({id: k.id}, {auth: {userId: 'sam'}})
		assert.equal(seen.ok, false)
		assert.equal(seen.message, 'That provider did not answer.')
		assert.equal(JSON.stringify(seen).includes('10.1.2.3'), false)
		assert.equal(JSON.stringify(seen).includes('8443'), false)
		const own = await asst.procedures['assistant.verifyKey'].run({id: k.id}, {auth: {userId: 'owner'}})
		assert.match(own.message, /10\.1\.2\.3/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('saving an edit changes the name, key and address together and clears the old check', async () => {
	const {dataDir, asst} = await setup()
	try {
		const k = await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: '', model: 'm', baseUrl: 'http://127.0.0.1:11434/v1'})
		await asst.keys.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})
		const out = await asst.procedures['assistant.updateKey'].run({id: k.id, name: 'Workstation', apiKey: 'tok-1234', baseUrl: 'http://127.0.0.1:8000'}, {auth: {userId: 'owner'}})
		assert.equal(out.name, 'Workstation')
		assert.equal(out.last4, '1234')
		assert.equal(out.baseUrl, 'http://127.0.0.1:8000/v1')
		assert.equal(out.check, null)
		assert.equal(out.apiKey, undefined)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a pasted endpoint address is trimmed back to its base', () => {
	assert.equal(normalizeBaseUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1')
	assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/v1/chat/completions/'), 'http://127.0.0.1:8000/v1')
	assert.equal(normalizeBaseUrl('http://box:1234/v1/models'), 'http://box:1234/v1')
	assert.equal(normalizeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1')
	assert.equal(normalizeBaseUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1')
})

test('a custom endpoint saved with a pasted endpoint path is fixed when keys load', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aep-'))
	try {
		await mkdir(join(dataDir, 'assistant'), {recursive: true})
		const row = {id: 'k1', name: 'Mine', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1/responses', apiKey: 'sk-x', last4: 'sk-x', model: 'm', ownerUserId: 'owner', sharedWith: [], systemDefault: true, createdAt: 1, updatedAt: 1}
		await writeFile(join(dataDir, 'assistant', 'keys.json'), JSON.stringify({keys: [row]}))
		const [listed] = await createKeyStore({dataDir}).listPublic('owner')
		assert.equal(listed.baseUrl, 'https://api.openai.com/v1')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a model that only takes tools through /responses is moved there, and that is remembered', async () => {
	const {chatOrResponses, forgetResponsesModels, wantsResponses} = await import('../omarchyd/assistant/providers.mjs')
	forgetResponsesModels()
	const refusal = "Function tools with reasoning_effort are not supported for gpt-6.2-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."
	assert.equal(wantsResponses({type: 'error', status: 400, message: refusal}), true)
	assert.equal(wantsResponses({type: 'error', status: 400, message: 'This model is only available in the Responses API'}), true)
	assert.equal(wantsResponses({type: 'error', status: 400, message: 'Invalid value for responses'}), false)
	assert.equal(wantsResponses({type: 'error', status: 500, message: refusal}), false)
	const urls = []
	const fetchImpl = async (url) => {
		urls.push(url)
		if (url.endsWith('/chat/completions')) return json(400, {error: {message: refusal}})
		return {ok: true, status: 200, headers: new Headers(), body: (async function* () {
			yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"pong"}\n\ndata: {"type":"response.completed"}\n\n')
		})()}
	}
	const run = async () => {
		const out = []
		for await (const ev of chatOrResponses({baseUrl: 'http://x/v1', apiKey: 'k', model: 'gpt-6.2-sol', messages: [{role: 'user', content: 'hi'}], tools: [{type: 'function', function: {name: 't', parameters: {}}}], fetchImpl})) out.push(ev)
		return out
	}
	assert.deepEqual(await run(), [{type: 'text', text: 'pong'}])
	assert.deepEqual(urls, ['http://x/v1/chat/completions', 'http://x/v1/responses'])
	await run()
	assert.deepEqual(urls.slice(2), ['http://x/v1/responses'], 'goes straight to /responses next time')
	forgetResponsesModels()
})
