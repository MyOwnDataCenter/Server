// Clip book: one private book for each signed-in person, outside Home so Files, Samba, and the
// download URL cannot serve it. A file on the server or another computer is a reference. The bytes
// move only when the person pastes. A damaged book is left byte-for-byte and new clips are refused.
import {createReadStream, createWriteStream} from 'node:fs'
import {chmod, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {once} from 'node:events'
import {finished} from 'node:stream/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {readJsonState, writeAtomic, plainObject} from './atomic.mjs'
import {RpcError, sendError, sendJson} from './rpc.mjs'
import {FOLDER_FROM_COMPUTER, FOLDER_TO_COMPUTER, MISSING_FILE} from './transferRules.mjs'

export const CLIP_LIMITS = {
	text: 256 * 1024,
	image: 8 * 1024 * 1024,
	stats: 256 * 1024,
	budget: 100 * 1024 * 1024,
	max: 200,
	preview: 240,
}
const RPC_TEXT = 48 * 1024
const PASTE_TEXT = 32 * 1024
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const CLIP_ID = /^[0-9a-f]{16}$/
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FULL = 'The clip book is full. Remove a clip first.'
const DAMAGED = 'The clip book is damaged and was left unchanged.'
const STILL = 'That file is still on that computer.'
const CHANGED = 'That file changed, so it was left where it is.'
const OWNER = 'Only the server’s owner can use files on another computer'

const oneLine = (text, n = CLIP_LIMITS.preview) =>
	String(text ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, n)

function cleanLabel(input, fallback) {
	const text = oneLine(input || fallback || 'Clip', 80)
	return text || 'Clip'
}

function fileName(label, ext) {
	// A name Files can save: no slash, and not hidden (a copied path or ".env" would be refused).
	const base = cleanLabel(label, 'clip').replace(/[/\\]/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'clip'
	const lower = base.toLowerCase()
	const named = ext && !lower.endsWith(ext) ? `${base}${ext}` : base
	return named.slice(0, 120)
}

function itemOk(item, scope) {
	if (!plainObject(item)) return false
	if (typeof item.path !== 'string' || item.path.length < 1 || item.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(item.path)) return false
	if (scope === 'server' && !item.path.startsWith('/')) return false
	if (item.dir != null && item.dir !== true) return false
	if (item.dir === true) return Number.isSafeInteger(item.mtime)
	return Number.isSafeInteger(item.size) && item.size >= 0 && Number.isSafeInteger(item.mtime)
}

function refOk(ref, kind) {
	if (kind !== 'file') return ref == null
	if (!plainObject(ref)) return false
	if (ref.scope !== 'server' && ref.scope !== 'swarm' && ref.scope !== 'machine') return false
	if (typeof ref.path !== 'string' || ref.path.length < 1 || ref.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(ref.path)) return false
	if (ref.scope === 'server' && !ref.path.startsWith('/')) return false
	if (ref.scope !== 'server' && (typeof ref.id !== 'string' || !USER_ID.test(ref.id))) return false
	if (ref.dir != null && ref.dir !== true) return false
	if (ref.items != null) {
		if (!Array.isArray(ref.items) || ref.items.length < 2 || ref.items.length > 40) return false
		if (!ref.items.every((item) => itemOk(item, ref.scope))) return false
	}
	if (ref.scope === 'machine') return ref.size == null && ref.mtime == null
	return Number.isSafeInteger(ref.size) && ref.size >= 0 && Number.isSafeInteger(ref.mtime)
}

function clipOk(clip, seen) {
	if (!plainObject(clip) || typeof clip.id !== 'string' || !CLIP_ID.test(clip.id) || seen.has(clip.id)) return false
	seen.add(clip.id)
	if (!['text', 'image', 'stats', 'file'].includes(clip.kind)) return false
	if (!Number.isSafeInteger(clip.at) || clip.at < 0) return false
	if (typeof clip.label !== 'string' || clip.label.length < 1 || clip.label.length > 80) return false
	if (typeof clip.where !== 'string' || clip.where.length > 16) return false
	if (typeof clip.name !== 'string' || clip.name.length < 1 || clip.name.length > 120) return false
	if (typeof clip.preview !== 'string' || clip.preview.length > CLIP_LIMITS.preview) return false
	if (clip.cut != null && clip.cut !== true) return false
	if (clip.kind === 'file') return refOk(clip.ref, 'file') && clip.bytes == null
	return Number.isSafeInteger(clip.bytes) && clip.bytes >= 0 && clip.ref == null
}

function validBook(value) {
	if (!plainObject(value) || !Array.isArray(value.clips)) return false
	const seen = new Set()
	return value.clips.every((clip) => clipOk(clip, seen))
}

async function readCapped(req, cap) {
	const declared = req.headers?.['content-length']
	if (declared != null && declared !== '') {
		const n = Number(declared)
		if (!Number.isInteger(n) || n < 0 || n > cap) throw new RpcError('BAD_REQUEST', 'That clip is too big.')
	}
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		total += buf.length
		if (total > cap) {
			req.destroy?.()
			throw new RpcError('BAD_REQUEST', 'That clip is too big.')
		}
		chunks.push(buf)
	}
	return Buffer.concat(chunks)
}

function decodeText(buf) {
	let text
	try {
		text = new TextDecoder('utf-8', {fatal: true}).decode(buf)
	} catch {
		throw new RpcError('BAD_REQUEST', 'That text isn’t valid.')
	}
	if (!text.trim()) throw new RpcError('BAD_REQUEST', 'There’s nothing to clip.')
	return text
}

function chunker(stream) {
	const it = stream[Symbol.asyncIterator]()
	let pending = Buffer.alloc(0)
	let done = false
	return async (n) => {
		while (pending.length < n && !done) {
			const step = await it.next()
			if (step.done) {
				done = true
				break
			}
			const part = Buffer.from(step.value)
			pending = pending.length ? Buffer.concat([pending, part]) : part
		}
		if (!pending.length) return Buffer.alloc(0)
		const out = pending.subarray(0, Math.min(n, pending.length))
		pending = pending.subarray(out.length)
		return Buffer.from(out)
	}
}

function disposition(name, inline) {
	const ascii = String(name || 'clip').replace(/[^\w. -]/g, '_').slice(0, 100) || 'clip'
	return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"`
}

// A percentage is printed only for a real number. An object from a sampler must not become "CPU [object Object]%".
function finite(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function cpuBit(v) {
	const n = finite(v)
	return n == null ? 'CPU' : `CPU ${Math.round(n)}%`
}
function statsPreview(scope, name, stats) {
	if (scope === 'server') {
		const used = finite(stats?.memory?.totalUsed)
		const size = finite(stats?.memory?.size)
		const memBit = used != null && size != null && size > 0 ? `memory ${Math.round(used / 1048576)} of ${Math.round(size / 1048576)} MB` : 'memory'
		return oneLine(`This server · ${cpuBit(stats?.cpu?.totalUsed)} · ${memBit}`)
	}
	if (scope === 'machine') {
		const mem = finite(stats?.last?.memMb)
		return oneLine(`${name || 'Machine'} · ${cpuBit(stats?.last?.cpu)} · ${mem == null ? 'memory' : `memory ${Math.round(mem)} MB`}`)
	}
	const used = finite(stats?.mem?.used)
	const total = finite(stats?.mem?.total)
	const memBit = used != null && total != null ? `memory ${Math.round(used / 1048576)} of ${Math.round(total / 1048576)} MB` : 'memory'
	return oneLine(`${name || 'Computer'} · ${cpuBit(stats?.cpu)} · ${memBit}`)
}

export function createClips({dataDir, files, fleet, readers = {}, roleOf = () => 'member', authenticate = () => null, urlUser = () => null, limits: override = {}, now = () => Date.now()} = {}) {
	const limits = {...CLIP_LIMITS, ...override}
	const tails = new Map()
	const withBook = (userId, fn) => {
		const prev = tails.get(userId) ?? Promise.resolve()
		const run = prev.catch(() => {}).then(fn)
		const tail = run.catch(() => {})
		tails.set(userId, tail)
		tail.then(() => {
			if (tails.get(userId) === tail) tails.delete(userId)
		})
		return run
	}

	function actor(auth) {
		const userId = String(auth?.userId ?? '')
		if (!USER_ID.test(userId)) throw new RpcError('FORBIDDEN', 'That account can’t keep a clip book')
		const given = auth?.role
		const role = given === 'owner' || given === 'member' ? given : roleOf(userId) === 'owner' ? 'owner' : 'member'
		return {userId, role}
	}
	const requireOwner = (who) => {
		if (who.role !== 'owner') throw new RpcError('FORBIDDEN', OWNER)
	}
	const bookDir = (userId) => join(dataDir, 'clips', userId)
	const bookFile = (userId) => join(bookDir(userId), 'book.json')

	async function ensure(userId) {
		const root = join(dataDir, 'clips')
		const dir = bookDir(userId)
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(root, 0o700)
		await chmod(dir, 0o700)
		return dir
	}
	async function load(userId) {
		const file = bookFile(userId)
		const state = await readJsonState(file, {validate: validBook, label: 'omarchyd'})
		if (state.damaged) return {damaged: true, clips: null, file}
		if (state.status === 'missing') return {damaged: false, clips: [], file}
		return {damaged: false, clips: state.value.clips, file}
	}
	const pub = (clip) => {
		const row = {id: clip.id, kind: clip.kind, at: clip.at, label: clip.label, where: clip.where, name: clip.name, preview: clip.preview}
		if (clip.cut) row.cut = true
		if (clip.bytes != null) row.bytes = clip.bytes
		if (clip.ref) {
			row.ref = {scope: clip.ref.scope, path: clip.ref.path, ...(clip.ref.id ? {id: clip.ref.id} : {}), size: clip.ref.size ?? null, mtime: clip.ref.mtime ?? null}
			if (clip.ref.dir) {
				row.dir = true
				row.ref.dir = true
			}
			if (Array.isArray(clip.ref.items)) {
				row.ref.items = clip.ref.items.map((item) => ({
					path: item.path,
					size: item.size ?? null,
					mtime: item.mtime ?? null,
					...(item.dir ? {dir: true} : {}),
				}))
			}
		}
		return row
	}
	const usedBytes = (clips) => clips.reduce((n, clip) => n + (Number.isSafeInteger(clip.bytes) ? clip.bytes : 0), 0)

	async function addRow(who, row, blob) {
		return withBook(who.userId, async () => {
			const book = await load(who.userId)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			if (book.clips.length >= limits.max) throw new RpcError('CONFLICT', FULL)
			if (blob && usedBytes(book.clips) + blob.length > limits.budget) throw new RpcError('CONFLICT', 'The clip book has reached its size limit. Remove a clip first.')
			const dir = await ensure(who.userId)
			if (blob) {
				const path = join(dir, `${row.id}.blob`)
				await writeFile(path, blob, {mode: 0o600})
				await chmod(path, 0o600)
				try {
					await writeAtomic(book.file, JSON.stringify({clips: [...book.clips, row]}, null, '\t'))
				} catch (error) {
					await rm(path, {force: true}).catch(() => {})
					throw error
				}
			} else {
				await writeAtomic(book.file, JSON.stringify({clips: [...book.clips, row]}, null, '\t'))
			}
			return pub(row)
		})
	}

	function textRow(text, meta) {
		const where = meta?.where === 'desktop' ? 'desktop' : 'terminal'
		const label = cleanLabel(meta?.label, oneLine(text, 80))
		return {
			id: randomBytes(8).toString('hex'),
			kind: 'text',
			at: now(),
			label,
			...(meta?.cut === true || meta?.cut === '1' ? {cut: true} : {}),
			where,
			name: fileName(label, '.txt'),
			bytes: Buffer.byteLength(text),
			preview: oneLine(text),
		}
	}
	async function addTextBuffer(who, buf, meta) {
		if (buf.length > limits.text) throw new RpcError('BAD_REQUEST', 'That clip is too big.')
		const text = decodeText(buf)
		const row = textRow(text, meta)
		row.bytes = buf.length
		return addRow(who, row, buf)
	}

	async function addStats(input, ctx) {
		const who = actor(ctx.auth)
		const scope = input?.scope
		if (scope !== 'server' && scope !== 'machine' && scope !== 'swarm') throw new RpcError('BAD_REQUEST', 'Choose this server, a machine, or a computer')
		if (scope !== 'server') requireOwner(who)
		let found = {name: 'This server', stats: null}
		if (scope === 'server') found = {name: 'This server', stats: await readers.server?.()}
		else if (scope === 'machine') {
			found = await readers.machine?.(String(input?.id ?? ''))
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That machine isn’t on this server')
		} else {
			found = await readers.swarm?.(String(input?.id ?? ''))
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That computer isn’t in your swarm')
		}
		let body
		try {
			body = JSON.stringify(found.stats ?? {})
		} catch {
			throw new RpcError('BAD_REQUEST', 'That snapshot can’t be kept.')
		}
		const buf = Buffer.from(body)
		if (buf.length > limits.stats) throw new RpcError('BAD_REQUEST', 'That snapshot is too big to keep.')
		const preview = statsPreview(scope, found.name, found.stats)
		const label = cleanLabel(input?.label, preview)
		const row = {id: randomBytes(8).toString('hex'), kind: 'stats', at: now(), label, where: scope, name: fileName(label, '.json'), bytes: buf.length, preview}
		return addRow(who, row, buf)
	}

	function vmPath(path) {
		const text = String(path ?? '')
		if (!text || text.length > 1024 || /[\u0000-\u001f\u007f]/.test(text)) return null
		return text
	}
	function cutOf(input) {
		return input?.cut === true || input?.cut === '1' ? {cut: true} : {}
	}
	async function addFiles(who, input, paths) {
		const scope = input?.scope
		if (scope !== 'server' && scope !== 'swarm') throw new RpcError('BAD_REQUEST', 'Choose a file on this server or a computer')
		if (paths.length > 40) throw new RpcError('BAD_REQUEST', 'Choose fewer files')
		if (scope === 'swarm') requireOwner(who)
		const id = String(input?.id ?? '')
		const items = []
		for (const path of paths) {
			if (scope === 'server') {
				const info = await files.inspect(path)
				items.push({path: info.path, size: info.dir ? 0 : info.size, mtime: info.mtimeMs, ...(info.dir ? {dir: true} : {})})
			} else {
				const info = await fleet.stat(id, path)
				if (!info) throw new RpcError('NOT_FOUND', 'That file isn’t in your home folder')
				const dir = !!info.dir
				if (!dir && (!Number.isSafeInteger(info.size) || info.size < 0)) throw new RpcError('BAD_GATEWAY', 'That computer didn’t say how big the file is')
				items.push({path, size: dir ? 0 : info.size, mtime: Number.isSafeInteger(info.mtime) ? info.mtime : 0, ...(dir ? {dir: true} : {})})
			}
		}
		const names = items.map((item) => item.path.split('/').filter(Boolean).at(-1) || 'file')
		const label = cleanLabel(input?.label, `${items.length} files`)
		const row = {
			id: randomBytes(8).toString('hex'),
			kind: 'file',
			at: now(),
			label,
			...cutOf(input),
			where: scope,
			name: fileName(names[0] || label),
			preview: oneLine(`${items.length} files · ${names.join(', ')}`),
			ref: {
				scope,
				path: items[0].path,
				...(scope === 'swarm' ? {id} : {}),
				size: items.reduce((sum, item) => sum + (Number.isSafeInteger(item.size) ? item.size : 0), 0),
				mtime: items[0].mtime,
				items,
			},
		}
		return addRow(who, row, null)
	}
	async function addFile(input, ctx) {
		const who = actor(ctx.auth)
		const scope = input?.scope
		const many = Array.isArray(input?.paths) ? input.paths.map((path) => String(path)).filter((path) => path) : null
		if (many && many.length >= 2) return addFiles(who, input, many)
		if (scope === 'server') {
			const info = await files.inspect(String(input?.path ?? ''))
			const label = cleanLabel(input?.label, info.name)
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				...cutOf(input),
				where: 'server',
				name: fileName(info.name),
				preview: info.dir ? oneLine(`${info.name} · folder`) : oneLine(`${info.name} · ${info.size} bytes`),
				ref: {scope: 'server', path: info.path, size: info.dir ? 0 : info.size, mtime: info.mtimeMs, ...(info.dir ? {dir: true} : {})},
			}
			return addRow(who, row, null)
		}
		if (scope === 'swarm') {
			requireOwner(who)
			const id = String(input?.id ?? '')
			const path = String(input?.path ?? '')
			const info = await fleet.stat(id, path)
			const dir = !!info?.dir
			if (!dir && (!Number.isSafeInteger(info?.size) || info.size < 0)) throw new RpcError('BAD_GATEWAY', 'That computer didn’t say how big the file is')
			const label = cleanLabel(input?.label, info.name || 'file')
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				...cutOf(input),
				where: 'swarm',
				name: fileName(info.name || label),
				preview: dir ? oneLine(`${label} · folder`) : oneLine(`${label} on that computer · ${info.size} bytes`),
				ref: {scope: 'swarm', path, id, size: dir ? 0 : info.size, mtime: Number.isSafeInteger(info.mtime) ? info.mtime : 0, ...(dir ? {dir: true} : {})},
			}
			return addRow(who, row, null)
		}
		if (scope === 'machine') {
			requireOwner(who)
			const id = String(input?.id ?? '')
			const path = vmPath(input?.path)
			if (!path) throw new RpcError('BAD_REQUEST', 'Name the file on that machine')
			const found = await readers.machine?.(id)
			if (!found?.name) throw new RpcError('NOT_FOUND', 'That machine isn’t on this server')
			const base = path.split(/[/\\]/).filter(Boolean).at(-1) || 'file'
			const label = cleanLabel(input?.label, base)
			const row = {
				id: randomBytes(8).toString('hex'),
				kind: 'file',
				at: now(),
				label,
				where: 'machine',
				name: fileName(base),
				preview: oneLine(`${label} is still on ${found.name}`),
				ref: {scope: 'machine', path, id, size: null, mtime: null},
			}
			return addRow(who, row, null)
		}
		throw new RpcError('BAD_REQUEST', 'Choose a file on this server, a computer, or a machine')
	}

	function fileFailure(error) {
		const code = error?.code
		const msg = String(error?.message ?? '')
		if (code === 'PRECONDITION_FAILED' || /offline/i.test(msg)) return 'offline'
		if (code === 'NOT_FOUND' && /swarm|isn’t on this server/i.test(msg)) return 'offline'
		if (code === 'NOT_FOUND' || MISSING_FILE.test(msg)) return 'missing'
		return 'offline'
	}
	async function blobThere(who, clip) {
		try {
			await blob(who, clip)
			return true
		} catch {
			return false
		}
	}
	function storedMachine(clip) {
		if (typeof clip.machine === 'string' && clip.machine) return clip.machine
		if (clip.kind === 'stats') {
			const name = String(clip.preview || '').split('·')[0].trim()
			return name || 'This server'
		}
		if (clip.where === 'desktop') return 'Desktop'
		return 'Terminal'
	}
	async function placeOf(who, clip) {
		if (clip.kind !== 'file') {
			const there = await blobThere(who, clip)
			return {machine: storedMachine(clip), availability: there ? 'available' : 'missing'}
		}
		const ref = clip.ref
		if (ref.scope === 'server') {
			try {
				const info = await files.inspect(ref.path)
				return {machine: 'This server', availability: 'available', dir: !!info.dir}
			} catch (error) {
				return {machine: 'This server', availability: fileFailure(error), dir: !!ref.dir}
			}
		}
		if (ref.scope === 'swarm') {
			let name = 'Another computer'
			const found = await readers.swarm?.(ref.id).catch(() => null)
			if (found?.name) name = found.name
			if (!found?.name || found.online === false) return {machine: name, availability: 'offline', dir: !!ref.dir}
			try {
				const info = await fleet.stat(ref.id, ref.path)
				if (!info) return {machine: name, availability: 'missing', dir: !!ref.dir}
				const dir = !!info.dir || !!ref.dir || !!ref.items?.some((item) => item.dir)
				return {machine: name, availability: 'available', dir}
			} catch (error) {
				return {machine: name, availability: fileFailure(error), dir: !!ref.dir}
			}
		}
		const found = await readers.machine?.(ref.id).catch(() => null)
		return {machine: found?.name || 'A virtual machine', availability: 'offline', dir: !!ref.dir}
	}
	async function annotate(who, clip) {
		const row = pub(clip)
		const place = await placeOf(who, clip)
		row.machine = place.machine
		row.availability = place.availability
		if (place.dir) row.dir = true
		return row
	}
	async function list(_input, ctx) {
		const who = actor(ctx.auth)
		const book = await load(who.userId)
		if (book.damaged) return {clips: [], damaged: true}
		const rows = []
		for (let i = book.clips.length - 1; i >= 0; i--) rows.push(await annotate(who, book.clips[i]))
		rows.sort((a, b) => b.at - a.at)
		return {clips: rows, damaged: false}
	}
	async function remove(input, ctx) {
		const who = actor(ctx.auth)
		return withBook(who.userId, async () => {
			const book = await load(who.userId)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const id = String(input?.id ?? '')
			if (!CLIP_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That clip isn’t in the book')
			if (!book.clips.some((clip) => clip.id === id)) throw new RpcError('NOT_FOUND', 'That clip isn’t in the book')
			await writeAtomic(book.file, JSON.stringify({clips: book.clips.filter((clip) => clip.id !== id)}, null, '\t'))
			await rm(join(bookDir(who.userId), `${id}.blob`), {force: true})
			return true
		})
	}

	async function take(who, id) {
		const book = await load(who.userId)
		if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
		if (!CLIP_ID.test(String(id ?? ''))) throw new RpcError('BAD_REQUEST', 'That clip isn’t in the book')
		const clip = book.clips.find((row) => row.id === id)
		if (!clip) throw new RpcError('NOT_FOUND', 'That clip isn’t in the book')
		return clip
	}
	async function blob(who, clip) {
		const path = join(bookDir(who.userId), `${clip.id}.blob`)
		const st = await stat(path).catch(() => null)
		if (!st?.isFile() || st.size !== clip.bytes) throw new RpcError('PRECONDITION_FAILED', 'That clip’s file is missing.')
		return path
	}
	async function textOf(who, clip) {
		if (clip.kind === 'stats') return clip.preview
		if (clip.kind !== 'text') throw new RpcError('BAD_REQUEST', clip.kind === 'image' ? 'Save that screenshot into a folder.' : 'Save that file into a folder.')
		if (clip.bytes > Math.min(PASTE_TEXT, limits.text)) throw new RpcError('BAD_REQUEST', 'That clip is too big to paste here. Save it into a folder.')
		return decodeText(await readFile(await blob(who, clip)))
	}

	// Several paths are one clip. Another computer receives the first file. The rest stay put.
	function firstFile(ref) {
		if (!Array.isArray(ref?.items) || !ref.items.length) return ref
		const item = ref.items[0]
		return {scope: ref.scope, path: item.path, id: ref.id, size: item.size, mtime: item.mtime, dir: !!item.dir}
	}
	async function freshServer(ref) {
		if (Array.isArray(ref.items) && ref.items.length) {
			const infos = []
			for (const item of ref.items) infos.push(await freshServer({path: item.path, size: item.size, mtime: item.mtime, dir: item.dir}))
			return infos
		}
		const info = await files.inspect(ref.path)
		if (!!info.dir !== !!ref.dir) throw new RpcError('CONFLICT', CHANGED)
		if (info.dir) {
			if (info.mtimeMs !== ref.mtime) throw new RpcError('CONFLICT', CHANGED)
			return info
		}
		if (info.size !== ref.size || info.mtimeMs !== ref.mtime) throw new RpcError('CONFLICT', CHANGED)
		return info
	}
	async function freshSwarm(ref) {
		requireOwner({role: 'owner'})
		const lead = firstFile(ref)
		const info = await fleet.stat(ref.id, lead.path)
		const mtime = Number.isSafeInteger(info?.mtime) ? info.mtime : 0
		if (!!info?.dir !== !!lead.dir) throw new RpcError('CONFLICT', CHANGED)
		if (info?.dir) {
			if (mtime !== lead.mtime) throw new RpcError('CONFLICT', CHANGED)
			return info
		}
		if (info?.size !== lead.size || mtime !== lead.mtime) throw new RpcError('CONFLICT', CHANGED)
		return info
	}
	async function transferFile() {
		const root = join(dataDir, 'clips')
		const dir = join(root, '.transfer')
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(root, 0o700)
		await chmod(dir, 0o700)
		return join(dir, randomBytes(8).toString('hex'))
	}
	async function pullToTemp(ref) {
		const lead = firstFile(ref)
		const tmp = await transferFile()
		const out = createWriteStream(tmp, {flags: 'wx', mode: 0o600})
		try {
			const meta = await fleet.pull(ref.id, lead.path, async (buf) => {
				if (!out.write(buf)) await once(out, 'drain')
			})
			out.end()
			await finished(out)
			if (meta?.size !== lead.size) throw new RpcError('CONFLICT', CHANGED)
			return tmp
		} catch (error) {
			out.destroy()
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	}

	async function placeServer(path, folder, cut) {
		const op = cut ? files.move : files.copy
		return op({path, toDirectory: folder, collision: 'keep-both'})
	}
	// A cut leaves the source until the new copy is in place. A failed removal keeps the paste.
	async function dropCutSource(clip) {
		if (!clip?.cut || clip.kind !== 'file' || !clip.ref) return false
		const ref = clip.ref
		const paths = Array.isArray(ref.items) && ref.items.length ? ref.items.map((item) => item.path) : [ref.path]
		try {
			if (ref.scope === 'server') {
				if (typeof files.trash !== 'function') return true
				for (const path of paths) await files.trash({path})
				return false
			}
			if (ref.scope === 'swarm') {
				if (typeof fleet.remove !== 'function') return true
				for (const path of paths) await fleet.remove(ref.id, path)
				return false
			}
			return true
		} catch {
			return true
		}
	}
	async function intoFolder(who, clip, folder) {
		if (typeof folder !== 'string' || !folder.startsWith('/')) throw new RpcError('BAD_REQUEST', 'Choose a folder')
		if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
		if (clip.kind === 'file' && clip.ref.scope === 'server') {
			await freshServer(clip.ref)
			if (Array.isArray(clip.ref.items) && clip.ref.items.length) {
				let saved = null
				for (const item of clip.ref.items) saved = await placeServer(item.path, folder, false)
				return {path: saved, kept: clip.cut ? await dropCutSource(clip) : false}
			}
			return {path: await placeServer(clip.ref.path, folder, !!clip.cut), kept: false}
		}
		if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
			requireOwner(who)
			if (clip.ref.dir || clip.ref.items?.some((item) => item.dir)) throw new RpcError('PRECONDITION_FAILED', FOLDER_FROM_COMPUTER)
			await freshSwarm(clip.ref)
			const tmp = await pullToTemp(clip.ref)
			try {
				const path = await files.saveNew(folder, clip.name, createReadStream(tmp), 'keep-both')
				// Several paths are one clip, and this paste writes one file. Leave the rest in place.
				const many = Array.isArray(clip.ref.items) && clip.ref.items.length > 1
				const kept = !clip.cut ? false : many ? true : await dropCutSource(clip)
				return {path, kept}
			} finally {
				await rm(tmp, {force: true}).catch(() => {})
			}
		}
		const path = await blob(who, clip)
		return {path: await files.saveNew(folder, clip.name, createReadStream(path), 'keep-both'), kept: false}
	}
	function joinComputer(folder, name) {
		const dir = String(folder ?? '').replace(/^\/+|\/+$/g, '')
		const base = String(name || 'clip').replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'clip'
		return dir ? `${dir}/${base}` : base
	}
	async function ontoComputer(who, clip, computer, path) {
		requireOwner(who)
		if (clip.kind === 'file' && (clip.ref.dir || clip.ref.items?.some((item) => item.dir))) {
			throw new RpcError('PRECONDITION_FAILED', FOLDER_TO_COMPUTER)
		}
		if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
		const dest = String(path ?? '')
		if (!dest) throw new RpcError('BAD_REQUEST', 'Name a file on that computer')
		let tmp = null
		try {
			let size
			let source
			if (clip.kind === 'file' && clip.ref.scope === 'server') {
				const lead = firstFile(clip.ref)
				const info = await freshServer(lead)
				size = info.size
				source = (await files.openRead(lead.path)).stream
			} else if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
				const lead = firstFile(clip.ref)
				await freshSwarm(lead)
				tmp = await pullToTemp(lead)
				size = lead.size
				source = createReadStream(tmp)
			} else {
				const file = await blob(who, clip)
				size = clip.bytes
				source = createReadStream(file)
			}
			try {
				await fleet.push(computer, dest, size, chunker(source))
			} finally {
				source.destroy()
			}
			const samePlace = clip.kind === 'file' && clip.ref?.scope === 'swarm' && clip.ref.id === computer && (clip.ref.path === dest || clip.ref.items?.some((item) => item.path === dest))
			const many = clip.kind === 'file' && Array.isArray(clip.ref?.items) && clip.ref.items.length > 1
			const kept = !clip.cut || samePlace ? false : many ? true : await dropCutSource(clip)
			return {path: dest, kept}
		} finally {
			if (tmp) await rm(tmp, {force: true}).catch(() => {})
		}
	}

	async function pasteMany(who, ids, dest) {
		if (dest?.clipboard !== 'server') throw new RpcError('BAD_REQUEST', 'Choose where to paste it')
		const parts = []
		for (const id of ids) {
			const clip = await take(who, id)
			if (clip.kind !== 'text' && clip.kind !== 'stats') throw new RpcError('PRECONDITION_FAILED', 'Text and files go to different places.')
			parts.push((await textOf(who, clip)).trim())
		}
		const text = parts.filter((part) => part.length > 0).join('\n\n')
		if (typeof readers.writeClipboard !== 'function') throw new RpcError('PRECONDITION_FAILED', 'This server can’t take clipboard text right now')
		await readers.writeClipboard(text)
		return {text, count: ids.length}
	}
	async function paste(input, ctx) {
		const who = actor(ctx.auth)
		const dest = input?.dest
		const ids = Array.isArray(input?.ids) ? input.ids.map((id) => String(id)).filter(Boolean) : null
		if (ids && ids.length > 1) return pasteMany(who, ids, dest)
		const clip = await take(who, ids?.length === 1 ? ids[0] : input?.id)
		if (dest === 'text' || dest?.text === true) return {text: await textOf(who, clip)}
		if (dest?.clipboard === 'server') {
			const text = await textOf(who, clip)
			if (typeof readers.writeClipboard !== 'function') throw new RpcError('PRECONDITION_FAILED', 'This server can’t take clipboard text right now')
			await readers.writeClipboard(text)
			return {text}
		}
		if (typeof dest?.computer === 'string' && typeof dest?.folder === 'string') return ontoComputer(who, clip, dest.computer, joinComputer(dest.folder, clip.name))
		if (typeof dest?.folder === 'string') return intoFolder(who, clip, dest.folder)
		if (typeof dest?.computer === 'string') return ontoComputer(who, clip, dest.computer, dest.path)
		throw new RpcError('BAD_REQUEST', 'Choose where to paste it')
	}
	async function fleetList(input, ctx) {
		const who = actor(ctx.auth)
		requireOwner(who)
		return fleet.list(String(input?.id ?? ''), input?.path ?? '')
	}

	async function resetAll() {
		await rm(join(dataDir, 'clips'), {recursive: true, force: true})
	}

	function browser(req) {
		const auth = authenticate(req)
		if (!auth || auth.kind !== 'browser') return null
		return auth
	}
	async function httpText(req, res, url) {
		const auth = browser(req)
		if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const clip = await addTextBuffer(actor(auth), await readCapped(req, limits.text), Object.fromEntries(url.searchParams))
			return sendJson(res, 200, {ok: true, clip})
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}
	async function httpImage(req, res, url) {
		const auth = browser(req)
		if (!auth) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const buf = await readCapped(req, limits.image)
			if (buf.length < PNG.length || !buf.subarray(0, PNG.length).equals(PNG)) throw new RpcError('BAD_REQUEST', 'That isn’t a PNG screenshot.')
			const label = cleanLabel(url.searchParams.get('label'), 'Screenshot')
			const row = {id: randomBytes(8).toString('hex'), kind: 'image', at: now(), label, where: 'desktop', name: fileName(label, '.png'), bytes: buf.length, preview: 'Screenshot'}
			const clip = await addRow(actor(auth), row, buf)
			return sendJson(res, 200, {ok: true, clip})
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}
	async function httpItem(req, res, url) {
		const auth = urlUser(url.searchParams.get('token'), req)
		if (!auth?.userId) return sendJson(res, 401, {error: 'unauthorized'})
		try {
			const who = actor(auth)
			const clip = await take(who, url.searchParams.get('id'))
			if (clip.kind === 'file' && clip.ref.scope === 'machine') throw new RpcError('PRECONDITION_FAILED', STILL)
			res.setHeader('X-Content-Type-Options', 'nosniff')
			res.setHeader('Cache-Control', 'private, no-store')
			// A finished GET also emits close. Stop the source only when the client left early.
			let clientLeft = false
			res.on('close', () => {
				if (!res.writableFinished) clientLeft = true
			})
			if (clip.kind === 'file' && clip.ref.scope === 'server') {
				const lead = firstFile(clip.ref)
				const info = await freshServer(lead)
				res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(info.size), 'content-disposition': disposition(clip.name, false)})
				const opened = await files.openRead(lead.path)
				res.on('close', () => {
					if (!res.writableFinished) opened.stream.destroy()
				})
				opened.stream.on('error', () => res.destroy())
				return opened.stream.pipe(res)
			}
			if (clip.kind === 'file' && clip.ref.scope === 'swarm') {
				requireOwner(who)
				const lead = firstFile(clip.ref)
				const info = await freshSwarm(lead)
				res.writeHead(200, {'content-type': 'application/octet-stream', 'content-length': String(info.size), 'content-disposition': disposition(clip.name, false)})
				let failed = false
				await fleet.pull(clip.ref.id, lead.path, async (buf) => {
					if (clientLeft || res.destroyed || req.destroyed) {
						failed = true
						throw new Error('closed')
					}
					if (!res.write(buf)) await once(res, 'drain')
				})
				if (!failed) res.end()
				return
			}
			const path = await blob(who, clip)
			const type = clip.kind === 'image' ? 'image/png' : clip.kind === 'stats' ? 'application/json' : 'text/plain; charset=utf-8'
			res.writeHead(200, {'content-type': type, 'content-length': String(clip.bytes), 'content-disposition': disposition(clip.name, clip.kind === 'image')})
			const stream = createReadStream(path)
			res.on('close', () => {
				if (!res.writableFinished) stream.destroy()
			})
			stream.on('error', () => res.destroy())
			return stream.pipe(res)
		} catch (error) {
			if (!res.headersSent) return sendError(res, error)
			res.destroy()
		}
	}

	const procedures = {
		'clips.list': {kind: 'query', run: list},
		'clips.addText': {kind: 'mutation', run: async (input, ctx) => {
			const buf = Buffer.from(String(input?.text ?? ''), 'utf8')
			if (buf.length > Math.min(RPC_TEXT, limits.text)) throw new RpcError('BAD_REQUEST', 'That clip is too big to send this way.')
			return addTextBuffer(actor(ctx.auth), buf, input ?? {})
		}},
		'clips.addStats': {kind: 'mutation', run: addStats},
		'clips.addFile': {kind: 'mutation', run: addFile},
		'clips.remove': {kind: 'mutation', run: remove},
		'clips.paste': {kind: 'mutation', run: paste},
		'clips.fleetList': {kind: 'query', run: fleetList},
	}

	return {procedures, resetAll, httpText, httpImage, httpItem}
}
