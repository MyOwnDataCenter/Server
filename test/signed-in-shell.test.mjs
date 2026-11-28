import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {extraWindowAction} from '../web/src/desktop/extraWindow.ts'
import {queryClearsOnSignOut} from '../web/src/signOutQueries.ts'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')

test('a second terminal focuses the one already open; files still opens another window', () => {
	assert.equal(extraWindowAction('terminal', true), 'focus')
	assert.equal(extraWindowAction('terminal', false), 'open')
	assert.equal(extraWindowAction('files', true), 'open')
	assert.equal(extraWindowAction('files', false), 'open')
})

test('New window and Ctrl+Alt+T use that decision, and files New window still opens', async () => {
	const desktop = await read('../web/src/desktop/Desktop.tsx')
	assert.match(desktop, /extraWindowAction\('terminal', sameShellWindows\(winsRef\.current, term\)\.length > 0\)/)
	assert.match(desktop, /extraWindowAction\('terminal', sameShellWindows\(winsRef\.current, null\)\.length > 0\)/)
	assert.match(desktop, /newWindow: action === 'open'/)
	assert.match(desktop, /const terminalChord = e\.ctrlKey && e\.altKey && e\.key\.toLowerCase\(\) === 't'/)
	assert.match(desktop, /if \(terminalChord\) \{[\s\S]*?api\.openTerminal\(\)/)
	assert.match(desktop, /if \(key === 'terminal'\) return api\.openTerminal\(\)/)
	assert.match(desktop, /extraWindowAction\('files', winsRef\.current\.some\(\(w\) => w\.kind === 'files'\)\)/)
	assert.match(desktop, /open\('files', undefined, \{newWindow: action === 'open'\}\)/)
})

test('sign-out drops every query except bootstrap', () => {
	assert.equal(queryClearsOnSignOut(['bootstrap']), false)
	assert.equal(queryClearsOnSignOut(['bootstrap', 'extra']), false)
	assert.equal(queryClearsOnSignOut(['user.get']), true)
	assert.equal(queryClearsOnSignOut(['app-frame', 'a,b']), true)
	assert.equal(queryClearsOnSignOut([]), true)
})

test('desktop and System sign-out keep bootstrap and surface a failed logout', async () => {
	const desktop = await read('../web/src/desktop/Desktop.tsx')
	const more = await read('../web/src/screens/More.tsx')
	for (const src of [desktop, more]) {
		assert.match(src, /qc\.removeQueries\(\{predicate: \(q\) => queryClearsOnSignOut\(q\.queryKey\)\}\)/)
		assert.match(src, /toast\(\(e as Error\)\.message, true\)/)
		assert.doesNotMatch(src, /qc\.clear\(\)/)
	}
	assert.doesNotMatch(desktop, /logout\(\)\.catch/)
	assert.match(more, /const finishSignOut = async \(\) => \{[\s\S]*?await logout\(\)[\s\S]*?return[\s\S]*?queryClearsOnSignOut/)
	assert.match(more, /const finishSignOut = async \(\) => \{[\s\S]*?await logout\(\)/)
	assert.match(more, /onClick=\{signOut\}/)
	assert.match(more, /The reset already ended the session/)
	assert.match(more, /await logout\(\)\.catch\(\(\) => \{\}\)/)
	assert.doesNotMatch(more, /onDone=\{finishSignOut\}/)
})

test('the apps window says the app session lasts 30 days', async () => {
	const desktop = await read('../web/src/desktop/Desktop.tsx')
	assert.match(desktop, /apps \(30 days\)/)
	assert.match(desktop, /for the next 30 days/)
	assert.doesNotMatch(desktop, /apps \(7 days\)/)
	assert.doesNotMatch(desktop, /next 7 days/)
})
