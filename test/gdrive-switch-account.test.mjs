import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {gdriveSignInFinished} from '../web/src/backupHelpers.ts'

test('"Switch Google account" is not finished by the sign-in that is being replaced', () => {
	const before = {connected: true, email: 'old@example.com'}
	assert.equal(gdriveSignInFinished({connected: true, email: 'old@example.com'}, before), false)
	assert.equal(gdriveSignInFinished({connected: true, email: 'new@example.com'}, before), true)
	assert.equal(gdriveSignInFinished({connected: false, email: ''}, before), false)
})

test('a first sign-in is finished as soon as the server reports connected', () => {
	assert.equal(gdriveSignInFinished({connected: true, email: 'a@example.com'}, {connected: false, email: ''}), true)
	assert.equal(gdriveSignInFinished({connected: false}, {connected: false}), false)
})

test('the sign-in sheet decides with that rule, not with connected alone', async () => {
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /gdriveSignInFinished\(st, /)
	assert.doesNotMatch(src, /if \(st\.connected\) \{/)
})
