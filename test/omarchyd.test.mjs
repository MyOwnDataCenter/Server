// omarchyd: accounts, file safety and the freedesktop trash, against a throwaway home folder.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {openAccounts, secretFromUri, totpCode} from '../omarchyd/accounts.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

describe('omarchyd', () => {
	let root, home, data, d
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-'))
		home = join(root, 'home')
		data = join(root, 'data')
		await mkdir(join(home, 'Documents'), {recursive: true})
		await writeFile(join(home, 'Documents/Notes.txt'), 'hello omarchy')
		await writeFile(join(home, '.secret'), 'hidden')
		await mkdir(join(root, 'outside'))
		await writeFile(join(root, 'outside/passwd'), 'nope')
		await symlink(join(root, 'outside'), join(home, 'escape'))
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({port: 0, dataDir: data, home})
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (kind, path, input, headers = {}) => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		return {status: r.status, body: await r.json(), headers: r.headers}
	}
	let native, browser
	test('system.version: version, when this process started, and the git revision', async () => {
		const r = await call('query', 'system.version')
		assert.equal(r.status, 200)
		const v = r.body.result.data
		assert.equal(v.version, '0.9.108')
		assert.equal(typeof v.startedAt, 'number')
		assert.ok(v.startedAt <= Date.now() && Date.now() - v.startedAt < 60_000)
		let expectedRevision
		try {
			const sha = execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'rev-parse', '--short', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim()
			if (/^[0-9a-f]{7,40}$/i.test(sha)) expectedRevision = sha
		} catch {}
		if (expectedRevision) {
			assert.match(String(v.revision ?? ''), /^[0-9a-f]{7,40}$/)
			assert.equal(v.revision, expectedRevision)
		} else {
			assert.equal(v.revision, undefined)
		}
	})
	test('accounts: wrong password refused, right one signs in', async () => {
		const bad = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'nope', client: {id: 't'}})
		assert.equal(bad.status, 401)
		const ok = await call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}})
		assert.equal(ok.status, 200)
		native = {authorization: `Bearer ${ok.body.result.data.accessToken}`}
		const login = await call('mutation', 'user.login', {userId: 'owner', password: 'correct horse'})
		const cookie = login.headers.getSetCookie()[0].split(';')[0]
		browser = {authorization: `Bearer ${login.body.result.data}`, cookie}
		assert.equal((await call('query', 'user.get', undefined, native)).body.result.data.name, 'Chris')
		assert.equal((await call('query', 'files.list', {path: '/Home'})).status, 401)
		// A browser bearer without its cookie is refused.
		assert.equal((await call('query', 'user.get', undefined, {authorization: browser.authorization})).status, 401)
	})
	test('two-factor: turning it on needs a right code, then signing in needs one; off again with a code', async () => {
		assert.equal((await call('query', 'user.is2faEnabled', undefined, native)).body.result.data, false)
		const uri = (await call('query', 'user.generateTotpUri', undefined, native)).body.result.data
		assert.match(uri, /^otpauth:\/\/totp\/MODC%3AChris\?secret=[A-Z2-7]{32}&issuer=MODC/)
		const secret = secretFromUri(uri)
		assert.equal((await call('mutation', 'user.enable2fa', {totpUri: uri, totpToken: '000000'}, native)).status, 400)
		assert.equal((await call('mutation', 'user.enable2fa', {totpUri: uri, totpToken: totpCode(secret)}, native)).status, 200)
		const login = (input) => call('mutation', 'user.loginNative', {userId: 'owner', password: 'correct horse', client: {id: 't'}, ...input})
		const noCode = await login({})
		assert.equal(noCode.status, 401)
		assert.match(noCode.body.error.message, /2FA/, 'the sign-in page asks for the code')
		assert.equal((await login({totpToken: '123456'})).status, 401)
		assert.equal((await login({totpToken: totpCode(secret)})).status, 200)
		assert.equal((await call('mutation', 'user.disable2fa', {totpToken: totpCode(secret)}, native)).status, 200)
		assert.equal((await login({})).status, 200)
	})
	test('settings: owner-only power actions; logs answer', async () => {
		const logs = await call('query', 'system.logs', {type: 'server', lines: 50}, native)
		assert.equal(logs.status, 200)
		assert.equal(typeof logs.body.result.data, 'string')
	})
	test('files: lists Home without dotfiles; stats are real numbers', async () => {
		const list = (await call('query', 'files.list', {path: '/Home'}, native)).body.result.data
		assert.deepEqual(list.files.map((f) => f.name).sort(), ['Documents', 'escape'])
		const mem = (await call('query', 'system.memoryUsage', undefined, native)).body.result.data
		assert.ok(mem.size > 0 && mem.totalUsed > 0)
		const gpus = (await call('query', 'system.gpuUsage', undefined, native)).body.result.data
		assert.ok(Array.isArray(gpus.gpus))
		const stats = (await call('query', 'system.stats', undefined, native)).body.result.data
		assert.ok(stats.cpu.threads > 0)
		assert.equal(typeof stats.cpu.totalUsed, 'number')
		assert.deepEqual(stats.memory, mem)
		assert.deepEqual(stats.gpu, gpus)
		assert.equal(typeof stats.uptime, 'number')
		const battery = (await call('query', 'system.batteryUsage', undefined, native)).body.result.data
		assert.ok(Array.isArray(battery.batteries))
	})
	test('files: nothing outside Home, not via .. nor via a symlink', async () => {
		assert.equal((await call('query', 'files.list', {path: '/Home/../..'}, native)).status, 400)
		assert.equal((await call('query', 'files.list', {path: '/Home/escape'}, native)).status, 403)
		assert.equal((await call('mutation', 'files.copy', {path: '/Home/escape/passwd', toDirectory: '/Home'}, native)).status, 403)
		assert.equal((await call('query', 'files.list', {path: '/etc'}, native)).status, 404)
	})
	test('files: view needs a url token and the browser cookie', async () => {
		const t = (await call('query', 'user.getHttpApiToken', undefined, browser)).body.result.data
		assert.equal((await call('query', 'user.getHttpApiToken', undefined, native)).status, 403)
		const path = encodeURIComponent('/Home/Documents/Notes.txt')
		assert.equal((await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`)).status, 401)
		const r = await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`, {headers: {cookie: browser.cookie}})
		assert.equal(await r.text(), 'hello omarchy')
		const part = await fetch(`${d.url}/api/files/view?path=${path}&token=${t}`, {headers: {cookie: browser.cookie, range: 'bytes=6-'}})
		assert.equal(part.status, 206)
		assert.equal(await part.text(), 'omarchy')
	})
	test('files: upload keeps both by default and replaces on request', async () => {
		const up = (collision) =>
			fetch(`${d.url}/api/files/upload?path=${encodeURIComponent('/Home/Documents/Notes.txt')}&collision=${collision}`, {method: 'POST', headers: browser, body: 'v2'})
		assert.equal((await (await up('keep-both')).json()).path, '/Home/Documents/Notes (2).txt')
		await up('replace')
		assert.equal(await readFile(join(home, 'Documents/Notes.txt'), 'utf8'), 'v2')
		const leftovers = (await readdir(join(home, 'Documents'))).filter((n) => n.endsWith('.uploading'))
		assert.deepEqual(leftovers, [])
	})
	test('files: trash and restore use the freedesktop trash', async () => {
		const trashed = (await call('mutation', 'files.trash', {path: '/Home/Documents/Notes (2).txt'}, native)).body.result.data
		assert.equal(trashed, '/Trash/Notes (2).txt')
		const info = await readFile(join(home, '.local/share/Trash/info/Notes (2).txt.trashinfo'), 'utf8')
		assert.match(info, /^Path=.*Documents\/Notes%20\(2\)\.txt$/m)
		assert.equal((await call('mutation', 'files.delete', {path: '/Home/Documents/Notes.txt'}, native)).status, 400)
		const back = (await call('mutation', 'files.restore', {path: '/Trash/Notes (2).txt'}, native)).body.result.data
		assert.equal(back, '/Home/Documents/Notes (2).txt')
	})
})

