import assert from 'node:assert/strict'
import {test} from 'node:test'

import {liveToasts, toastRemaining, toastSurface} from '../web/src/toasts/view.ts'

const toast = (over) => ({
	id: 'a',
	text: 'Sent',
	at: 1,
	href: '#/clips',
	expireAt: null,
	level: 'note',
	...over,
})

test('a toast whose time has passed is hidden, and one that waits for a person stays', () => {
	const now = 1_000
	const rows = [
		toast({id: 'old', expireAt: 1_000, at: 1}),
		toast({id: 'soon', expireAt: 1_001, at: 2}),
		toast({id: 'stay', expireAt: null, at: 3}),
	]
	assert.deepEqual(liveToasts(rows, now).map((row) => row.id), ['stay', 'soon'])
})

test('problems sort ahead of notes, and each group is newest first', () => {
	const rows = [
		toast({id: 'note-old', at: 1, level: 'note'}),
		toast({id: 'problem-old', at: 2, level: 'problem'}),
		toast({id: 'note-new', at: 4, level: 'note'}),
		toast({id: 'problem-new', at: 3, level: 'problem'}),
	]
	assert.deepEqual(liveToasts(rows, 10).map((row) => row.id), ['problem-new', 'problem-old', 'note-new', 'note-old'])
})

test('the character speaks when it is on screen, and the box is used when it is covered or hidden', () => {
	assert.equal(toastSurface({floating: true, covered: false}), 'bubble')
	assert.equal(toastSurface({floating: true, covered: true}), 'box')
	assert.equal(toastSurface({floating: false, covered: false}), 'box')
})

test('toastRemaining empties from create to expiry and is null when untimed', () => {
	assert.equal(toastRemaining({at: 0, expireAt: null}, 500), null)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 0), 1)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 500), 0.5)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 1000), 0)
	assert.equal(toastRemaining({at: 0, expireAt: 1000}, 1500), 0)
	assert.equal(toastRemaining({at: 100, expireAt: 100}, 100), null)
})
