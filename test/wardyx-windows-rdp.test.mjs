import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import net from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import tls from 'node:tls'
import WebSocket, {WebSocketServer} from 'ws'

import {
	RDCLEANPATH_VERSION_1,
	attachRdcCleanPathBridge,
	decodeRdcRequest,
	decodeRdcResponse,
	encodeRdcError,
	encodeRdcRequest,
	encodeRdcResponse,
} from '../omarchyd/rdcleanpath.mjs'

test('RDCleanPath v3390 ASN.1 DER matches upstream IronRDP wire tags (0, 1, 2, 3, 5, 6, 7, 9)', () => {
	// Independent hand-encoded IronRDP wire vector:
	// SEQUENCE { [0] INTEGER 3390 (0x0d3e), [2] UTF8String "box:3389", [5] UTF8String "pcb", [6] OCTET STRING 03 00 00 04 }
	const ironRdpWireHex =
		'3021' + // SEQUENCE len 33
		'a00402020d3e' + // [0] version = 3390
		'a20a0c08626f783a33333839' + // [2] destination = "box:3389"
		'a5050c03706362' + // [5] preconnectionBlob = "pcb"
		'a606040403000004' // [6] x224ConnectionPdu = 03 00 00 04
	const parsed = decodeRdcRequest(Buffer.from(ironRdpWireHex, 'hex'))
	assert.equal(parsed.version, RDCLEANPATH_VERSION_1)
	assert.equal(parsed.destination, 'box:3389')
	assert.equal(parsed.preconnectionBlob, 'pcb')
	assert.deepEqual(parsed.x224ConnectionPdu, Buffer.from([0x03, 0x00, 0x00, 0x04]))

	// Verify encoder emits exact IronRDP tags ([6] x224, [7] serverCertChain, [9] serverAddr)
	const fakeCert = Buffer.alloc(40, 0xab)
	const encodedResp = encodeRdcResponse({
		serverAddr: '127.0.0.1:3389',
		x224ConnectionPdu: Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00]),
		serverCertChain: [fakeCert],
	})
	// Check context tags directly in the encoded buffer
	const hex = encodedResp.toString('hex')
	assert.ok(hex.includes('a00402020d3e'), 'version [0] = 3390')
	assert.ok(hex.includes('a60d040b0300000b'), 'x224 [6] OCTET STRING')
	assert.ok(hex.includes('a72c302a0428'), 'serverCertChain [7] SEQUENCE OF OCTET STRING')
	assert.ok(hex.includes('a9100c0e3132372e302e302e313a33333839'), 'serverAddr [9] UTF8String')
	const decodedResp = decodeRdcResponse(encodedResp)
	assert.equal(decodedResp.version, RDCLEANPATH_VERSION_1)
	assert.equal(decodedResp.serverAddr, '127.0.0.1:3389')
	assert.equal(decodedResp.serverCertChain.length, 1)
	assert.deepEqual(decodedResp.serverCertChain[0], fakeCert)

	const encodedErr = encodeRdcError({errorCode: 1, httpStatusCode: 502})
	const decodedErr = decodeRdcResponse(encodedErr)
	assert.equal(decodedErr.version, RDCLEANPATH_VERSION_1)
	assert.equal(decodedErr.error?.errorCode, 1)
	assert.equal(decodedErr.error?.httpStatusCode, 502)

	// Malformed huge 4-byte length (0x84 0xff 0xff 0xff 0xff) must throw cleanly without hanging
	assert.throws(() => decodeRdcRequest(Buffer.from('3084ffffffff00', 'hex')))
})

test('RDCleanPath bridge performs X.224 confirm, TLS upgrade, cert extraction, and bidirectional relay', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'omarchy-rdp-test-'))
	const keyPath = join(dir, 'key.pem')
	const certPath = join(dir, 'cert.pem')
	execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=mock-rdp'], {stdio: 'ignore'})
	const key = await readFile(keyPath)
	const cert = await readFile(certPath)

	const x224Confirm = Buffer.from([0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00])
	const mockRdp = net.createServer((raw) => {
		raw.once('data', () => {
			raw.write(x224Confirm)
			const tlsSock = new tls.TLSSocket(raw, {isServer: true, key, cert})
			tlsSock.on('data', (chunk) => {
				tlsSock.write(Buffer.concat([Buffer.from('RDP:'), chunk]))
			})
		})
	})
	await new Promise((r) => mockRdp.listen(0, '127.0.0.1', r))
	const rdpPort = mockRdp.address().port

	let closeCalled = 0
	const wss = new WebSocketServer({port: 0, host: '127.0.0.1'})
	await new Promise((r) => wss.once('listening', r))
	wss.on('connection', (ws) => attachRdcCleanPathBridge(ws, {host: '127.0.0.1', port: rdpPort, onClose: () => closeCalled++}))
	const wsPort = wss.address().port

	try {
		const client = new WebSocket(`ws://127.0.0.1:${wsPort}`)
		await new Promise((resolve, reject) => {
			client.once('open', resolve)
			client.once('error', reject)
		})
		const x224Req = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00])
		const firstMsg = new Promise((resolve) => client.once('message', resolve))
		client.send(encodeRdcRequest({destination: '127.0.0.1:3389', x224ConnectionPdu: x224Req}), {binary: true})

		const resp = decodeRdcResponse(await firstMsg)
		assert.equal(resp.version, RDCLEANPATH_VERSION_1)
		assert.deepEqual(resp.x224ConnectionPdu, x224Confirm)
		assert.equal(resp.serverCertChain.length, 1)
		assert.ok(resp.serverCertChain[0].length > 200)

		const secondMsg = new Promise((resolve) => client.once('message', resolve))
		client.send(Buffer.from('hello-rdp'), {binary: true})
		const echoed = Buffer.from(await secondMsg).toString('utf8')
		assert.equal(echoed, 'RDP:hello-rdp')
		client.close()
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(closeCalled, 1)
	} finally {
		wss.close()
		mockRdp.close()
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})

test('Windows connector install.ps1 verifies DER CA SHA-256, uses positional enroll args, and runs agent.py with no extra args', async () => {
	const ps1 = await readFile(new URL('../connector/install.ps1', import.meta.url), 'utf8')
	assert.match(ps1, /BEGIN CERTIFICATE/)
	assert.match(ps1, /FromBase64String/)
	assert.match(ps1, /ActualCa -ne \$ExpectedCa/)
	assert.match(ps1, /@\(\$AgentPath, "enroll", \$Server, \$Token\)/)
	assert.match(ps1, /ast\.parse/)
	assert.match(ps1, /-Argument "`"\$AgentPath`""/)
	assert.doesNotMatch(ps1, /"\$AgentPath`" run/)
	assert.match(ps1, /\$Uninstall/)
})
