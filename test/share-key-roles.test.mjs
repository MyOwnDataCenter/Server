// A provider stays with the person who added it. Settings offers it to everyone else; it does not check accounts one by one.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

test('a provider is offered to everyone else, not checked onto one account', () => {
	const s = readFileSync(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')
	assert.doesNotMatch(s, /picked\.includes\(a\.userId\)/)
	assert.doesNotMatch(s, /ShareKeySheet/)
	assert.match(s, /role="radio"/)
	assert.match(s, /aria-label=\{`Offer \$\{k\.name\} to everyone else`\}/)
})
