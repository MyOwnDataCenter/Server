import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

test('.editorconfig keeps Python files on spaces, as they are written', async () => {
	const config = await readFile(new URL('../.editorconfig', import.meta.url), 'utf8')
	const section = config.match(/^\[\*\.py\]\n((?:(?!\[).*\n?)*)/m)
	assert.ok(section, 'a [*.py] section is missing')
	assert.match(section[1], /^indent_style = space$/m)
	assert.match(section[1], /^indent_size = 4$/m)
	const agent = await readFile(new URL('../connector/agent.py', import.meta.url), 'utf8')
	assert.equal(/^\t/m.test(agent), false, 'connector/agent.py is indented with spaces')
})
