// Signing out must drop the desktop that lived in this tab, including a save already on the wire.
import assert from 'node:assert/strict'
import {test} from 'node:test'

const bag = new Map()
globalThis.localStorage = {
	getItem: (k) => (bag.has(k) ? bag.get(k) : null),
	setItem: (k, v) => bag.set(k, String(v)),
	removeItem: (k) => bag.delete(k),
}
globalThis.window = {
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
	addEventListener: () => {},
	setInterval: () => 0,
}
globalThis.document = {
	addEventListener: () => {},
	visibilityState: 'visible',
}

const posts = []
let fetchImpl = async () => ({ok: true, json: async () => ({desktop: null})})
globalThis.fetch = (url, opts) => fetchImpl(url, opts)

const KEY = 'omarchy-server:desktop-config'
const REV = `${KEY}:rev`
const DIRTY = `${KEY}:dirty`

const {patchDeskConfig, resetDeskConfig, syncDeskConfig} = await import('../web/src/desktop/config.ts')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the next account does not inherit this tab’s desktop', async () => {
	assert.equal(typeof resetDeskConfig, 'function', 'resetDeskConfig is not exported')

	patchDeskConfig({wallpaper: 'color:#335577', dock: {position: 'bottom'}})
	assert.match(localStorage.getItem(KEY), /"bottom"/)
	localStorage.setItem(REV, '3')
	localStorage.setItem(DIRTY, '1')
	resetDeskConfig()
	assert.equal(localStorage.getItem(KEY), null)
	assert.equal(localStorage.getItem(REV), null)
	assert.equal(localStorage.getItem(DIRTY), null)

	posts.length = 0
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return {ok: true, json: async () => ({desktop: {rev: 1}})}
		}
		return {ok: true, json: async () => ({desktop: null})}
	}
	syncDeskConfig()
	await wait(800)
	const posted = posts.join('\n')
	assert.equal(posted.includes('"bottom"'), false, 'push still has the previous dock')
	assert.equal(posted.includes('color:#335577'), false, 'push still has the previous wallpaper')

	patchDeskConfig({wallpaper: 'color:#335577', dock: {position: 'bottom'}})
	localStorage.setItem(REV, '3')
	resetDeskConfig()
	posts.length = 0
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return {ok: true, json: async () => ({desktop: {rev: 4}})}
		}
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#225588', dock: {position: 'top'}}, rev: 3}})}
	}
	syncDeskConfig()
	await wait(50)
	const saved = JSON.parse(localStorage.getItem(KEY))
	assert.equal(saved.wallpaper, 'color:#225588')
	assert.equal(saved.dock.position, 'top')
	assert.equal(localStorage.getItem(REV), '3')
	const again = posts.join('\n')
	assert.equal(again.includes('color:#335577'), false, 'posted the previous wallpaper')
	assert.equal(again.includes('"bottom"'), false, 'posted the previous dock')

	let release
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts.push(String(opts.body))
			return new Promise((resolve) => {
				release = () => resolve({ok: true, json: async () => ({desktop: {rev: 9}})})
			})
		}
		return {ok: true, json: async () => ({desktop: null})}
	}
	patchDeskConfig({wallpaper: 'color:#aa8855', dock: {position: 'right'}})
	await wait(700)
	assert.equal(typeof release, 'function', 'the push never left')
	resetDeskConfig()
	release()
	await wait(0)
	assert.equal(localStorage.getItem(REV), null, 'a late save wrote the previous rev')

	resetDeskConfig()
	let releaseGet
	fetchImpl = () =>
		new Promise((resolve) => {
			releaseGet = () => resolve({ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#558833', dock: {position: 'bottom'}}, rev: 8}})})
		})
	syncDeskConfig()
	await wait(30)
	assert.equal(typeof releaseGet, 'function', 'the load never started')
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') return {ok: true, json: async () => ({desktop: {rev: 1}})}
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#884466', dock: {position: 'right'}}, rev: 4}})}
	}
	resetDeskConfig()
	// The next account mounts while that load is still in flight.
	syncDeskConfig()
	releaseGet()
	await wait(50)
	const followed = JSON.parse(localStorage.getItem(KEY))
	assert.equal(followed.wallpaper, 'color:#884466', 'the load that was in flight swallowed the next account')
	assert.equal(followed.dock.position, 'right')
})

