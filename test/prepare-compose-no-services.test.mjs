// A compose file with no services (empty, only comments, or `services:` with nothing under it) is
// refused with a sentence, not with a JavaScript error message.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {prepareCompose} from '../omarchyd/apps.mjs'

test('a compose file with no services says so', () => {
	for (const text of ['', '# nothing here\n', 'services:\n', 'services: []\n', 'name: demo\n']) {
		assert.throws(() => prepareCompose('demo', text, () => 21000), /lists no services/, JSON.stringify(text))
	}
})

test('a compose file with services still prepares', () => {
	const out = prepareCompose('demo', 'services:\n  web:\n    image: x\n', () => 21000)
	assert.match(out.text, /container_name: demo_web_1/)
})
