// Writing a state file safely: whole-file replace (write a temporary file, then rename it over the
// old one), one write at a time per file. Two saves at the same moment used to share one temporary
// name, so the second rename failed (ENOENT) and that change was lost.
import {randomBytes} from 'node:crypto'
import {constants} from 'node:fs'
import {chmod, copyFile, open, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {basename} from 'node:path'

const queues = new Map()

// null and arrays are not plain objects. JSON values have no other prototypes.
export const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

async function copyDamaged(file) {
	const dest = `${file}.damaged-${Date.now()}-${randomBytes(4).toString('hex')}`
	try {
		await copyFile(file, dest, constants.COPYFILE_EXCL)
		try {
			await chmod(dest, 0o600)
		} catch {
			await rm(dest, {force: true}).catch(() => {})
			return null
		}
		return dest
	} catch {
		return null
	}
}

/**
 * Safely reads and validates a JSON state file.
 * Missing files (ENOENT) are returned with status 'missing' without logging.
 * Read errors, invalid JSON, or values rejected by `validate` return damaged: true
 * and log only the file basename once while leaving the original bytes untouched.
 */
export async function readJsonState(file, {validate = plainObject, label = 'omarchyd', log, preserveCopy = false} = {}) {
	const name = basename(file)
	const report = (msg) => {
		if (log === undefined) console.error(msg)
		else if (typeof log === 'function') log(msg)
	}
	const fail = async (reason, allowCopy) => {
		const copy = allowCopy && preserveCopy ? await copyDamaged(file) : null
		report(`[${label}] couldn’t load ${name}; leaving it unchanged`)
		return {status: 'damaged', value: null, damaged: true, reason, ...(copy ? {copy} : {})}
	}

	let raw
	try {
		raw = await readFile(file, 'utf8')
	} catch (error) {
		if (error?.code === 'ENOENT') return {status: 'missing', value: null, damaged: false}
		return fail('read', false)
	}

	let parsed
	try {
		parsed = JSON.parse(raw)
	} catch {
		return fail('parse', true)
	}

	let ok = false
	try {
		ok = Boolean(validate(parsed))
	} catch {
		ok = false
	}
	if (!ok) return fail('shape', true)
	return {status: 'ok', value: parsed, damaged: false}
}

function enqueue(file, run) {
	const prev = queues.get(file) ?? Promise.resolve()
	const next = prev.then(run)
	const settled = next.catch(() => {})
	queues.set(file, settled)
	settled.then(() => queues.get(file) === settled && queues.delete(file))
	return next
}

// `content` may be a function, so what's written is the state as it is when the write runs.
// `null` / `undefined` skips the write (a store closed by factory reset must not recreate the file).
export function writeAtomic(file, content, {mode = 0o600} = {}) {
	return enqueue(file, async () => {
		const data = typeof content === 'function' ? content() : content
		if (data == null) return
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
		try {
			// Flushed before the rename: after a power cut the name must hold the old or the new
			// contents, never a file the disk had not yet written.
			// (fsync acts on the file, so a second handle flushes what writeFile wrote.)
			await writeFile(tmp, data, {mode})
			const handle = await open(tmp, 'r')
			try {
				await handle.sync()
			} finally {
				await handle.close()
			}
			await rename(tmp, file)
		} catch (error) {
			await rm(tmp, {force: true}).catch(() => {})
			throw error
		}
	})
}

// Delete on the same per-file queue as writeAtomic, so it runs after a write already queued.
export function removeAtomic(file) {
	return enqueue(file, () => rm(file, {force: true}))
}
