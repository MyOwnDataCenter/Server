import assert from 'node:assert/strict'
import {test} from 'node:test'

import {nearBottom} from '../web/src/logFollow.ts'
import {categoryOf, effectiveCategory, joinedFields, nextStartingToast, rankedCategories, searchNeedle, storeDisplayName, storeRiskHints, validCommunityStoreUrl, appVersionLine} from '../web/src/storeBrowse.ts'
import {showUnplugged} from '../web/src/usbPresent.ts'

test('store and apps search trim the query and skip missing fields', () => {
	assert.equal(searchNeedle(' notes'), 'notes')
	assert.equal(searchNeedle('acme '), 'acme')
	assert.equal(searchNeedle('   '), '')
	const apps = [
		{name: 'Immich', tagline: 'Photos', developer: 'Immich team'},
		{name: 'Notes', tagline: 'Write', developer: 'Acme'},
		{name: 'Plexish', tagline: 'Media'},
		{name: 'Bare'},
	]
	const hit = (q) => apps.filter((a) => joinedFields([a.name, a.tagline, a.developer]).toLowerCase().includes(searchNeedle(q))).map((a) => a.name)
	assert.deepEqual(hit(' notes'), ['Notes'])
	assert.deepEqual(hit('acme '), ['Notes'])
	assert.deepEqual(hit('undefined'), [])
	assert.deepEqual(hit(''), ['Immich', 'Notes', 'Plexish', 'Bare'])
})

test('apps without a category land in Other, and a vanished category falls back to all', () => {
	const all = [{category: 'files'}, {category: 'files'}, {}, {category: 'media'}]
	assert.equal(categoryOf(undefined), 'other')
	assert.equal(categoryOf('files'), 'files')
	assert.deepEqual(rankedCategories(all), ['files', 'other', 'media'])
	assert.equal(effectiveCategory('media', ['files', 'other']), 'all')
	assert.equal(effectiveCategory('files', ['files', 'other']), 'files')
	assert.equal(effectiveCategory('::omarchy-plugins', ['files'], ['::omarchy-plugins']), '::omarchy-plugins')
	assert.equal(effectiveCategory('all', ['files']), 'all')
})

test('store source names collapse MODC aliases to one label', () => {
	assert.equal(storeDisplayName('MODC'), 'My Own Data Center')
	assert.equal(storeDisplayName('Modc'), 'My Own Data Center')
	assert.equal(storeDisplayName('My Own Data Center'), 'My Own Data Center')
	assert.equal(storeDisplayName('Community Labs'), 'Community Labs')
	assert.equal(storeDisplayName(''), 'App store')
})

test('store risk hints surface OIDC and elevated access before install', () => {
	assert.deepEqual(storeRiskHints({}), [])
	assert.deepEqual(storeRiskHints({oidc: {supported: true}}), ['Sign-in shared'])
	assert.deepEqual(storeRiskHints({caution: 'Needs GPU elsewhere'}), ['Needs extra access'])
	assert.deepEqual(storeRiskHints({permissions: ['host-network']}), ['Needs extra access'])
	assert.deepEqual(storeRiskHints({oidc: {supported: true}, permissions: ['privileged']}), ['Sign-in shared', 'Needs extra access'])
})

test('a community store link matches the server, including a port and a ~user path', () => {
	assert.equal(validCommunityStoreUrl('https://github.com/someone/app-store'), true)
	assert.equal(validCommunityStoreUrl('https://git.home.lan:3000/me/app-store'), true)
	assert.equal(validCommunityStoreUrl('https://example.com/~bob/store'), true)
	assert.equal(validCommunityStoreUrl('http://example.com/store'), false)
	assert.equal(validCommunityStoreUrl('  https://git.home.lan:3000/me/app-store  '), true)
})

test('a missing version is not the word undefined', () => {
	assert.equal(appVersionLine({version: '1.2', port: 8123}), 'Version 1.2 · port 8123')
	assert.equal(appVersionLine({port: 8123}), '– · port 8123')
	assert.equal(appVersionLine({}), '–')
	assert.equal(appVersionLine({version: undefined}, '2.0'), '– → 2.0')
})

test('a starting toast skips 0s and then shows about every 10 seconds', () => {
	let last = 0
	const shown = []
	let t = 0
	while (true) {
		const sec = Math.round(t / 1000)
		if (sec > 180) break
		const next = nextStartingToast(sec, last)
		last = next.lastShown
		if (next.show) shown.push(sec)
		t += 100 + 2000
	}
	assert.equal(shown.includes(0), false)
	assert.ok(shown[0] >= 10)
	for (let i = 1; i < shown.length; i++) assert.ok(shown[i] - shown[i - 1] >= 10)
	assert.ok(shown.length >= 8)
})

test('live logs stick only when the reader is already near the bottom', () => {
	assert.equal(nearBottom({scrollTop: 0, scrollHeight: 400, clientHeight: 100}), false)
	assert.equal(nearBottom({scrollTop: 300, scrollHeight: 400, clientHeight: 100}), true)
	assert.equal(nearBottom({scrollTop: 260, scrollHeight: 400, clientHeight: 100}), true)
})

test('Unplugged follows the present flag, not a missing by-id path', () => {
	assert.equal(showUnplugged({present: true, path: null}), false)
	assert.equal(showUnplugged({present: false, path: null}), true)
	assert.equal(showUnplugged({present: false, path: '/dev/serial/by-id/usb-x'}), true)
	assert.equal(showUnplugged({path: null}), false)
})
