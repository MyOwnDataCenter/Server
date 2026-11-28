// Phone Back (the gesture and the on-screen button) closes a full-screen terminal or console.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {overlayBackUsesHistory, popstateClosesOverlay} from '../web/src/overlayHistory.ts'

test('a popstate closes this overlay only when the revealed entry is not ours', () => {
	assert.equal(popstateClosesOverlay(null, 'terminal'), true)
	assert.equal(popstateClosesOverlay(undefined, 'terminal'), true)
	assert.equal(popstateClosesOverlay({}, 'terminal'), true)
	assert.equal(popstateClosesOverlay({omarchyOverlay: 'console'}, 'terminal'), true)
	assert.equal(popstateClosesOverlay({omarchyApp: 'files'}, 'terminal'), true)
	assert.equal(popstateClosesOverlay({omarchyOverlay: 'terminal'}, 'terminal'), false)
	assert.equal(popstateClosesOverlay({omarchyOverlay: 'console'}, 'console'), false)
})

test('the on-screen Back calls history.back only while our entry is still on top', () => {
	assert.equal(overlayBackUsesHistory(false, {omarchyOverlay: 'terminal'}, 'terminal'), true)
	assert.equal(overlayBackUsesHistory(false, {omarchyOverlay: 'console'}, 'console'), true)
	assert.equal(overlayBackUsesHistory(true, {omarchyOverlay: 'terminal'}, 'terminal'), false)
	assert.equal(overlayBackUsesHistory(false, null, 'terminal'), false)
	assert.equal(overlayBackUsesHistory(false, {}, 'terminal'), false)
	assert.equal(overlayBackUsesHistory(false, {omarchyOverlay: 'console'}, 'terminal'), false)
})

test('the full-screen terminal and phone console follow that history, and the embedded one does not push', async () => {
	const terminal = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
	const consoleSrc = await readFile(new URL('../web/src/Console.tsx', import.meta.url), 'utf8')
	for (const src of [terminal, consoleSrc]) {
		assert.match(src, /popstateClosesOverlay\(/)
		assert.match(src, /overlayBackUsesHistory\(/)
		assert.match(src, /history\.pushState\(\{omarchyOverlay:/)
		assert.match(src, /addEventListener\('popstate'/)
		assert.match(src, /history\.back\(\)/)
	}
	assert.match(terminal, /if \(embedded \|\| inline\) return/)
	assert.match(consoleSrc, /if \(embedded\) return/)
	// A desktop window and a row on the Terminals page close directly: neither pushes an entry.
	const gate = terminal.indexOf('if (embedded || inline) return')
	assert.ok(gate > 0)
	assert.doesNotMatch(terminal.slice(0, gate), /history\.pushState/)
})
