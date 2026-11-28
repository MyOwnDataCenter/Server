import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {defaultSpawn} from '../omarchyd/backups.mjs'
import {howLong, stoppedMessage} from '../omarchyd/exec-error.mjs'

const run = (cmd, args, timeout, maxBuffer = 1 << 20) => new Promise((resolve) => execFile(cmd, args, {timeout, maxBuffer}, (error) => resolve(error)))

test('howLong says seconds, minutes or hours in plain words', () => {
	assert.equal(howLong(300), '1 second')
	assert.equal(howLong(30_000), '30 seconds')
	assert.equal(howLong(10 * 60_000), '10 minutes')
	assert.equal(howLong(15 * 60_000), '15 minutes')
	assert.equal(howLong(6 * 60 * 60_000), '6 hours')
})

test('a command stopped for taking too long is reported as a time-out, not as its last output (#452)', async () => {
	const error = await run('sh', ['-c', 'echo Pulling fs layer 3/7 >&2; sleep 5'], 300)
	assert.equal(error.killed, true)
	assert.equal(stoppedMessage('docker-compose', error, 10 * 60_000), 'docker-compose took longer than 10 minutes and was stopped')
})

test('a command that simply failed keeps its own message', async () => {
	const error = await run('sh', ['-c', 'echo nope >&2; exit 3'], 5000)
	assert.equal(stoppedMessage('sh', error, 5000), null)
})

test('output past the buffer is reported in words, not as a Node message', async () => {
	const error = await run('sh', ['-c', 'yes | head -c 5000'], 5000, 100)
	assert.match(stoppedMessage('sh', error, 5000), /^sh printed more than can be kept and was stopped$/)
})

test('a backup command stopped by its timer says it took too long, not "exit null"', async () => {
	await assert.rejects(defaultSpawn('sleep', ['5'], {timeout: 300}), (error) => {
		assert.equal(error.message, 'sleep took longer than 1 second and was stopped')
		return true
	})
})

test('every helper that runs external commands builds its message with stoppedMessage', async () => {
	for (const file of ['apps', 'updater', 'machines', 'storage', 'omarchy-plugins', 'system-apps', 'backups']) {
		const source = await readFile(new URL(`../omarchyd/${file}.mjs`, import.meta.url), 'utf8')
		assert.match(source, /stoppedMessage\(/, `${file}.mjs`)
	}
})
