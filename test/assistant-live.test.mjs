// Live assistant turn: working/typing mark in the bubble, keep the stream if the window closes,
// unread count on the character.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {answeredBy, assistantKeyLabel, cardAction, threadItems} from '../web/src/assistant.ts'
import {assistantActivity, setAssistantActivity} from '../web/src/assistantActivity.ts'
import {appendLiveText, assistantIconBadge, finishLiveItems, insertLiveAction, liveBubbleMark, noteLiveVia, startLiveTurn} from '../web/src/assistantLive.ts'
import {
	abortAssistantTurn,
	assistantTurn,
	beginAssistantTurn,
	closeAssistantView,
	finishAssistantTurn,
	keepAssistantWindow,
	openAssistantView,
	assistantEpoch,
	registerAssistantAbort,
	resetAssistantTurn,
	setTurnConversationId,
	setTurnError,
	setTurnItems,
} from '../web/src/assistantTurn.ts'

test('an empty live bubble shows a spinner; tokens switch it to an ellipsis', () => {
	assert.equal(liveBubbleMark({streaming: true, content: ''}), 'spinner')
	assert.equal(liveBubbleMark({streaming: true, content: '', activity: 'Checked disk'}), 'spinner')
	assert.equal(liveBubbleMark({streaming: true, content: 'Hello'}), 'ellipsis')
	assert.equal(liveBubbleMark({streaming: false, content: 'Hello'}), null)
	assert.equal(liveBubbleMark({streaming: false, content: ''}), null)
})

test('the character badge is the unread count, then pending Approves, and hidden at zero', () => {
	assert.equal(assistantIconBadge({unread: 0, pending: 0, phase: 'idle'}), null)
	assert.deepEqual(assistantIconBadge({unread: 3, pending: 1, phase: 'idle'}), {count: 3})
	assert.deepEqual(assistantIconBadge({unread: 0, pending: 2, phase: 'idle'}), {count: 2})
	assert.deepEqual(assistantIconBadge({unread: 0, pending: 0, phase: 'error'}), {warn: true})
})

test('closing the assistant view does not abort the in-flight turn', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	closeAssistantView()
	assert.equal(ac.signal.aborted, false)
	assert.equal(assistantTurn().open, false)
	assert.equal(assistantTurn().streaming, true)
})

test('Super+W keeps the assistant window mounted while it is still working', () => {
	resetAssistantTurn()
	assert.equal(keepAssistantWindow('assistant'), false)
	const ac = new AbortController()
	beginAssistantTurn(ac)
	assert.equal(keepAssistantWindow('assistant'), true)
	assert.equal(keepAssistantWindow('files'), false)
	closeAssistantView()
	assert.equal(keepAssistantWindow('assistant'), true)
	finishAssistantTurn(ac)
	assert.equal(keepAssistantWindow('assistant'), false)
})

test('a reply that finishes while closed counts as unread until the chat is opened', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	closeAssistantView()
	finishAssistantTurn()
	assert.equal(assistantTurn().unread, 1)
	assert.equal(assistantTurn().streaming, false)
	openAssistantView()
	assert.equal(assistantTurn().unread, 0)
	assert.equal(assistantTurn().open, true)
})

test('New session aborts the in-flight turn', () => {
	resetAssistantTurn()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	abortAssistantTurn()
	assert.equal(ac.signal.aborted, true)
	assert.equal(assistantTurn().streaming, false)
})

test('finishing a superseded turn does not count as unread', () => {
	resetAssistantTurn()
	const first = new AbortController()
	beginAssistantTurn(first)
	closeAssistantView()
	const second = new AbortController()
	beginAssistantTurn(second)
	finishAssistantTurn(first)
	assert.equal(assistantTurn().streaming, true)
	assert.equal(assistantTurn().unread, 0)
	assert.equal(second.signal.aborted, false)
	finishAssistantTurn(second)
	assert.equal(assistantTurn().streaming, false)
	assert.equal(assistantTurn().unread, 1)
})

const chatSse = (chunks) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		for (const c of chunks) yield new TextEncoder().encode(`data: ${JSON.stringify(c)}\n\n`)
		yield new TextEncoder().encode('data: [DONE]\n\n')
	})(),
})