describe('network shares are owner-only', () => {
	let root, d, owner, member
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-shares-'))
		const home = join(root, 'home')
		const data = join(root, 'data')
		await mkdir(join(home, 'Documents'), {recursive: true})
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))
		d = await startOmarchyd({port: 0, dataDir: data, home, updaterOptions: {autoCheck: false, installerCheck: true}})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			const body = await r.json()
			return {authorization: `Bearer ${body.result.data.accessToken}`}
		}
		owner = await login('owner')
		member = await login('member')
	})
	after(async () => {
		await d.close()
		await rm(root, {recursive: true, force: true})
	})
	const call = async (kind, path, input, headers) => {
		const url = new URL(`${d.url}/trpc/${path}`)
		const init = {method: kind === 'mutation' ? 'POST' : 'GET', headers: {...headers}}
		if (kind === 'mutation') {
			init.headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input ?? null)
		} else if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
		const r = await fetch(url, init)
		return {status: r.status, body: await r.json()}
	}
	test('only the owner is asked to run the installer (it needs sudo on the server)', async () => {
		const o = (await call('query', 'system.installerStatus', undefined, owner)).body.result.data
		assert.equal(o.needed, true, 'this data folder has no installer stamp yet')
		assert.match(o.command, /\| OMARCHY_SERVER_FROM_APP=1 OMARCHY_SERVER_PORT=7780 bash$/)
		assert.deepEqual((await call('query', 'system.installerStatus', undefined, member)).body.result.data, {needed: false, reasons: []})
	})

	test('a member is refused every files.*Share* RPC; the owner may still list shares', async () => {
		const rpcs = [
			['query', 'files.shares'],
			['query', 'files.sharePassword'],
			['query', 'files.shareOptions'],
			['mutation', 'files.addShare', {path: '/Home/Documents'}],
			['mutation', 'files.updateShare', {path: '/Home/Documents'}],
			['mutation', 'files.removeShare', {path: '/Home/Documents'}],
			['mutation', 'files.setSharePassword', {password: 'abcdefgh'}],
		]
		for (const [kind, path, input] of rpcs) {
			const r = await call(kind, path, input, member)
			assert.equal(r.status, 403, path)
			assert.match(r.body.error.message, /owner/i, path)
		}
		assert.equal((await call('query', 'files.shares', undefined, owner)).status, 200)
		assert.equal((await call('query', 'files.list', {path: '/Home'}, member)).status, 200, 'members can still use Files')
	})
	test('backups and moving from Unraid are owner-only: a member is refused every backups.* and unraid.* RPC', async () => {
		const rpcs = [
			['query', 'backups.status'],
			['query', 'backups.discover'],
			['query', 'backups.snapshots'],
			['mutation', 'backups.shares', {host: 'nas.local', username: 'u', password: 'p'}],
			['mutation', 'backups.configure', {schedule: {frequency: 'off', hour: 3, weekday: 0}}],
			['mutation', 'backups.recoveryKey'],
			['mutation', 'backups.keySaved'],
			['mutation', 'backups.runNow'],
			['mutation', 'backups.restoreApp', {snapshotId: 'abcdef12', appId: 'notes'}],
			['mutation', 'backups.connectExisting', {}],
			['query', 'unraid.status'],
			['mutation', 'unraid.connect', {host: 'tower.local', password: 'x'}],
			['mutation', 'unraid.scan'],
			['mutation', 'unraid.start', {}],
			['mutation', 'unraid.cancel'],
			['mutation', 'unraid.disconnect'],
			['mutation', 'unraid.forgetHost', {host: 'tower.local'}],
		]
		for (const [kind, path, input] of rpcs) {
			const r = await call(kind, path, input, member)
			assert.equal(r.status, 403, path)
			assert.match(r.body.error.message, /owner/i, path)
		}
		const st = await call('query', 'backups.status', undefined, owner)
		assert.equal(st.status, 200)
		assert.equal(st.body.result.data.configured, false)
	})
	test('a member cannot replace this server or change storage pools', async () => {
		const rpcs = [
			['mutation', 'system.update'],
			['mutation', 'system.setReleaseChannel', {channel: 'stable'}],
			['mutation', 'storage.createPool', {name: 'pool', devices: ['not-a-disk']}],
			['mutation', 'storage.addToPool', {name: 'pool', device: 'not-a-disk'}],
			['mutation', 'storage.importPool', {name: 'pool', uuid: 'not-a-uuid'}],
			['mutation', 'storage.forgetPool', {name: 'pool'}],
			['mutation', 'storage.scrub', {name: 'pool'}],
			['mutation', 'storage.setSleep', {device: 'not-a-disk', minutes: 10}],
		]
		for (const [kind, path, input] of rpcs) {
			const r = await call(kind, path, input, member)
			assert.equal(r.status, 403, path)
			assert.match(r.body.error.message, /owner/i, path)
		}
		assert.equal((await call('query', 'storage.pools', undefined, member)).status, 200, 'members can still see pools')
	})
	test('a member cannot add or remove an app store', async () => {
		const add = await call('mutation', 'appStore.addRepository', {url: 'http://example.com/store'}, member)
		assert.equal(add.status, 403)
		assert.match(add.body.error.message, /owner/i)
		const remove = await call('mutation', 'appStore.removeRepository', {url: 'https://github.com/example/not-added'}, member)
		assert.equal(remove.status, 403)
		assert.match(remove.body.error.message, /owner/i)
		const ownerAdd = await call('mutation', 'appStore.addRepository', {url: 'http://example.com/store'}, owner)
		assert.equal(ownerAdd.status, 400)
		assert.match(ownerAdd.body.error.message, /https/i)
		assert.equal((await call('query', 'appStore.repositories', undefined, member)).status, 200)
	})
})
