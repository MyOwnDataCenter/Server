// The phone console pushes one history entry. Every way of closing it must go through back(),
// or the entry stays behind and the next Back press seems to do nothing.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SRC = readFileSync(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')

test('the direct GPU view closes through back(), not the raw onClose', () => {
	const start = SRC.indexOf('if (directGpu) {')
	assert.ok(start > 0, 'directGpu branch not found')
	const branch = SRC.slice(start, SRC.indexOf('portalRoot,', start))
	assert.match(branch, /onClose=\{embedded \? undefined : back\}/)
	assert.doesNotMatch(branch, /onClose=\{embedded \? undefined : onClose\}/)
})
