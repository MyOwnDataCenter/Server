// The SSH command in the installer prompt must be copyable from the keyboard (#520).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SRC = readFileSync(new URL('../web/src/InstallerPrompt.tsx', import.meta.url), 'utf8')

test('the installer prompt offers a real Copy command button next to the SSH command', () => {
	const manual = SRC.match(/<details className="installer-manual">[\s\S]*?<\/details>/)?.[0]
	assert.ok(manual, 'manual section not found')
	assert.match(manual, /<button type="button"[^>]*onClick=\{copy\}[^>]*>[\s\S]*?Copy command\s*<\/button>/)
})
