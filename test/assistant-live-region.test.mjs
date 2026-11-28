import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const src = await readFile(new URL('../web/src/screens/Assistant.tsx', import.meta.url), 'utf8')

test('the conversation is a polite live region so a screen reader announces replies and approval cards', () => {
	const thread = /<div\s+className="assistant-thread"\s+role="log"\s+aria-live="polite"[^>]*ref=\{threadRef\}/.exec(src)
	assert.ok(thread, 'the thread that holds the messages has role="log" and aria-live="polite"')
})

test('a reply that is still streaming is held back from announcement until it is finished', () => {
	assert.match(src, /className=\{`bubble \$\{b\.role\}\$\{b\.streaming \? ' live' : ''\}`\}\s+aria-busy=\{b\.streaming \? true : undefined\}/)
})

test('the "Working..." line is a status message', () => {
	assert.match(src, /className="assistant-activity"\s+role="status"/)
})
