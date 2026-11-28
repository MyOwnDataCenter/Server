// Machines, Terminals, and Clip book share one filter row.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the list screens use the shared filter bar', () => {
	const bar = read('../web/src/FilterBar.tsx')
	assert.match(bar, /className="filter-bar"/)
	assert.match(bar, /className="segmented glass"/)
	assert.match(bar, /aria-pressed=\{slot\.pressed\}/)
	assert.match(bar, /rovingKeyDown/)
	for (const file of ['../web/src/fleet/MachineManager.tsx', '../web/src/fleet/Terminals.tsx', '../web/src/clips/ClipBook.tsx']) {
		const src = read(file)
		assert.match(src, /<FilterBar/, file)
		assert.doesNotMatch(src, /clip-filters|mm-search|mm-filters/, file)
	}
	const css = read('../web/src/styles.css')
	assert.match(css, /\.filter-bar \.segmented button\[aria-pressed='true'\]/)
	assert.doesNotMatch(css, /\.clip-filters button/)
})
