// "Paste as text" in the clip book must reach one terminal or desktop screen, not every open one.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {isClipTarget, markClipTarget, unmarkClipTarget} from '../web/src/clipPasteTarget.ts'

test('only the screen used last is the paste target, and the one before it takes over when it closes', () => {
	const a = {}
	const b = {}
	markClipTarget(a)
	markClipTarget(b)
	assert.equal(isClipTarget(a), false)
	assert.equal(isClipTarget(b), true)
	markClipTarget(a)
	assert.equal(isClipTarget(a), true)
	assert.equal(isClipTarget(b), false)
	unmarkClipTarget(a)
	assert.equal(isClipTarget(b), true)
	unmarkClipTarget(b)
	assert.equal(isClipTarget(a), false)
	assert.equal(isClipTarget(b), false)
})

for (const file of ['Terminal.tsx', 'Console.tsx']) {
	test(`${file} only pastes a clip when it is the paste target`, async () => {
		const src = await readFile(new URL(`../web/src/${file}`, import.meta.url), 'utf8')
		const handler = src.match(/const onClipPaste = [\s\S]*?\n\t\t\}/)
		assert.ok(handler, 'clip paste handler not found')
		assert.match(handler[0], /isClipTarget\(/)
		assert.match(src, /markClipTarget\(/)
		assert.match(src, /unmarkClipTarget\(/)
	})
}
