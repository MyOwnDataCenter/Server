import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// The operating system list is filtered by the host's architecture, which comes from machines.capabilities.
// When that request fails (a joined computer that is offline, say) the list is empty. The sheet showed the
// error for the image list but not for this one, so the person saw a blank sheet and no reason.
test('New machine says why when the host capabilities cannot be loaded', async () => {
	const src = await readFile(new URL('../web/src/CreateMachine.tsx', import.meta.url), 'utf8')
	assert.match(src, /hostArchitecture != null/)
	assert.match(src, /\{caps\.error && \(/)
	assert.match(src, /\(caps\.error as Error\)\.message/)
})
