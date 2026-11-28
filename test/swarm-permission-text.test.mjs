// "Add a computer": what each permission allows can be read in full before the owner turns it on (#539).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const SWARM = readFileSync(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')

test('the permission rows wrap their explanation instead of cutting it to one line', () => {
	const rule = CSS.match(/\n\.wrap-sub \.row \.main span \{[^}]*\}/)?.[0]
	assert.ok(rule, 'a .wrap-sub rule for the row explanation')
	assert.match(rule, /white-space:\s*normal/)
	assert.match(rule, /overflow:\s*visible/)
	// Both permission lists (Add a computer, Change permissions) opt in.
	const groups = SWARM.match(/<div className="glass group wrap-sub"[^>]*>\s*(?:<Row icon="sparkle"[^\n]*\n\s*)?\{shown\.map|<div className="glass group wrap-sub"[^>]*>\s*\{\(Object\.keys\(ABILITY\)/g) ?? []
	assert.equal(groups.length, 2)
})
