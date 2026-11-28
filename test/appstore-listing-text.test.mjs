// A listing's text fields reach the App Store screens as they are. A tagline, category, website or
// similar that is a list or a mapping in the listing's file is not text, and the screens cannot draw
// it, so the text fields are always text (or absent).
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createApps} from '../omarchyd/apps.mjs'
import {gitArgv} from './git-nosign.mjs'

const git = (cwd, ...args) => execFileSync('git', gitArgv(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args]), {cwd, stdio: 'pipe'}).toString()

test('text fields of a listing are text, or left out', async (t) => {
	const root = await realpath(await mkdtemp(join(os.tmpdir(), 'listing-text-')))
	t.after(() => rm(root, {recursive: true, force: true}))
	const store = join(root, 'store')
	await mkdir(join(store, 'odd'), {recursive: true})
	await mkdir(join(store, 'plain'), {recursive: true})
	await writeFile(join(store, 'omarchy-app-store.yml'), 'id: odd\nname: Odd\n')
	await writeFile(join(store, 'odd/omarchy-app.yml'), [
		'manifestVersion: 1', 'id: odd', 'name: Odd', 'port: 31001',
		'tagline: {a: 1}', 'category: [media, tools]', 'description: [one, two]', 'developer: {name: Someone}',
		'website: 5', 'releaseNotes: {x: y}', 'defaultUsername: [admin]', 'defaultPassword: {}', '',
	].join('\n'))
	await writeFile(join(store, 'plain/omarchy-app.yml'), 'manifestVersion: 1\nid: plain\nname: Plain\nport: 31002\ntagline: Says hello\ncategory: media\ndeveloper: Someone\nwebsite: https://example.com\ndefaultUsername: admin\ndefaultPassword: secret\n')
	for (const dir of ['odd', 'plain']) await writeFile(join(store, dir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
	git(store, 'init', '-q', '-b', 'main')
	git(store, 'add', '-A')
	git(store, 'commit', '-qm', 'init')
	const run = async (cmd, args, opts = {}) => (cmd === 'git' ? execFileSync('git', args, {cwd: opts.cwd, stdio: 'pipe'}).toString() : '')
	const apps = createApps({dataDir: join(root, 'data'), home: join(root, 'home'), allowFileStores: true, defaultStores: [{url: `file://${store}`}], systemApps: null, run})
	t.after(() => apps.close())

	const reg = await apps.procedures['appStore.registry'].run()
	const isText = (v) => v === undefined || typeof v === 'string'
	const odd = await apps.procedures['appStore.app'].run({appId: 'odd'})
	for (const view of [reg[0].apps.find((a) => a.id === 'odd'), odd]) {
		for (const field of ['tagline', 'category', 'description', 'developer', 'website', 'releaseNotes', 'defaultUsername', 'defaultPassword']) assert.ok(isText(view[field]), `${field} is ${JSON.stringify(view[field])}`)
	}
	assert.equal(odd.website, '5', 'a number is kept as the text it was written as')
	const plain = await apps.procedures['appStore.app'].run({appId: 'plain'})
	assert.deepEqual([plain.tagline, plain.category, plain.developer, plain.website, plain.defaultUsername, plain.defaultPassword], ['Says hello', 'media', 'Someone', 'https://example.com', 'admin', 'secret'])
})
