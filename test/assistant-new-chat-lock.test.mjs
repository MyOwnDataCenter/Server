import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'

const accounts = {getUser: (userId) => (userId === 'owner' ? {userId, role: 'owner'} : null)}

const sse = (text) => ({ok: true, status: 200, text: async () => text, body: (async function* () { yield text })()})
const textSse = (text) => sse(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)

function streamPair(body) {
	const chunks = []
	const req = {
		socket: {on() {}, off() {}, setNoDelay() {}},
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(JSON.stringify(body))
		},
	}
	const res = {
		writableEnded: false,
		destroyed: false,
		writeHead() {},
		write(chunk) {
			chunks.push(String(chunk))
			return true
		},
		end() {
			this.writableEnded = true
		},
		on() {},
	}
	return {req, res, chunks}
}

test('a reply still being written in a brand-new chat refuses a second reply on that chat', async () => {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'ncl-'))
	let release
	const gate = new Promise((r) => (release = r))
	let calls = 0
	const fetchImpl = async () => {
		calls++
		if (calls === 1) await gate
		return textSse(calls === 1 ? 'First.' : 'Second.')
	}
	const asst = createAssistant({dataDir, accounts, now: () => 50, fetchImpl, runProcedure: async () => null})
	try {
		await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		const a = streamPair({message: 'hello'})
		const first = asst.handleStream(a.req, a.res, {userId: 'owner'})
		// The chat exists as soon as the first message is saved; the page learns its id from the chat list.
		let id
		for (let i = 0; i < 200 && !id; i++) {
			await new Promise((r) => setTimeout(r, 10))
			id = (await asst.conversations.list('owner'))[0]?.id
		}
		assert.ok(id, 'the new chat is saved while its first reply is still being written')
		const b = streamPair({conversationId: id, message: 'and another'})
		await asst.handleStream(b.req, b.res, {userId: 'owner'})
		assert.match(b.chunks.join(''), /This chat is still answering/)
		release()
		await first
		assert.equal(calls, 1, 'the refused message never reached the model')
		const saved = await asst.conversations.get('owner', id)
		assert.deepEqual(saved.messages.filter((m) => m.role === 'user').map((m) => m.content), ['hello'])
		// Once the first reply ends, the chat takes a new message again.
		const c = streamPair({conversationId: id, message: 'once more'})
		await asst.handleStream(c.req, c.res, {userId: 'owner'})
		assert.match(c.chunks.join(''), /event: done/)
	} finally {
		release()
		await rm(dataDir, {recursive: true, force: true})
	}
})
