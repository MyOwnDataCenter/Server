import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// Restore and Computers on the Backups page drew rows when they had them and nothing when the request failed,
// so a failed list looked like "nothing to restore" or no computers.
test('the Backups page says when the restore list or the computers list could not be loaded', async () => {
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /snaps\.error && appsBacked\.size === 0/)
	assert.match(src, /Couldn’t list the app backups: \{errorText\(snaps\.error\)\}/)
	assert.match(src, /comps\.error && !comps\.data/)
	assert.match(src, /Couldn’t list the computers: \{errorText\(comps\.error\)\}/)
})
