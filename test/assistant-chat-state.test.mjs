import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createKeyStore} from '../omarchyd/assistant/keys.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const SAM = {userId: 'sam', role: 'member'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : id === 'sam' ? SAM : null)})
const tmp = () => mkdtemp(join(os.tmpdir(), 'acs-state-'))
const chunk = (s) => new TextEncoder().encode(s)
const openaiSays = (text) => ({
	ok: true,
	status: 200,
	headers: new Headers(),
	body: (async function* () {
		yield chunk(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)
	})(),
})
const anthropicSse = (events) => ({
	ok: true,
	status: 200,
	headers: new Headers(),
	body: (async function* () {
		for (const e of events) yield chunk(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
	})(),
})
const anthropicTool = (id, name) => anthropicSse([
	{type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id, name}},
	{type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{}'}},
	{type: 'content_block_stop', index: 0},
	{type: 'message_delta', delta: {stop_reason: 'tool_use'}},
	{type: 'message_stop'},
])
const anthropicText = (text) => anthropicSse([
	{type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
	{type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}},
	{type: 'content_block_stop', index: 0},
	{type: 'message_delta', delta: {stop_reason: 'end_turn'}},
	{type: 'message_stop'},
])

test('a rejected API key update leaves the key and other defaults untouched in memory and on disk', async () => {
	const dataDir = await tmp()
	try {
		const ks = createKeyStore({dataDir, now: () => 10})
		const first = await ks.add(OWNER, {provider: 'openai', apiKey: 'sk-first-1111', model: 'gpt-first', name: 'First'})
		await ks.update(OWNER, {id: first.id, systemDefault: true})
		const k = await ks.add(OWNER, {provider: 'openai', apiKey: 'sk-abcdef1234', model: 'gpt-a', name: 'Old'})
		await ks.recordCheck(k.id, {ok: true, status: 'ok', message: 'Connected'})

		await assert.rejects(
			() => ks.update(OWNER, {id: k.id, name: 'New name', model: 'gpt-b', systemDefault: true, apiKey: 'abc'}),
			/Enter an API key/,
		)
		const listed = await ks.listPublic('owner')
		const current = listed.find((x) => x.id === k.id)
		assert.equal(current.name, 'Old')
		assert.equal(current.model, 'gpt-a')
		assert.equal(current.systemDefault, false)
		assert.equal(current.check?.ok, true)
		assert.equal(listed.find((x) => x.id === first.id).systemDefault, true)

		// An unrelated edit afterwards must not save anything from the rejected update.
		await ks.update(OWNER, {id: k.id, effort: 'high'})
		const reloaded = (await createKeyStore({dataDir}).listPublic('owner')).find((x) => x.id === k.id)
		assert.equal(reloaded.name, 'Old')
		assert.equal(reloaded.model, 'gpt-a')
		assert.equal(reloaded.effort, 'high')
		assert.equal(reloaded.systemDefault, false)
		assert.equal(reloaded.check?.ok, true)

		// Non-owner trying to change a custom endpoint along with name/model also changes nothing.
		const custom = await ks.add({userId: 'pat', role: 'owner'}, {
			provider: 'openai-compatible',
			apiKey: '',
			model: 'llama-a',
			name: 'Local',
			baseUrl: 'http://127.0.0.1:11434/v1',
		})
		await assert.rejects(
			() => ks.update({userId: 'pat', role: 'member'}, {id: custom.id, name: 'Changed', model: 'llama-b', baseUrl: 'http://10.0.0.5/v1'}),
			/Only the server’s owner can change a custom endpoint/,
		)
		const customAfter = (await ks.listPublic('pat')).find((x) => x.id === custom.id)
		assert.equal(customAfter.name, 'Local')
		assert.equal(customAfter.model, 'llama-a')
		assert.equal(customAfter.baseUrl, 'http://127.0.0.1:11434/v1')

		// A removal during the write shifts the list. The reply is the key that was edited.
		const keep = await ks.add(OWNER, {provider: 'openai', apiKey: 'sk-keep-2222', model: 'gpt-keep', name: 'Keep'})
		const [updated] = await Promise.all([
			ks.update(OWNER, {id: keep.id, name: 'Kept'}),
			ks.remove(OWNER, first.id),
		])
		assert.equal(updated.id, keep.id)
		assert.equal(updated.name, 'Kept')
		assert.equal((await ks.listPublic('owner')).some((x) => x.id === first.id), false)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a step left running across a restart is marked interrupted and reports its tool result', async () => {
	const dataDir = await tmp()
	try {
		let started
		const runningStarted = new Promise((resolve) => {
			started = resolve
		})
		const a1 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 10,
			runProcedure: () => {
				started()
				return new Promise(() => {})
			},
		})
		const chat = await a1.conversations.create('owner', {title: 'Install'})
		await a1.conversations.append('owner', chat.id, {role: 'user', content: 'install x', at: 1})
		await a1.conversations.append('owner', chat.id, {
			role: 'assistant',
			content: '',
			toolCalls: [{id: 'call_1', name: 'apps_install', arguments: '{"appId":"x"}'}],
			at: 2,
		})
		const act = await a1.conversations.putAction('owner', chat.id, {
			kind: 'rpc',
			toolName: 'apps_install',
			toolCallId: 'call_1',
			title: 'Install X',
			detail: '',
			rpc: {path: 'apps.install', input: {appId: 'x'}},
			mcp: null,
		})
		// A separate pending step in another chat must stay pending across restart.
		const other = await a1.conversations.create('owner', {title: 'Other'})
		const pendingAct = await a1.conversations.putAction('owner', other.id, {
			kind: 'rpc',
			toolName: 'apps_start',
			toolCallId: 'call_2',
			title: 'Start Y',
			detail: '',
			rpc: {path: 'apps.start', input: {appId: 'y'}},
			mcp: null,
		})

		void a1.procedures['assistant.approve'].run({actionId: act.id}, {auth: {userId: 'owner'}})
		await runningStarted

		// Restart: a fresh assistant instance on the same data directory.
		const seen = []
		const a2 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 20,
			fetchImpl: async (_url, init) => {
				seen.push(JSON.parse(init.body))
				return openaiSays('Let us try again.')
			},
			runProcedure: async () => null,
		})
		const after = await a2.conversations.get('owner', chat.id)
		assert.equal(after.actions[0].status, 'error')
		assert.match(after.actions[0].error, /Interrupted/i)
		assert.equal(after.actions[0].resolvedAt, 20)
		const outcome = after.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_1')
		assert.ok(outcome, 'appends a tool result for the interrupted step')
		assert.equal(outcome.content, after.actions[0].error)
		assert.equal((await a2.conversations.get('owner', other.id)).actions[0].id, pendingAct.id)
		assert.equal((await a2.conversations.get('owner', other.id)).actions[0].status, 'pending')

		// Continuing the chat sends the interrupted result instead of "waiting for Approve".
		await a2.keys.add(OWNER, {provider: 'openai', api: 'chat', apiKey: 'sk-test-1234', model: 'm'})
		const events = []
		await a2.runTurn({userId: 'owner', role: 'owner', conversationId: chat.id, message: 'what happened?', emit: (e) => events.push(e)})
		assert.deepEqual(events.map((e) => e.event), ['speaker', 'text', 'done'])
		const sentTool = seen[0].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1')
		assert.ok(sentTool)
		assert.match(sentTool.content, /Interrupted/i)
		assert.doesNotMatch(sentTool.content, /waiting for Approve/i)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('an existing chat falls back to another usable key when its remembered key is deleted or unshared', async () => {
	const dataDir = await tmp()
	try {
		const auths = []
		const asst = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 1,
			fetchImpl: async (_url, init) => {
				auths.push(init.headers.authorization)
				return openaiSays('hello')
			},
			runProcedure: async () => null,
		})
		const k1 = await asst.keys.add(OWNER, {provider: 'openai', api: 'chat', apiKey: 'sk-aaaa1111', model: 'm'})
		const run = async (who, opts) => {
			const events = []
			const res = await asst.runTurn({userId: who.userId, role: who.role, ...opts, emit: (e) => events.push(e)})
			return {conversationId: res.conversationId, events}
		}

		// Case 1: owner deletes the key the chat started with and adds another.
		const first = await run(OWNER, {message: 'hi'})
		assert.deepEqual(first.events.map((e) => e.event), ['speaker', 'text', 'done'])
		const k2 = await asst.keys.add(OWNER, {provider: 'openai', api: 'chat', apiKey: 'sk-bbbb2222', model: 'm'})
		await asst.keys.remove(OWNER, k1.id)
		const second = await run(OWNER, {conversationId: first.conversationId, message: 'again'})
		assert.deepEqual(second.events.map((e) => e.event), ['speaker', 'text', 'done'])
		assert.equal(auths.at(-1), 'Bearer sk-bbbb2222')
		assert.equal((await asst.conversations.get('owner', first.conversationId)).keyId, k2.id)

		// Explicit keyId still refuses an unavailable key rather than silently switching.
		const explicit = await run(OWNER, {conversationId: first.conversationId, keyId: k1.id, message: 'explicit'})
		assert.deepEqual(explicit.events, [{event: 'error', data: {message: 'That key isn’t available', conversationId: first.conversationId}}])

		// Case 2: owner withdraws the offer from a member who still has another key.
		await asst.keys.update(OWNER, {id: k2.id, systemDefault: true})
		const samChat = await run(SAM, {message: 'hello from sam'})
		assert.deepEqual(samChat.events.map((e) => e.event), ['speaker', 'text', 'done'])
		const kSam = await asst.keys.add(SAM, {provider: 'openai', api: 'chat', apiKey: 'sk-sams3333', model: 'm'})
		await asst.keys.clearDefault(OWNER)
		const samNext = await run(SAM, {conversationId: samChat.conversationId, message: 'still there?'})
		assert.deepEqual(samNext.events.map((e) => e.event), ['speaker', 'text', 'done'])
		assert.equal(auths.at(-1), 'Bearer sk-sams3333')
		assert.equal((await asst.conversations.get('sam', samChat.conversationId)).keyId, kSam.id)

		// Case 3: when no usable key remains, guide them to Settings instead of "That key isn’t available".
		await asst.keys.remove(SAM, kSam.id)
		const noneLeft = await run(SAM, {conversationId: samChat.conversationId, message: 'any key?'})
		assert.equal(noneLeft.events[0].event, 'error')
		assert.match(noneLeft.events[0].data.message, /Settings → Assistant/)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

function assertValidAnthropicHistory(messages, label) {
	assert.ok(messages.length > 0, `${label}: history is not empty`)
	assert.equal(messages[0].role, 'user', `${label}: first message is user`)
	assert.ok(messages[0].content.every((b) => b.type !== 'tool_result'), `${label}: first user message has no orphan tool_result`)
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]
		if (m.role === 'user') {
			const results = m.content.filter((b) => b.type === 'tool_result')
			if (!results.length) continue
			const prev = messages[i - 1]
			assert.equal(prev?.role, 'assistant', `${label}: tool_result follows an assistant turn`)
			const callIds = new Set(prev.content.filter((b) => b.type === 'tool_use').map((b) => b.id))
			for (const r of results) assert.ok(callIds.has(r.tool_use_id), `${label}: tool_result ${r.tool_use_id} matches previous tool_use`)
		}
	}
}

