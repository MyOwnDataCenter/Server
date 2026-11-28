import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

test('the New machine stepper value is a live status that names what it is, so a screen reader announces the change', async () => {
	const src = await readFile(new URL('../web/src/CreateMachine.tsx', import.meta.url), 'utf8')
	const block = /<span className="step-val num"[^>]*>[\s\S]*?<\/span>\s*<button/.exec(src)?.[0] ?? ''
	assert.match(block, /role="status"/)
	assert.match(block, /<span className="sr-only">\{label\} <\/span>/)
})
