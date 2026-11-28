import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cardFor} from '../omarchyd/assistant/loop.mjs'

const names = {machines: {abcd1234: 'Family NAS'}}

test('the port forwards card says which ports end up open, not just how many', () => {
	const card = cardFor('machines_updateSettings', {id: 'abcd1234', portForwards: [{protocol: 'tcp', hostPort: 2222, guestPort: 22}, {protocol: 'udp', hostPort: 5353, guestPort: 5353}]}, names)
	assert.equal(card.title, 'Change port forwards on Family NAS')
	assert.equal(card.detail, '2 port forwards: tcp 2222 → 22, udp 5353 → 5353')
})

test('a long list is cut with a count, and an empty list says it removes every forward', () => {
	const many = Array.from({length: 10}, (_, i) => ({protocol: 'tcp', hostPort: 3000 + i, guestPort: 80 + i}))
	const card = cardFor('machines_updateSettings', {id: 'abcd1234', portForwards: many}, names)
	assert.match(card.detail, /^10 port forwards: tcp 3000 → 80, .*tcp 3007 → 87, and 2 more$/)
	assert.equal(cardFor('machines_updateSettings', {id: 'abcd1234', portForwards: []}, names).detail, 'Removes every port forward')
})
