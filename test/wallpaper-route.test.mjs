import assert from 'node:assert/strict'
import http from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('the desktop background is passed on with its real type and is not cached as unchanging (#815)', async () => {
	// Like omarchyd: the current Omarchy background is served as /assets/wallpapers/1.jpg, here a PNG.
	const upstream = http.createServer((req, res) => {
		if (req.url === '/assets/wallpapers/1.jpg') {
			res.writeHead(200, {'content-type': 'image/png', 'cache-control': 'no-cache'})
			return res.end(PNG)
		}
		res.writeHead(404)
		res.end()
	})
	const upstreamPort = await listen(upstream)
	const dir = await mkdtemp(join(tmpdir(), 'wallpaper-route-'))
	const store = await createStore(dir)
	await store.setConfig({backendUrl: `http://127.0.0.1:${upstreamPort}`})
	const app = createApp({store, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	try {
		const res = await fetch(`http://127.0.0.1:${server.address().port}/api/wallpaper/1`)
		assert.equal(res.status, 200)
		assert.equal(res.headers.get('content-type'), 'image/png')
		assert.equal(res.headers.get('cache-control'), 'no-cache')
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG)
	} finally {
		app.closeRelays()
		await new Promise((resolve) => server.close(resolve))
		await new Promise((resolve) => upstream.close(resolve))
		await rm(dir, {recursive: true, force: true})
	}
})
