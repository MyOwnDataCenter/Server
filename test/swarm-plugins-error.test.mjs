import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// The Omarchy plugins sheet on a joined computer searched the registry and drew nothing when the search failed,
// the same as a search with no matches.
test('the plugins sheet says when the plugin list could not be loaded', async () => {
	const src = await readFile(new URL('../web/src/swarm/Swarm.tsx', import.meta.url), 'utf8')
	assert.match(src, /\{page\.error && <Row icon="alert" label="Couldn’t load the plugin list" sub=\{errorText\(page\.error\)\} \/>\}/)
	assert.match(src, /import \{errorText\} from '\.\.\/queryNotice'/)
})
