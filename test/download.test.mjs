// Adding an ISO or a container template from a link.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {checkLink, fileNameFor, listDownloads, startDownload} from '../omarchyd/download.mjs'

test('a link must be http(s) and must not point at this server itself', async () => {
	await assert.rejects(checkLink('ftp://example.com/a.iso'), /https/)
	await assert.rejects(checkLink('not a link'), /full link/)
	await assert.rejects(checkLink('http://127.0.0.1:2021/rpc'), /this server itself/)
	await assert.rejects(checkLink('http://localhost:7780/a.iso'), /this server itself/)
	await assert.rejects(checkLink('http://[::1]/a.iso'), /this server itself/)
	await assert.rejects(checkLink('http://169.254.169.254/latest'), /this server itself/)
	await assert.rejects(checkLink('https://user:pw@example.com/a.iso'), /user name or password/)
	assert.equal((await checkLink('http://192.168.1.20/isos/debian.iso')).hostname, '192.168.1.20', 'a NAS on your network is fine')
})

test('the file name comes from the link and must have the right ending', () => {
	assert.equal(fileNameFor(new URL('https://x.org/a/debian-13.1.0-amd64-netinst.iso'), /\.iso$/i), 'debian-13.1.0-amd64-netinst.iso')
	assert.equal(fileNameFor(new URL('https://x.org/a/download?id=3'), /\.iso$/i), null)
	assert.equal(fileNameFor(new URL('https://x.org/..%2F..%2Fetc%2Fpasswd.iso'), /\.iso$/i).includes('/'), false)
})

test('a download is written as .part and renamed when complete; progress is listed meanwhile', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'dl-'))
	try {
		const jobs = new Map()
		let release
		const body = new ReadableStream({
			start(ctl) {
				ctl.enqueue(new Uint8Array(1024))
				release = () => (ctl.enqueue(new Uint8Array(1024)), ctl.close())
			},
		})
		const fetchImpl = async () => new Response(body, {headers: {'content-length': '2048'}})
		await startDownload({url: new URL('http://192.168.1.20/x.iso'), dir, name: 'x.iso', jobs, fetchImpl})
		await new Promise((r) => setTimeout(r, 30))
		assert.deepEqual(await readdir(dir), ['x.iso.part'])
		assert.equal(listDownloads(jobs)[0].total, 2048)
		release()
		await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(await readdir(dir), ['x.iso'])
		assert.equal((await readFile(join(dir, 'x.iso'))).length, 2048)
		assert.deepEqual(listDownloads(jobs), [])
		await assert.rejects(startDownload({url: new URL('http://192.168.1.20/x.iso'), dir, name: 'x.iso', jobs, fetchImpl}), /already in that folder/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
