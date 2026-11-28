// Toggle buttons that show their state with the "on" class must also expose it to assistive technology.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const src = (p) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8')

test('Wrap lines reports whether wrapping is on', () => {
	assert.match(src('screens/viewer/FileViewer.tsx'), /aria-label="Wrap lines" aria-pressed=\{wrap\}/)
})

test('the open sheet in the spreadsheet viewer is marked current', () => {
	assert.match(src('screens/viewer/FileViewer.tsx'), /aria-current=\{n === tab \? "true" : undefined\}/)
})

test('the current root in the Move/Copy folder picker is pressed', () => {
	assert.match(src('screens/Files.tsx'), /aria-pressed=\{dir === r\.path \|\| dir\.startsWith\(`\$\{r\.path\}\/`\)\}/)
})

test('the chosen computer chip in the NAS setup is pressed', () => {
	assert.match(src('backups.tsx'), /aria-pressed=\{host === f\.host\}/)
})
