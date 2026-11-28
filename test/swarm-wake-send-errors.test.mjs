import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import {EventEmitter} from 'node:events'
import {mock, test} from 'node:test'

import {sendWolPacket} from '../omarchyd/connector.mjs'

// A UDP socket whose sends fail or succeed by destination.
function fakeSocket(fails) {
	const sock = new EventEmitter()
	sock.bind = (_port, done) => done()
	sock.setBroadcast = () => {}
	sock.send = (_packet, _port, host, done) => done(fails(host) ? Object.assign(new Error('Network is unreachable'), {code: 'ENETUNREACH'}) : null)
	sock.close = () => {}
	return sock
}

test('a wake packet that could not be sent to any address is an error, not a success', async (t) => {
	t.mock.method(dgram, 'createSocket', () => fakeSocket(() => true))
	await assert.rejects(sendWolPacket('aa:bb:cc:dd:ee:01'), /unreachable/i)
})

test('a wake packet that reached at least one address is sent', async (t) => {
	t.mock.method(dgram, 'createSocket', () => fakeSocket((host) => host !== '255.255.255.255'))
	await sendWolPacket('aa:bb:cc:dd:ee:01')
	t.mock.method(dgram, 'createSocket', () => fakeSocket((host) => host === '255.255.255.255'))
	await assert.doesNotReject(sendWolPacket('aa:bb:cc:dd:ee:01'))
})
