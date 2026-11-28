import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {phoneSettingsGearAction} from '../web/src/settingsChrome.ts'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('phone Settings gear resets to main when already in Settings', () => {
	assert.equal(phoneSettingsGearAction('settings'), 'reset-main')
	assert.equal(phoneSettingsGearAction('home'), 'open-settings')
	assert.equal(phoneSettingsGearAction('apps'), 'open-settings')
})

test('phone chrome wires the gear through phoneSettingsGearAction and remounts Settings', () => {
	const app = read('../web/src/App.tsx')
	assert.match(app, /phoneSettingsGearAction\(/)
	assert.match(app, /openSettingsFromChrome/)
	assert.match(app, /settingsEpoch/)
	assert.match(app, /<Settings key=\{settingsEpoch\}/)
})

test('desktop Appearance opens as its own window so Settings can keep focus without closing it', () => {
	const desk = read('../web/src/desktop/Desktop.tsx')
	assert.match(desk, /open\('personalize'/)
	assert.doesNotMatch(desk, /openAppearance[\s\S]*open\('settings',\s*\{page:\s*'appearance'\}\)/)
	assert.match(desk, /onSettings=\{\(\) => open\('settings'\)\}/)
	const settings = read('../web/src/screens/Settings.tsx')
	assert.match(settings, /onOpenAppearance/)
	assert.match(desk, /onOpenAppearance=\{\(\) => desk\.open\('personalize'\)\}/)
})
