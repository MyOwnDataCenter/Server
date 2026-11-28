// Signing in or out saves sessions.json. When that save fails (disk full, read-only data folder) the
// request must be answered with an error, not left hanging with an unhandled rejection that ends the process.
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeserverd} from './fake-omarchyd.mjs'

async function start(fake, breakSave) {
	const dir = await mkdtemp(join(tmpdir(), 'login-save-'))
	const real = await createStore(dir)
	await real.setConfig({backendUrl: fake.url})
	const store = {...real, ...breakSave(real)}
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	return {
		store: real,
		base: `http://127.0.0.1:${server.address().port}`,
		close: async () => {
			await new Promise((resolve) => server.close(resolve))
			await rm(dir, {recursive: true, force: true})
		},
	}
}

const call = (touch, path, body, cookie) =>
	fetch(`${touch.base}${path}`, {
		method: 'POST',
		headers: {'content-type': 'application/json', 'x-omarchy-server': '1', ...(cookie ? {cookie} : {})},
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(3000),
	})

async function quietly(fn) {
	const rejections = []
	const onRejection = (error) => rejections.push(error)
	const origError = console.error
	console.error = () => {}
	process.on('unhandledRejection', onRejection)
	try {
		const result = await fn()
		await new Promise((resolve) => setImmediate(resolve))
		return {result, rejections}
	} finally {
		process.off('unhandledRejection', onRejection)
		console.error = origError
	}
}

test('a failed sessions.json save while signing in answers an error and sets no cookie', async () => {
	const fake = await startFakeserverd({accessTtlMs: 60 * 60 * 1000})
	const touch = await start(fake, () => ({
		putSession: async () => {
			throw new Error('ENOSPC: no space left on device')
		},
	}))
	try {
		const {result, rejections} = await quietly(() => call(touch, '/api/auth/login', {username: 'Chris', password: 'correct horse'}))
		assert.equal(result.status, 500)
		assert.equal(result.headers.getSetCookie().some((c) => c.startsWith('omarchy_server_sid=')), false)
		const body = await result.json()
		assert.equal(body.error.code, 'INTERNAL')
		assert.equal(JSON.stringify(body).includes('ENOSPC'), false)
		assert.deepEqual(rejections, [])
	} finally {
		await touch.close()
		await fake.close()
	}
})

test('a failed sessions.json save while signing out answers an error and keeps the cookie', async () => {
	const fake = await startFakeserverd({accessTtlMs: 60 * 60 * 1000})
	const touch = await start(fake, () => ({
		deleteSession: async () => {
			throw new Error('EROFS: read-only file system')
		},
	}))
	try {
		const login = await call(touch, '/api/auth/login', {username: 'Chris', password: 'correct horse'})
		assert.equal(login.status, 200)
		const cookie = login.headers.getSetCookie().find((c) => c.startsWith('omarchy_server_sid=')).split(';')[0]
		const {result, rejections} = await quietly(() => call(touch, '/api/auth/logout', undefined, cookie))
		assert.equal(result.status, 500)
		assert.equal(result.headers.getSetCookie().some((c) => c.startsWith('omarchy_server_sid=')), false)
		assert.deepEqual(rejections, [])
	} finally {
		await touch.close()
		await fake.close()
	}
})
