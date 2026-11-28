// A Terminal inside an app is a different shell from the server's own Terminal. Asking for it must not
// just bring the other window forward.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {extraWindowAction, sameShellWindows} from '../web/src/desktop/extraWindow.ts'

const host = {id: 'w1', kind: 'terminal', z: 11}
const immich = {id: 'w2', kind: 'terminal', z: 12, payload: {term: {id: 'immich'}}}
const files = {id: 'w3', kind: 'files', z: 13}

test('windows on the same shell are the ones that can stand in for a new Terminal', () => {
	assert.deepEqual(sameShellWindows([host, immich, files], null), [host])
	assert.deepEqual(sameShellWindows([host, immich, files], undefined), [host])
	assert.deepEqual(sameShellWindows([host, immich, files], {id: 'immich'}), [immich])
	assert.deepEqual(sameShellWindows([host, files], {id: 'immich'}), [])
})

test('an app shell asked for next to a server Terminal opens a window instead of focusing', () => {
	const alreadyOpen = sameShellWindows([host], {id: 'immich'}).length > 0
	assert.equal(extraWindowAction('terminal', alreadyOpen), 'open')
	assert.equal(extraWindowAction('terminal', sameShellWindows([host, immich], {id: 'immich'}).length > 0), 'focus')
})

test('the desktop looks for an existing Terminal on the same shell', () => {
	const src = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(src, /sameShellWindows\(winsRef\.current, term\)/)
	assert.match(src, /sameShellWindows\(sameKey, payload\?\.term\)/)
})
