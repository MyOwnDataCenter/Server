// The connector's enroll call has no browser around it: a body that is not JSON, or too large, must get
// the short JSON answer omarchyd gives, not Express's HTML error page (which carries file paths).
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

async function start() {
	const dir = await mkdtemp(join(tmpdir(), 'enroll-body-'))
	const store = await createStore(dir)
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	return {
		base: `http://127.0.0.1:${server.address().port}`,
		close: async () => {
			await new Promise((resolve) => server.close(resolve))
			await rm(dir, {recursive: true, force: true})
		},
	}
}

const post = (base, body) => fetch(`${base}/connector/enroll`, {method: 'POST', headers: {'content-type': 'application/json'}, body})

test('enroll with a body that is not JSON answers 400 as JSON, with no stack trace', async () => {
	const touch = await start()
	try {
		const r = await post(touch.base, '{bad')
		assert.equal(r.status, 400)
		assert.match(r.headers.get('content-type'), /application\/json/)
		const text = await r.text()
		assert.deepEqual(JSON.parse(text), {error: 'Bad request'})
		assert.equal(text.includes('node_modules'), false)
	} finally {
		await touch.close()
	}
})

test('enroll with a body over 64 KB answers 413 as JSON', async () => {
	const touch = await start()
	try {
		const r = await post(touch.base, JSON.stringify({token: 'x'.repeat(70 * 1024)}))
		assert.equal(r.status, 413)
		assert.match(r.headers.get('content-type'), /application\/json/)
		assert.deepEqual(await r.json(), {error: 'Too large'})
	} finally {
		await touch.close()
	}
})