function replayLive(userText, events) {
	let items = [
		{id: 'user-1', kind: 'text', role: 'user', content: userText},
		{id: 'live-1', kind: 'text', role: 'assistant', content: '', streaming: true},
	]
	let turn = startLiveTurn('live-1')
	let sawAction = false
	let failed = false
	for (const e of events) {
		if (e.event === 'text') {
			const step = appendLiveText(items, turn, e.data.text)
			items = step.items
			turn = step.turn
		} else if (e.event === 'tool') {
			turn = {...turn, afterTool: true}
		} else if (e.event === 'action') {
			sawAction = true
			items = insertLiveAction(items, turn.liveId, cardAction(e.data))
		} else if (e.event === 'error') {
			failed = true
		}
	}
	return finishLiveItems(items, turn.liveId, failed || sawAction)
}

const comparable = (items) =>
	items.map((b) => (b.kind === 'card' ? {kind: 'card', id: b.action.id, title: b.action.title} : {kind: 'text', role: b.role, content: b.content}))

test('text from separate model rounds becomes separate bubbles, matching the saved chat', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'al-rounds-'))
	const OWNER = {userId: 'owner', role: 'owner'}
	let round = 0
	const replies = [
		chatSse([
			{choices: [{delta: {content: 'Let me check the disk.'}}]},
			{choices: [{delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'system_diskUsage', arguments: '{}'}}]}}]},
		]),
		chatSse([
			{choices: [{delta: {content: 'You have '}}]},
			{choices: [{delta: {content: '40 GB free.'}}]},
		]),
	]
	try {
		const asst = createAssistant({
			dataDir,
			accounts: {getUser: (id) => (id === 'owner' ? OWNER : null)},
			now: () => 1,
			fetchImpl: async () => replies[round++],
			runProcedure: async (name) => (name === 'system.diskUsage' ? {free: '40 GB'} : null),
		})
		await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:8000/v1'})
		const events = []
		const {conversationId} = await asst.runTurn({userId: 'owner', role: 'owner', message: 'disk?', emit: (e) => events.push(e)})
		const live = replayLive('disk?', events)
		const saved = await asst.conversations.get('owner', conversationId)
		const reloaded = threadItems(saved)

		assert.deepEqual(
			live.filter((b) => b.kind === 'text' && b.role === 'assistant').map((b) => b.content),
			['Let me check the disk.', 'You have 40 GB free.'],
		)
		assert.equal(live.some((b) => b.kind === 'text' && b.streaming), false)
		assert.deepEqual(comparable(live), comparable(reloaded))
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})

test('a tool call with no earlier text stays in one bubble, and the lookup limit starts its own bubble', () => {
	// Tool call with no earlier text: all Round 2 chunks stay in one bubble.
	const oneBubble = replayLive('disk?', [
		{event: 'tool', data: {name: 'system_diskUsage', state: 'done'}},
		{event: 'text', data: {text: 'You have '}},
		{event: 'text', data: {text: '40 GB free.'}},
		{event: 'done', data: {conversationId: 'c1'}},
	])
	assert.deepEqual(
		oneBubble.filter((b) => b.kind === 'text' && b.role === 'assistant').map((b) => b.content),
		['You have 40 GB free.'],
	)

	// Text before hitting the lookup limit: the limit notice becomes its own bubble.
	const hitLimit = replayLive('check everything', [
		{event: 'text', data: {text: 'Checking one more thing.'}},
		{event: 'tool', data: {name: 'system_diskUsage', state: 'done'}},
		{event: 'text', data: {text: 'I hit the lookup limit for this turn.'}},
		{event: 'done', data: {conversationId: 'c1'}},
	])
	assert.deepEqual(
		hitLimit.filter((b) => b.kind === 'text' && b.role === 'assistant').map((b) => b.content),
		['Checking one more thing.', 'I hit the lookup limit for this turn.'],
	)

	// Text, tool, more text, then an Approve card: both bubbles stay before the card.
	const withCard = replayLive('install jellyfin', [
		{event: 'text', data: {text: 'Let me check the store.'}},
		{event: 'tool', data: {name: 'appStore_app', state: 'done'}},
		{event: 'text', data: {text: 'Found it.'}},
		{event: 'action', data: {id: 'a1', status: 'pending', kind: 'rpc', toolName: 'apps_install', title: 'Install Jellyfin', detail: ''}},
		{event: 'done', data: {conversationId: 'c1'}},
	])
	assert.deepEqual(comparable(withCard), [
		{kind: 'text', role: 'user', content: 'install jellyfin'},
		{kind: 'text', role: 'assistant', content: 'Let me check the store.'},
		{kind: 'text', role: 'assistant', content: 'Found it.'},
		{kind: 'card', id: 'a1', title: 'Install Jellyfin'},
	])
})

