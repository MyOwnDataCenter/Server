// After a factory reset the sign-in page says there is no account and how to make one (#564).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {CREATE_OWNER_COMMAND, needsFirstAccount} from '../web/src/screens/firstAccount.ts'

const read = (p) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8')

test('needsFirstAccount: only when the server says it has no owner', () => {
	assert.equal(needsFirstAccount({server: {onboarded: false}}), true)
	assert.equal(needsFirstAccount({server: {onboarded: true}}), false)
	assert.equal(needsFirstAccount({server: {}}), false)
	assert.equal(needsFirstAccount({server: null}), false)
})

test('the command is the create-owner one the installer runs', () => {
	assert.match(CREATE_OWNER_COMMAND, /omarchyd\/cli\.mjs create-owner --data /)
	const install = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
	assert.match(install, /\$APP\/omarchyd\/cli\.mjs" create-owner/)
	assert.match(install, /BASE="\$\{XDG_DATA_HOME:-\$HOME\/\.local\/share\}\/omarchy-server"/)
})

test('Login shows the no-account page, and the reset sheet no longer promises a web setup', () => {
	const auth = read('screens/Auth.tsx')
	assert.match(auth, /if \(needsFirstAccount\(boot\)\) return <NoAccount/)
	assert.match(auth, /CREATE_OWNER_COMMAND/)
	const reset = read('screens/machineHost.tsx')
	assert.doesNotMatch(reset, /goes back to first-time setup/)
	assert.match(reset, /make the first account again in a Terminal on the server/)
})
