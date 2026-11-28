// Wake-on-LAN packets and which addresses a powered-on machine sends them to.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {directedBroadcasts, fanoutWake, magicPacket} from '../omarchyd/wol.mjs'

test('magic packet is six 0xff bytes then the MAC sixteen times', () => {
	const packet = magicPacket('AA-BB-CC-DD-EE-0F')
	assert.equal(packet.length, 102)
	assert.equal(packet.subarray(0, 6).toString('hex'), 'ffffffffffff')
	const mac = Buffer.from('aabbccddee0f', 'hex')
	for (let i = 0; i < 16; i++) assert.deepEqual(packet.subarray(6 + i * 6, 12 + i * 6), mac)
})

test('directed broadcasts are the subnet broadcasts of physical IPv4 NICs', () => {
	const targets = directedBroadcasts({
		lo: [{address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00'}],
		docker0: [{address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false, mac: '02:42:00:00:00:01'}],
		tailscale0: [{address: '100.64.1.2', netmask: '255.255.255.255', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00'}],
		'br-lan': [{address: '10.0.0.1', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:aa:aa:aa:aa:01'}],
		enp3s0: [{address: '192.168.84.10', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:01'}],
		wlan0: [
			{address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false, mac: 'aa:bb:cc:dd:ee:02'},
			{address: '10.0.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:02'},
		],
		wg0: [{address: '10.9.0.2', netmask: '255.255.255.0', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00'}],
	})
	assert.deepEqual(targets.sort(), ['10.0.1.255', '192.168.84.255'])
})

test('wake is sent from this server and every other computer that is on', async () => {
	const calls = []
	const out = await fanoutWake({
		macs: ['aa:bb:cc:dd:ee:01'],
		selfId: 'asleep',
		onlineIds: ['asleep', 'quito', 'old'],
		sendLocal: async (macs) => calls.push(['local', macs]),
		sendRemote: async (id, macs) => {
			calls.push([id, macs])
			if (id === 'old') throw new Error('Unknown action')
		},
	})
	assert.equal(out.sent, true)
	assert.equal(out.from, 2)
	assert.deepEqual(calls.map((c) => c[0]).sort(), ['local', 'old', 'quito'])
	assert.ok(calls.every((c) => c[1][0] === 'aa:bb:cc:dd:ee:01'))
	assert.equal(calls.some((c) => c[0] === 'asleep'), false)
})

test('wake fails when nobody could send', async () => {
	await assert.rejects(
		() => fanoutWake({macs: ['aa:bb:cc:dd:ee:01'], selfId: 'asleep', onlineIds: [], sendLocal: async () => { throw new Error('down') }, sendRemote: async () => {}}),
		/wake packet/,
	)
	await assert.rejects(() => fanoutWake({macs: [], selfId: 'asleep', onlineIds: ['quito'], sendLocal: async () => {}, sendRemote: async () => {}}), /remembered/)
})
