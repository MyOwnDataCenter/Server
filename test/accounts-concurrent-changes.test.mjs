// Two account changes made at the same moment both stick. Each change used to be built from the
// accounts as they were when it started, so the one that finished last wrote over the other.
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'

test('a name change and a language change made together are both kept', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'acct-concurrent-'))
	try {
		const accounts = await openAccounts(dir)
		await accounts.createOwner({name: 'Ada', password: 'longenough'})
		await Promise.all([accounts.updateUser('owner', {name: 'Bea'}), accounts.updateUser('owner', {language: 'fr'}), accounts.updateUser('owner', {wallpaper: 'forest'})])
		const user = accounts.getUser('owner')
		assert.equal(user.name, 'Bea')
		assert.equal(user.language, 'fr')
		assert.equal(user.wallpaper.id, 'forest')
		const saved = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).users[0]
		assert.equal(saved.name, 'Bea')
		assert.equal(saved.language, 'fr')
		assert.equal(saved.wallpaper.id, 'forest')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
