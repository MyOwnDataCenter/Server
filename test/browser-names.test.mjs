// Settings > Signed-in devices names the browser a person would recognise (#172).
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {browserName} from '../web/src/screens/settingsHelpers.ts'

const UA = {
	chromeLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
	firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
	safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
	safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
	firefoxIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15',
	chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
	edgeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/120.0.0.0 Mobile/15E148 Safari/605.1.15',
	edgeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0',
	operaLinux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/105.0.0.0',
}

test('browserName: the browsers that also say Chrome or Safari are named for what they are', () => {
	assert.equal(browserName(UA.firefoxIphone), 'Firefox')
	assert.equal(browserName(UA.chromeIphone), 'Chrome')
	assert.equal(browserName(UA.edgeIphone), 'Edge')
	assert.equal(browserName(UA.edgeAndroid), 'Edge')
	assert.equal(browserName(UA.operaLinux), 'Opera')
})

test('browserName: the common browsers keep their names', () => {
	assert.equal(browserName(UA.chromeLinux), 'Chrome')
	assert.equal(browserName(UA.edgeWindows), 'Edge')
	assert.equal(browserName(UA.firefoxLinux), 'Firefox')
	assert.equal(browserName(UA.safariMac), 'Safari')
	assert.equal(browserName(UA.safariIphone), 'Safari')
	assert.equal(browserName(''), 'Browser')
})
