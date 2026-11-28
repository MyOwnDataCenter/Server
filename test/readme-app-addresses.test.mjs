// The "see the README" in the app-open error is true: the README explains app addresses (#304).
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {normalizeAppHosts} from '../server/app.mjs'

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8')

test('the README documents the app addresses setting the NEEDS_APP_HOSTS error points to', async () => {
	assert.match(await read('server/app.mjs'), /Opening apps remotely needs app addresses \(see the README\)/)
	const readme = await read('README.md')
	assert.match(readme, /app addresses/i)
	assert.match(readme, /TOUCH_APP_HOSTS/)
	// The example pattern is one the server accepts, and the unit it names is the one the installer writes.
	assert.equal(normalizeAppHosts('{app}-touch.example.com'), '{app}-touch.example.com')
	assert.match(readme, /omarchy-server-web\.service/)
	assert.match(await read('install.sh'), /omarchy-server-web\.service/)
})
