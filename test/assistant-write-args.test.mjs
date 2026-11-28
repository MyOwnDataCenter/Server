import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {WRITE_TOOLS} from '../omarchyd/assistant/tools.mjs'

const sse = (text) => ({ok: true, status: 200, text: async () => text, body: (async function* () { yield text })()})
const toolSse = (name, args) => sse(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'call_1', function: {name, arguments: JSON.stringify(args)}}]}}]})}\n\ndata: [DONE]\n\n`)
const textSse = (text) => sse(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)

async function run(name, args) {
	const dataDir = await mkdtemp(join(os.tmpdir(), 'awa-'))
	try {
		let calls = 0
		const fetchImpl = async () => (calls++ === 0 ? toolSse(name, args) : textSse('Sorry, which one?'))
		const accounts = {getUser: (userId) => (userId === 'owner' ? {userId, role: 'owner'} : null)}
		const asst = createAssistant({dataDir, accounts, now: () => 50, fetchImpl, runProcedure: async () => null})
		await asst.keys.add({userId: 'owner', role: 'owner'}, {name: 'k', provider: 'spacexai', apiKey: 'xai-secret-abcd', model: 'grok-4.7'})
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'do it', emit: (e) => events.push(e)})
		return events
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
}

test('a write tool called without its target, or with the wrong type, makes no Approve card', async () => {
	for (const [name, args] of [
		['apps_start', {}],
		['apps_stop', {appId: 5}],
		['machines_start', {}],
		['machines_updateSettings', {id: 'abcd1234', portForwards: 'x'}],
		['swarm_action', {id: 'x', name: 'format-disk'}],
		['usb_attach', {deviceId: 'usb-1'}],
	]) {
		const events = await run(name, args)
		assert.equal(events.some((e) => e.event === 'action'), false, `${name} ${JSON.stringify(args)} made a card`)
		assert.equal(events.some((e) => e.event === 'tool' && e.data.state === 'error'), true, name)
	}
})

test('a complete write tool call still gets its Approve card', async () => {
	const events = await run('apps_start', {appId: 'homeassistant'})
	const card = events.find((e) => e.event === 'action')
	assert.ok(card, 'expected an action card')
})

test('every write tool that needs a target says so in its schema', () => {
	const need = new Map(WRITE_TOOLS.map((t) => [t.name, t.parameters.required ?? []]))
	assert.deepEqual(need.get('apps_start'), ['appId'])
	assert.deepEqual(need.get('machines_start'), ['id'])
	assert.deepEqual(need.get('swarm_action'), ['id', 'name'])
})
