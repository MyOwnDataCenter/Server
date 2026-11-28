import assert from 'node:assert/strict'
import {test} from 'node:test'

import {SYSTEM_DOCK} from '../web/src/desktop/config.ts'
import {placeableKeys} from '../web/src/desktop/places.ts'

test('clip book can be pinned or placed on the desktop, and it is not on the default dock', () => {
	assert.equal(SYSTEM_DOCK.includes('clips'), false)
	const keys = placeableKeys([{id: 'b', name: 'Beta'}, {id: 'a', name: 'Alpha'}], [{id: 'm1'}], true, true)
	assert.ok(keys.includes('clips'))
	assert.ok(keys.indexOf('assistant') < keys.indexOf('clips'))
	assert.ok(keys.includes('folder:/Home'))
	assert.deepEqual(
		keys.filter((key) => key.startsWith('app:')),
		['app:a', 'app:b'],
	)
	const member = placeableKeys([], [], false, false)
	assert.equal(member.includes('terminal'), false)
	assert.equal(member.includes('machine:desktop'), false)
	assert.ok(member.includes('clips'))
})
