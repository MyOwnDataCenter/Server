import assert from 'node:assert/strict'
import {afterEach, test} from 'node:test'

import {BackendError, UNREACHABLE_MESSAGE, createBackendClient} from '../server/backend.mjs'
import {ApiError, mutate, query} from '../web/src/api.ts'

const originalFetch = globalThis.fetch
const originalWarn = console.warn

afterEach(() => {
	globalThis.fetch = originalFetch
	console.warn = originalWarn
})

test('createBackendClient uses plain-English message without loopback address or procedure name', async () => {
	const refused = createBackendClient({
		baseUrl: 'http://127.0.0.1:42241',
		fetchImpl: async () => {
			throw Object.assign(new TypeError('fetch failed'), {cause: {code: 'ECONNREFUSED'}})
		},
	})
	await assert.rejects(
		() => refused.query('user.get'),
		(err) => {
			assert.ok(err instanceof BackendError)
			assert.equal(err.code, 'UNREACHABLE')
			assert.equal(err.status, 502)
			assert.equal(err.message, UNREACHABLE_MESSAGE)
			assert.equal(err.message.includes('127.0.0.1'), false)
			assert.equal(err.message.includes('42241'), false)
			assert.equal(err.message.includes('ECONNREFUSED'), false)
			assert.match(err.detail ?? '', /127\.0\.0\.1:42241 \(ECONNREFUSED\)/)
			return true
		},
	)

	const timedOut = createBackendClient({
		baseUrl: 'http://127.0.0.1:40085',
		fetchImpl: async () => {
			const e = new Error('The operation was aborted due to timeout')
			e.name = 'TimeoutError'
			throw e
		},
	})
	await assert.rejects(
		() => timedOut.mutation('apps.start', {appId: 'immich'}),
		(err) => {
			assert.ok(err instanceof BackendError)
			assert.equal(err.code, 'UNREACHABLE')
			assert.equal(err.status, 502)
			assert.equal(err.message, UNREACHABLE_MESSAGE)
			assert.equal(err.message.includes('127.0.0.1'), false)
			assert.equal(err.message.includes('timed out'), false)
			assert.match(err.detail ?? '', /timed out/)
			return true
		},
	)

	const html502 = createBackendClient({
		baseUrl: 'http://127.0.0.1:35345',
		fetchImpl: async () => new Response('<html>502 Bad Gateway</html>', {status: 502}),
	})
	await assert.rejects(
		() => html502.query('user.get'),
		(err) => {
			assert.ok(err instanceof BackendError)
			assert.equal(err.code, 'BAD_RESPONSE')
			assert.equal(err.status, 502)
			assert.equal(err.message, UNREACHABLE_MESSAGE)
			assert.equal(err.message.includes('user.get'), false)
			assert.match(err.detail ?? '', /user\.get.*HTTP 502/)
			return true
		},
	)

	const json503 = createBackendClient({
		baseUrl: 'http://127.0.0.1:35345',
		fetchImpl: async () => new Response(JSON.stringify({ok: false}), {status: 503}),
	})
	await assert.rejects(
		() => json503.query('user.get'),
		(err) => {
			assert.ok(err instanceof BackendError)
			assert.equal(err.code, 'BAD_RESPONSE')
			assert.equal(err.status, 503)
			assert.equal(err.message, UNREACHABLE_MESSAGE)
			assert.equal(err.message.includes('user.get'), false)
			return true
		},
	)
})

test('web api maps UNREACHABLE, BAD_RESPONSE, NOT_CONFIGURED, and HTML 502/503/504 to plain English', async () => {
	const warned = []
	console.warn = (...args) => warned.push(args.join(' '))

	for (const [code, rawMsg] of [
		['UNREACHABLE', "Can't reach My Own Data Center at http://127.0.0.1:42241 (ECONNREFUSED)"],
		['BAD_RESPONSE', 'My Own Data Center returned an unexpected response for user.get (HTTP 502)'],
		['NOT_CONFIGURED', 'The My Own Data Center backend (omarchyd) isn’t set up yet'],
	]) {
		globalThis.fetch = async () => new Response(JSON.stringify({error: {code, message: rawMsg}}), {status: code === 'NOT_CONFIGURED' ? 409 : 502})
		await assert.rejects(
			() => mutate('files.createDirectory', {path: '/Home/x'}),
			(err) => {
				assert.ok(err instanceof ApiError)
				assert.equal(err.code, code)
				assert.equal(err.message, UNREACHABLE_MESSAGE)
				assert.equal(err.message.includes('127.0.0.1'), false)
				assert.equal(err.message.includes('user.get'), false)
				assert.equal(err.message.includes('ECONNREFUSED'), false)
				return true
			},
		)
	}

	globalThis.fetch = async () => new Response('<html>502 Bad Gateway</html>', {status: 502})
	await assert.rejects(
		() => query('user.get'),
		(err) => err instanceof ApiError && err.code === 'UNREACHABLE' && err.status === 502 && err.message === UNREACHABLE_MESSAGE,
	)

	assert.equal(warned.length, 3)
	assert.match(warned[0], /127\.0\.0\.1:42241/)
})

test('createBackendClient treats an answer that stops part way like an unreachable server, not a raw error', async () => {
	for (const make of [
		() => Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}),
		() => Object.assign(new TypeError('terminated'), {cause: {code: 'UND_ERR_SOCKET'}}),
	]) {
		const client = createBackendClient({
			baseUrl: 'http://127.0.0.1:40086',
			fetchImpl: async () => ({ok: true, status: 200, text: async () => Promise.reject(make())}),
		})
		await assert.rejects(
			() => client.query('apps.list'),
			(err) => {
				assert.ok(err instanceof BackendError, String(err))
				assert.equal(err.code, 'UNREACHABLE')
				assert.equal(err.status, 502)
				assert.equal(err.message, UNREACHABLE_MESSAGE)
				return true
			},
		)
	}
})
