import assert from 'node:assert/strict'
import {test} from 'node:test'

import {createQemuAgent} from '../omarchyd/qemu-agent.mjs'

const DOMAIN = 'omarchy-deadbeef'

function fakeRun(replies) {
	const calls = []
	const run = async (cmd, args) => {
		calls.push({cmd, args})
		const reply = replies[calls.length - 1]
		if (reply instanceof Error) throw reply
		return reply
	}
	return {calls, run}
}

function agentJson(call) {
	assert.equal(call.cmd, 'virsh')
	assert.deepEqual(call.args.slice(0, 4), ['-c', 'qemu:///session', 'qemu-agent-command', DOMAIN])
	assert.equal(call.args.length, 5, 'JSON is one argv element, not a shell line')
	assert.equal(typeof call.args[4], 'string')
	assert.equal(call.args.some((arg) => /\s/.test(arg) && arg.startsWith('virsh')), false)
	return JSON.parse(call.args[4])
}

test('ping, exec, and status talk through virsh qemu-agent-command JSON', async () => {
	const {calls, run} = fakeRun([
		'{"return":{}}\n',
		'{"return":{"pid":1965}}',
		JSON.stringify({
			return: {
				exited: true,
				exitcode: 0,
				'out-data': Buffer.from('hello\n', 'utf8').toString('base64'),
				'err-data': Buffer.from('warn', 'utf8').toString('base64'),
			},
		}),
	])
	const agent = createQemuAgent({run, domain: DOMAIN})

	await agent.ping()
	assert.deepEqual(agentJson(calls[0]), {execute: 'guest-ping'})

	assert.deepEqual(await agent.exec({path: '/usr/bin/curl', args: ['-fsSL', 'https://example/install.sh']}), {pid: 1965})
	assert.deepEqual(agentJson(calls[1]), {
		execute: 'guest-exec',
		arguments: {
			path: '/usr/bin/curl',
			arg: ['-fsSL', 'https://example/install.sh'],
			'capture-output': true,
		},
	})

	assert.deepEqual(await agent.status(1965), {exited: true, exitcode: 0, out: 'hello\n', err: 'warn'})
	assert.deepEqual(agentJson(calls[2]), {execute: 'guest-exec-status', arguments: {pid: 1965}})
})

test('guest-exec stdin is input-data base64, not plaintext on the argv', async () => {
	const secret = 'sudo-secret-p@ss café'
	const {calls, run} = fakeRun(['{"return":{"pid":7}}'])
	const agent = createQemuAgent({run, domain: DOMAIN})
	await agent.exec({path: '/usr/bin/sudo', args: ['-S', 'true'], input: secret})

	const argv = calls[0].args
	assert.equal(argv.includes(secret), false)
	assert.equal(argv[4].includes(secret), false, 'plaintext must not sit inside the JSON argv element')
	const body = agentJson(calls[0])
	assert.equal(body.execute, 'guest-exec')
	assert.equal(body.arguments['input-data'], Buffer.from(secret, 'utf8').toString('base64'))
})

test('interfaces and routes read qemu-ga network JSON', async () => {
	const ifaces = [{name: 'enp1s0', 'ip-addresses': [{'ip-address': '192.168.84.81'}]}]
	const routes = [{version: 4, destination: '0.0.0.0', gateway: '192.168.86.1'}]
	const {calls, run} = fakeRun([
		JSON.stringify({return: ifaces}),
		JSON.stringify({return: routes}),
	])
	const agent = createQemuAgent({run, domain: DOMAIN})
	assert.deepEqual(await agent.interfaces(), ifaces)
	assert.deepEqual(agentJson(calls[0]), {execute: 'guest-network-get-interfaces'})
	assert.deepEqual(await agent.routes(), routes)
	assert.deepEqual(agentJson(calls[1]), {execute: 'guest-network-get-route'})
})

test('exec leaves capture-output off when capture is false', async () => {
	const {calls, run} = fakeRun(['{"return":{"pid":3}}'])
	const agent = createQemuAgent({run, domain: DOMAIN})
	await agent.exec({path: '/bin/true', args: [], capture: false})
	const capture = agentJson(calls[0]).arguments['capture-output']
	assert.ok(capture === false || capture === undefined)
})

test('status treats missing output as empty strings', async () => {
	const {run} = fakeRun(['{"return":{"exited":false}}'])
	const agent = createQemuAgent({run, domain: DOMAIN})
	assert.deepEqual(await agent.status(9), {exited: false, exitcode: undefined, out: '', err: ''})
})

test('ping rejects when the guest agent is not connected', async () => {
	const err = new Error('Guest agent not available for now')
	const {run} = fakeRun([err])
	const agent = createQemuAgent({run, domain: DOMAIN})
	await assert.rejects(() => agent.ping(), err)
})
