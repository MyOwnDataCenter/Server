import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

// When usb.list failed (or had not answered yet), the Devices tab said "Plug a serial adapter or Zigbee
// stick into this server", as if the list had loaded and was empty.
test('the Devices tab shows a failed list as an error, not as "plug in a stick"', async () => {
	const src = await readFile(new URL('../web/src/usb.tsx', import.meta.url), 'utf8')
	assert.match(src, /list\.error && !devices\.length/)
	assert.match(src, /errorText\(list\.error\)/)
	assert.match(src, /list\.isSuccess && !devices\.length/)
	assert.doesNotMatch(src, /\{!devices\.length && <p/)
})
