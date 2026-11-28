// Remembered physical NICs for Wake-on-LAN, and when a missing one is forgotten.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {FORGET_ONLINE_MS, FORGET_SESSIONS, updateNics} from '../omarchyd/nics.mjs'

const DAY = 24 * 60 * 60 * 1000

test('a NIC seen while the computer is on is remembered and its miss counters reset', () => {
	const next = updateNics(
		[{mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1, missingSessions: 2, missingOnlineMs: DAY, countedSession: 1}],
		['AA:BB:CC:DD:EE:01'],
		{now: 1000, session: 4, elapsedOnlineMs: 5000},
	)
	assert.deepEqual(next, [{mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1000, missingSessions: 0, missingOnlineMs: 0, countedSession: 4}])
})

test('a missing NIC is counted once per later online session, and time only while online', () => {
	const first = updateNics(
		[{mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1, missingSessions: 0, missingOnlineMs: 0, countedSession: 1}],
		[],
		{now: 10_000, session: 2, elapsedOnlineMs: 9_000},
	)
	assert.equal(first[0].missingSessions, 1)
	assert.equal(first[0].missingOnlineMs, 9_000)
	const again = updateNics(first, [], {now: 20_000, session: 2, elapsedOnlineMs: 10_000})
	assert.equal(again[0].missingSessions, 1)
	assert.equal(again[0].missingOnlineMs, 19_000)
})

test('a NIC is forgotten only after 3 later sessions and 7 days online without it', () => {
	const base = {mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1, countedSession: 2}
	const shortTime = updateNics([{...base, missingSessions: 2, missingOnlineMs: 6 * DAY}], [], {now: 8 * DAY, session: 3, elapsedOnlineMs: 0})
	assert.equal(shortTime.length, 1)
	const fewSessions = updateNics([{...base, missingSessions: 1, missingOnlineMs: 8 * DAY}], [], {now: 9 * DAY, session: 3, elapsedOnlineMs: 0})
	assert.equal(fewSessions.length, 1)
	const dropped = updateNics([{...base, missingSessions: 2, missingOnlineMs: 7 * DAY}], [], {now: 10 * DAY, session: 3, elapsedOnlineMs: 0})
	assert.deepEqual(dropped, [])
})

test('three quick sessions without seven days online do not forget the NIC', () => {
	let nics = [{mac: 'aa:bb:cc:dd:ee:01', lastSeen: 1, missingSessions: 0, missingOnlineMs: 0, countedSession: 0}]
	for (const session of [1, 2, 3]) nics = updateNics(nics, [], {now: session * 1000, session, elapsedOnlineMs: 1000})
	assert.equal(nics.length, 1)
	assert.equal(nics[0].missingSessions, FORGET_SESSIONS)
	assert.ok(nics[0].missingOnlineMs < FORGET_ONLINE_MS)
})