test('Anthropic requests always start with a user message and never split tool calls when history passes 40 messages', async () => {
	const dataDir = await tmp()
	try {
		const bodies = []
		const responses = [
			anthropicTool('toolu_1', 'system_uptime'),
			anthropicTool('toolu_2', 'system_uptime'),
			anthropicTool('toolu_3', 'system_uptime'),
			anthropicText('All good.'),
		]
		const asst = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 1,
			sleep: async () => {},
			fetchImpl: async (_url, init) => {
				bodies.push(JSON.parse(init.body))
				return responses.shift() ?? anthropicText('ok')
			},
			runProcedure: async (name) => (name === 'system.uptime' ? {uptime: 123} : null),
		})
		await asst.keys.add(OWNER, {provider: 'anthropic', apiKey: 'sk-ant-test-1234', model: 'claude-sonnet-4-6'})

		// Seed 36 messages (18 turns, with a tool call sitting right near the 40-message cut).
		const chat = await asst.conversations.create('owner', {title: 'Long'})
		await asst.conversations.append('owner', chat.id, {role: 'user', content: 'q0', at: 1})
		await asst.conversations.append('owner', chat.id, {role: 'assistant', content: '', toolCalls: [{id: 'toolu_old', name: 'system_uptime', arguments: '{}'}], at: 1})
		await asst.conversations.append('owner', chat.id, {role: 'tool', toolCallId: 'toolu_old', name: 'system_uptime', content: '{"uptime":1}', at: 1})
		await asst.conversations.append('owner', chat.id, {role: 'assistant', content: 'a0', at: 1})
		for (let i = 1; i < 17; i++) {
			await asst.conversations.append('owner', chat.id, {role: 'user', content: `q${i}`, at: 1})
			await asst.conversations.append('owner', chat.id, {role: 'assistant', content: `a${i}`, at: 1})
		}

		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', conversationId: chat.id, message: 'uptime please', emit: (e) => events.push(e)})
		assert.equal(bodies.length, 4)
		assert.equal(events.at(-1).event, 'done')
		for (let i = 0; i < bodies.length; i++) assertValidAnthropicHistory(bodies[i].messages, `tool-loop request ${i + 1}`)

		// Also check when summary fails on a >40 message chat: the backstop still starts with a user message.
		const failedSummaryBodies = []
		let call = 0
		const asst2 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 2,
			sleep: async () => {},
			fetchImpl: async (_url, init) => {
				const body = JSON.parse(init.body)
				if (call++ === 0) return {ok: false, status: 400, headers: new Headers(), text: async () => '{"error":{"message":"too long"}}'}
				failedSummaryBodies.push(body)
				return anthropicText('Still fine.')
			},
			runProcedure: async () => null,
		})
		const longChat = await asst2.conversations.create('owner', {title: 'Very long'})
		for (let i = 0; i < 25; i++) {
			await asst2.conversations.append('owner', longChat.id, {role: 'user', content: `u${i}`, at: 1})
			await asst2.conversations.append('owner', longChat.id, {role: 'assistant', content: `r${i}`, at: 1})
		}
		await asst2.runTurn({userId: 'owner', role: 'owner', conversationId: longChat.id, message: 'next', emit: () => {}})
		assert.equal(failedSummaryBodies.length, 1)
		assertValidAnthropicHistory(failedSummaryBodies[0].messages, 'failed-summary backstop')

		// Also check a chat where the last 40 messages have no user message (one user turn + 22 tool loops).
		const deepBodies = []
		const asst3 = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 3,
			sleep: async () => {},
			fetchImpl: async (_url, init) => {
				deepBodies.push(JSON.parse(init.body))
				return anthropicText('Done.')
			},
			runProcedure: async () => null,
		})
		const deepChat = await asst3.conversations.create('owner', {title: 'Deep tools'})
		await asst3.conversations.append('owner', deepChat.id, {role: 'user', content: 'run everything', at: 1})
		for (let i = 0; i < 22; i++) {
			await asst3.conversations.append('owner', deepChat.id, {role: 'assistant', content: '', toolCalls: [{id: `toolu_d${i}`, name: 'system_uptime', arguments: '{}'}], at: 1})
			await asst3.conversations.append('owner', deepChat.id, {role: 'tool', toolCallId: `toolu_d${i}`, name: 'system_uptime', content: '{}', at: 1})
		}
		await asst3.runTurnContinue({userId: 'owner', role: 'owner', conversationId: deepChat.id, emit: () => {}})
		assert.equal(deepBodies.length, 1)
		assertValidAnthropicHistory(deepBodies[0].messages, 'deep tool chain')
		const deepText = JSON.stringify(deepBodies[0].messages)
		assert.ok(deepBodies[0].messages.length <= 40, 'deep tool chain stays within 40 messages')
		assert.equal(deepText.includes('toolu_d0'), false)
		assert.equal(deepText.includes('toolu_d21'), true)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('an error in the first reply of a new chat carries the chat id so the next message stays in that chat', async () => {
	const dataDir = await tmp()
	try {
		const bodies = []
		let n = 0
		const cutOff = () => ({
			ok: true,
			status: 200,
			headers: new Headers(),
			body: (async function* () {
				yield chunk(`data: ${JSON.stringify({choices: [{delta: {content: 'The disk is mostly full, '}, finish_reason: 'length'}]})}\n\ndata: [DONE]\n\n`)
			})(),
		})
		const asst = createAssistant({
			dataDir,
			accounts: fakeAccounts(),
			now: () => 1,
			fetchImpl: async (_url, init) => {
				bodies.push(JSON.parse(init.body))
				return n++ === 0 ? cutOff() : openaiSays('Continuing.')
			},
			runProcedure: async () => null,
		})
		await asst.keys.add(OWNER, {provider: 'openai', api: 'chat', apiKey: 'sk-test-1234', model: 'm'})
		const first = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'why is my disk full?', emit: (e) => first.push(e)})
		const err = first.find((e) => e.event === 'error')
		assert.ok(err, 'the first reply ends in an error')
		assert.equal(first.some((e) => e.event === 'done'), false)
		assert.ok(err.data.conversationId, 'the error event names the chat')
		await asst.runTurn({userId: 'owner', role: 'owner', conversationId: err.data.conversationId, message: 'please continue', emit: () => {}})
		assert.equal((await asst.conversations.list('owner')).length, 1)
		assert.ok(bodies[1].messages.some((m) => m.role === 'user' && /why is my disk full/.test(m.content)))
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
