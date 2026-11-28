import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {typedSshPort} from '../web/src/unraidView.ts'

test('a blank SSH port is 22 and text that is not a number is not turned into 22', async () => {
	assert.equal(typedSshPort(''), 22)
	assert.equal(typedSshPort(' '), 22)
	assert.equal(typedSshPort('2222'), 2222)
	assert.ok(Number.isNaN(typedSshPort('22x')))
	assert.ok(Number.isNaN(typedSshPort('abc')))
	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(src, /Number\(port\) \|\| 22/)
	assert.match(src, /typedSshPort\(port\)/)
})
