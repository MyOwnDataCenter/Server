// The current browser is "This device", not "This phone": the app also runs on laptops and desktops (#170).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const read = (p) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8')

test('Signed-in devices and sign-out wording does not call the current device a phone', () => {
	const settings = read('screens/Settings.tsx')
	assert.doesNotMatch(settings, /This phone|this phone/)
	assert.match(settings, /'This device'/)
	assert.match(settings, /except this device, is signed out/)
	assert.doesNotMatch(read('screens/More.tsx'), /This phone is signed out/)
	assert.match(read('screens/More.tsx'), /This device is signed out/)
})
