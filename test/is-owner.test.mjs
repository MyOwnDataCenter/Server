// Strict owner: one meaning for every UI privilege gate.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {isOwner} from '../web/src/isOwner.ts'

test('isOwner is true only for role owner', () => {
	assert.equal(isOwner({role: 'owner'}), true)
	assert.equal(isOwner({role: 'member'}), false)
	assert.equal(isOwner({role: null}), false)
	assert.equal(isOwner({role: undefined}), false)
	assert.equal(isOwner({}), false)
	assert.equal(isOwner(null), false)
	assert.equal(isOwner(undefined), false)
})
