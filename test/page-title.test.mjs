// Each phone screen names itself in the page title (#502, WCAG 2.4.2).
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {APP_TITLE, pageTitle} from '../web/src/pageTitle.ts'

test('every phone screen gets its own title that ends with the app name', () => {
	const screens = ['home', 'apps', 'files', 'machines', 'more', 'settings', 'store', 'clips']
	const titles = screens.map(pageTitle)
	assert.equal(new Set(titles).size, screens.length)
	for (const t of titles) assert.match(t, / - My Own Data Center$/)
	assert.equal(pageTitle('files'), 'Files - My Own Data Center')
})

test('an unknown screen falls back to the plain app name', () => {
	assert.equal(pageTitle('nope'), APP_TITLE)
})

test('the phone shell sets document.title from the current tab and restores the app name', () => {
	const src = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
	assert.match(src, /document\.title = pageTitle\(tab\)/)
	assert.match(src, /document\.title = APP_TITLE/)
})