test('a signed-out pull does not throttle the next account desktop', async () => {
	resetDeskConfig()
	let releaseGet
	let gets = 0
	fetchImpl = () => {
		gets++
		if (gets === 1) {
			return new Promise((resolve) => {
				releaseGet = () => resolve({ok: false, status: 401, json: async () => ({})})
			})
		}
		// The follow-up that sign-out used to start is still signed out.
		return Promise.resolve({ok: false, status: 401, json: async () => ({})})
	}
	syncDeskConfig()
	await wait(30)
	assert.equal(typeof releaseGet, 'function', 'the load never started')
	resetDeskConfig()
	releaseGet()
	await wait(30)
	let nextGets = 0
	fetchImpl = async () => {
		nextGets++
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#cc3377', dock: {position: 'top'}}, rev: 6}})}
	}
	syncDeskConfig()
	await wait(50)
	assert.equal(nextGets, 1, 'signed-out pull left the next syncDeskConfig behind the 3 second throttle')
	const raw = localStorage.getItem(KEY)
	assert.equal(raw && JSON.parse(raw).wallpaper, 'color:#cc3377', 'the next account desktop was not loaded')
})

test('a second tab picks up changes from the first on focus instead of overwriting them', async (t) => {
	const origAddEventListener = window.addEventListener
	const origNow = Date.now
	const origFetch = fetchImpl
	let tabA
	let tabB
	t.after(() => {
		tabA?.resetDeskConfig()
		tabB?.resetDeskConfig()
		window.addEventListener = origAddEventListener
		Date.now = origNow
		fetchImpl = origFetch
		bag.clear()
	})
	bag.clear()
	let now = 10_000
	Date.now = () => now
	let serverDesktop = {
		config: {wallpaper: 'color:#335577', style: 'glass', accent: 'wallpaper', shell: 'gnome', dock: {position: 'left', iconSize: 46, hover: 'lift', magnify: 1.6, bounce: true, floating: false, autohide: false, showRunning: true, items: ['files']}, icons: [], showIcons: true, appsOpenIn: 'auto'},
		rev: 2,
	}
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			const body = JSON.parse(String(opts.body))
			serverDesktop = {config: body.config, rev: serverDesktop.rev + 1}
			return {ok: true, json: async () => ({desktop: {rev: serverDesktop.rev}})}
		}
		return {ok: true, json: async () => ({desktop: serverDesktop})}
	}
	const tabAEvents = new Map()
	const tabBEvents = new Map()
	window.addEventListener = (type, fn) => tabBEvents.set(type, fn)
	tabB = await import('../web/src/desktop/config.ts?tab=b1')
	tabB.syncDeskConfig()
	await wait(30)
	window.addEventListener = (type, fn) => tabAEvents.set(type, fn)
	tabA = await import('../web/src/desktop/config.ts?tab=a1')
	tabA.syncDeskConfig()
	await wait(30)

	tabA.patchDeskConfig({dock: {...tabA.DEFAULT_CONFIG.dock, position: 'bottom'}})
	await wait(700)
	assert.equal(serverDesktop.config.dock.position, 'bottom')
	assert.equal(serverDesktop.rev, 3)

	// Four seconds later, tab B regains focus (no storage event fired) and pulls.
	now += 4000
	tabBEvents.get('focus')?.()
	await wait(30)

	// Tab B toggles icons off: it must build on tab A's bottom dock, not its stale left dock.
	tabB.patchDeskConfig({showIcons: false})
	await wait(700)
	assert.equal(serverDesktop.config.dock.position, 'bottom', 'tab A dock change was overwritten by stale tab B')
	assert.equal(serverDesktop.config.showIcons, false)
	assert.equal(serverDesktop.rev, 4)
})

test('a second tab picks up changes immediately via storage events', async (t) => {
	const origAddEventListener = window.addEventListener
	const origNow = Date.now
	const origFetch = fetchImpl
	let tabA
	let tabB
	t.after(() => {
		tabA?.resetDeskConfig()
		tabB?.resetDeskConfig()
		window.addEventListener = origAddEventListener
		Date.now = origNow
		fetchImpl = origFetch
		bag.clear()
	})
	bag.clear()
	Date.now = () => 20_000
	let serverDesktop = {
		config: {wallpaper: 'color:#335577', style: 'glass', accent: 'wallpaper', shell: 'gnome', dock: {position: 'left', iconSize: 46, hover: 'lift', magnify: 1.6, bounce: true, floating: false, autohide: false, showRunning: true, items: ['files']}, icons: [], showIcons: true, appsOpenIn: 'auto'},
		rev: 2,
	}
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			const body = JSON.parse(String(opts.body))
			serverDesktop = {config: body.config, rev: serverDesktop.rev + 1}
			return {ok: true, json: async () => ({desktop: {rev: serverDesktop.rev}})}
		}
		return {ok: true, json: async () => ({desktop: serverDesktop})}
	}
	const tabAEvents = new Map()
	const tabBEvents = new Map()
	window.addEventListener = (type, fn) => tabBEvents.set(type, fn)
	tabB = await import('../web/src/desktop/config.ts?tab=b2')
	tabB.syncDeskConfig()
	await wait(30)
	window.addEventListener = (type, fn) => tabAEvents.set(type, fn)
	tabA = await import('../web/src/desktop/config.ts?tab=a2')
	tabA.syncDeskConfig()
	await wait(30)

	tabA.patchDeskConfig({dock: {...tabA.DEFAULT_CONFIG.dock, position: 'right'}})
	tabBEvents.get('storage')?.({key: KEY, newValue: localStorage.getItem(KEY), storageArea: localStorage})
	tabB.patchDeskConfig({showIcons: false})
	await wait(700)
	assert.equal(serverDesktop.config.dock.position, 'right', 'tab B missed tab A storage change')
	assert.equal(serverDesktop.config.showIcons, false)
})

