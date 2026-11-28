// The server's OS, Omarchy version and waiting updates, for the assistant (#442). Checks only.
import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createOsInfo} from '../omarchyd/os-info.mjs'

const release = {pretty: 'Omarchy'}

async function withOmarchy(fn) {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-osinfo-'))
	try {
		const bin = join(root, 'omarchy', 'bin')
		await mkdir(bin, {recursive: true})
		for (const name of ['omarchy-version', 'omarchy-update-available']) {
			await writeFile(join(bin, name), '#!/bin/sh\n')
			await chmod(join(bin, name), 0o755)
		}
		await fn({root, bin, env: {PATH: '/usr/bin', OMARCHY_PATH: join(root, 'omarchy')}})
	} finally {
		await rm(root, {recursive: true, force: true})
	}
}
const fakeRun = (answers, calls = []) => async (cmd, args, opts) => {
	calls.push({cmd, args, path: opts?.env?.PATH})
	const name = cmd.split('/').pop()
	return answers[name] ?? {code: 127, stdout: ''}
}

test('Omarchy version, an Omarchy update and waiting packages are reported', async () => {
	await withOmarchy(async ({root, bin, env}) => {
		const calls = []
		const run = fakeRun({
			'omarchy-version': {code: 0, stdout: '3.2.1-1\n'},
			'omarchy-update-available': {code: 0, stdout: 'omarchy 3.2.1-1 -> 3.3.0-1\n'},
			checkupdates: {code: 0, stdout: 'omarchy 3.2.1-1 -> 3.3.0-1\nlinux 6.17.1 -> 6.17.2\n'},
		}, calls)
		const info = await createOsInfo({release, home: root, env, run, kernel: '6.17.1-arch1-1'}).get()
		assert.deepEqual({...info, checkedAt: 0}, {
			os: 'Omarchy',
			kernel: '6.17.1-arch1-1',
			omarchy: {version: '3.2.1-1', updateAvailable: true, waiting: ['omarchy 3.2.1-1 -> 3.3.0-1']},
			packages: {waiting: 2, sample: ['omarchy 3.2.1-1 -> 3.3.0-1', 'linux 6.17.1 -> 6.17.2']},
			checkedAt: 0,
		})
		assert.ok(calls.every((c) => c.path.startsWith(bin)), 'Omarchy’s scripts find each other on PATH')
		assert.ok(!calls.some((c) => /pacman|omarchy-update$/.test(c.cmd)), 'nothing that installs is run')
	})
})

test('up to date: Omarchy says so with exit 1, checkupdates with exit 2', async () => {
	await withOmarchy(async ({root, env}) => {
		const run = fakeRun({
			'omarchy-version': {code: 0, stdout: '3.3.0-1\n'},
			'omarchy-update-available': {code: 1, stdout: 'Omarchy is up to date\n'},
			checkupdates: {code: 2, stdout: ''},
		})
		const info = await createOsInfo({release, home: root, env, run}).get()
		assert.deepEqual(info.omarchy, {version: '3.3.0-1', updateAvailable: false})
		assert.deepEqual(info.packages, {waiting: 0, sample: []})
	})
})

test('a server without Omarchy or checkupdates reports what it knows, not a guess', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchyd-osinfo-none-'))
	try {
		const info = await createOsInfo({release: {pretty: 'Debian GNU/Linux 13 (trixie)'}, home: root, env: {PATH: '/usr/bin', OMARCHY_PATH: join(root, 'none')}, dirs: [join(root, 'none', 'bin')], run: fakeRun({checkupdates: {code: 1, stdout: ''}})}).get()
		assert.equal(info.os, 'Debian GNU/Linux 13 (trixie)')
		assert.equal(info.omarchy, null)
		assert.equal(info.packages, null, 'a failed check is unknown, not "nothing waiting"')
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('one check serves everyone for half an hour, and callers at the same moment share it', async () => {
	await withOmarchy(async ({root, env}) => {
		const calls = []
		let t = 0
		const run = fakeRun({'omarchy-version': {code: 0, stdout: '3.3.0-1'}, 'omarchy-update-available': {code: 1, stdout: ''}, checkupdates: {code: 2, stdout: ''}}, calls)
		const info = createOsInfo({release, home: root, env, run, now: () => t})
		await Promise.all([info.get(), info.get(), info.get()])
		assert.equal(calls.length, 3, 'three programs, run once')
		t = 29 * 60 * 1000
		await info.get()
		assert.equal(calls.length, 3)
		t = 31 * 60 * 1000
		await info.get()
		assert.equal(calls.length, 6)
	})
})
