import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// A Stop that the server refuses used to reject inside the click handler: nothing on screen said so and
// the card kept offering Stop as if it had worked. Sync changes right beside it already reports its error.
test('Stop the move reports an error from unraid.cancel', async () => {
	const src = await readFile(new URL('../web/src/unraid.tsx', import.meta.url), 'utf8')
	const at = src.indexOf("mutate('unraid.cancel')")
	assert.ok(at > 0)
	const around = src.slice(at - 120, at + 200)
	assert.match(around, /try \{/)
	assert.match(around, /catch \(e\) \{\s*toast\(\(e as Error\)\.message, true\)/)
	assert.doesNotMatch(src, /mutate\('unraid\.cancel'\)\.then\(/)
})
