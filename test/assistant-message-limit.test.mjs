import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

test('an assistant message up to omarchyd’s 100 KB limit reaches it, and a longer one gets a JSON explanation', async () => {
	const fake = await startFakeserverd({accessTtlMs: 60 * 60 * 1000})
	const dir = await mkdtemp(join(tmpdir(), 'aml-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: fake.url})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(server)
	const base = `http://127.0.0.1:${server.address().port}`
	try {
		const login = await fetch(`${base}/api/auth/login`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1'},
			body: JSON.stringify({username: 'Chris', password: 'correct horse'}),
		})
		assert.equal(login.status, 200)
		const cookie = login.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
		const send = (n) => fetch(`${base}/api/assistant/stream`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-omarchy-server': '1', cookie},
			body: JSON.stringify({message: 'a'.repeat(n)}),
		})
		const ok = await send(90_000)
		assert.equal(ok.status, 200)
		await ok.body.cancel()
		const tooBig = await send(120_000)
		assert.equal(tooBig.status, 413)
		assert.match(tooBig.headers.get('content-type') ?? '', /json/)
		assert.match((await tooBig.json()).error.message, /message is too long/)
	} finally {
		app.closeRelays()
		await new Promise((r) => server.close(r))
		await rm(dir, {recursive: true, force: true})
		await fake.close()
	}
})
