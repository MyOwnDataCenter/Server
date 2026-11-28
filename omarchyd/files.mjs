// Files: the web app's /Home is the owner's real home folder, and /Trash is the freedesktop trash
// (~/.local/share/Trash) that Omarchy's own file manager uses, so browser and desktop agree.
// Every path is resolved and checked to stay inside those folders, symlinks included.
import {constants as fsc, createReadStream, createWriteStream} from 'node:fs'
import {Readable} from 'node:stream'
import {cp, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join, resolve as pathResolve, sep} from 'node:path'
import {pipeline} from 'node:stream/promises'
import os from 'node:os'
import {createHash, randomBytes} from 'node:crypto'

import {readJsonState, writeAtomic} from './atomic.mjs'
import {createKeyedLock} from './locks.mjs'
import {RpcError} from './rpc.mjs'

const MIME = {
	jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
	mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
	mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus',
	pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', iso: 'application/x-iso9660-image',
	txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', sh: 'text/x-shellscript', py: 'text/x-python', yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', conf: 'text/plain', ini: 'text/plain',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
	ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
}
const typeFor = (name) => MIME[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
const SEARCH_BUDGET_MS = 8000
const RECENTS_BUDGET_MS = 30000
const RECENT_LIMIT = 30

// Freedesktop Trash DeletionDate is local YYYY-MM-DDThh:mm:ss, with no zone suffix.
export function deletionDateStamp(date = new Date()) {
	const p = (n) => String(n).padStart(2, '0')
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

// Keep-both inserts " (n)" before a real extension. Folders have none. A suffix counts only when
// it is 1–8 letters or digits and contains a letter, so "v1.2" and "Dr. Smith" stay intact and
// "archive.tar.gz" still keeps ".gz".
export function keepBothParts(name, directory = false) {
	const text = typeof name === 'string' ? name : String(name ?? '')
	if (directory) return {stem: text, ext: ''}
	const dot = text.lastIndexOf('.')
	if (dot <= 0) return {stem: text, ext: ''}
	const suffix = text.slice(dot + 1)
	if (!/^[A-Za-z0-9]{1,8}$/.test(suffix) || !/[A-Za-z]/.test(suffix)) return {stem: text, ext: ''}
	return {stem: text.slice(0, dot), ext: text.slice(dot)}
}

export function keepBothCandidate(name, n, directory = false) {
	if (n <= 1) return name
	const {stem, ext} = keepBothParts(name, directory)
	return `${stem} (${n})${ext}`
}

export function uploadStatusForFsError(error) {
	const code = error?.code
	if (code === 'ENOSPC' || code === 'EDQUOT') return {status: 507, error: 'Not enough free space'}
	if (code === 'EACCES') return {status: 403, error: 'Permission denied'}
	if (code === 'EROFS') return {status: 403, error: 'Read-only'}
	if (code === 'ENOENT') return {status: 404, error: 'Folder not found'}
	return null
}

function nameProblem(n) {
	if (typeof n !== 'string' || n.length === 0 || Buffer.byteLength(n) > 255 || n.includes('/') || n.includes('\0') || n === '.' || n === '..') return '[invalid-name]'
	if (n.startsWith('.')) return '[hidden-name]'
	return null
}
// A Content-Disposition value that any file name can travel in: the name goes out percent-encoded
// (UTF-8), so a name outside Latin-1 cannot make the response fail.
export const contentDisposition = (name, inline = false) => `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
// Shown inline when viewed; everything else is sent as a download.
const INLINE = /^(image\/(jpeg|png|gif|webp|avif|bmp)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf|text\/plain)/
const STAT_CONCURRENCY = 16

function shownName(name) {
	return Buffer.isBuffer(name) ? name.toString('utf8') : String(name)
}
// Join without decoding the child name as UTF-8, so a Latin-1 byte still stats.
function childPath(dir, name) {
	const dirBuf = Buffer.isBuffer(dir) ? dir : Buffer.from(dir)
	const nameBuf = Buffer.isBuffer(name) ? name : Buffer.from(name)
	const sepBuf = Buffer.from(sep)
	if (dirBuf.length >= sepBuf.length && dirBuf.subarray(-sepBuf.length).equals(sepBuf)) return Buffer.concat([dirBuf, nameBuf])
	return Buffer.concat([dirBuf, sepBuf, nameBuf])
}
function trashInfoName(fileName) {
	const suffix = '.trashinfo'
	const plain = `${fileName}${suffix}`
	if (Buffer.byteLength(plain) <= 255) return plain
	return `${createHash('sha256').update(fileName).digest('hex')}${suffix}`
}
function fileTag(st) {
	return `"${st.size}-${st.mtime.getTime()}"`
}
function ifRangeMatches(header, st) {
	if (header == null || header === '') return true
	const value = (Array.isArray(header) ? header[0] : String(header)).trim()
	if (value === fileTag(st)) return true
	const parsed = Date.parse(value)
	if (Number.isNaN(parsed)) return false
	return new Date(parsed).toUTCString() === st.mtime.toUTCString()
}
function mapFsError(error, path) {
	if (error instanceof RpcError) throw error
	const code = error?.code
	if (code === 'EACCES') throw new RpcError('FORBIDDEN', '[permission]')
	if (code === 'EROFS') throw new RpcError('FORBIDDEN', '[read-only]')
	if (code === 'ENOTDIR') {
		const name = typeof path === 'string' ? basename(dirname(path)) : ''
		throw new RpcError('BAD_REQUEST', `[not-a-directory:${name || 'That'}]`)
	}
	if (code === 'ENOSPC') throw new RpcError('BAD_REQUEST', '[no-space]')
	throw error
}
function guard(run) {
	return async (input, ctx) => {
		try {
			return await run(input, ctx)
		} catch (error) {
			mapFsError(error, input?.path)
		}
	}
}

async function mapPool(items, n, fn) {
	const out = new Array(items.length)
	let i = 0
	await Promise.all(
		Array.from({length: Math.min(n, items.length)}, async () => {
			while (i < items.length) {
				const idx = i++
				out[idx] = await fn(items[idx], idx)
			}
		}),
	)
	return out
}

// /External is the drives you mount in Storage: they go under /run/media/<you>, and each one is a
// folder here. A drive itself can't be moved, renamed or trashed (unmount it in Storage instead).
// The largest piece of a chunked upload (the browser sends 8 MB).
const CHUNK_MAX = 64 * 1024 * 1024

export function createFiles({home, dataDir, io, drivesDir = join('/run/media', os.userInfo().username)} = {}) {
	const mkdirOp = typeof io?.mkdir === 'function' ? io.mkdir : mkdir
	const trashRoot = join(home, '.local/share/Trash')
	const trashFiles = join(trashRoot, 'files')
	const trashInfo = join(trashRoot, 'info')
	const favoritesFile = join(dataDir, 'favorites.json')
	const lock = createKeyedLock()
	let homeReal = null
	const roots = async () => (homeReal ??= await realpath(home))
	// Keys and the rest of omarchyd state live under dataDir, often inside Home. Never serve that tree.
	const realCache = new Map()
	async function cachedReal(target) {
		if (realCache.has(target)) return realCache.get(target)
		try {
			const real = await realpath(target)
			realCache.set(target, real)
			return real
		} catch {
			return null
		}
	}
	const privateRoots = typeof dataDir === 'string' ? [dataDir, join(dataDir, 'assistant')] : []

	// Virtual path -> real path, refusing anything outside /Home or /Trash.
	async function resolve(virtual, {mustExist = true} = {}) {
		if (typeof virtual !== 'string' || !virtual.startsWith('/') || virtual.includes('\0')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const parts = virtual.split('/').filter(Boolean)
		if (parts.some((p) => p === '..' || p === '.')) throw new RpcError('BAD_REQUEST', '[invalid-path]')
		const [top, ...rest] = parts
		const base = top === 'Home' ? await roots() : top === 'Trash' ? trashFiles : top === 'External' ? drivesDir : null
		if (!base) throw new RpcError('NOT_FOUND', '[does-not-exist]')
		const real = join(base, ...rest)
		// Follow symlinks for what exists, and make sure we're still inside the base.
		const check = mustExist ? real : dirname(real)
		let resolved
		try {
			resolved = await realpath(check)
		} catch {
			throw new RpcError('NOT_FOUND', '[does-not-exist]')
		}
		// Drives are what's mounted: nothing new is made beside them.
		if (top === 'External' && !mustExist && rest.length === 1) throw new RpcError('BAD_REQUEST', '[cannot-create-here]')
		if (top === 'External' && !(await lstat(drivesDir).then(() => true, () => false))) {
			// Nothing mounted yet: an empty Drives, not an error.
			if (rest.length) throw new RpcError('NOT_FOUND', '[does-not-exist]')
		}
		const baseReal = top === 'Home' ? base : await realpath(base).catch(() => base)
		if (resolved !== baseReal && !resolved.startsWith(baseReal + sep)) throw new RpcError('FORBIDDEN', '[outside-home]')
		const homeRoot = await roots()
		for (const target of privateRoots) {
			const blocked = await cachedReal(target)
			if (!blocked || blocked === homeRoot || homeRoot.startsWith(blocked + sep)) continue
			if (resolved === blocked || resolved.startsWith(blocked + sep)) throw new RpcError('FORBIDDEN', '[outside-home]')
		}
		return {real, top, base}
	}
	// Trash lives inside Home, so it's checked first.
	const toVirtual = async (real) => {
		const h = await roots()
		const text = Buffer.isBuffer(real) ? real.toString('utf8') : real
		const t = join(h, '.local/share/Trash/files')
		if (text === t || text.startsWith(t + sep)) return `/Trash${text.slice(t.length)}`
		if (text === trashFiles || text.startsWith(trashFiles + sep)) return `/Trash${text.slice(trashFiles.length)}`
		if (text === h || text.startsWith(h + sep)) return `/Home${text.slice(h.length)}`
		const d = (await cachedReal(drivesDir)) ?? drivesDir
		if (text === d || text.startsWith(d + sep)) return `/External${text.slice(d.length)}`
		return null
	}

	async function entry(virtual, real, st) {
		st ??= await stat(real)
		const dir = st.isDirectory()
		const file = st.isFile()
		const inTrash = virtual.startsWith('/Trash/')
		const name = virtual === '/Home' ? 'Home' : virtual === '/Trash' ? 'Trash' : virtual === '/External' ? 'Drives' : basename(virtual)
		const type = dir ? 'directory' : typeFor(name)
		const top = virtual === '/Home' || virtual === '/Trash' || virtual === '/External'
		const ops = top
			? virtual === '/Home'
				? ['writable']
				: []
			: inTrash
				? ['restore', 'delete']
				: isDriveRoot(virtual)
					? ['copy', 'favorite', 'writable']
					: ['copy', 'move', 'rename', 'trash', 'favorite', 'writable']
		// Home folders can be shared on the LAN. The client shows that only for the owner.
		if (dir && virtual.startsWith('/Home/')) ops.push('share')
		return {
			name,
			path: virtual,
			type,
			...(dir ? {} : {size: st.size}),
			modified: st.mtimeMs,
			operations: file && !top && !inTrash ? [...ops, 'download', 'view'] : ops,
		}
	}
	const visible = (name) => !name.startsWith('.')
	// A mounted drive's own folder (/External/<drive>).
	function isDriveRoot(virtual) {
		return /^\/External\/[^/]+$/.test(virtual)
	}
	const refuseDriveRoot = (virtual, code) => {
		if (typeof virtual === 'string' && isDriveRoot(virtual.replace(/\/+$/, ''))) throw new RpcError('BAD_REQUEST', code)
	}

	async function list({path, sortBy = 'name', sortOrder = 'ascending', limit} = {}) {
		if (path === '/Trash') {
			const h = await roots()
			let near = join(h, '.local/share/Trash/files')
			while (near !== h && near !== dirname(near) && !(await lstat(near).then(() => true, () => false))) near = dirname(near)
			const nearReal = await realpath(near).catch(() => '')
			if (nearReal === h || nearReal.startsWith(h + sep)) await mkdirOp(trashFiles, {recursive: true})
		}
		if (path === '/External' && !(await lstat(drivesDir).then(() => true, () => false))) {
			return {name: 'Drives', path, type: 'directory', modified: 0, operations: [], files: [], hasMore: false, totalFiles: 0}
		}
		const {real} = await resolve(path)
		const st = await stat(real)
		if (!st.isDirectory()) throw new RpcError('BAD_REQUEST', '[not-a-directory]')
		const dirents = (await readdir(real, {withFileTypes: true, encoding: 'buffer'})).filter((d) => visible(shownName(d.name)))
		const totalFiles = dirents.length
		const cap = Number.isInteger(limit) && limit > 0 ? limit : null
		const dirFirst = (a, b) => Number(!!b.dir) - Number(!!a.dir)
		const textCmp = (a, b, key) => String(a[key]).localeCompare(String(b[key]), undefined, {numeric: true, sensitivity: 'base'})
		const key = sortBy === 'modified' ? 'modified' : sortBy === 'size' ? 'size' : sortBy === 'type' ? 'type' : 'name'
		const toEntry = async (d) => {
			const name = shownName(d.name)
			const r = childPath(real, d.name)
			const s = await stat(r).catch(() => null) // broken symlinks are skipped
			return s ? await entry(`${path}/${name}`, r, s) : null
		}

		let files
		let countable
		const order = sortOrder === 'descending' ? -1 : 1
		if (key === 'modified' || key === 'size') {
			// mtime/size sort needs every entry's stat; we still honour limit after sorting.
			const rows = (await mapPool(dirents, STAT_CONCURRENCY, (d) => toEntry(d))).filter(Boolean)
			rows.sort((a, b) => dirFirst({dir: a.type === 'directory'}, {dir: b.type === 'directory'}) || order * ((a[key] ?? 0) - (b[key] ?? 0)) || textCmp(a, b, 'name'))
			countable = rows.length
			files = cap ? rows.slice(0, cap) : rows
		} else {
			// Name/type: sort from dirents (cheap), slice, then stat only the page.
			// A link to a folder sorts with the folders (as it did when every entry was stat'ed).
			const isDir = async (d) => d.isDirectory() || (d.isSymbolicLink() && (await stat(childPath(real, d.name)).then((s) => s.isDirectory(), () => false)))
			const rows = await mapPool(dirents, STAT_CONCURRENCY, async (d) => {
				const dir = await isDir(d)
				const name = shownName(d.name)
				return {name, dir, type: dir ? 'directory' : typeFor(name), d}
			})
			rows.sort((a, b) => dirFirst(a, b) || order * textCmp(a, b, key === 'type' ? 'type' : 'name') || textCmp(a, b, 'name'))
			countable = rows.length
			const page = cap ? rows.slice(0, cap) : rows
			files = (await mapPool(page, STAT_CONCURRENCY, (row) => toEntry(row.d))).filter(Boolean)
		}
		return {...(await entry(path, real, st)), files, hasMore: cap != null && countable > cap, totalFiles}
	}

	// A free name next to the original: "Report (2).pdf", or "Photos 2024.05 (2)" for a folder.
	async function freeName(dir, name, directory = false) {
		for (let n = 1; ; n++) {
			const candidate = join(dir, keepBothCandidate(name, n, directory))
			try {
				await lstat(candidate)
			} catch {
				return candidate
			}
		}
	}
	const isDirPath = (real) => stat(real).then((s) => s.isDirectory(), () => false)
	const assertVisibleName = (n) => {
		const problem = nameProblem(n)
		if (problem) throw new RpcError('BAD_REQUEST', problem)
	}
	// Storage registers this so a renamed, moved, or trashed folder takes its network share with it.
	// Copy leaves the share on the original. `to` is null when the folder was trashed.
	let follow = async () => {}

	async function createDirectory(input) {
		const path = input && typeof input === 'object' ? input.path : undefined
		if (typeof path !== 'string') throw new RpcError('BAD_REQUEST', 'Path must be a string')
		assertVisibleName(basename(path))
		const {real} = await resolve(path, {mustExist: false})
		await mkdirOp(real).catch((e) => {
			if (e.code === 'EEXIST') throw new RpcError('CONFLICT', '[already-exists]')
			throw e
		})
		return path
	}
	async function renameItem({path, newName}) {
		assertVisibleName(newName)
		refuseDriveRoot(path, '[drive-root]')
		const {real, base} = await resolve(path)
		if (real === base) throw new RpcError('BAD_REQUEST', '[cannot-rename]')
		const target = join(dirname(real), newName)
		if (await lstat(target).then(() => true, () => false)) throw new RpcError('CONFLICT', '[already-exists]')
		const fromVirtual = await toVirtual(real)
		await rename(real, target)
		const next = await toVirtual(target)
		await retargetFavorites(fromVirtual, next)
		await follow(fromVirtual, next)
		return next
	}
	async function moveOrCopy({path, toDirectory, collision = 'keep-both'}, copy) {
		if (!copy) refuseDriveRoot(path, '[drive-root]')
		if (toDirectory === '/External') throw new RpcError('BAD_REQUEST', '[cannot-move]')
		const {real, base} = await resolve(path)
		if (real === base) throw new RpcError('BAD_REQUEST', '[cannot-move]')
		const {real: dest} = await resolve(toDirectory)
		// `dest` and `real` are the paths as typed (symlink names included). A link that sits
		// outside the folder can still point inside it; comparing those real paths rejects the
		// copy before it nests, and a realpath failure must not fall through to cp.
		const sourceReal = await realpath(real)
		const destReal = await realpath(dest)
		if (dest === real || dest.startsWith(real + sep) || destReal === sourceReal || destReal.startsWith(sourceReal + sep)) {
			throw new RpcError('BAD_REQUEST', '[subdir-of-self]')
		}
		const fromVirtual = await toVirtual(real)
		const directory = await isDirPath(real)
		let target = join(dest, basename(real))
		// Only replace of this same file returns early. A directory symlink to the parent still
		// names that file once both paths are real; a hard link in another folder does not.
		let targetReal = null
		if (collision === 'replace') {
			targetReal = await realpath(target).catch(() => null)
			if (targetReal !== null && targetReal === sourceReal) return toVirtual(real)
		}
		if (await lstat(target).then(() => true, () => false)) {
			if (collision === 'error') throw new RpcError('CONFLICT', '[already-exists]')
			if (collision === 'replace') {
				// The replacement target can be this item's parent (the source sits inside it, or
				// they are the same path). rm would delete that parent. Refuse instead.
				if (
					targetReal !== null &&
					(sourceReal === targetReal || sourceReal.startsWith(targetReal + sep) || targetReal === destReal || targetReal.startsWith(sourceReal + sep))
				) {
					throw new RpcError('BAD_REQUEST', '[subdir-of-self]')
				}
				await rm(target, {recursive: true, force: true})
			} else target = await freeName(dest, basename(real), directory)
		}
		if (copy) await cp(real, target, {recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true})
		else
			await rename(real, target).catch(async (e) => {
				if (e.code !== 'EXDEV') throw e
				await cp(real, target, {recursive: true, verbatimSymlinks: true})
				await rm(real, {recursive: true, force: true})
			})
		const next = await toVirtual(target)
		if (!copy) {
			await retargetFavorites(fromVirtual, next)
			await follow(fromVirtual, next)
		}
		return next
	}

	// Trash the freedesktop way: the item in Trash/files, a .trashinfo with where it came from.
	async function trash({path}) {
		const {real, top} = await resolve(path)
		if ((top !== 'Home' && top !== 'External') || path === '/Home' || path === '/External') throw new RpcError('BAD_REQUEST', '[cannot-trash]')
		refuseDriveRoot(path, '[drive-root]')
		await mkdirOp(trashFiles, {recursive: true})
		await mkdirOp(trashInfo, {recursive: true})
		const target = await freeName(trashFiles, basename(real), await isDirPath(real))
		const info = `[Trash Info]\nPath=${encodeURI(real)}\nDeletionDate=${deletionDateStamp()}\n`
		await writeFile(join(trashInfo, trashInfoName(basename(target))), info)
		await rename(real, target).catch(async (e) => {
			if (e.code !== 'EXDEV') throw e
			await cp(real, target, {recursive: true, verbatimSymlinks: true})
			await rm(real, {recursive: true, force: true})
		})
		const next = await toVirtual(target)
		await follow(await toVirtual(real), null)
		return next
	}
	async function restore({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash') throw new RpcError('BAD_REQUEST', '[not-in-trash]')
		// Only a direct child of Trash/files has its own .trashinfo. A nested file can share a
		// basename with another trashed item, and must not read or remove that item's info.
		const ownInfo = dirname(real) === trashFiles
		const infoFile = join(trashInfo, trashInfoName(basename(real)))
		const original = ownInfo ? /^Path=(.*)$/m.exec(await readFile(infoFile, 'utf8').catch(() => ''))?.[1] : undefined
		const h = await roots()
		// The .trashinfo can be written by anything that can write to the Trash, so where it says the
		// item came from is only trusted inside Home: normalised (no "../" tricks) and, once its folder
		// exists, checked again with symlinks followed.
		let dest = null
		try {
			// .trashinfo Path is a percent-encoded pathname, not a full URI. decodeURI leaves
			// & , + = # ; : @ encoded (`Q%26A`). Reject NUL and anything pathResolve walks out of Home.
			const decoded = original ? decodeURIComponent(original) : ''
			dest = decoded && !decoded.includes('\0') ? pathResolve(decoded) : null
		} catch {
			dest = null
		}
		const inside = (p) => p === h || p.startsWith(h + sep)
		if (!dest || !inside(dest) || dest === h) dest = join(h, basename(real))
		// Its nearest existing folder must really be inside Home (a symlinked folder could point out).
		let near = dirname(dest)
		while (near !== h && !(await lstat(near).then(() => true, () => false))) near = dirname(near)
		if (!inside(await realpath(near).catch(() => ''))) dest = join(h, basename(real))
		await mkdirOp(dirname(dest), {recursive: true})
		if (await lstat(dest).then(() => true, () => false)) dest = await freeName(dirname(dest), basename(dest), await isDirPath(real))
		await rename(real, dest)
		if (ownInfo) await rm(infoFile, {force: true})
		return toVirtual(dest)
	}
	async function deleteItem({path}) {
		const {real, top} = await resolve(path)
		if (top !== 'Trash' || path === '/Trash') throw new RpcError('BAD_REQUEST', '[only-from-trash]')
		await rm(real, {recursive: true, force: true})
		if (dirname(real) === trashFiles) await rm(join(trashInfo, trashInfoName(basename(real))), {force: true})
		return true
	}
	async function emptyTrash() {
		for (const n of await readdir(trashFiles).catch(() => [])) await rm(join(trashFiles, n), {recursive: true, force: true})
		for (const n of await readdir(trashInfo).catch(() => [])) await rm(join(trashInfo, n), {force: true})
		return true
	}

	// Walk a folder (skipping hidden names). Stop when the visitor says so, or when the time budget runs out.
	// There is no entry-count cap: a large Home must still be searchable past the first 20,000 names.
	async function walk(visit, {root, deadline} = {}) {
		const start = root ?? (await roots())
		const queue = [start]
		while (queue.length) {
			if (deadline && Date.now() >= deadline) return {complete: false}
			const dir = queue.shift()
			const items = await readdir(dir, {withFileTypes: true, encoding: 'buffer'}).catch(() => [])
			for (let i = 0; i < items.length; i++) {
				if (deadline && Date.now() >= deadline) return {complete: false}
				const d = items[i]
				const name = shownName(d.name)
				if (!visible(name) || name === 'node_modules') continue
				const r = childPath(dir, d.name)
				if (d.isDirectory()) queue.push(r)
				if (d.isDirectory() || d.isFile()) {
					const stop = await visit(r, d)
					if (stop === false) return {complete: !(i < items.length - 1 || queue.length > 0)}
				}
			}
		}
		return {complete: true}
	}
	async function search({query, path, maxResults} = {}) {
		const q = String(query ?? '').trim().normalize('NFC').toLowerCase()
		if (!q) return {files: [], truncated: false}
		const max = Number.isInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, 500) : 100
		let root = null
		if (typeof path === 'string' && path.length) {
			const {real} = await resolve(path)
			const st = await stat(real)
			if (!st.isDirectory()) {
				const name = basename(path)
				if (!name.normalize('NFC').toLowerCase().includes(q)) return {files: [], truncated: false}
				return {files: [await entry(path, real, st)], truncated: false}
			}
			root = real
		}
		const out = []
		const deadline = Date.now() + SEARCH_BUDGET_MS
		const walked = await walk(
			async (r, d) => {
				if (!shownName(d.name).normalize('NFC').toLowerCase().includes(q)) return
				out.push(r)
				if (out.length >= max) return false
			},
			{root, deadline},
		)
		const rows = await Promise.all(
			out.map(async (r) => {
				try {
					const virtual = await toVirtual(r)
					if (!virtual) return null
					return await entry(virtual, r)
				} catch (error) {
					if (error instanceof RpcError) throw error
					return null
				}
			}),
		)
		return {files: rows.filter(Boolean), truncated: !walked.complete}
	}
	function considerRecent(top, row) {
		if (top.length < RECENT_LIMIT) {
			top.push(row)
			return
		}
		let min = 0
		for (let i = 1; i < top.length; i++) if (top[i].s.mtimeMs < top[min].s.mtimeMs) min = i
		if (row.s.mtimeMs > top[min].s.mtimeMs) top[min] = row
	}
	// Recents keeps a bounded top while it walks. Stats for one directory run together so a Home
	// with tens of thousands of files is not cut off after the first 20,000 entries.
	async function recents() {
		const top = []
		const deadline = Date.now() + RECENTS_BUDGET_MS
		const queue = [await roots()]
		while (queue.length) {
			if (Date.now() >= deadline) break
			const dir = queue.shift()
			const items = await readdir(dir, {withFileTypes: true, encoding: 'buffer'}).catch(() => [])
			const files = []
			for (const d of items) {
				const name = shownName(d.name)
				if (!visible(name) || name === 'node_modules') continue
				const r = childPath(dir, d.name)
				if (d.isDirectory()) queue.push(r)
				else if (d.isFile()) files.push(r)
			}
			const stats = await mapPool(files, STAT_CONCURRENCY, async (r) => {
				const s = await stat(r).catch(() => null)
				return s ? {r, s} : null
			})
			for (const row of stats) if (row) considerRecent(top, row)
		}
		top.sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
		return Promise.all(top.map(async ({r, s}) => entry(await toVirtual(r), r, s)))
	}

	const validFavorites = (value) => Array.isArray(value) && value.every((p) => typeof p === 'string')
	let favoritesDamagedLogged = false
	async function readFavoritesState() {
		const res = await readJsonState(favoritesFile, favoritesDamagedLogged ? {validate: validFavorites, log: null} : {validate: validFavorites})
		if (res.damaged) {
			favoritesDamagedLogged = true
			return {list: [], damaged: true}
		}
		favoritesDamagedLogged = false
		return {list: res.status === 'ok' ? res.value : [], damaged: false}
	}
	// Rename and move rewrite favorite paths (including everything inside a renamed folder).
	// A damaged favorites file is never rewritten. Only a missing file means favorites were never set up.
	async function retargetFavorites(fromVirtual, toVirtual) {
		if (typeof fromVirtual !== 'string' || typeof toVirtual !== 'string' || fromVirtual === toVirtual) return
		await lock('favorites', async () => {
			const {list, damaged} = await readFavoritesState()
			if (damaged) return
			let changed = false
			const next = list.map((p) => {
				if (p === fromVirtual || p.startsWith(`${fromVirtual}/`)) {
					changed = true
					return toVirtual + p.slice(fromVirtual.length)
				}
				return p
			})
			if (changed) await writeAtomic(favoritesFile, JSON.stringify(next))
		})
	}
	async function favorites() {
		return lock('favorites', async () => {
			const {list, damaged} = await readFavoritesState()
			if (damaged) return []
			const keep = []
			for (const p of list) {
				// A joined computer's place is not a path on this server. Keep it without resolve().
				if (computerFavoritePath(p)) {
					keep.push(p)
					continue
				}
				try {
					await resolve(p)
					keep.push(p)
				} catch (error) {
					// A drive that is unplugged has no folders to find; its favorites wait for it.
					if (!(error instanceof RpcError) || error.code !== 'NOT_FOUND' || p.startsWith('/External/')) keep.push(p)
				}
			}
			if (keep.length !== list.length) await writeAtomic(favoritesFile, JSON.stringify(keep))
			return keep
		})
	}
	// A joined computer's file is not a path on this server. Store the place, and never resolve it here.
	function computerFavoritePath(path) {
		if (typeof path !== 'string' || path.length > 1024 || path.includes('\0') || !path.startsWith('::computer/')) return null
		const rest = path.slice('::computer/'.length)
		const slash = rest.indexOf('/')
		if (slash <= 0) return null
		const id = rest.slice(0, slash)
		const rel = rest.slice(slash + 1)
		if (!id || id === '.' || id === '..' || id.includes('\\') || id.includes('/')) return null
		if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null
		return {id, rel}
	}
	async function setFavorite(path, on) {
		if (typeof path === 'string' && path.startsWith('::')) {
			if (!computerFavoritePath(path)) throw new RpcError('BAD_REQUEST', 'Choose a file')
		} else await resolve(path)
		return lock('favorites', async () => {
			const {list, damaged} = await readFavoritesState()
			if (damaged) throw new RpcError('PRECONDITION_FAILED', 'favorites.json is damaged and was left unchanged. Repair or remove it before saving.')
			const set = new Set(list)
			on ? set.add(path) : set.delete(path)
			await writeAtomic(favoritesFile, JSON.stringify([...set]))
			return true
		})
	}

	// ---- HTTP: view, download, upload -------------------------------------------------------
	async function serveFile(req, res, url, kind) {
		const paths = url.searchParams.getAll('path')
		if (paths.length !== 1) return endPlain(res, 501, 'Downloading several items or a folder isn’t supported yet')
		let real
		try {
			;({real} = await resolve(paths[0]))
		} catch {
			return endPlain(res, 404, 'Not found')
		}
		const st = await stat(real).catch(() => null)
		if (!st) return endPlain(res, 404, 'Not found')
		if (st.isDirectory()) return endPlain(res, 501, 'Downloading a folder isn’t supported yet')
		if (!st.isFile()) return endPlain(res, 400, 'That isn’t a regular file')
		const name = basename(real)
		const type = typeFor(name)
		const inline = kind === 'view' && INLINE.test(type)
		const headers = {
			'content-type': kind === 'view' && !INLINE.test(type) && !type.startsWith('image/svg') ? 'application/octet-stream' : type,
			'accept-ranges': 'bytes',
			etag: fileTag(st),
			'last-modified': st.mtime.toUTCString(),
			'content-disposition': contentDisposition(name, inline),
			'x-content-type-options': 'nosniff',
		}
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
		if (range && (range[1] || range[2]) && ifRangeMatches(req.headers['if-range'], st)) {
			let start = range[1] ? Number(range[1]) : st.size - Number(range[2])
			let end = range[1] && range[2] ? Number(range[2]) : st.size - 1
			start = Math.max(0, start)
			end = Math.min(st.size - 1, end)
			if (start > end) {
				res.writeHead(416, {'content-range': `bytes */${st.size}`})
				return res.end()
			}
			res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': String(end - start + 1)})
			return pipeline(createReadStream(real, {start, end}), res).catch(() => res.destroy())
		}
		res.writeHead(200, {...headers, 'content-length': String(st.size)})
		return pipeline(createReadStream(real), res).catch(() => res.destroy())
	}
	async function linkOrRename(tmp, candidate) {
		try {
			await link(tmp, candidate)
			await rm(tmp, {force: true}).catch(() => {})
			return true
		} catch (e) {
			if (e.code === 'EEXIST') return false
			if (e.code === 'EPERM' || e.code === 'ENOTSUP' || e.code === 'EOPNOTSUPP') {
				if (await lstat(candidate).then(() => true, () => false)) return false
				await rename(tmp, candidate)
				return true
			}
			throw e
		}
	}
	function claimUpload(tmp, real, collision) {
		const dir = dirname(real)
		const name = basename(real)
		return lock(`upload:${dir}`, async () => {
			if (collision === 'replace') {
				const cur = await lstat(real).catch(() => null)
				if (cur?.isDirectory()) throw new RpcError('CONFLICT', '[is-a-directory]')
				await rename(tmp, real)
				return real
			}
			if (collision === 'error') {
				if (await linkOrRename(tmp, real)) return real
				const cur = await lstat(real).catch(() => null)
				throw new RpcError('CONFLICT', cur?.isDirectory() ? '[is-a-directory]' : '[already-exists]')
			}
			for (let n = 1; ; n++) {
				const candidate = join(dir, keepBothCandidate(name, n, false))
				if (await linkOrRename(tmp, candidate)) return candidate
			}
		})
	}
	async function upload(req, res, url) {
		const path = url.searchParams.get('path')
		const collision = url.searchParams.get('collision') ?? 'keep-both'
		const openOut = typeof io?.createWriteStream === 'function' ? io.createWriteStream : createWriteStream
		let real
		try {
			assertVisibleName(basename(path ?? ''))
			;({real} = await resolve(path, {mustExist: false}))
		} catch (e) {
			return endJson(res, e instanceof RpcError && e.code === 'NOT_FOUND' ? 404 : 400, {error: e.message})
		}
		const exists = await lstat(real).then((s) => s, () => null)
		if (exists?.isDirectory() && collision === 'replace') return endJson(res, 409, {error: '[is-a-directory]'})
		if (exists && collision === 'error') return endJson(res, 409, {error: '[already-exists]'})
		// Write to a temporary file first, then claim the final name atomically so overlapping
		// uploads never overwrite each other.
		const tmp = join(dirname(real), `.upload.${randomBytes(6).toString('hex')}`)
		let target
		try {
			await pipeline(req, openOut(tmp, {flags: 'wx', mode: 0o644}))
			target = await claimUpload(tmp, real, collision)
		} catch (e) {
			await rm(tmp, {force: true}).catch(() => {})
			if (e instanceof RpcError && e.code === 'CONFLICT') return endJson(res, 409, {error: e.message})
			const mapped = uploadStatusForFsError(e)
			if (mapped) return endJson(res, mapped.status, {error: mapped.error})
			return endJson(res, 500, {error: 'Upload failed'})
		}
		return endJson(res, 200, {path: await toVirtual(target)})
	}

	// A big file in pieces: each request is one piece (up to CHUNK_MAX), appended in order to a
	// hidden partial file next to where the file goes. When the last byte is in, the file takes its
	// name the same way a whole upload does. A piece can be sent again (a dropped connection); one
	// out of order is refused with how much arrived, so the browser carries on from there. This gets
	// big files through anything that limits one request (a Cloudflare Tunnel allows 100 MB).
	async function uploadChunk(req, res, url) {
		const path = url.searchParams.get('path')
		const collision = url.searchParams.get('collision') ?? 'keep-both'
		const id = url.searchParams.get('id') ?? ''
		const offset = Number(url.searchParams.get('offset'))
		const total = Number(url.searchParams.get('total'))
		if (!/^[a-f0-9]{16,64}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total < 0 || offset > total) {
			return endJson(res, 400, {error: '[bad-chunk]'})
		}
		let real
		try {
			assertVisibleName(basename(path ?? ''))
			;({real} = await resolve(path, {mustExist: false}))
		} catch (e) {
			return endJson(res, e instanceof RpcError && e.code === 'NOT_FOUND' ? 404 : 400, {error: e.message})
		}
		const exists = await lstat(real).then((s) => s, () => null)
		if (exists?.isDirectory() && collision === 'replace') return endJson(res, 409, {error: '[is-a-directory]'})
		if (exists && collision === 'error') return endJson(res, 409, {error: '[already-exists]'})
		const dir = dirname(real)
		const part = join(dir, `.upload.part.${id}`)
		return lock(`chunk:${part}`, async () => {
			const cur = await lstat(part).catch(() => null)
			if (cur && !cur.isFile()) return endJson(res, 400, {error: '[bad-chunk]'})
			const have = offset === 0 ? 0 : (cur?.size ?? 0)
			if (offset !== have) {
				req.resume()
				return endJson(res, 409, {error: '[wrong-offset]', received: cur?.size ?? 0})
			}
			if (offset === 0) await sweepParts(dir)
			let got = 0
			const flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_NOFOLLOW | (offset === 0 ? fsc.O_TRUNC : fsc.O_APPEND)
			try {
				await pipeline(
					req,
					async function* (source) {
						for await (const c of source) {
							got += c.length
							if (got > CHUNK_MAX || offset + got > total) throw new RpcError('BAD_REQUEST', '[bad-chunk]')
							yield c
						}
					},
					createWriteStream(part, {flags, mode: 0o644}),
				)
			} catch (e) {
				if (e instanceof RpcError) {
					await rm(part, {force: true}).catch(() => {})
					return endJson(res, 400, {error: e.message})
				}
				const mapped = uploadStatusForFsError(e)
				// What arrived stays, so the browser can carry on from it.
				return endJson(res, mapped?.status ?? 500, {error: mapped?.error ?? 'Upload failed', received: (await lstat(part).catch(() => null))?.size ?? 0})
			}
			const size = (await lstat(part)).size
			if (size < total) return endJson(res, 200, {received: size})
			if (size > total) {
				await rm(part, {force: true}).catch(() => {})
				return endJson(res, 400, {error: '[bad-chunk]'})
			}
			try {
				const target = await claimUpload(part, real, collision)
				return endJson(res, 200, {received: size, path: await toVirtual(target)})
			} catch (e) {
				await rm(part, {force: true}).catch(() => {})
				if (e instanceof RpcError && e.code === 'CONFLICT') return endJson(res, 409, {error: e.message})
				const mapped = uploadStatusForFsError(e)
				return endJson(res, mapped?.status ?? 500, {error: mapped?.error ?? 'Upload failed'})
			}
		})
	}
	// Pieces of uploads given up more than a day ago.
	async function sweepParts(dir) {
		const names = await readdir(dir).catch(() => [])
		const old = Date.now() - 24 * 60 * 60 * 1000
		for (const n of names) {
			if (!n.startsWith('.upload.part.')) continue
			const st = await lstat(join(dir, n)).catch(() => null)
			if (st?.isFile() && st.mtimeMs < old) await rm(join(dir, n), {force: true}).catch(() => {})
		}
	}

	async function describe(virtual) {
		const {real} = await resolve(virtual)
		const st = await stat(real)
		if (!st.isFile()) throw new RpcError('BAD_REQUEST', 'Choose a file')
		return {name: basename(virtual), path: virtual, size: st.size, mtimeMs: Math.trunc(st.mtimeMs)}
	}
	// A file or a folder. A directory’s size is not its contents, so callers compare mtime.
	async function inspect(virtual) {
		const {real} = await resolve(virtual)
		const st = await stat(real)
		const dir = st.isDirectory()
		if (!dir && !st.isFile()) throw new RpcError('BAD_REQUEST', 'Choose a file')
		return {name: basename(virtual), path: virtual, size: dir ? 0 : st.size, mtimeMs: Math.trunc(st.mtimeMs), dir}
	}
	async function openRead(virtual) {
		const info = await describe(virtual)
		const {real} = await resolve(virtual)
		return {...info, stream: createReadStream(real)}
	}
	// A new file in a folder the person can already use. The bytes land in a temporary name, then
	// the same claim an upload uses. keep-both is the default, so a paste does not replace a file.
	async function saveNew(dirVirtual, name, source, collision = 'keep-both') {
		assertVisibleName(name)
		if (dirVirtual === '/External') throw new RpcError('BAD_REQUEST', '[cannot-create-here]')
		const {real: dir} = await resolve(dirVirtual)
		const st = await stat(dir)
		if (!st.isDirectory()) throw new RpcError('BAD_REQUEST', '[not-a-directory]')
		const tmp = join(dir, `.upload.${randomBytes(6).toString('hex')}`)
		try {
			const body = Buffer.isBuffer(source) ? Readable.from(source) : source
			await pipeline(body, createWriteStream(tmp, {flags: 'wx', mode: 0o644}))
			const target = await claimUpload(tmp, join(dir, name), collision)
			return toVirtual(target)
		} catch (error) {
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	}

	return {
		describe,
		inspect,
		openRead,
		saveNew,
		resolve,
		copy: (input) => moveOrCopy(input, true),
		move: (input) => moveOrCopy(input, false),
		trash,
		procedures: {
			'files.list': {kind: 'query', run: guard((i) => list(i))},
			'files.search': {kind: 'query', run: guard((i) => search(i ?? {}))},
			'files.recents': {kind: 'query', run: guard(() => recents())},
			'files.favorites': {
				kind: 'query',
				run: guard(async () => {
					const paths = await favorites()
					return (
						await mapPool(paths, STAT_CONCURRENCY, async (p) => {
							const remote = computerFavoritePath(p)
							if (remote) {
								return {name: basename(remote.rel), path: p, type: 'application/octet-stream', modified: 0, operations: ['favorite']}
							}
							try {
								const {real} = await resolve(p)
								return await entry(p, real)
							} catch {
								return null
							}
						})
					).filter(Boolean)
				}),
			},
			'files.addFavorite': {kind: 'mutation', run: guard(({path}) => setFavorite(path, true))},
			'files.removeFavorite': {kind: 'mutation', run: guard(({path}) => setFavorite(path, false))},
			'files.createDirectory': {kind: 'mutation', run: guard((i) => createDirectory(i))},
			'files.rename': {kind: 'mutation', run: guard((i) => renameItem(i))},
			'files.copy': {kind: 'mutation', run: guard((i) => moveOrCopy(i, true))},
			'files.move': {kind: 'mutation', run: guard((i) => moveOrCopy(i, false))},
			'files.trash': {kind: 'mutation', run: guard((i) => trash(i))},
			'files.restore': {kind: 'mutation', run: guard((i) => restore(i))},
			'files.delete': {kind: 'mutation', run: guard((i) => deleteItem(i))},
			'files.emptyTrash': {kind: 'mutation', run: guard(() => emptyTrash())},
			'files.operationProgress': {kind: 'query', run: guard(() => [])},
			'files.externalDevices': {kind: 'query', run: guard(() => [])},
		},
		serveFile,
		upload,
		uploadChunk,
		resolve,
		followShares(fn) {
			if (typeof fn === 'function') follow = fn
		},
	}
}

function endPlain(res, status, text) {
	res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'})
	res.end(text)
}
function endJson(res, status, body) {
	res.writeHead(status, {'content-type': 'application/json'})
	res.end(JSON.stringify(body))
}
