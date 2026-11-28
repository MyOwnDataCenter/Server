import assert from 'node:assert/strict'
import test from 'node:test'

import {viewerBackpressure} from '../omarchyd/backpressure.mjs'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const source = () => {
	const s = {paused: false, pauses: 0, resumes: 0}
	s.pause = () => ((s.paused = true), s.pauses++)
	s.resume = () => ((s.paused = false), s.resumes++)
	return s
}

test('a big burst pauses the screen and resumes it once the browser catches up (no disconnect)', async () => {
	const dest = {bufferedAmount: 0, readyState: 1}
	const src = source()
	let stalled = 0
	const bp = viewerBackpressure(dest, src, () => stalled++, {high: 100, low: 20, stallMs: 1000, every: 5})
	dest.bufferedAmount = 50
	bp.check()
	assert.equal(src.paused, false, 'under the high mark nothing happens')
	dest.bufferedAmount = 5_000 // the whole picture after signing in
	bp.check()
	bp.check()
	assert.equal(src.pauses, 1)
	assert.equal(bp.paused, true)
	await wait(20)
	dest.bufferedAmount = 10
	await wait(20)
	assert.equal(src.paused, false)
	assert.equal(src.resumes, 1)
	assert.equal(stalled, 0)
})

test('a viewer that keeps reading slowly is not a stall', async () => {
	const dest = {bufferedAmount: 1000, readyState: 1}
	const src = source()
	let stalled = 0
	let t = 0
	const bp = viewerBackpressure(dest, src, () => stalled++, {high: 100, low: 20, stallMs: 30, every: 5, now: () => t})
	bp.check()
	for (let i = 0; i < 10; i++) {
		t += 20
		dest.bufferedAmount -= 50
		await wait(8)
	}
	assert.equal(stalled, 0)
	bp.stop()
})

test('a viewer that reads nothing for the stall time is let go', async () => {
	const dest = {bufferedAmount: 1000, readyState: 1}
	const src = source()
	let stalled = 0
	let t = 0
	const bp = viewerBackpressure(dest, src, () => stalled++, {high: 100, low: 20, stallMs: 30, every: 5, now: () => t})
	bp.check()
	t = 40
	await wait(20)
	assert.equal(stalled, 1)
	assert.equal(bp.paused, false)
})
