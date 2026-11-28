// A swarm file whose name is outside Latin-1 (Japanese, emoji) must still download: the
// Content-Disposition header carries the name percent-encoded, never as raw characters.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import http from 'node:http'
import {test} from 'node:test'

import {contentDisposition} from '../omarchyd/files.mjs'

test('contentDisposition keeps any file name valid in a header and readable again', async () => {
	const server = http.createServer((req, res) => {
		const name = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('n'))
		res.writeHead(200, {'content-disposition': contentDisposition(name)})
		res.end('x')
	})
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	try {
		for (const name of ['日本語.txt', 'party 🎉.png', 'a"b\\c.txt', 'résumé.pdf', 'plain.txt']) {
			const res = await fetch(`http://127.0.0.1:${server.address().port}/?n=${encodeURIComponent(name)}`)
			assert.equal(res.status, 200, name)
			const m = /^attachment; filename\*=UTF-8''(.+)$/.exec(res.headers.get('content-disposition'))
			assert.equal(decodeURIComponent(m[1]), name)
		}
	} finally {
		server.close()
	}
})

test('the swarm download route sends the name through contentDisposition, not as raw characters', async () => {
	const source = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	assert.doesNotMatch(source, /filename="\$\{/)
	assert.match(source, /'content-disposition': contentDisposition\(file\.name\)/)
})