test('signing out clears the previous person\'s assistant chat', () => {
	resetAssistantTurn()
	setTurnItems([{id: 'prev', kind: 'text', role: 'user', content: 'hello from the last person'}])
	setTurnConversationId('conv-previous')
	setTurnError('the last person had no key')
	closeAssistantView()
	const done = new AbortController()
	beginAssistantTurn(done)
	finishAssistantTurn(done)
	const live = new AbortController()
	beginAssistantTurn(live)
	setAssistantActivity({phase: 'working', pending: 2, composing: true, successAt: 9, open: true})
	resetAssistantTurn()
	assert.equal(live.signal.aborted, true)
	const turn = assistantTurn()
	assert.equal(turn.items, null)
	assert.equal(turn.conversationId, undefined)
	assert.equal(turn.unread, 0)
	assert.equal(turn.streaming, false)
	assert.equal(turn.error, null)
	const activity = assistantActivity()
	assert.equal(activity.phase, 'idle')
	assert.equal(activity.pending, 0)
	assert.equal(activity.open, false)
	assert.equal(activity.composing, false)
	assert.equal(activity.successAt, 0)
})

test('a notice names the switch, and a speaker name is kept on the next bubble', () => {
	const start = [
		{id: 'user-1', kind: 'text', role: 'user', content: 'hi'},
		{id: 'live-1', kind: 'text', role: 'assistant', content: '', streaming: true},
	]
	const noticed = noteLiveVia(start, 'live-1', 'Grok did not answer. This chat is using OpenAI.')
	const kept = noteLiveVia(noticed, 'live-1', 'Answered by OpenAI', {keep: true})
	assert.equal(kept.find((b) => b.id === 'live-1').via, 'Grok did not answer. This chat is using OpenAI.')
	const named = noteLiveVia(start, 'live-1', 'Answered by OpenAI')
	assert.equal(named.find((b) => b.id === 'live-1').via, 'Answered by OpenAI')
	const spoken = named.map((b) => (b.id === 'live-1' ? {...b, content: 'First.'} : b))
	const split = appendLiveText(spoken, {...startLiveTurn('live-1'), afterTool: true}, 'Second.')
	assert.equal(split.items.find((b) => b.content === 'Second.').via, 'Answered by OpenAI')
	const finished = finishLiveItems(named, 'live-1', true)
	assert.equal(finished.find((b) => b.id === 'live-1').via, 'Answered by OpenAI')
})

test('a saved chat names the provider when that key is still listed', () => {
	const items = threadItems({
		messages: [
			{role: 'user', content: 'hi', at: 1},
			{role: 'assistant', content: 'hello', at: 2},
		],
	})
	const blank = answeredBy(items, '')
	assert.equal(blank.find((b) => b.kind === 'text' && b.role === 'assistant').via, undefined)
	const named = answeredBy(items, 'Answered by Grok')
	assert.equal(named.find((b) => b.kind === 'text' && b.role === 'assistant').via, 'Answered by Grok')
	assert.equal(named.find((b) => b.kind === 'text' && b.role === 'user').via, undefined)
	assert.equal(assistantKeyLabel({name: 'Backup', provider: 'openai'}), 'Backup')
	assert.equal(assistantKeyLabel({name: '', provider: 'spacexai'}), 'Grok')
	assert.equal(assistantKeyLabel(null), '')
})

test('reset aborts a registered approve controller and bumps the assistant epoch', () => {
	resetAssistantTurn()
	const before = assistantEpoch()
	const own = new AbortController()
	registerAssistantAbort(own)
	resetAssistantTurn()
	assert.equal(own.signal.aborted, true)
	assert.notEqual(assistantEpoch(), before)
})

test('an in-flight send does not restore the conversation id after reset', async () => {
	resetAssistantTurn()
	const since = assistantEpoch()
	let release = () => {}
	const gate = new Promise((resolve) => {
		release = resolve
	})
	const pending = (async () => {
		await gate
		// send() writes the id it just looked up only when this generation is still current.
		setTurnConversationId('conv-previous', since)
	})()
	resetAssistantTurn()
	release()
	await pending
	assert.equal(assistantTurn().conversationId, undefined)
})
