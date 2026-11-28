// "Add a computer" must not say a switched-off ability can never be switched on again (#560).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SWARM = readFileSync(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')

test('the Add a computer text matches how abilities work: off and on again, more through Change permissions', () => {
	assert.doesNotMatch(SWARM, /but not on again without adding it again/)
	assert.match(SWARM, /switch any of these off and on again from the computer’s page, and Change permissions there can allow more/)
})
