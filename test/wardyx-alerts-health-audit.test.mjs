import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {checkPushEndpoint, createAlerts, encryptPushPayload, generateVapidPair, vapidJwt} from '../omarchyd/alerts.mjs'
import {createAudit, verifyAuditLines} from '../omarchyd/audit.mjs'
import {createHealth, sendDeadmanPing, validatePingUrl} from '../omarchyd/health.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

async function makeTemp(prefix) {
	return mkdtemp(join(tmpdir(), prefix))
}

test('Web Push RFC 8291 encryption, RFC 8292 VAPID JWT, and SSRF endpoint checks', async () => {
	const vapid = await generateVapidPair()
	assert.ok(vapid.publicKey.length > 60)
	assert.ok(vapid.pkcs8.length > 40)

	// Generate a mock subscriber P-256 ECDH keypair + 16-byte auth secret.
	const subKey = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits'])
	const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', subKey.publicKey))
	const p256dh = Buffer.from(rawPub).toString('base64url')
	const auth = Buffer.alloc(16, 7).toString('base64url')
	const encrypted = await encryptPushPayload(new TextEncoder().encode(JSON.stringify({title: 'Hi', body: 'World'})), {p256dh, auth})
	assert.ok(encrypted instanceof Uint8Array)
	// Header = 16 salt + 4 rs + 1 idlen + 65 pubkey = 86 bytes, plus ciphertext + 16-byte tag
	assert.ok(encrypted.length > 86 + 16)
	assert.equal(encrypted[20], 65)

	const pkcs8 = Buffer.from(vapid.pkcs8, 'base64')
	const signKey = await crypto.subtle.importKey('pkcs8', pkcs8, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign'])
	const jwt = await vapidJwt(
		{
			subject: 'https://omarchy.local',
			sign: async (data) => new Uint8Array(await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, signKey, data)),
		},
		'https://fcm.googleapis.com',
	)
	assert.equal(jwt.split('.').length, 3)

	// SSRF checks block non-HTTPS, loopback, and private RFC1918 addresses
	assert.equal((await checkPushEndpoint('http://push.example.com/1')).ok, false)
	assert.equal((await checkPushEndpoint('https://127.0.0.1/push')).ok, false)
	assert.equal((await checkPushEndpoint('https://10.0.0.5/push')).ok, false)
	assert.equal((await checkPushEndpoint('https://192.168.1.10/push')).ok, false)
	assert.equal((await checkPushEndpoint('https://[::1]/push')).ok, false)
	const okPublic = await checkPushEndpoint('https://push.example.com/sub/1', async () => ['93.184.216.34'])
	assert.equal(okPublic.ok, true)
})

