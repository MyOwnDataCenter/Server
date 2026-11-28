// The desktop Home icon opens the Home page. A saved home-folder shortcut becomes that icon once.
import assert from 'node:assert/strict'
import {test} from 'node:test'

const bag = new Map()
globalThis.localStorage = {
	getItem: (k) => (bag.has(k) ? bag.get(k) : null),
	setItem: (k, v) => bag.set(k, String(v)),
	removeItem: (k) => bag.delete(k),
}
globalThis.window = {setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), addEventListener: () => {}, setInterval: () => 0}
globalThis.document = {addEventListener: () => {}, visibilityState: 'visible'}
globalThis.fetch = async () => ({ok: true, json: async () => ({desktop: null})})

const KEY = 'omarchy-server:desktop-config'
const {loadConfig, patchDeskConfig, resetDeskConfig} = await import('../web/src/desktop/config.ts')

const saved = (icons, extra = {}) => {
	bag.set(KEY, JSON.stringify({icons, ...extra}))
}

test('a new desktop puts Home on the desktop, and Trash stays a folder', () => {
	resetDeskConfig()
	bag.delete(KEY)
	const icons = loadConfig().icons
	assert.deepEqual(icons.map((i) => i.key), ['home', 'folder:/Trash'])
	assert.equal(loadConfig().homePageIcon, true)
})

test('the old Home folder icon becomes the Home page, and keeps its place', () => {
	resetDeskConfig()
	saved([
		{key: 'folder:/Home', col: 0, row: 0},
		{key: 'folder:/Trash', col: 0, row: 1},
	])
	const loaded = loadConfig()
	assert.deepEqual(loaded.icons, [
		{key: 'home', col: 0, row: 0},
		{key: 'folder:/Trash', col: 0, row: 1},
	])
	assert.equal(loaded.homePageIcon, true)
})

test('a Home folder added after that stays a folder', () => {
	resetDeskConfig()
	saved([{key: 'folder:/Home', col: 0, row: 0}])
	const loaded = loadConfig()
	patchDeskConfig({icons: [...loaded.icons, {key: 'folder:/Home', col: 1, row: 0}]})
	const again = loadConfig()
	assert.deepEqual(again.icons.map((i) => i.key), ['home', 'folder:/Home'])
	resetDeskConfig()
})

test('an existing Home page icon is not joined by a second one', () => {
	resetDeskConfig()
	saved([
		{key: 'home', col: 1, row: 2},
		{key: 'folder:/Home', col: 0, row: 0},
		{key: 'folder:/Trash', col: 0, row: 1},
	])
	assert.deepEqual(loadConfig().icons, [
		{key: 'home', col: 1, row: 2},
		{key: 'folder:/Trash', col: 0, row: 1},
	])
	resetDeskConfig()
})

test('a desktop that already made the change keeps a Home folder shortcut', () => {
	resetDeskConfig()
	saved([{key: 'home', col: 0, row: 0}, {key: 'folder:/Home', col: 2, row: 0}], {homePageIcon: true})
	assert.deepEqual(loadConfig().icons.map((i) => i.key), ['home', 'folder:/Home'])
	resetDeskConfig()
})
