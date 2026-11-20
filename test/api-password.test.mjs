import assert from 'node:assert/strict'
import {test} from 'node:test'

const events = []
globalThis.window = {
	dispatchEvent(e) {
		events.push(e.type)
	},
}

const {mutate} = await import('../web/src/api.ts')

function failWith(message) {
	globalThis.fetch = async () => ({
		ok: false,
		status: 401,
		json: async () => ({error: {code: 'UNAUTHORIZED', message}}),
	})
}

test('password failure stays on the form', async () => {
	for (const message of ['Incorrect password', 'Incorrect 2FA code', 'Invalid password']) {
		events.length = 0
		failWith(message)
		await assert.rejects(() => mutate('user.changePassword', {oldPassword: 'nope'}), {message})
		assert.equal(events.includes('touch:signed-out'), false, message)
	}
	for (const message of ['Invalid token', 'Invalid native session', 'Signed out']) {
		events.length = 0
		failWith(message)
		await assert.rejects(() => mutate('user.changePassword', {oldPassword: 'nope'}), {message})
		assert.equal(events.includes('touch:signed-out'), true, message)
	}
})
