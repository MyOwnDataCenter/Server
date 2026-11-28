// Error messages that appear after an action must be announced: every error block carries role="alert".
import assert from 'node:assert/strict'
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {test} from 'node:test'

const ROOT = new URL('../web/src/', import.meta.url).pathname
function* walk(dir) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f)
		if (statSync(p).isDirectory()) yield* walk(p)
		else if (p.endsWith('.tsx')) yield p
	}
}

test('every error, bk-err, plugin-error and desk-signin-error element has role="alert"', () => {
	let seen = 0
	for (const p of walk(ROOT)) {
		readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
			for (const m of line.matchAll(/<(div|p|span) className="((?:error|bk-err|plugin-error|desk-signin-error)(?: shake)?)"[^>]*>/g)) {
				seen++
				assert.match(m[0], /role="alert"/, `${p}:${i + 1}: ${m[0]}`)
			}
		})
	}
	assert.ok(seen >= 30, `expected the error blocks, found ${seen}`)
})
