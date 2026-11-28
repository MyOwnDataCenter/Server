// Move and copy between this server and computers the connector can read.
// A path on this server starts with "/". A computer path is ::computer/<id>/<rel>.
// The same machine uses its own rename or copy. A different machine pulls, then pushes.
import {mkdtemp, open, readdir, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'

import {RpcError} from './rpc.mjs'

const COMPUTER = '::computer/'
const MAX_FILES = 200
const MAX_BYTES = 512 * 1024 * 1024

export function locateTransferPath(path) {
	if (typeof path !== 'string' || !path || path.includes('\0')) return null
	if (path.startsWith(COMPUTER)) {
		const rest = path.slice(COMPUTER.length)
		const slash = rest.indexOf('/')
		const id = slash < 0 ? rest : rest.slice(0, slash)
		const rel = slash < 0 ? '' : rest.slice(slash + 1)
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
		// An empty relative path is that computer's home. A blank segment is not a folder.
		if (rel && rel.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null
		return {kind: 'computer', id, rel, path}
	}
	if (path.startsWith('/') && !path.split('/').includes('..')) return {kind: 'server', path}
	return null
}

function childComputer(parent, name) {
	if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null
	const rel = parent.rel ? `${parent.rel}/${name}` : name
	return {kind: 'computer', id: parent.id, rel, path: `${COMPUTER}${parent.id}/${rel}`}
}

function childServer(parentPath, name) {
	const path = `${parentPath.replace(/\/$/, '')}/${name}`
	return {kind: 'server', path}
}

export function createFileTransfer({files, fleet}) {
	// Looked up on disk, not through the Files listing: that hides names starting with a dot, and a
	// folder moved away is deleted whole once it has been copied.
	async function serverNode(path) {
		const name = basename(path)
		const {real} = await files.resolve(path)
		const st = await stat(real).catch(() => {
			throw new RpcError('NOT_FOUND', 'That file isn’t there')
		})
		return {dir: st.isDirectory(), name: name || 'Home', path, size: st.isDirectory() ? 0 : st.size}
	}

	async function computerNode(node) {
		const row = await fleet.stat(node.id, node.rel)
		return {dir: !!row?.dir, name: row?.name || basename(node.rel), path: node.path, size: row?.size ?? 0}
	}

	async function nodeOf(loc) {
		return loc.kind === 'server' ? serverNode(loc.path) : computerNode(loc)
	}

	async function listOf(loc) {
		if (loc.kind === 'server') {
			const {real} = await files.resolve(loc.path)
			const rows = []
			for (const name of await readdir(real)) {
				const st = await stat(join(real, name)).catch(() => null) // a broken link has nothing to copy
				if (st) rows.push({name, dir: st.isDirectory(), path: childServer(loc.path, name).path, size: st.isDirectory() ? 0 : st.size})
			}
			return rows
		}
		const listed = await fleet.list(loc.id, loc.rel)
		return (listed.entries ?? []).map((e) => ({name: e.name, dir: !!e.dir, size: e.size ?? 0}))
	}

	async function ensureComputerDir(id, rel) {
		if (rel) await fleet.mkdir(id, rel)
	}

	async function writeComputerFile(id, rel, size, readChunk) {
		await fleet.push(id, rel, size, readChunk)
	}

	async function readServer(path) {
		return files.openRead(path)
	}

	async function pullComputer(id, rel) {
		const dir = await mkdtemp(join(tmpdir(), 'modc-xfer-'))
		const file = join(dir, 'file')
		const chunks = []
		const meta = await fleet.pull(id, rel, async (buf) => {
			chunks.push(Buffer.from(buf))
		})
		const body = Buffer.concat(chunks)
		return {dir, file, body, size: Number.isSafeInteger(meta?.size) ? meta.size : body.length}
	}

	async function readServerBytes(path) {
		const opened = await readServer(path)
		if (opened.size > MAX_BYTES) throw new RpcError('PRECONDITION_FAILED', 'That file is too large to copy from here.')
		const {real} = await files.resolve(path)
		const handle = await open(real, 'r')
		return {
			size: opened.size,
			close: () => handle.close(),
			read: async (n) => {
				const buf = Buffer.alloc(n)
				const {bytesRead} = await handle.read(buf, 0, n, null)
				if (!bytesRead) throw new RpcError('BAD_GATEWAY', 'The file arrived short')
				return buf.subarray(0, bytesRead)
			},
		}
	}

	async function copyFile(src, destDir, info) {
		const name = info.name
		if ((info.size ?? 0) > MAX_BYTES) throw new RpcError('PRECONDITION_FAILED', 'That file is too large to copy from here.')
		if (src.kind === 'server' && destDir.kind === 'server') {
			return files.procedures['files.copy'].run({path: src.path, toDirectory: destDir.path, collision: 'keep-both'})
		}
		if (src.kind === 'server' && destDir.kind === 'computer') {
			const opened = await readServerBytes(src.path)
			try {
				const rel = destDir.rel ? `${destDir.rel}/${name}` : name
				await ensureComputerDir(destDir.id, destDir.rel)
				await writeComputerFile(destDir.id, rel, opened.size, opened.read)
				return `${COMPUTER}${destDir.id}/${rel}`
			} finally {
				await opened.close()
			}
		}
		if (src.kind === 'computer' && destDir.kind === 'server') {
			const pulled = await pullComputer(src.id, src.rel)
			try {
				if (pulled.size !== pulled.body.length) throw new RpcError('BAD_GATEWAY', 'The file arrived short')
				return await files.saveNew(destDir.path, name, pulled.body, 'keep-both')
			} finally {
				await rm(pulled.dir, {recursive: true, force: true}).catch(() => {})
			}
		}
		const pulled = await pullComputer(src.id, src.rel)
		try {
			const rel = destDir.rel ? `${destDir.rel}/${name}` : name
			await ensureComputerDir(destDir.id, destDir.rel)
			let off = 0
			await writeComputerFile(destDir.id, rel, pulled.body.length, async (n) => {
				const slice = pulled.body.subarray(off, off + n)
				off += slice.length
				if (!slice.length) throw new RpcError('BAD_GATEWAY', 'The file arrived short')
				return slice
			})
			return `${COMPUTER}${destDir.id}/${rel}`
		} finally {
			await rm(pulled.dir, {recursive: true, force: true}).catch(() => {})
		}
	}

	async function removeNode(loc) {
		if (loc.kind === 'computer') return fleet.remove(loc.id, loc.rel)
		const {real} = await files.resolve(loc.path)
		await rm(real, {recursive: true, force: true})
		return true
	}

	async function copyNode(src, destDir, budget) {
		const info = await nodeOf(src)
		if (!info.dir) return copyFile(src, destDir, info)
		if (destDir.kind === 'server' && src.kind === 'server') {
			return files.procedures['files.copy'].run({path: src.path, toDirectory: destDir.path, collision: 'keep-both'})
		}
		const folderName = info.name
		let nextDir
		if (destDir.kind === 'computer') {
			const rel = destDir.rel ? `${destDir.rel}/${folderName}` : folderName
			await fleet.mkdir(destDir.id, rel)
			nextDir = {kind: 'computer', id: destDir.id, rel, path: `${COMPUTER}${destDir.id}/${rel}`}
		} else {
			const made = await files.procedures['files.createDirectory'].run({path: `${destDir.path}/${folderName}`}).catch(async (error) => {
				if (error?.code !== 'CONFLICT') throw error
				return `${destDir.path}/${folderName}`
			})
			nextDir = {kind: 'server', path: typeof made === 'string' ? made : `${destDir.path}/${folderName}`}
		}
		const kids = await listOf(src)
		for (const kid of kids) {
			budget.n += 1
			if (budget.n > MAX_FILES) throw new RpcError('PRECONDITION_FAILED', 'That folder is too large to copy from here.')
			const child = src.kind === 'computer' ? childComputer(src, kid.name) : childServer(src.path, kid.name)
			if (!child) continue
			await copyNode(child, nextDir, budget)
		}
		return nextDir.path
	}

	async function transfer(input) {
		const copy = input?.mode !== 'move'
		const from = locateTransferPath(input?.path)
		const to = locateTransferPath(input?.toDirectory)
		if (!from || !to) throw new RpcError('BAD_REQUEST', 'Choose a folder on a machine that can be read')
		if (!from.rel && from.kind === 'computer') throw new RpcError('BAD_REQUEST', 'Choose a file')
		// A move deletes the original afterwards. Home, Trash, Drives and a drive itself can't be moved.
		if (!copy && from.kind === 'server' && /^\/(Home|Trash|External(\/[^/]+)?)\/*$/.test(from.path)) throw new RpcError('BAD_REQUEST', '[cannot-move]')
		if (from.kind === 'server' && to.kind === 'server') {
			return files.procedures[copy ? 'files.copy' : 'files.move'].run({path: from.path, toDirectory: to.path, collision: input?.collision || 'keep-both'})
		}
		if (from.kind === 'computer' && to.kind === 'computer' && from.id === to.id) {
			return copy ? fleet.copy(from.id, from.rel, to.rel) : fleet.move(from.id, from.rel, to.rel)
		}
		const next = await copyNode(from, to, {n: 0})
		if (!copy) await removeNode(from)
		return next
	}

	function recentEntry(row, path) {
		return {
			name: row.name,
			path,
			type: row.dir ? 'directory' : 'application/octet-stream',
			size: row.size ?? 0,
			modified: row.mtime ?? row.modified ?? 0,
			operations: ['favorite', 'copy', 'move'],
		}
	}

	async function fleetRecents() {
		const server = await files.procedures['files.recents'].run()
		const rows = Array.isArray(server) ? [...server] : []
		let agents = []
		try {
			agents = await fleet.agents()
		} catch {
			agents = []
		}
		for (const agent of agents) {
			if (!agent?.online || !agent.files) continue
			let listed = []
			try {
				listed = await fleet.recents(agent.id)
			} catch {
				continue
			}
			for (const row of listed) {
				if (!row?.name || !row.path) continue
				rows.push(recentEntry(row, `${COMPUTER}${agent.id}/${row.path}`))
			}
		}
		rows.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
		return rows.slice(0, 40)
	}

	return {transfer, fleetRecents}
}
