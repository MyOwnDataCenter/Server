import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {RpcError} from '../omarchyd/rpc.mjs'
import {createToasts} from '../omarchyd/toasts.mjs'
import {createTransfers} from '../omarchyd/transfers.mjs'
import {jobToast, TOAST_LIFE_MS} from '../web/src/clips/transferView.ts'

const owner = {userId: 'owner', role: 'owner'}
const member = {userId: 'sam', role: 'member'}
const modeOf = async (p) => (await stat(p)).mode & 0o777

async function boot(paste, stat = async () => null, now = () => 5_000) {
	const root = await mkdtemp(join(tmpdir(), 'transfers-'))
	const toasts = createToasts({dataDir: root, now})
	const transfers = createTransfers({dataDir: root, toasts, paste, stat, now})
	return {root, toasts, transfers, ctx: {auth: owner}, member: {auth: member}, now}
}

const clip = (id, name) => ({id, name})
const startInput = (clips, name = 'This server') => ({name, dest: {folder: '/Home'}, clips})

async function until(fn) {
	for (let i = 0; i < 80; i++) {
		const value = await fn()
		if (value) return value
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error('timed out')
}

function jobsOf(b) {
	return b.transfers.procedures['transfers.list'].run({}, b.ctx)
}

test('three clips run one at a time and each is landed only after paste returns', async () => {
	let active = 0
	let max = 0
	const marks = []
	const order = []
	const b = await boot(async (_auth, id) => {
		active += 1
		max = Math.max(max, active)
		order.push(id)
		const mid = await jobsOf(b)
		marks.push(mid[0].items.find((item) => item.clipId === id).state)
		await new Promise((resolve) => setTimeout(resolve, 15))
		active -= 1
		return {path: `/Home/${id}`, size: 2}
	})
	try {
		await b.transfers.procedures['transfers.start'].run(startInput([clip('a', 'Notes'), clip('b', 'Photo'), clip('c', 'Plan')]), b.ctx)
		const done = await until(async () => {
			const rows = await jobsOf(b)
			return rows[0]?.state === 'done' ? rows[0] : null
		})
		assert.equal(max, 1)
		assert.deepEqual(order, ['a', 'b', 'c'])
		assert.deepEqual(marks, ['sending', 'sending', 'sending'])
		assert.deepEqual(done.items.map((item) => item.state), ['done', 'done', 'done'])
		assert.equal(done.progress.done, 3)
		assert.deepEqual(await b.transfers.procedures['transfers.list'].run({}, b.member), [])
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a short drop pauses after three tries, and resume sends only what is left', async () => {
	const calls = []
	let drops = 0
	const b = await boot(async (_auth, id) => {
		calls.push(id)
		if (id === 'drop') {
			drops += 1
			if (drops <= 3) throw new RpcError('PRECONDITION_FAILED', 'The machine is offline')
		}
		return {path: `/Home/${id}`, size: 1}
	})
	try {
		const started = await b.transfers.procedures['transfers.start'].run(startInput([clip('landed', 'Notes'), clip('drop', 'Photo'), clip('later', 'Plan')]), b.ctx)
		const paused = await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.state === 'paused' ? row : null
		})
		assert.equal(paused.canResume, true)
		assert.deepEqual(calls, ['landed', 'drop', 'drop', 'drop'])
		calls.length = 0
		await b.transfers.procedures['transfers.resume'].run({id: started.id}, b.ctx)
		const done = await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.state === 'done' ? row : null
		})
		assert.deepEqual(calls, ['drop', 'later'])
		assert.equal(done.items.find((item) => item.clipId === 'landed').state, 'done')
		assert.equal(done.canResume, false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a gone clip stays failed and the next clip still runs', async () => {
	const calls = []
	const b = await boot(async (_auth, id) => {
		calls.push(id)
		if (id === 'gone') throw new RpcError('NOT_FOUND', 'That clip isn’t in the book')
		if (id === 'nope') throw new RpcError('PRECONDITION_FAILED', 'A folder can be saved on this server. Another computer can’t take a whole folder yet.')
		return {path: `/Home/${id}`, size: 1}
	})
	try {
		const started = await b.transfers.procedures['transfers.start'].run(startInput([clip('gone', 'Old'), clip('nope', 'Folder'), clip('keep', 'Notes')]), b.ctx)
		const done = await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.state === 'done' ? row : null
		})
		assert.deepEqual(calls, ['gone', 'nope', 'keep'])
		assert.equal(done.items.find((item) => item.clipId === 'gone').reason, 'gone')
		assert.equal(done.items.find((item) => item.clipId === 'nope').reason, 'refused')
		assert.equal(done.items.find((item) => item.clipId === 'keep').state, 'done')
		assert.equal(done.canResume, false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a file the other computer says is gone does not pause the transfer', async () => {
	const calls = []
	const b = await boot(async (_auth, id) => {
		calls.push(id)
		if (id === 'gone') throw new RpcError('BAD_GATEWAY', 'That file isn’t in your home folder')
		return {path: `/Home/${id}`, size: 1}
	})
	try {
		const started = await b.transfers.procedures['transfers.start'].run(startInput([clip('gone', 'Old'), clip('keep', 'Notes')]), b.ctx)
		assert.equal(Object.hasOwn(started, 'auth'), false)
		assert.equal(JSON.stringify(started).includes('"auth"'), false)
		assert.equal(await modeOf(join(b.root, 'transfers')), 0o700)
		assert.equal(await modeOf(join(b.root, 'transfers', 'owner.json')), 0o600)
		await assert.rejects(() => b.transfers.procedures['transfers.start'].run(startInput([clip('x', 'X')]), {auth: {userId: '../owner', role: 'owner'}}), /account/)
		await assert.rejects(() => b.transfers.procedures['transfers.start'].run(startInput([clip('x', 'X')]), {auth: {userId: 'a'.repeat(65), role: 'owner'}}), /account/)
		const done = await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.state === 'done' ? row : null
		})
		assert.deepEqual(calls, ['gone', 'keep'])
		assert.equal(done.items.find((item) => item.clipId === 'gone').reason, 'gone')
		assert.equal(done.items.find((item) => item.clipId === 'keep').state, 'done')
		assert.equal(done.state, 'done')
		assert.equal(done.canResume, false)
		assert.equal(Object.hasOwn(done, 'auth'), false)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a second transfer waits, and the same clip is not queued twice', async () => {
	const calls = []
	let release
	const b = await boot((_auth, id) => {
		calls.push(id)
		if (id === 'slow') return new Promise((resolve) => {
			release = () => resolve({path: '/Home/slow', size: 1})
		})
		return Promise.resolve({path: `/Home/${id}`, size: 1})
	})
	try {
		await b.transfers.procedures['transfers.start'].run(startInput([clip('slow', 'Big')]), b.ctx)
		await until(() => calls.includes('slow'))
		await b.transfers.procedures['transfers.start'].run(startInput([clip('other', 'Other')]), b.ctx)
		await b.transfers.procedures['transfers.start'].run(startInput([clip('slow', 'Big')]), b.ctx)
		const waiting = await jobsOf(b)
		assert.equal(waiting.length, 2)
		assert.deepEqual(calls, ['slow'])
		release()
		await until(async () => {
			const rows = await jobsOf(b)
			return rows.length === 2 && rows.every((job) => job.state === 'done')
		})
		assert.deepEqual(calls, ['slow', 'other'])
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('cancel leaves what landed and does not send the rest', async () => {
	const calls = []
	let release
	const b = await boot((_auth, id) => {
		calls.push(id)
		if (id === 'a') return new Promise((resolve) => {
			release = () => resolve({path: '/Home/a', size: 3})
		})
		return Promise.resolve({path: `/Home/${id}`, size: 3})
	})
	try {
		const started = await b.transfers.procedures['transfers.start'].run(startInput([clip('a', 'A'), clip('b', 'B'), clip('c', 'C')]), b.ctx)
		await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.items.find((item) => item.clipId === 'a')?.state === 'sending'
		})
		await b.transfers.procedures['transfers.cancel'].run({id: started.id}, b.ctx)
		release()
		const stopped = await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.state === 'cancelled' ? row : null
		})
		assert.deepEqual(calls, ['a'])
		assert.equal(stopped.items.find((item) => item.clipId === 'a').state, 'done')
		assert.equal(stopped.canResume, false)
		await assert.rejects(() => b.transfers.procedures['transfers.resume'].run({id: started.id}, b.ctx), (error) => error.code === 'PRECONDITION_FAILED')
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a restart does not count a clip as landed until paste returns, and a saved path with the same size is skipped', async () => {
	let release
	const b = await boot(() => new Promise((resolve) => {
		release = resolve
	}))
	try {
		const started = await b.transfers.procedures['transfers.start'].run(startInput([clip('move', 'Notes')]), b.ctx)
		await until(async () => {
			const row = (await jobsOf(b)).find((job) => job.id === started.id)
			return row?.items[0]?.state === 'sending'
		})
		const marks = []
		const second = createTransfers({
			dataDir: b.root,
			toasts: b.toasts,
			now: b.now,
			stat: async () => null,
			paste: async () => {
				const mid = await second.procedures['transfers.list'].run({}, b.ctx)
				marks.push(mid[0].items[0].state)
				return {path: '/Home/Notes', size: 5}
			},
		})
		await second.kick()
		const done = await until(async () => {
			const row = (await second.procedures['transfers.list'].run({}, b.ctx)).find((job) => job.id === started.id)
			return row?.state === 'done' ? row : null
		})
		assert.deepEqual(marks, ['sending'])
		assert.equal(done.items[0].state, 'done')
		release?.({path: '/Home/ignored', size: 1})

		const root = await mkdtemp(join(tmpdir(), 'transfers-skip-'))
		try {
			const id = 'a'.repeat(16)
			await mkdir(join(root, 'transfers'), {recursive: true})
			await writeFile(join(root, 'transfers', 'owner.json'), JSON.stringify({
				jobs: [{
					id,
					at: 1,
					state: 'running',
					name: 'This server',
					dest: {folder: '/Home'},
					auth: owner,
					cancel: false,
					items: [{clipId: 'file', name: 'Notes', state: 'sending', reason: null, tries: 1, error: null, path: '/Home/Notes', size: 9}],
				}],
			}))
			let pasted = false
			const skipped = createTransfers({
				dataDir: root,
				toasts: createToasts({dataDir: root, now: () => 5_000}),
				now: () => 5_000,
				stat: async (path) => (path === '/Home/Notes' ? {size: 9} : null),
				paste: async () => {
					pasted = true
					return {path: '/Home/Notes', size: 9}
				},
			})
			await skipped.kick()
			const row = await until(async () => {
				const listed = await skipped.procedures['transfers.list'].run({}, b.ctx)
				return listed[0]?.state === 'done' ? listed[0] : null
			})
			assert.equal(pasted, false)
			assert.equal(row.items[0].state, 'done')
		} finally {
			await rm(root, {recursive: true, force: true})
		}
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('started, finished, and problem toasts are written on the account', async () => {
	const now = () => 5_000
	const clean = await boot(async () => ({path: '/Home/a', size: 1}), async () => null, now)
	try {
		await clean.transfers.procedures['transfers.start'].run(startInput([clip('a', 'Notes')]), clean.ctx)
		const started = jobToast('started', 'This server')
		const finished = jobToast('finished', 'This server')
		const notes = await until(async () => {
			if ((await jobsOf(clean))[0]?.state !== 'done') return null
			const rows = await clean.toasts.procedures['toasts.list'].run({}, clean.ctx)
			const hasStarted = rows.some((row) => row.text === started.text && row.level === 'note' && row.href === '#/clips' && row.expireAt === now() + TOAST_LIFE_MS)
			const hasFinished = rows.some((row) => row.text === finished.text && row.level === 'note' && row.href === '#/clips' && row.expireAt === now() + TOAST_LIFE_MS)
			return hasStarted && hasFinished ? rows : null
		})
		assert.equal(notes.some((row) => row.text === started.text), true)
		assert.equal(notes.some((row) => row.text === finished.text), true)
	} finally {
		await rm(clean.root, {recursive: true, force: true})
	}

	const problem = await boot(async () => {
		throw new RpcError('PRECONDITION_FAILED', 'offline')
	}, async () => null, now)
	try {
		await problem.transfers.procedures['transfers.start'].run(startInput([clip('a', 'Notes')]), problem.ctx)
		const expected = jobToast('problem', 'This server')
		const notes = await until(async () => {
			if ((await jobsOf(problem))[0]?.state !== 'paused') return null
			const rows = await problem.toasts.procedures['toasts.list'].run({}, problem.ctx)
			return rows.some((row) => row.text === expected.text && row.level === 'problem' && row.href === '#/clips' && row.expireAt == null) ? rows : null
		})
		assert.equal(notes.some((row) => row.text === expected.text && row.expireAt == null), true)
	} finally {
		await rm(problem.root, {recursive: true, force: true})
	}
})

test('the saved book is readable', async () => {
	const b = await boot(async () => ({path: '/Home/a', size: 1}))
	try {
		await b.transfers.procedures['transfers.start'].run(startInput([clip('a', 'Notes')]), b.ctx)
		await until(async () => ((await jobsOf(b))[0]?.state === 'done' ? true : null))
		const raw = await readFile(join(b.root, 'transfers', 'owner.json'), 'utf8')
		assert.match(raw, /"state": "done"/)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a toast that cannot be saved does not stop the transfer', async () => {
	const b = await boot(async () => ({path: '/Home/a', size: 1}))
	b.toasts.procedures['toasts.add'].run = async () => {
		throw new Error('disk full')
	}
	const errors = []
	const onError = (error) => errors.push(error)
	process.on('unhandledRejection', onError)
	try {
		await b.transfers.procedures['transfers.start'].run(startInput([clip('a', 'Notes')]), b.ctx)
		assert.equal(await until(async () => ((await jobsOf(b))[0]?.state === 'done' ? true : null)), true)
		await new Promise((resolve) => setTimeout(resolve, 40))
		assert.deepEqual(errors, [])
	} finally {
		process.off('unhandledRejection', onError)
		await rm(b.root, {recursive: true, force: true})
	}
})
