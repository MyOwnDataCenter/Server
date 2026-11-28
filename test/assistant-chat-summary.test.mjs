import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {needsSummary, pickCut, SUMMARY_PROMPT, transcript} from '../omarchyd/assistant/summary.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : null)})
const chunk = (s) => new TextEncoder().encode(s)
// A Chat Completions stream that says `text`.
const says = (text) => ({ok: true, status: 200, headers: new Headers(), body: (async function* () {
	yield chunk(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)
})()})
const user = (content) => ({role: 'user', content, at: 1})
const reply = (content) => ({role: 'assistant', content, at: 1})
// n question/answer pairs, numbered so the test can tell which ones were sent.
const pairs = (n, size = 10) => Array.from({length: n}, (_, i) => [user(`q${i} ${'x'.repeat(size)}`), reply(`a${i}`)]).flat()

async function seeded(dataDir, messages, summary) {
	const conversations = createConversations({dataDir, now: () => 1})
	let row = await conversations.create('owner', {title: 'Long chat'})
	for (const m of messages) row = await conversations.append('owner', row.id, m)
	if (summary) row = await conversations.setSummary('owner', row.id, summary)
	return row
}

function recorder(...answers) {
	const bodies = []
	const fetchImpl = async (_url, init) => {
		bodies.push(JSON.parse(init.body))
		return says(answers.shift() ?? 'ok')
	}
	return {bodies, fetchImpl}
}

const assistant = async (fetchImpl) => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'acs-'))
	const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, sleep: async () => {}, runProcedure: async () => null})
	await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: '', model: 'local', baseUrl: 'http://127.0.0.1:8000'})
	return {dataDir, asst}
}

test('a short chat needs no summary; a long one does, by count or by size', () => {
	assert.equal(needsSummary({messages: pairs(10)}), false)
	assert.equal(needsSummary({messages: pairs(21)}), true)
	assert.equal(needsSummary({messages: [user('x'.repeat(100_000))]}), true)
	// Only the part after the last summary counts.
	assert.equal(needsSummary({messages: pairs(21), summary: {text: 'earlier', upTo: 30}}), false)
})

test('the summary always ends where the person spoke, keeps the newest messages, and never splits a tool call', () => {
	const tooly = [
		...pairs(15),
		user('check disk'),
		{role: 'assistant', content: '', toolCalls: [{id: 't1', name: 'system_disk', arguments: '{}'}], at: 1},
		{role: 'tool', toolCallId: 't1', name: 'system_disk', content: 'free 10G', at: 1},
		reply('10G free'),
		...pairs(9),
	]
	const cut = pickCut(tooly)
	assert.equal(tooly[cut].role, 'user')
	assert.ok(tooly.length - cut >= 20, 'keeps at least 20 messages')
	assert.ok(cut > 0)
	// The latest message is always kept whole, however long; with nothing before it there is nothing to summarize.
	assert.equal(pickCut([user('hi'), reply('hello'), user('x'.repeat(100_000))]), 2)
	assert.equal(pickCut([user('x'.repeat(100_000))]), -1)
	// Nothing at or before `from` is cut again.
	assert.equal(pickCut(pairs(30), 50), -1)
})

test('the transcript shortens tool output and says what happened to each proposed change', () => {
	const text = transcript(
		[user('theme?'), {role: 'tool', name: 'apps_list', content: 'y'.repeat(5000)}, {role: 'action', actionId: 'a_1'}],
		[{id: 'a_1', title: 'Set theme nord', detail: 'nord', status: 'done'}],
	)
	assert.match(text, /^Person: theme\?/)
	assert.ok(text.length < 2000)
	assert.match(text, /Proposed change: Set theme nord \(nord\), approved and done/)
})

