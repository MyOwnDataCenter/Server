import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {pasteInto, terminalPasteDecision} from '../web/src/terminalPaste.ts'

test('a clipboard paste is taken once so the browser cannot repeat the last character', async () => {
	assert.deepEqual(terminalPasteDecision('hello'), {prevent: true, text: 'hello'})
	assert.deepEqual(terminalPasteDecision('line\n'), {prevent: true, text: 'line\n'})
	assert.deepEqual(terminalPasteDecision(''), {prevent: true, text: ''})
	assert.deepEqual(terminalPasteDecision(null), {prevent: true, text: ''})

	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /terminalPasteDecision\(e\.clipboardData/)
	assert.match(src, /e\.preventDefault\(\)/)
	assert.match(src, /e\.stopPropagation\(\)/)
	assert.match(src, /term\.paste\(decision\.text\)/)
	assert.match(src, /addEventListener\('paste', onPaste, true\)/)
})

test('the paste box inserts at the caret and keeps the text after it', async () => {
	assert.equal(pasteInto('hello', 5, 5, '!'), 'hello!')
	assert.equal(pasteInto('hello', 2, 2, 'X'), 'heXllo')
	assert.equal(pasteInto('hello', 0, 0, 'Z'), 'Zhello')
	assert.equal(pasteInto('hello', 1, 4, 'YY'), 'hYYo')
	assert.equal(pasteInto('abcdef', 4, 2, '-'), 'ab-ef')
	assert.equal(pasteInto('abcd', 1, 3, ''), 'ad')
	assert.equal(pasteInto('', 0, 0, 'hi'), 'hi')

	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /pasteInto\(/)
	assert.doesNotMatch(src, /setPasteText\(\(v\) => v \+ t\)/)
})

test('a terminal’s own answers to a replayed screen are recognised; typing never is', async () => {
	const {isTerminalReply} = await import('../web/src/terminalPaste.ts')
	for (const r of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[?2004;1$y', '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b]11;rgb:0b0b/0b0b/0e0e\x07', '\x1b]10;rgb:e6e6/e6e6/eaea\x1b\\']) assert.equal(isTerminalReply(r), true, JSON.stringify(r))
	for (const t of ['ls\r', 'c', '\x1b[A', '\x1b[1;5C', '\x03', '1;2c', '\x1b[200~text\x1b[201~']) assert.equal(isTerminalReply(t), false, JSON.stringify(t))
})

test('the answers seen in a reopened terminal (tmux asking what terminal it is) are recognised, together too', async () => {
	const {isTerminalReply} = await import('../web/src/terminalPaste.ts')
	// What showed up as "1;2c0;276;0c2026;0$y" in the shell.
	assert.equal(isTerminalReply('\x1b[?1;2c\x1b[>0;276;0c\x1b[?2026;0$y'), true)
	assert.equal(isTerminalReply('\x1b[?2026;0$y'), true)
	assert.equal(isTerminalReply('\x1b[?1;2cls\r'), false, 'typing mixed in is never dropped')
})
