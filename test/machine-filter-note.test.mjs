import assert from 'node:assert/strict'
import {test} from 'node:test'

import {fleetStatus} from '../web/src/fleet/machineManagerLogic.ts'
import {cleanTutorials, dismissTutorial, MACHINES_FILTER_TIP} from '../web/src/tutorials.ts'

test('the shown count sits beside the fleet count only when it says something new', () => {
	assert.deepEqual(fleetStatus({shown: 30, total: 30, online: 3, filter: 'all'}), {shown: null, online: '3 of 30 online'})
	assert.deepEqual(fleetStatus({shown: 4, total: 30, online: 3, filter: 'physical'}), {shown: '4 of 30 shown', online: '3 of 30 online'})
	assert.deepEqual(fleetStatus({shown: 3, total: 30, online: 3, filter: 'online'}), {shown: null, online: '3 of 30 online'})
	assert.deepEqual(fleetStatus({shown: 1, total: 30, online: 3, filter: 'online'}), {shown: '1 of 30 shown', online: '3 of 30 online'})
	assert.deepEqual(fleetStatus({shown: 3, total: 30, online: 3, filter: 'physical'}), {shown: '3 of 30 shown', online: '3 of 30 online'})
	assert.deepEqual(fleetStatus({shown: 0, total: 30, online: 3, filter: 'virtual'}), {shown: null, online: '3 of 30 online'})
})

test('dismissing a note is remembered for the account, and restoring clears it', () => {
	assert.deepEqual(dismissTutorial([], MACHINES_FILTER_TIP), ['machines-filters'])
	assert.deepEqual(dismissTutorial(['machines-filters'], MACHINES_FILTER_TIP), ['machines-filters'])
	assert.deepEqual(cleanTutorials(['machines-filters', 'nope', 4]), ['machines-filters'])
	assert.deepEqual(cleanTutorials(null), [])
})
