// A terminal that never connected must not say the shell is still running.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {terminalCloseOutcome, terminalStatusLabel} from '../web/src/terminalClose.ts'

test('a connection that never opened is an error, not a running shell', () => {
	const out = terminalCloseOutcome({opened: false, shellEnded: false, onComputer: false})
	assert.equal(out.state, 'error')
	assert.doesNotMatch(out.message, /still running/)
})

test('a dropped connection says the shell is still running, on the right machine', () => {
	assert.match(terminalCloseOutcome({opened: true, shellEnded: false, onComputer: false}).message, /on the server/)
	assert.match(terminalCloseOutcome({opened: true, shellEnded: false, onComputer: true}).message, /on that computer/)
	assert.equal(terminalCloseOutcome({opened: true, shellEnded: false, onComputer: false}).state, 'lost')
})

test('a shell that ended is closed', () => {
	assert.deepEqual(terminalCloseOutcome({opened: true, shellEnded: true, onComputer: false}), {state: 'closed', message: 'The shell has ended.'})
})

test('status labels cover connecting through failed', () => {
	assert.equal(terminalStatusLabel('connecting'), 'Connecting…')
	assert.equal(terminalStatusLabel('connecting', {attempt: 2}), 'Reconnecting…')
	assert.equal(terminalStatusLabel('connected'), 'Connected')
	assert.equal(terminalStatusLabel('closed'), 'Session ended')
	assert.equal(terminalStatusLabel('lost'), 'Disconnected')
	assert.equal(terminalStatusLabel('error'), 'Failed')
})

test('Terminal.tsx uses it', async () => {
	const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	assert.match(src, /terminalCloseOutcome\(/)
	assert.match(src, /terminalStatusLabel\(/)
	assert.doesNotMatch(src, /Your shell is still running on the server/)
})
