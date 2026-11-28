// Settings > Software update: the page leaves the progress panel once the update has finished (#167).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {updateFinished} from '../web/src/screens/settingsHelpers.ts'

test('updateFinished: only after the update was seen running, then stopped without an error', () => {
	assert.equal(updateFinished(true, {running: false, error: false}), true)
	assert.equal(updateFinished(true, {running: true, error: false}), false)
	assert.equal(updateFinished(true, {running: false, error: 'The update failed'}), false)
	assert.equal(updateFinished(true, undefined), false)
	// An "Updated to X" left over from an earlier update must not reload the page at once.
	assert.equal(updateFinished(false, {running: false, error: false}), false)
})

test('Settings reloads the page when the update finishes, as the panel promises', () => {
	const src = readFileSync(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')
	assert.match(src, /updateFinished\(/)
	assert.match(src, /location\.reload\(\)/)
})
