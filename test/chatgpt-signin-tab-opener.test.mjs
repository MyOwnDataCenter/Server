// The ChatGPT sign-in tab is opened before its address is known, so it cannot use noopener.
// It has to cut its link back to this page by hand before it is sent to the sign-in page.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const SRC = readFileSync(new URL('../web/src/screens/Settings.tsx', import.meta.url), 'utf8')

test('the sign-in tab loses window.opener before it is pointed at ChatGPT', () => {
	const open = SRC.slice(SRC.indexOf("window.open('about:blank', '_blank')"))
	const cut = open.indexOf('tab.opener = null')
	const go = open.indexOf('tab.location.href = r.url')
	assert.ok(cut > 0, 'tab.opener is never cleared')
	assert.ok(go > cut, 'the tab is navigated before the link is cut')
})