test('cross-tab sign-out cancels pending edits, invalidates in-flight pulls, and clears pull throttle', async (t) => {
	const origAddEventListener = window.addEventListener
	const origNow = Date.now
	const origFetch = fetchImpl
	let tabA
	let tabB
	t.after(() => {
		tabA?.resetDeskConfig()
		tabB?.resetDeskConfig()
		window.addEventListener = origAddEventListener
		Date.now = origNow
		fetchImpl = origFetch
		bag.clear()
	})
	bag.clear()
	Date.now = () => 30_000
	let posts = 0
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts++
			return {ok: true, json: async () => ({desktop: {rev: 9}})}
		}
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#335577'}, rev: 2}})}
	}
	const tabAEvents = new Map()
	const tabBEvents = new Map()
	window.addEventListener = (type, fn) => tabBEvents.set(type, fn)
	tabB = await import('../web/src/desktop/config.ts?tab=b3')
	tabB.syncDeskConfig()
	await wait(30)
	window.addEventListener = (type, fn) => tabAEvents.set(type, fn)
	tabA = await import('../web/src/desktop/config.ts?tab=a3')
	tabA.syncDeskConfig()
	await wait(30)

	// Tab B queues an unsaved edit; Tab A signs out before the 600ms push fires.
	tabB.patchDeskConfig({wallpaper: 'peak'})
	tabA.resetDeskConfig()
	tabBEvents.get('storage')?.({key: KEY, newValue: null, storageArea: localStorage})
	await wait(700)
	assert.equal(posts, 0, 'cross-tab sign-out failed to cancel pending push timer')
	assert.equal(localStorage.getItem(KEY), null)

	// Next, Tab B starts an in-flight pull for Account 1, then Tab A clears storage again.
	let releaseGet
	fetchImpl = async (_url, opts) => {
		if (opts?.method === 'POST') {
			posts++
			return {ok: true, json: async () => ({desktop: {rev: 10}})}
		}
		await new Promise((r) => (releaseGet = r))
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#335577'}, rev: 3}})}
	}
	tabB.syncDeskConfig()
	await wait(15)
	tabA.resetDeskConfig()
	tabBEvents.get('storage')?.({key: null, newValue: null, storageArea: localStorage})
	releaseGet()
	await wait(30)
	assert.equal(localStorage.getItem(KEY), null, 'in-flight pull wrote stale account config after cross-tab sign-out')

	// Restricted storage contexts that throw on storageArea access must not throw in onStorage.
	assert.doesNotThrow(() => {
		tabBEvents.get('storage')?.({key: KEY, newValue: null, get storageArea() { throw new Error('SecurityError') }})
	})

	// Immediately syncing Account 2 in Tab B must not be throttled by Account 1's lastPull.
	let account2Gets = 0
	fetchImpl = async () => {
		account2Gets++
		return {ok: true, json: async () => ({desktop: {config: {wallpaper: 'color:#cc3377'}, rev: 5}})}
	}
	tabB.syncDeskConfig()
	await wait(30)
	assert.equal(account2Gets, 1, 'cross-tab sign-out left Tab B behind the 3 second pull throttle')
	const raw = localStorage.getItem(KEY)
	assert.equal(raw && JSON.parse(raw).wallpaper, 'color:#cc3377')
})

test('a saved built-in photo that was removed falls back to the Omarchy background', async () => {
	localStorage.setItem(KEY, JSON.stringify({v: 1, wallpaper: 'valley', preset: 'yosemite'}))
	const {loadConfig} = await import('../web/src/desktop/config.ts')
	const c = loadConfig()
	assert.equal(c.wallpaper, 'omarchy')
})
