// The Files selection bar's cancel button holds only an icon and a count, so it needs its own name.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

test('the selection bar cancel button is named, not just a number', () => {
	const s = readFileSync(new URL('../web/src/screens/Files.tsx', import.meta.url), 'utf8')
	const m = s.match(/<button\s+className="sb-cancel"([^>]*)>/)
	assert.ok(m, 'sb-cancel button not found')
	assert.match(m[1], /aria-label=\{`Cancel selection, \$\{selected\.size\} selected`\}/)
})
