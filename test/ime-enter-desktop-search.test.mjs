// Enter and the arrow keys that drive an input-method candidate list must not also open an app.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {overviewEnterOpensApp} from '../web/src/desktop/overviewEnter.ts'

test('Enter that confirms a composition in the Activities search opens nothing', () => {
	assert.equal(overviewEnterOpensApp('Enter', true, 3, true), false)
	assert.equal(overviewEnterOpensApp('Enter', true, 3, false), true)
	assert.equal(overviewEnterOpensApp('Enter', true, 3), true)
	assert.equal(overviewEnterOpensApp('Enter', false, 3, false), false)
})

test('the Hyprland launcher leaves keys alone while a composition is open', () => {
	const launcher = readFileSync(new URL('../web/src/desktop/hyprland/Launcher.tsx', import.meta.url), 'utf8')
	const fn = launcher.slice(launcher.indexOf('const onKey ='))
	const composing = fn.indexOf('if (e.isComposing) return')
	assert.ok(composing > 0, 'the launcher key handler ignores composition keys')
	assert.ok(composing < fn.indexOf("e.key === 'Escape'"), 'it checks before Escape, the arrows and Enter')
})

test('the Activities search passes the composition state through', () => {
	const desk = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	assert.match(desk, /overviewEnterOpensApp\(e\.key, showApps, items\.length, e\.nativeEvent\.isComposing\)/)
})
