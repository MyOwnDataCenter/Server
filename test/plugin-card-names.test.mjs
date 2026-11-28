// Every plugin card repeats Install/Remove/Details, so each control must name its plugin.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const s = readFileSync(new URL('../web/src/screens/Plugins.tsx', import.meta.url), 'utf8')

test('plugin card buttons and link carry the plugin name', () => {
	assert.match(s, /aria-label=\{`Install \$\{p\.name\}`\}/)
	assert.match(s, /aria-label=\{`Installed · Remove \$\{p\.name\}`\}/)
	assert.match(s, /aria-label=\{`Details for \$\{p\.name\}`\}/)
	assert.match(s, /aria-label=\{`\$\{p\.job!\.state === 'installing' \? 'Installing' : 'Removing'\} \$\{p\.name\}`\}/)
})
