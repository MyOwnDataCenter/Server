// A forgotten web password, set from a terminal on the server (#919).
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {openAccounts} from '../omarchyd/accounts.mjs'

test('resetPassword sets a new password without the old one and signs every session out', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'acct-reset-'))
	try {
		const accounts = await openAccounts(root)
		await accounts.createOwner({name: 'Ada', password: 'forgotten-one'})
		await accounts.loginBrowser({userId: 'owner', password: 'forgotten-one'})
		assert.equal(Object.keys(JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')).browsers).length, 1)

		assert.deepEqual(await accounts.resetPassword({name: 'ada', newPassword: 'a new password'}), {name: 'Ada', twoFactor: false}, 'the name matches without regard to case, like sign-in')
		await assert.rejects(accounts.verifyCredentials({username: 'Ada', password: 'forgotten-one'}), /Incorrect username or password/)
		assert.equal((await accounts.verifyCredentials({username: 'Ada', password: 'a new password'})).userId, 'owner')
		assert.deepEqual(JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')).browsers, {}, 'sessions are signed out')

		// A new process (the CLI) reading the same file sees the new password.
		const again = await openAccounts(root, {create: false})
		assert.equal((await again.verifyCredentials({username: 'Ada', password: 'a new password'})).userId, 'owner')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('with no name the owner is reset; an unknown name or a short password changes nothing', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'acct-reset-refuse-'))
	try {
		const accounts = await openAccounts(root)
		await assert.rejects(accounts.resetPassword({newPassword: 'long enough'}), /no owner account yet/)
		await accounts.createOwner({name: 'Ada', password: 'first password'})
		const before = await readFile(join(root, 'accounts.json'), 'utf8')
		await assert.rejects(accounts.resetPassword({name: 'Grace', newPassword: 'long enough'}), /no account named “Grace”/)
		await assert.rejects(accounts.resetPassword({newPassword: 'short'}), /at least 8 characters/)
		assert.equal(await readFile(join(root, 'accounts.json'), 'utf8'), before)
		assert.equal((await accounts.resetPassword({newPassword: 'second password'})).name, 'Ada')
		assert.equal((await accounts.verifyCredentials({username: 'Ada', password: 'second password'})).userId, 'owner')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})