test('Alerts flap damping, quiet hours, and critical bypass', async () => {
	const dir = await makeTemp('omarchy-alerts-')
	try {
		let currentAlerts = []
		let clock = new Date('2026-05-01T14:00:00Z').getTime()
		const sent = []
		const alerts = createAlerts({
			dataDir: dir,
			collectAlerts: async () => currentAlerts,
			autoStart: false,
			now: () => clock,
			checkEndpoint: async (u) => ({ok: u.startsWith('https://'), url: new URL(u)}),
			fetchImpl: async (url, init) => {
				sent.push({url, headers: init.headers, len: init.body?.length ?? 0})
				return new Response('', {status: 201})
			},
		})
		const subKey = await crypto.subtle.generateKey({name: 'ECDH', namedCurve: 'P-256'}, true, ['deriveBits'])
		const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', subKey.publicKey))).toString('base64url')
		const auth = Buffer.alloc(16, 3).toString('base64url')
		await alerts.procedures['alerts.subscribePush'].run({endpoint: 'https://push.example.com/sub/abc', p256dh, auth, label: 'Test'})

		// Warning needs 2 consecutive ticks
		currentAlerts = [{id: 'disk-1', severity: 'warning', kind: 'disk', name: 'box', message: 'Disk at 92%'}]
		const t1 = await alerts.evaluate()
		assert.equal(t1.fired.length, 0)
		assert.equal(sent.length, 0)
		const t2 = await alerts.evaluate()
		assert.equal(t2.fired.length, 1)
		assert.equal(sent.length, 1)
		// Already active: does not re-fire
		const t3 = await alerts.evaluate()
		assert.equal(t3.fired.length, 0)

		// Recovery resets flap state
		currentAlerts = []
		await alerts.evaluate()

		// Critical fires immediately on tick 1
		currentAlerts = [{id: 'offline-1', severity: 'critical', kind: 'offline', name: 'box', message: 'box is offline'}]
		const t4 = await alerts.evaluate()
		assert.equal(t4.fired.length, 1)
		assert.equal(sent.length, 2)

		// Quiet hours suppresses warnings, still allows critical
		await alerts.procedures['alerts.saveSettings'].run({quietHours: {enabled: true, startHour: 0, endHour: 23}})
		currentAlerts = [{id: 'warn-qh', severity: 'warning', kind: 'cpu', name: 'box', message: 'CPU high'}]
		await alerts.evaluate()
		const t5 = await alerts.evaluate()
		assert.equal(t5.fired[0]?.skipped, 'quiet-hours')
		assert.equal(sent.length, 2)

		// Once quiet hours are turned off, the still-active warning is delivered!
		await alerts.procedures['alerts.saveSettings'].run({quietHours: {enabled: false, startHour: 22, endHour: 7}})
		const t5b = await alerts.evaluate()
		assert.equal(t5b.fired[0]?.dispatched, true)
		assert.equal(sent.length, 3)

		currentAlerts = [{id: 'crit-qh', severity: 'critical', kind: 'offline', name: 'box2', message: 'box2 offline'}]
		const t6 = await alerts.evaluate()
		assert.equal(t6.fired[0]?.dispatched, true)
		assert.equal(sent.length, 4)

		alerts.close()
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})

test('Tamper-evident audit log detects modifications and redacts secrets', async () => {
	const dir = await makeTemp('omarchy-audit-')
	try {
		const audit = createAudit({dataDir: dir})
		await audit.record({actor: 'owner', action: 'swarm.action', target: 'box1', detail: {action: 'restart', password: 'super-secret-value', apiKey: 'sk-1234'}})
		await audit.record({actor: 'owner', action: 'system.setSecurity', target: 'security', detail: {alwaysHttps: true}})

		const verified = await audit.procedures['audit.verify'].run()
		assert.equal(verified.ok, true)
		assert.equal(verified.count, 2)

		const raw = await audit.exportNdjson()
		assert.ok(!raw.includes('super-secret-value'))
		assert.ok(!raw.includes('sk-1234'))

		// Tamper with entry 1 and verify detection
		const tampered = raw.replace('box1', 'box9')
		const check = verifyAuditLines(tampered)
		assert.equal(check.ok, false)
		assert.equal(check.brokenAt, 1)
		assert.match(check.reason, /Hash mismatch/)
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})

test('Health check and dead-man heartbeat never echo secret URLs', async () => {
	const dir = await makeTemp('omarchy-health-')
	try {
		assert.equal(validatePingUrl('http://hc-ping.com/secret-uuid', false).reason, 'insecure_url')
		assert.equal(validatePingUrl('https://hc-ping.com/secret-uuid', false).ok, true)

		const secretUrl = 'https://hc-ping.com/very-secret-token-999'
		const failRes = await sendDeadmanPing(secretUrl, {
			fetchImpl: async () => new Response('err', {status: 500}),
		})
		assert.deepEqual(failRes, {ok: false, reason: 'http_5xx'})
		assert.ok(!JSON.stringify(failRes).includes('very-secret-token-999'))

		let pinged = 0
		const health = createHealth({
			dataDir: dir,
			version: '0.9.54',
			autoStart: false,
			fetchImpl: async () => {
				pinged++
				return new Response('OK', {status: 200})
			},
		})
		await health.procedures['health.setDeadman'].run({enabled: true, url: secretUrl, intervalMinutes: 5})
		const detail = await health.procedures['health.detail'].run()
		assert.equal(detail.ok, true)
		assert.equal(detail.deadman.configured, true)
		assert.equal(detail.deadman.host, 'hc-ping.com')
		assert.ok(!JSON.stringify(detail).includes('very-secret-token-999'))

		await health.procedures['health.testDeadman'].run()
		assert.equal(pinged, 1)
		health.close()
	} finally {
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})

test('omarchyd exposes public /api/health and owner-only /api/audit/export', async () => {
	const dir = await makeTemp('omarchy-srv-l7-')
	const srv = await startOmarchyd({
		port: 0,
		dataDir: dir,
		home: dir,
		machineOptions: {run: async () => ({ok: true, out: '', err: ''})},
		appOptions: {run: async () => ({ok: true, out: '', err: ''})},
		storageOptions: {helper: async () => ''},
	})
	try {
		const hRes = await fetch(`${srv.url}/api/health`)
		assert.equal(hRes.status, 200)
		const hBody = await hRes.json()
		assert.equal(hBody.ok, true)
		assert.equal(hBody.status, 'ok')

		// Unauthenticated audit export is rejected
		const unauth = await fetch(`${srv.url}/api/audit/export`)
		assert.equal(unauth.status, 401)

		// Authenticate as owner and export audit log
		await srv.accounts.createOwner({name: 'owner', password: 'password123'})
		const login = await srv.accounts.loginNative({username: 'owner', password: 'password123', client: {id: 'test'}})
		await srv.audit.record({actor: 'owner', action: 'test.event', target: 'self'})
		const exp = await fetch(`${srv.url}/api/audit/export`, {headers: {authorization: `Bearer ${login.accessToken}`}})
		assert.equal(exp.status, 200)
		const text = await exp.text()
		assert.equal(verifyAuditLines(text).ok, true)
		assert.equal(verifyAuditLines(text).count, 1)
	} finally {
		await srv.close()
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})
