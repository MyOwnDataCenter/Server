// Download a file from a link into one of the server's folders, for ISOs (virtual machines) and
// container templates. Owner-only callers. The file is written as "<name>.part" and renamed when
// complete, so a half-finished download is never offered as an ISO or template.

import {lookup} from 'node:dns/promises'
import {createWriteStream} from 'node:fs'
import {rename, rm, stat} from 'node:fs/promises'
import {isIP} from 'node:net'
import {basename, join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

import {RpcError} from './rpc.mjs'

// This server's own services listen on loopback; a link must never reach them (or link-local
// addresses such as a cloud's metadata service). Other addresses on your network are allowed:
// a NAS sharing ISOs is a normal place to download from.
function blockedAddress(address) {
	const a = address.toLowerCase()
	if (isIP(a) === 4) return /^(127\.|0\.|169\.254\.)/.test(a)
	return a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:169.254.')
}

export async function checkLink(raw) {
	let url
	try {
		url = new URL(String(raw ?? '').trim())
	} catch {
		throw new RpcError('BAD_REQUEST', 'Paste a full link, starting with https://')
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RpcError('BAD_REQUEST', 'Use an https:// or http:// link')
	if (url.username || url.password) throw new RpcError('BAD_REQUEST', 'Use a link without a user name or password in it')
	const host = url.hostname.replace(/^\[|\]$/g, '')
	if (host === 'localhost' || host.endsWith('.localhost')) throw new RpcError('BAD_REQUEST', 'That link points at this server itself')
	const addresses = isIP(host) ? [{address: host}] : await lookup(host, {all: true}).catch(() => [])
	if (!addresses.length) throw new RpcError('BAD_REQUEST', `Couldn’t find ${host}`)
	if (addresses.some((x) => blockedAddress(x.address))) throw new RpcError('BAD_REQUEST', 'That link points at this server itself')
	return url
}

/** A safe file name for the download: from the link's path, with the extension the caller wants. */
export function fileNameFor(url, ext) {
	const last = decodeURIComponent(basename(url.pathname) || '').replace(/[^\w.+-]+/g, '-').replace(/^[.-]+/, '')
	if (last && ext.test(last)) return last.slice(0, 180)
	return null
}

/**
 * Start downloading in the background; `jobs` (a Map) shows progress until it finishes.
 * @returns {{name: string}}
 */
export async function startDownload({url, dir, name, jobs, fetchImpl = fetch, now = Date.now, maxBytes = 64 * 1024 ** 3}) {
	const dest = join(dir, name)
	if (await stat(dest).catch(() => null)) throw new RpcError('CONFLICT', `${name} is already in that folder`)
	if ([...jobs.values()].some((j) => j.name === name && !j.error)) throw new RpcError('CONFLICT', `${name} is already downloading`)
	const job = {name, url: url.href, received: 0, total: null, startedAt: new Date(now()).toISOString(), error: null}
	jobs.set(name, job)
	const part = `${dest}.part`
	;(async () => {
		try {
			const res = await fetchImpl(url.href, {redirect: 'follow', signal: AbortSignal.timeout(6 * 3600_000)})
			if (!res.ok || !res.body) throw new Error(`The link answered ${res.status}`)
			// A redirect may not land on this server either.
			if (res.url && res.url !== url.href) await checkLink(res.url)
			const total = Number(res.headers.get('content-length')) || null
			if (total && total > maxBytes) throw new Error('That file is too big')
			job.total = total
			const counter = new TransformStream({
				transform(chunk, ctl) {
					job.received += chunk.byteLength
					if (job.received > maxBytes) return ctl.error(new Error('That file is too big'))
					ctl.enqueue(chunk)
				},
			})
			await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part, {mode: 0o644}))
			await rename(part, dest)
			jobs.delete(name)
		} catch (error) {
			await rm(part, {force: true}).catch(() => {})
			job.error = error?.message ?? String(error)
		}
	})()
	return {name}
}

/** The downloads still running or that failed in the last 10 minutes. */
export function listDownloads(jobs, now = Date.now) {
	for (const [k, j] of jobs) if (j.error && now() - Date.parse(j.startedAt) > 10 * 60_000) jobs.delete(k)
	return [...jobs.values()].map((j) => ({name: j.name, received: j.received, total: j.total, error: j.error, startedAt: j.startedAt}))
}
