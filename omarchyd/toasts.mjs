// Account toasts. One file per person. A timed toast carries the moment it expires.
// One that waits for the person has no expiry. A damaged file is left as it is.
import {chmod, mkdir, rm} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {readJsonState, writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const TOAST_ID = /^[0-9a-f]{16}$/
const DAMAGED = 'Toasts are damaged and were left unchanged.'

const valid = (value) =>
	!!value &&
	Array.isArray(value.toasts) &&
	value.toasts.every((row) => row && typeof row.id === 'string' && typeof row.text === 'string' && (row.level == null || row.level === 'note' || row.level === 'problem'))

const oneLine = (text) =>
	String(text ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 240)

export function createToasts({dataDir, now = () => Date.now()} = {}) {
	const tails = new Map()
	const withFile = (userId, fn) => {
		const prev = tails.get(userId) ?? Promise.resolve()
		const run = prev.catch(() => {}).then(fn)
		const tail = run.catch(() => {})
		tails.set(userId, tail)
		tail.then(() => {
			if (tails.get(userId) === tail) tails.delete(userId)
		})
		return run
	}
	const fileOf = (userId) => join(dataDir, 'toasts', `${userId}.json`)
	const actor = (auth) => {
		const userId = String(auth?.userId ?? '')
		if (!USER_ID.test(userId)) throw new RpcError('FORBIDDEN', 'That account can’t keep toasts')
		return userId
	}
	const pub = (row) => ({
		id: row.id,
		text: row.text,
		at: row.at,
		href: row.href ?? null,
		expireAt: row.expireAt ?? null,
		level: row.level === 'problem' ? 'problem' : 'note',
	})
	async function load(userId) {
		const state = await readJsonState(fileOf(userId), {validate: valid, label: 'omarchyd'})
		if (state.damaged) return {damaged: true, toasts: null}
		if (state.status === 'missing') return {damaged: false, toasts: []}
		return {damaged: false, toasts: state.value.toasts}
	}
	function live(rows) {
		const at = now()
		return rows.filter((row) => row.expireAt == null || row.expireAt > at).map(pub)
	}
	async function list(_input, ctx) {
		const who = actor(ctx.auth)
		const book = await load(who)
		if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
		return live(book.toasts)
	}
	async function add(input, ctx) {
		const who = actor(ctx.auth)
		const text = oneLine(input?.text)
		if (!text) throw new RpcError('BAD_REQUEST', 'That toast has nothing to say')
		const href = input?.href == null || input.href === '' ? null : String(input.href).slice(0, 200)
		const level = input?.level === 'problem' ? 'problem' : 'note'
		let expireAt = null
		if (input?.expireAt != null) {
			const n = Number(input.expireAt)
			if (!Number.isSafeInteger(n)) throw new RpcError('BAD_REQUEST', 'That toast has no time')
			expireAt = n
		}
		const row = {id: randomBytes(8).toString('hex'), text, at: now(), href, expireAt, level}
		await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const dir = join(dataDir, 'toasts')
			await mkdir(dir, {recursive: true, mode: 0o700})
			await chmod(dir, 0o700)
			await writeAtomic(fileOf(who), JSON.stringify({toasts: [...book.toasts, row]}, null, '\t'))
		})
		return pub(row)
	}
	async function dismiss(input, ctx) {
		const who = actor(ctx.auth)
		const id = String(input?.id ?? '')
		if (!TOAST_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That toast isn’t there')
		await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			if (!book.toasts.some((row) => row.id === id)) throw new RpcError('NOT_FOUND', 'That toast isn’t there')
			await writeAtomic(fileOf(who), JSON.stringify({toasts: book.toasts.filter((row) => row.id !== id)}, null, '\t'))
		})
		return true
	}
	async function resetAll() {
		await rm(join(dataDir, 'toasts'), {recursive: true, force: true})
	}
	return {
		procedures: {
			'toasts.list': {kind: 'query', run: list},
			'toasts.add': {kind: 'mutation', run: add},
			'toasts.dismiss': {kind: 'mutation', run: dismiss},
		},
		resetAll,
	}
}
