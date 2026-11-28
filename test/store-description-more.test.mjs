import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {isClamped} from '../web/src/textClamp.ts'

test('a clamped description counts as cut off when its content is taller than its box (#240)', () => {
	assert.equal(isClamped({scrollHeight: 192, clientHeight: 120}), true)
	assert.equal(isClamped({scrollHeight: 120, clientHeight: 120}), false)
	assert.equal(isClamped({scrollHeight: 121, clientHeight: 120}), false)
})

test('the store sheet shows More from the measured layout, not from the number of characters (#240)', async () => {
	const source = await readFile(new URL('../web/src/screens/Store.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(source, /description\.length\s*>\s*280/)
	assert.match(source, /isClamped\(el\)/)
})
