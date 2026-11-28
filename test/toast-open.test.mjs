import assert from 'node:assert/strict'
import {test} from 'node:test'

import {toastDeskKind} from '../web/src/toasts/open.ts'

test('a toast opens Clip book on the phone hash and as a desktop window', () => {
	assert.equal(toastDeskKind('#/clips'), 'clips')
	assert.equal(toastDeskKind('#/more'), 'system')
	assert.equal(toastDeskKind('#/settings'), 'settings')
	assert.equal(toastDeskKind('#/nope'), null)
	assert.equal(toastDeskKind('clips'), null)
})
