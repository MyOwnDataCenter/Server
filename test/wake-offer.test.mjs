import assert from 'node:assert/strict'
import {test} from 'node:test'

import {wakeOffer} from '../web/src/swarm/wake.ts'

const base = {online: false, allowed: {manage: true}, on: {manage: true}, macs: ['aa:bb:cc:dd:ee:01']}

test('Wake is offered only for an offline managed computer with a remembered NIC', () => {
	assert.deepEqual(wakeOffer(base), {enabled: true, why: ''})
	assert.equal(wakeOffer({...base, online: true}), null)
	assert.equal(wakeOffer({...base, on: {manage: false}}), null)
	const none = wakeOffer({...base, macs: []})
	assert.equal(none.enabled, false)
	assert.match(none.why, /online once/)
})
