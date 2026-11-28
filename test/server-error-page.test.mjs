// A request the routes cannot make sense of (a path that is not valid percent-encoding) is answered with a
// short plain message, not Express's HTML error page, which shows a stack trace with this server's file paths.
import assert from 'node:assert/strict'
import net from 'node:net'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'

async function start(withStatic) {
	const dir = await mkdtemp(join(tmpdir(), 'error-page-'))
	let staticDir
	if (withStatic) {
		staticDir = join(dir, 'dist')
		await mkdir(staticDir)
		await writeFile(join(staticDir, 'index.html'), '<html></html>')
	}
	const store = await createStore(join(dir, 'data'))
	const app = createApp({store, staticDir, relayPortBase: 0, relayHost: '127.0.0.1'})
	const server = await new Promise((resolve) => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s))
	})
	return {
		port: server.address().port,
		close: async () => {
			await new Promise((resolve) => server.close(resolve))
			await rm(dir, {recursive: true, force: true})
		},
	}
}

// Sent raw, because fetch would refuse or re-encode the path.
const get = (port, path) =>
	new Promise((resolve) => {
		const c = net.connect(port, '127.0.0.1', () => c.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`))
		let text = ''
		c.on('data', (d) => (text += d))
		c.on('close', () => resolve({status: Number(/^HTTP\/1.1 (\d+)/.exec(text)?.[1]), type: /content-type: ([^\r]*)/i.exec(text)?.[1] ?? '', text}))
	})

for (const [label, withStatic, path] of [
	['the backup relay path', false, '/connector/backup/%'],
	['a page path, with the web app installed', true, '/%'],
]) {
	test(`${label} that is not valid percent-encoding gets a plain 400 with no file paths`, async () => {
		const origError = console.error
		console.error = () => {}
		const touch = await start(withStatic)
		try {
			const r = await get(touch.port, path)
			assert.equal(r.status, 400)
			assert.match(r.type, /^text\/plain/)
			assert.equal(/node_modules|\.mjs/.test(r.text), false)
		} finally {
			console.error = origError
			await touch.close()
		}
	})
}
