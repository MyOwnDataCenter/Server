// The machine panels draw tables from divs: every row must own cells or headers, or the table is not valid ARIA.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const lines = readFileSync(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8').split('\n')
const indent = (l) => l.match(/^\t*/)[0]

test('every mx-tr row is a row and its direct children are cells or column headers', () => {
	let rows = 0
	lines.forEach((l, i) => {
		if (!/<div className=(\{`|")mx-tr/.test(l)) return
		rows++
		assert.match(l, /role="row"/, `row without role: ${l.trim()}`)
		const ind = indent(l)
		if (l.includes('</div>')) return
		for (let j = i + 1; lines[j] !== `${ind}</div>`; j++) {
			if (!lines[j].startsWith(`${ind}\t<span`)) continue
			assert.match(lines[j], /^\t*<span role="(cell|columnheader)"/, `child without cell role: ${lines[j].trim()}`)
		}
	})
	assert.ok(rows >= 11, `expected the table rows, found ${rows}`)
})

test('backup and snapshot buttons say which one they act on', () => {
	const s = lines.join('\n')
	assert.match(s, /aria-label=\{`Restore the backup from \$\{when\(b\.createdAt\)\}`\}/)
	assert.match(s, /aria-label=\{`Delete the backup from \$\{when\(b\.createdAt\)\}`\}/)
	assert.match(s, /aria-label=\{`Roll back to \$\{s\.name\}`\}/)
})
