import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createQemuAgent} from '../omarchyd/qemu-agent.mjs'
import {remoteGuestAgentRun} from '../omarchyd/remote-guest-agent.mjs'

const ID = 'abcd1234'
const DOMAIN = `omarchy-${ID}`
const SECRET = 'secret-pw'

test('ping, exec, and status go through vm-ga and nowhere else', async () => {
	const calls = []
	const run = remoteGuestAgentRun({
		guestId: ID,
		call: async (name, args) => {
			calls.push({name, args})
			if (name === 'vm-ga-ping') return '{"return":{}}'
			if (name === 'vm-ga-exec') return JSON.stringify({pid: 42})
			if (name === 'vm-ga-status') return JSON.stringify({exited: true, exitcode: 0, out: 'hello', err: 'nope'})
			throw new Error(`unexpected ${name}`)
		},
	})
	const agent = createQemuAgent({run, domain: DOMAIN})
	await agent.ping()
	const started = await agent.exec({path: 'loginctl', args: ['enable-linger', 'chris'], input: SECRET})
	assert.deepEqual(started, {pid: 42})
	assert.deepEqual(await agent.status(42), {exited: true, exitcode: 0, out: 'hello', err: 'nope'})
	assert.deepEqual(calls.map((c) => c.name), ['vm-ga-ping', 'vm-ga-exec', 'vm-ga-status'])
	assert.deepEqual(calls[0].args, {guestId: ID})
	assert.equal(calls[1].args.path, 'loginctl')
	assert.deepEqual(calls[1].args.args, ['enable-linger', 'chris'])
	assert.equal(calls[1].args.input, SECRET)
	assert.equal(calls[1].args.capture, undefined)
	assert.deepEqual(calls[2].args, {guestId: ID, pid: '42'})
	const execReturn = await run('virsh', ['-c', 'qemu:///session', 'qemu-agent-command', DOMAIN, JSON.stringify({execute: 'guest-exec', arguments: {path: 'true', 'input-data': Buffer.from(SECRET, 'utf8').toString('base64')}})])
	assert.equal(String(execReturn).includes(SECRET), false)
	await assert.rejects(() => run('sh', ['-c', 'virsh']), /qemu-agent-command/)
	await assert.rejects(
		() => run('virsh', ['-c', 'qemu:///session', 'qemu-agent-command', 'omarchy-ffffffff', '{}']),
		/qemu-agent-command/,
	)
	assert.equal(calls.some((c) => c.name === 'sh'), false)
	assert.equal(calls.filter((c) => c.name === 'vm-ga-exec').length, 2)
})

test('vm-ga-exec may already be an object', async () => {
	const run = remoteGuestAgentRun({
		guestId: ID,
		call: async () => ({pid: 9}),
	})
	const agent = createQemuAgent({run, domain: DOMAIN})
	assert.deepEqual(await agent.exec({path: 'true'}), {pid: 9})
})
