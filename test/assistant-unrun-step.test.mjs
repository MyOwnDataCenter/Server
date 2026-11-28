import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'

const accounts = {getUser: (userId) => (userId === 'owner' ? {userId, role: 'owner'} : null)}
const sse = (text) => ({ok: true, status: 200, text: async () => text, body: (async function* () { yield text })()})
const toolSse = (id, name, args = '{}') => sse(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id, function: {name, arguments: args}}]}}]})}\n\ndata: [DONE]\n\n`)
const textSse = (text) => sse(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)

test('a lookup that was stopped before it ran is not described to the model as waiting for Approve', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'aus-'))
	const ac = new AbortController()
	const seen = []
	const replies = [toolSse('call_disk', 'system_diskUsage'), textSse('Sure.')]
	const fetchImpl = async (_url, opts) => {
		seen.push(JSON.parse(opts.body))
		return replies[seen.length - 1]
	}
	const runProcedure = async (name) => {
		if (name === 'system.diskUsage') {
			// The person stops the reply while the lookup is still running.
			ac.abort()
			return new Promise(() => {})
		}
		if (name === 'system.getHostname') return 'box'
		return null
	}
	const asst = createAssistant({dataDir, accounts, now: () => 50, fetchImpl, runProcedure})
	try {
		await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		const first = await asst.runTurn({userId: 'owner', role: 'owner', message: 'how much disk', signal: ac.signal, emit: () => {}})
		const saved = await asst.conversations.get('owner', first.conversationId)
		assert.equal(saved.messages.some((m) => m.role === 'tool'), false, 'the stopped lookup has no saved result')
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'never mind, hello', conversationId: first.conversationId, emit: () => {}})
		const tool = seen[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_disk')
		assert.ok(tool)
		assert.doesNotMatch(tool.content, /waiting for Approve/)
		assert.equal(tool.content, 'this step did not run')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
