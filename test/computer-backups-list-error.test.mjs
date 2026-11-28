import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// The Backups list on a computer's sheet only drew when it had rows. When backups.computerSnapshots failed
// the section just vanished, so the person could not tell "no backups" from "could not be listed".
test('the computer sheet says when its backups could not be listed', async () => {
	const src = await readFile(new URL('../web/src/backups.tsx', import.meta.url), 'utf8')
	assert.match(src, /snaps\.error && computerSnapshotRows\(snaps\.data\)\.length === 0/)
	assert.match(src, /Couldn’t list the backups: \{errorText\(snaps\.error\)\}/)
	assert.match(src, /import \{errorText\} from '\.\/queryNotice'/)
})
