import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {streamAnthropic} from '../omarchyd/assistant/anthropic.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'
import {streamChat, streamResponses} from '../omarchyd/assistant/providers.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? {userId: 'sam', role: 'member'} : null)})
const empty = () => ({ok: true, status: 200, body: (async function* () {})()})
const bodyOf = async (stream, opts) => {
	let body
	const fetchImpl = async (_url, init) => {
		body = JSON.parse(init.body)
		return empty()
	}
	for await (const _ of stream({baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [{role: 'user', content: 'hi'}], tools: [], fetchImpl, ...opts}));
	return body
}

test('each API gets the effort in its own field, and nothing when it is left to the model', async () => {
	assert.equal((await bodyOf(streamChat, {effort: 'high'})).reasoning_effort, 'high')
	assert.equal('reasoning_effort' in (await bodyOf(streamChat, {})), false)
	assert.deepEqual((await bodyOf(streamResponses, {effort: 'low'})).reasoning, {effort: 'low'})
	assert.equal('reasoning' in (await bodyOf(streamResponses, {})), false)
	const claude = await bodyOf(streamAnthropic, {effort: 'medium'})
	assert.deepEqual(claude.thinking, {type: 'adaptive'})
	assert.deepEqual(claude.output_config, {effort: 'medium'})
	assert.ok(claude.max_tokens >= 16000, 'room for thinking and the answer')
	assert.equal(claude.budget_tokens, undefined)
	const plain = await bodyOf(streamAnthropic, {})
	assert.equal(plain.thinking, undefined)
	assert.equal(plain.output_config, undefined)
})

test('a key keeps an effort; only its owner can change it, and unknown values are ignored', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'are-'))
	try {
		const keys = createKeyStore({dataDir})
		const k = await keys.add(OWNER, {provider: 'openai', apiKey: 'sk-test', model: 'gpt-5.5'})
		assert.equal(k.effort, '')
		assert.equal((await keys.update(OWNER, {id: k.id, effort: 'high'})).effort, 'high')
		assert.equal((await keys.update(OWNER, {id: k.id, effort: 'ludicrous'})).effort, 'high')
		assert.equal((await keys.update(OWNER, {id: k.id, effort: ''})).effort, '')
		await assert.rejects(() => keys.update({userId: 'sam', role: 'member'}, {id: k.id, effort: 'low'}), /Only the person who added/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a turn sends the key’s effort to the provider', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'are-'))
	const bodies = []
	const fetchImpl = async (_url, init) => {
		bodies.push(JSON.parse(init.body))
		return {ok: true, status: 200, body: (async function* () {
			yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n')
		})()}
	}
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, runProcedure: async () => null})
		const k = await asst.keys.add(OWNER, {provider: 'openai', apiKey: 'sk-test', model: 'gpt-5.5'})
		await asst.keys.update(OWNER, {id: k.id, effort: 'medium'})
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: () => {}})
		assert.deepEqual(bodies[0].reasoning, {effort: 'medium'})
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
