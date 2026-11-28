import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cleanBackground, cleanTheme, cleanUploadName, createQuickTransfer} from '../server/quick-transfer.mjs'

test('quick transfer links end after 10 minutes, when stopped, or when their maker signs out', () => {
	let t = 1_000_000
	const q = createQuickTransfer({now: () => t})
	const {token} = q.create({kind: 'download', path: '/Home/a.txt', name: 'a.txt', sid: 'S1'})
	assert.match(token, /^[A-Za-z0-9_-]{32}$/)
	assert.ok(q.get(token))
	assert.equal(q.get(token, {sessionAlive: () => false}), null, 'signed out: gone')
	const b = q.create({kind: 'download', path: '/Home/a.txt', sid: 'S1'}).token
	t += 10 * 60_000 - 1
	assert.ok(q.get(b))
	t += 1
	assert.equal(q.get(b), null, 'ten minutes: gone')
	const c = q.create({kind: 'upload', path: '/Home', sid: 'S1'}).token
	assert.equal(q.revoke(c, 'S2'), false, 'only its maker stops it')
	assert.equal(q.revoke(c, 'S1'), true)
	assert.equal(q.get(c), null)
	assert.throws(() => q.create({kind: 'delete', path: '/Home', sid: 'S1'}))
})

test('portal theme, background and upload names are cleaned', () => {
	assert.deepEqual(cleanTheme({'--accent': 'hsl(24 90% 50%)', '--fg': '#fff', '--bg': 'url(x)', '--evil': '#000'}), {'--accent': 'hsl(24 90% 50%)', '--fg': '#fff'})
	assert.deepEqual(cleanBackground('/api/wallpaper/3'), {kind: 'wallpaper', id: '3'})
	assert.deepEqual(cleanBackground('http://10.0.0.2:7780/api/omarchy/background/current'), {kind: 'omarchy', id: 'current'})
	assert.deepEqual(cleanBackground('/api/background?v=4'), {kind: 'photo'})
	assert.equal(cleanBackground('/api/files/download?path=/Home/secret.jpg'), null)
	assert.equal(cleanBackground('javascript:alert(1)'), null)
	assert.equal(cleanUploadName('photo.jpg'), 'photo.jpg')
	assert.equal(cleanUploadName('a/b\\c.txt'), 'a_b_c.txt')
	for (const bad of ['', '.', '..', '.env', '../x', 'x'.repeat(300), null]) assert.equal(cleanUploadName(bad), null, String(bad))
})
