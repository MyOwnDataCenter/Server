import assert from 'node:assert/strict'
import {test} from 'node:test'

import {afterFailure, canResume, jobToast, resumeIds, transferProgress, TRANSIENT_TRIES} from '../web/src/clips/transferView.ts'

const item = (over) => ({
	clipId: 'a',
	name: 'Notes',
	state: 'waiting',
	reason: null,
	tries: 0,
	error: null,
	...over,
})

test('progress counts what has landed and names the clip that is moving', () => {
	const items = [item({clipId: 'a', state: 'done'}), item({clipId: 'b', name: 'Photo', state: 'sending'}), item({clipId: 'c', state: 'waiting'})]
	assert.deepEqual(transferProgress(items), {done: 1, total: 3, current: 'Photo'})
})

test('a short drop is tried again, and the third failure pauses the transfer', () => {
	assert.equal(TRANSIENT_TRIES, 3)
	const first = afterFailure(item({tries: 0}), 'transient', 'offline')
	assert.equal(first.pause, false)
	assert.equal(first.item.state, 'waiting')
	assert.equal(first.item.tries, 1)
	const third = afterFailure(item({tries: 2}), 'transient', 'offline')
	assert.equal(third.pause, true)
	assert.equal(third.item.state, 'failed')
	assert.equal(third.item.tries, 3)
})

test('a clip that is gone stays failed, and the transfer can continue', () => {
	const gone = afterFailure(item(), 'gone', 'gone')
	assert.equal(gone.pause, false)
	assert.equal(gone.item.state, 'failed')
	assert.equal(gone.item.reason, 'gone')
	const changed = afterFailure(item(), 'changed', 'changed')
	assert.equal(changed.pause, false)
	const refused = afterFailure(item(), 'refused', 'refused')
	assert.equal(refused.pause, false)
})

test('resume picks up what did not land, and leaves a gone clip where it is', () => {
	const items = [
		item({clipId: 'landed', state: 'done'}),
		item({clipId: 'moving', state: 'sending'}),
		item({clipId: 'later', state: 'waiting'}),
		item({clipId: 'drop', state: 'failed', reason: 'transient', tries: 3}),
		item({clipId: 'missing', state: 'failed', reason: 'gone', tries: 1}),
		item({clipId: 'edited', state: 'failed', reason: 'changed', tries: 1}),
		item({clipId: 'nope', state: 'failed', reason: 'refused', tries: 1}),
	]
	assert.deepEqual(resumeIds(items), ['moving', 'later', 'drop'])
	assert.equal(canResume('paused', items), true)
	assert.equal(canResume('cancelled', items), false)
	assert.equal(canResume('done', items), false)
})

test('a transfer tells the person it started, finished, or hit a problem', () => {
	assert.deepEqual(jobToast('started', 'Quito'), {text: 'Sending to Quito', level: 'note', untilDismiss: false, href: '#/clips'})
	assert.deepEqual(jobToast('finished', 'Quito'), {text: 'Sent to Quito', level: 'note', untilDismiss: false, href: '#/clips'})
	const problem = jobToast('problem', 'Quito')
	assert.equal(problem.level, 'problem')
	assert.equal(problem.untilDismiss, true)
	assert.equal(problem.href, '#/clips')
	assert.match(problem.text, /Clip book/)
})
