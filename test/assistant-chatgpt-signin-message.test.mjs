import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createConversations} from '../omarchyd/assistant/conversations.mjs'
import {createLoop} from '../omarchyd/assistant/loop.mjs'

// The loop gets a fresh ChatGPT token before it asks the model. When that fails, the person should read
// why, not "couldn't reach <address>" for a request that was never sent.
async function failWith(message, code) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'acm-'))
	try {
		const conversations = createConversations({dataDir})
		const key = {id: 'k_1', name: 'ChatGPT', provider: 'chatgpt', baseUrl: 'https://api.openai.com/v1', model: 'gpt-plan', ownerUserId: 'owner', updatedAt: 1}
		const keys = {resolveForUser: async () => key, candidatesForUser: async () => [key]}
		const chatgpt = {
			accessToken: async () => {
				throw Object.assign(new Error(message), {code})
			},
		}
		let asked = 0
		const loop = createLoop({keys, conversations, runProcedure: async () => null, fetchImpl: async () => (asked++, {ok: true, status: 200, body: null}), chatgpt})
		const events = []
		await loop.runTurn({userId: 'owner', role: 'owner', message: 'hi', emit: (e) => events.push(e)})
		assert.equal(asked, 0, 'the model was never asked')
		return events.find((e) => e.event === 'error')?.data.message
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
}

test('a signed-out ChatGPT key says to sign in again, without claiming the address could not be reached', async () => {
	assert.equal(await failWith('Sign in with ChatGPT again in Settings → Assistant', 'PRECONDITION_FAILED'), 'Sign in with ChatGPT again in Settings → Assistant')
})

test('a temporary ChatGPT sign-in failure is reported as it is', async () => {
	assert.equal(await failWith('Couldn’t reach ChatGPT; try again in a moment', 'BAD_GATEWAY'), 'Couldn’t reach ChatGPT; try again in a moment')
})
