import assert from 'node:assert/strict'
import {mkdtemp, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createToasts} from '../omarchyd/toasts.mjs'

const owner = {userId: 'owner', role: 'owner'}
const member = {userId: 'sam', role: 'member'}
const modeOf = async (p) => (await stat(p)).mode & 0o777

async function boot(now = () => 1_000) {
	const root = await mkdtemp(join(tmpdir(), 'toasts-'))
	const toasts = createToasts({dataDir: root, now})
	return {
		root,
		toasts,
		ctx: (auth) => ({auth}),
	}
}

test('a toast belongs to one account, and dismiss removes it', async () => {
	const b = await boot()
	try {
		const added = await b.toasts.procedures['toasts.add'].run({text: 'Three files are on the way', href: '#/clips', expireAt: null, level: 'note'}, b.ctx(owner))
		assert.equal(added.text, 'Three files are on the way')
		const mine = await b.toasts.procedures['toasts.list'].run({}, b.ctx(owner))
		assert.deepEqual(mine.map((row) => row.id), [added.id])
		const theirs = await b.toasts.procedures['toasts.list'].run({}, b.ctx(member))
		assert.deepEqual(theirs, [])
		await b.toasts.procedures['toasts.dismiss'].run({id: added.id}, b.ctx(owner))
		assert.deepEqual(await b.toasts.procedures['toasts.list'].run({}, b.ctx(owner)), [])
		assert.equal(await modeOf(join(b.root, 'toasts')), 0o700)
		assert.equal(await modeOf(join(b.root, 'toasts', 'owner.json')), 0o600)
		await assert.rejects(() => b.toasts.procedures['toasts.add'].run({text: 'x'}, b.ctx({userId: '../owner', role: 'owner'})), /account/)
		await assert.rejects(() => b.toasts.procedures['toasts.add'].run({text: 'x'}, b.ctx({userId: 'a'.repeat(65), role: 'owner'})), /account/)
	} finally {
		await rm(b.root, {recursive: true, force: true})
	}
})

test('a toast whose time has passed is hidden, and one that waits is still there after a restart', async () => {
	const root = await mkdtemp(join(tmpdir(), 'toasts-'))
	try {
		const first = createToasts({dataDir: root, now: () => 1_000})
		const ctx = {auth: owner}
		await first.procedures['toasts.add'].run({text: 'Started', href: '#/clips', expireAt: 1_000, level: 'note'}, ctx)
		const stay = await first.procedures['toasts.add'].run({text: 'One file did not send', href: '#/clips', expireAt: null, level: 'problem'}, ctx)
		assert.deepEqual((await first.procedures['toasts.list'].run({}, ctx)).map((row) => row.id), [stay.id])
		const again = createToasts({dataDir: root, now: () => 5_000})
		const listed = await again.procedures['toasts.list'].run({}, ctx)
		assert.deepEqual(listed.map((row) => row.text), ['One file did not send'])
		assert.equal(listed[0].level, 'problem')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
