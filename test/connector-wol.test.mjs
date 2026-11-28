import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const py = fileURLToPath(new URL('./connector-wol.py', import.meta.url))

test('connector wake relay', () => {
	execFileSync('python3', [py], {encoding: 'utf8', stdio: 'pipe'})
	assert.ok(true)
})
