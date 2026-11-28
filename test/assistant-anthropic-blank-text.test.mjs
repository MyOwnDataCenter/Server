import assert from 'node:assert/strict'
import {test} from 'node:test'

import {anthropicMessages} from '../omarchyd/assistant/anthropic.mjs'

// The Messages API refuses a text block that is only whitespace, and a saved chat replays every message.
const blank = (messages) => messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && !b.text.trim())

test('a whitespace-only assistant reply is not sent as a text block next to a tool call', () => {
	const out = anthropicMessages([
		{role: 'user', content: 'how much disk'},
		{role: 'assistant', content: '\n\n', tool_calls: [{id: 'toolu_1', type: 'function', function: {name: 'system_diskUsage', arguments: '{}'}}]},
		{role: 'tool', tool_call_id: 'toolu_1', content: '12 GB'},
	])
	assert.deepEqual(blank(out.messages), [])
	assert.deepEqual(out.messages[1].content.map((b) => b.type), ['tool_use'])
})

test('a whitespace-only assistant reply on its own is left out, and real text is kept as written', () => {
	const out = anthropicMessages([
		{role: 'user', content: 'hi'},
		{role: 'assistant', content: ' \n'},
		{role: 'user', content: 'again'},
		{role: 'assistant', content: 'Hello\n'},
	])
	assert.deepEqual(blank(out.messages), [])
	assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant'])
	assert.equal(out.messages[1].content[0].text, 'Hello\n')
})