test('a long chat is summarized once; the turn sends the summary and only the recent messages', async () => {
	const {bodies, fetchImpl} = recorder('They asked about q0 to q14.', 'Sure.', 'Again.')
	const {dataDir, asst} = await assistant(fetchImpl)
	try {
		const row = await seeded(dataDir, pairs(25))
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'next', conversationId: row.id, emit: (e) => events.push(e)})
		assert.equal(bodies.length, 2)
		const [ask, turn] = bodies
		assert.equal(ask.messages[0].content, SUMMARY_PROMPT)
		assert.equal(ask.tools, undefined)
		assert.match(ask.messages[1].content, /Person: q0 /)
		assert.match(turn.messages[0].content, /Summary of the earlier part of this chat[^]*They asked about q0 to q14\./)
		const sent = turn.messages.slice(1)
		assert.equal(sent[0].role, 'user')
		assert.equal(sent.at(-1).content, 'next')
		assert.ok(!sent.some((m) => /^q0 /.test(m.content ?? '')), 'the oldest messages are not sent again')
		assert.ok(!ask.messages[1].content.includes('next'), 'the newest messages are not summarized')
		assert.deepEqual(events.map((e) => e.event), ['speaker', 'text', 'done'])
		const saved = JSON.parse(await readFile(join(dataDir, 'assistant', 'conversations', `${row.id}.json`), 'utf8'))
		assert.equal(saved.summary.text, 'They asked about q0 to q14.')
		assert.equal(saved.messages[saved.summary.upTo].role, 'user')
		assert.equal(saved.messages.length, 52, 'every message is still saved')
		// The next turn reuses it rather than writing another.
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'more', conversationId: row.id, emit: () => {}})
		assert.equal(bodies.length, 3)
		assert.match(bodies[2].messages[0].content, /They asked about q0 to q14\./)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a new summary builds on the last one', async () => {
	const {bodies, fetchImpl} = recorder('Newer summary.', 'ok')
	const {dataDir, asst} = await assistant(fetchImpl)
	try {
		const row = await seeded(dataDir, pairs(45), {text: 'Old summary.', upTo: 10})
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'next', conversationId: row.id, emit: () => {}})
		const asked = bodies[0].messages[1].content
		assert.match(asked, /^Summary so far:\nOld summary\./)
		assert.ok(!asked.includes('q4 '), 'already-summarized messages are not sent again')
		assert.match(asked, /q5 /)
		const saved = JSON.parse(await readFile(join(dataDir, 'assistant', 'conversations', `${row.id}.json`), 'utf8'))
		assert.equal(saved.summary.text, 'Newer summary.')
		assert.ok(saved.summary.upTo > 10)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('when the summary cannot be written the turn still runs, as before', async () => {
	let n = 0
	const fetchImpl = async () => (n++ === 0 ? {ok: false, status: 400, headers: new Headers(), text: async () => '{"error":{"message":"context too long"}}'} : says('fine'))
	const {dataDir, asst} = await assistant(fetchImpl)
	try {
		const row = await seeded(dataDir, pairs(25))
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'next', conversationId: row.id, emit: (e) => events.push(e)})
		assert.deepEqual(events.map((e) => e.event), ['speaker', 'text', 'done'])
		const saved = JSON.parse(await readFile(join(dataDir, 'assistant', 'conversations', `${row.id}.json`), 'utf8'))
		assert.equal(saved.summary, undefined)
		// The next turn doesn't ask again straight away.
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'again', conversationId: row.id, emit: () => {}})
		assert.equal(n, 3)
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('setSummary only moves forward', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'acs-'))
	try {
		const row = await seeded(dataDir, pairs(10), {text: 'first', upTo: 8})
		const conversations = createConversations({dataDir, now: () => 2})
		assert.equal((await conversations.setSummary('owner', row.id, {text: 'stale', upTo: 4})).summary.text, 'first')
		assert.equal((await conversations.setSummary('owner', row.id, {text: 'too far', upTo: 99})).summary.text, 'first')
		assert.equal((await conversations.setSummary('owner', row.id, {text: 'later', upTo: 12})).summary.text, 'later')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
