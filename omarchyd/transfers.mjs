// A file transfer for one account. The server keeps running it after the browser closes.
// One transfer runs at a time. The next waits. A clip already in a live transfer is not added again.
import {chmod, mkdir, readdir, rm} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {join} from 'node:path'

import {readJsonState, writeAtomic} from './atomic.mjs'
import {RpcError} from './rpc.mjs'
import {afterFailure, canResume, FOLDER_FROM_COMPUTER, FOLDER_TO_COMPUTER, jobToast, MISSING_FILE, resumeIds, TOAST_LIFE_MS, transferProgress} from './transferRules.mjs'

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const JOB_ID = /^[0-9a-f]{16}$/
const CLIP_ID = /^[A-Za-z0-9_-]{1,64}$/
const DAMAGED = 'Transfers are damaged and were left unchanged.'
const LIVE = new Set(['queued', 'running', 'paused'])

const valid = (value) => !!value && Array.isArray(value.jobs) && value.jobs.every((job) => job && typeof job.id === 'string' && Array.isArray(job.items))

function reasonOf(error) {
	const code = error?.code
	const message = String(error?.message ?? '')
	if (code === 'CONFLICT' || /changed/i.test(message)) return 'changed'
	if (code === 'NOT_FOUND' || /gone|isn’t in the book|isn't in the book/i.test(message) || MISSING_FILE.test(message)) return 'gone'
	if (message.includes(FOLDER_TO_COMPUTER) || message.includes(FOLDER_FROM_COMPUTER)) return 'refused'
	return 'transient'
}

function pick(job) {
	return job.items.find((item) => item.state === 'waiting' || item.state === 'sending' || (item.state === 'failed' && item.reason === 'transient')) ?? null
}

export function createTransfers({dataDir, paste, stat = async () => null, toasts, now = () => Date.now()} = {}) {
	const tails = new Map()
	const pumps = new Map()
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
	const fileOf = (userId) => join(dataDir, 'transfers', `${userId}.json`)
	const actor = (auth) => {
		const userId = String(auth?.userId ?? '')
		if (!USER_ID.test(userId)) throw new RpcError('FORBIDDEN', 'That account can’t keep transfers')
		return userId
	}
	async function load(userId) {
		const state = await readJsonState(fileOf(userId), {validate: valid, label: 'omarchyd'})
		if (state.damaged) return {damaged: true, jobs: null}
		if (state.status === 'missing') return {damaged: false, jobs: []}
		return {damaged: false, jobs: state.value.jobs}
	}
	async function save(userId, jobs) {
		const dir = join(dataDir, 'transfers')
		await mkdir(dir, {recursive: true, mode: 0o700})
		await chmod(dir, 0o700)
		await writeAtomic(fileOf(userId), JSON.stringify({jobs}, null, '\t'))
	}
	function publish(job) {
		return {
			id: job.id,
			at: job.at,
			state: job.state,
			name: job.name,
			dest: job.dest,
			canResume: canResume(job.state, job.items),
			progress: transferProgress(job.items),
			items: job.items.map((item) => ({
				clipId: item.clipId,
				name: item.name,
				state: item.state,
				reason: item.reason ?? null,
				tries: item.tries ?? 0,
				error: item.error ?? null,
				path: item.path ?? null,
				size: item.size ?? null,
			})),
		}
	}
	async function writeToast(auth, kind, name) {
		if (!toasts?.procedures?.['toasts.add']) return
		const toast = jobToast(kind, name)
		const expireAt = toast.untilDismiss ? null : now() + TOAST_LIFE_MS
		await toasts.procedures['toasts.add'].run({text: toast.text, href: toast.href, level: toast.level, expireAt}, {auth})
	}
	async function work(userId) {
		for (;;) {
			const step = await withFile(userId, async () => {
				const book = await load(userId)
				if (book.damaged) return {kind: 'idle'}
				const job = book.jobs.find((row) => row.state === 'running') ?? book.jobs.find((row) => row.state === 'queued')
				if (!job) return {kind: 'idle'}
				if (job.state === 'queued') {
					if (job.cancel) {
						job.state = 'cancelled'
						await save(userId, book.jobs)
						return {kind: 'continue'}
					}
					job.state = 'running'
					await save(userId, book.jobs)
					return {kind: 'toast', toast: 'started', name: job.name, auth: job.auth}
				}
				if (job.cancel) {
					job.state = 'cancelled'
					await save(userId, book.jobs)
					return {kind: 'continue'}
				}
				const item = pick(job)
				if (!item) {
					const failed = job.items.some((row) => row.state === 'failed')
					job.state = 'done'
					await save(userId, book.jobs)
					return {kind: 'toast', toast: failed ? 'problem' : 'finished', name: job.name, auth: job.auth}
				}
				if (item.state === 'sending' && item.path && item.size != null) return {kind: 'check', id: job.id, clipId: item.clipId, path: item.path, size: item.size}
				item.state = 'sending'
				await save(userId, book.jobs)
				return {kind: 'paste', id: job.id, clipId: item.clipId, dest: job.dest, auth: job.auth}
			})
			if (step.kind === 'idle') return
			if (step.kind === 'continue') continue
			if (step.kind === 'toast') {
				// The job is already saved. A toast that cannot be written must not reject the worker.
				try {
					await writeToast(step.auth, step.toast, step.name)
				} catch (error) {
					console.error('[omarchyd] transfer toast:', error instanceof Error ? error.message : error)
				}
				continue
			}
			if (step.kind === 'check') {
				const found = await stat(step.path).catch(() => null)
				await withFile(userId, async () => {
					const book = await load(userId)
					const job = book.jobs?.find((row) => row.id === step.id)
					const item = job?.items.find((row) => row.clipId === step.clipId)
					if (!job || !item) return
					if (found && found.size === step.size) {
						item.state = 'done'
						item.reason = null
						item.error = null
					} else {
						item.path = null
						item.size = null
						item.state = 'waiting'
					}
					await save(userId, book.jobs)
				})
				continue
			}
			let result = null
			let error = null
			try {
				result = await paste(step.auth, step.clipId, step.dest)
			} catch (caught) {
				error = caught
			}
			let size = Number.isFinite(Number(result?.size)) ? Number(result.size) : null
			if (!error && size == null && result?.path) {
				const found = await stat(result.path).catch(() => null)
				size = found?.size ?? null
			}
			const pause = await withFile(userId, async () => {
				const book = await load(userId)
				const job = book.jobs?.find((row) => row.id === step.id)
				const item = job?.items.find((row) => row.clipId === step.clipId)
				if (!job || !item) return false
				if (error) {
					const next = afterFailure(item, reasonOf(error), String(error.message ?? 'That file didn’t send'))
					Object.assign(item, next.item, {path: null, size: null})
					if (next.pause) job.state = 'paused'
					await save(userId, book.jobs)
					return next.pause
				}
				item.path = result?.path ?? null
				item.size = size
				item.state = 'sending'
				await save(userId, book.jobs)
				item.state = 'done'
				item.reason = null
				item.error = null
				if (job.cancel) job.state = 'cancelled'
				await save(userId, book.jobs)
				return false
			})
			if (pause) {
				try {
					const book = await load(userId)
					const job = book.jobs?.find((row) => row.id === step.id)
					if (job) await writeToast(job.auth, 'problem', job.name)
				} catch (error) {
					console.error('[omarchyd] transfer toast:', error instanceof Error ? error.message : error)
				}
			}
		}
	}
	function pump(userId) {
		const existing = pumps.get(userId)
		if (existing) return existing
		const run = work(userId).finally(() => {
			if (pumps.get(userId) === run) pumps.delete(userId)
		})
		pumps.set(userId, run)
		return run
	}
	async function list(_input, ctx) {
		const who = actor(ctx.auth)
		const book = await load(who)
		if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
		return book.jobs
			.slice()
			.sort((a, b) => b.at - a.at)
			.map(publish)
	}
	async function start(input, ctx) {
		const who = actor(ctx.auth)
		const name = String(input?.name ?? '').trim()
		if (!name) throw new RpcError('BAD_REQUEST', 'That transfer needs a destination')
		if (!input?.dest || typeof input.dest !== 'object') throw new RpcError('BAD_REQUEST', 'That transfer needs a folder')
		const clips = Array.isArray(input?.clips) ? input.clips : []
		const job = await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const busy = new Set()
			for (const row of book.jobs) {
				if (!LIVE.has(row.state)) continue
				for (const item of row.items) busy.add(item.clipId)
			}
			const fresh = []
			for (const clip of clips) {
				const id = String(clip?.id ?? '')
				const label = String(clip?.name ?? '').trim()
				if (!CLIP_ID.test(id) || !label) throw new RpcError('BAD_REQUEST', 'That clip can’t be sent')
				if (busy.has(id) || fresh.some((item) => item.clipId === id)) continue
				fresh.push({clipId: id, name: label, state: 'waiting', reason: null, tries: 0, error: null, path: null, size: null})
			}
			if (!fresh.length) return book.jobs.find((row) => LIVE.has(row.state) && row.items.some((item) => clips.some((clip) => String(clip?.id) === item.clipId))) ?? null
			const row = {
				id: randomBytes(8).toString('hex'),
				at: now(),
				state: 'queued',
				name,
				dest: input.dest,
				auth: {userId: who, role: ctx.auth?.role},
				cancel: false,
				items: fresh,
			}
			book.jobs.push(row)
			await save(who, book.jobs)
			return row
		})
		void pump(who)
		return job ? publish(job) : null
	}
	async function resume(input, ctx) {
		const who = actor(ctx.auth)
		const id = String(input?.id ?? '')
		if (!JOB_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That transfer isn’t there')
		const job = await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const row = book.jobs.find((item) => item.id === id)
			if (!row) throw new RpcError('NOT_FOUND', 'That transfer isn’t there')
			if (!canResume(row.state, row.items)) throw new RpcError('PRECONDITION_FAILED', 'That transfer can’t be resumed')
			row.state = 'running'
			row.cancel = false
			await save(who, book.jobs)
			return row
		})
		await writeToast(job.auth, 'started', job.name)
		void pump(who)
		return publish(job)
	}
	async function cancel(input, ctx) {
		const who = actor(ctx.auth)
		const id = String(input?.id ?? '')
		if (!JOB_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That transfer isn’t there')
		const job = await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const row = book.jobs.find((item) => item.id === id)
			if (!row) throw new RpcError('NOT_FOUND', 'That transfer isn’t there')
			if (row.state === 'done' || row.state === 'cancelled') return row
			row.cancel = true
			if (row.state === 'queued' || row.state === 'paused') row.state = 'cancelled'
			await save(who, book.jobs)
			return row
		})
		void pump(who)
		return publish(job)
	}
	async function dismiss(input, ctx) {
		const who = actor(ctx.auth)
		const id = String(input?.id ?? '')
		if (!JOB_ID.test(id)) throw new RpcError('BAD_REQUEST', 'That transfer isn’t there')
		await withFile(who, async () => {
			const book = await load(who)
			if (book.damaged) throw new RpcError('PRECONDITION_FAILED', DAMAGED)
			const row = book.jobs.find((item) => item.id === id)
			if (!row) throw new RpcError('NOT_FOUND', 'That transfer isn’t there')
			if (row.state === 'running' || row.state === 'queued') throw new RpcError('PRECONDITION_FAILED', 'That transfer is still running')
			await save(who, book.jobs.filter((item) => item.id !== id))
		})
		return true
	}
	async function kick() {
		let names = []
		try {
			names = await readdir(join(dataDir, 'transfers'))
		} catch {
			return
		}
		const runs = []
		for (const name of names) {
			if (!name.endsWith('.json')) continue
			const userId = name.slice(0, -5)
			if (!USER_ID.test(userId)) continue
			runs.push(pump(userId))
		}
		await Promise.all(runs)
	}
	async function resetAll() {
		await rm(join(dataDir, 'transfers'), {recursive: true, force: true})
	}
	return {
		procedures: {
			'transfers.list': {kind: 'query', run: list},
			'transfers.start': {kind: 'mutation', run: start},
			'transfers.resume': {kind: 'mutation', run: resume},
			'transfers.cancel': {kind: 'mutation', run: cancel},
			'transfers.dismiss': {kind: 'mutation', run: dismiss},
		},
		kick,
		resetAll,
	}
}
