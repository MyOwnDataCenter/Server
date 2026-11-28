// Home joins an old saved dock once. Taking it off the dock afterwards must stick.
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
const previous = ['files', 'apps', 'store', 'terminal', 'machines', 'system', 'settings']

test('a dock saved before Home existed gains Home', () => {
	bag.set(KEY, JSON.stringify({dock: {items: previous}}))
	assert.deepEqual(loadConfig().dock.items, ['home', ...previous])
})

test('taking Home off the dock stays off', () => {
	bag.set(KEY, JSON.stringify({dock: {items: previous}}))
	const loaded = loadConfig()
	patchDeskConfig({dock: {...loaded.dock, items: loaded.dock.items.filter((k) => k !== 'home')}})
	assert.deepEqual(JSON.parse(bag.get(KEY)).dock.items, previous)
	bag.set(KEY, bag.get(KEY))
	assert.deepEqual(loadConfig().dock.items, previous)
	resetDeskConfig()
})
