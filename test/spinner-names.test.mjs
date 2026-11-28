// A busy button must keep an accessible name, and a standalone spinner must be a status, not an unnamed span.
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

test('a spinner named "Loading" is a status, because a plain span cannot carry a name', () => {
	let seen = 0
	for (const p of walk(ROOT)) {
		for (const line of readFileSync(p, 'utf8').split('\n')) {
			if (!line.includes('aria-label="Loading"')) continue
			seen++
			assert.match(line, /<span className="spinner"[^>]* role="status" aria-label="Loading"/, `${p}: ${line.trim()}`)
		}
	}
	assert.ok(seen >= 9, `expected the Loading spinners, found ${seen}`)
})

test('buttons that swap their text for a spinner keep the text for screen readers', () => {
	const read = (p) => readFileSync(ROOT + p, 'utf8')
	const cases = [
		['machines/panels.tsx', /<span className="spinner" \/><span className="sr-only">\{label\}<\/span>/],
		['machines/panels.tsx', /<span className="spinner" \/><span className="sr-only">Regenerate image<\/span>/],
		['Console.tsx', /<span className="spinner" \/><span className="sr-only">Sign in to the desktop<\/span>/],
		['swarm/Swarm.tsx', /<span className="spinner" \/><span className="sr-only">Install<\/span>/],
		['screens/Settings.tsx', /<span className="spinner" \/><span className="sr-only">Finish signing in<\/span>/],
		['screens/Store.tsx', /<span className="sr-only">Open<\/span>/],
		['fleet/GuestLive.tsx', /<span className="sr-only">Install connector<\/span>/],
	]
	for (const [file, re] of cases) assert.match(read(file), re, file)
})
