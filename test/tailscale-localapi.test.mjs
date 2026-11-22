import assert from 'node:assert/strict'
import test from 'node:test'

import {createTailscale, isDefaultRouteCidr, isValidCidr, normalizeControlUrl, parseTailscaleStatus} from '../omarchyd/tailscale.mjs'

const MOCK_STATUS = {
	Version: '1.104.6',
	BackendState: 'Running',
	AuthURL: '',
	TailscaleIPs: ['100.68.115.94', 'fd7a:115c:a1e0::1'],
	MagicDNSSuffix: 'tail8dd7d.ts.net',
	CurrentTailnet: {Name: 'kdegeek.github', MagicDNSSuffix: 'tail8dd7d.ts.net'},
	Health: [''],
	Self: {
		ID: 'self-1',
		HostName: 'omarchy-2',
		DNSName: 'omarchy-2.tail8dd7d.ts.net.',
		OS: 'linux',
		TailscaleIPs: ['100.68.115.94'],
		Relay: 'ord',
		Online: true,
		ExitNode: false,
	},
	Peer: {
		k1: {
			ID: 'peer-mac',
			HostName: 'mac-studio',
			DNSName: 'mac-studio.tail8dd7d.ts.net.',
			OS: 'macOS',
			TailscaleIPs: ['100.68.10.2'],
			CurAddr: '10.0.1.5:41641',
			Relay: 'ord',
			RxBytes: 4096,
			TxBytes: 8192,
			Online: true,
			Active: true,
			ExitNode: false,
			ExitNodeOption: true,
			LastSeen: '0001-01-01T00:00:00Z',
		},
		k2: {
			ID: 'peer-phone',
			HostName: 'iphone',
			DNSName: 'iphone.tail8dd7d.ts.net.',
			OS: 'iOS',
			TailscaleIPs: ['100.68.10.9'],
			CurAddr: '',
			Relay: 'dfw',
			Online: false,
			ExitNodeOption: false,
			LastSeen: '2026-11-20T12:00:00Z',
		},
	},
}

const MOCK_PREFS = {
	WantRunning: true,
	OperatorUser: 'nate',
	ControlURL: '',
	CorpDNS: true,
	RouteAll: false,
	RunSSH: false,
	ShieldsUp: false,
	ExitNodeID: '',
	ExitNodeAllowLANAccess: true,
	AdvertiseRoutes: ['10.0.1.0/24', '0.0.0.0/0', '::/0'],
}

test('Tailscale CIDR and control URL validators', () => {
	assert.equal(isValidCidr('10.0.1.0/24'), true)
	assert.equal(isValidCidr('192.168.1.0/24'), true)
	assert.equal(isValidCidr('10.0.1.5/32'), true)
	assert.equal(isValidCidr('fd00::/64'), true)
	assert.equal(isValidCidr('fd00::1/128'), true)
	// Rejects host bits set & malformed addresses
	assert.equal(isValidCidr('192.168.1.5/24'), false)
	assert.equal(isValidCidr('fd00::1/64'), false)
	assert.equal(isValidCidr('not-a-cidr'), false)
	assert.equal(isValidCidr('999.0.0.1/24'), false)
	assert.equal(isValidCidr('1::2::3/64'), false)
	assert.equal(isValidCidr('fd00::/129'), false)
	// Recognizes all spellings of default routes
	assert.equal(isDefaultRouteCidr('0.0.0.0/0'), true)
	assert.equal(isDefaultRouteCidr('::/0'), true)
	assert.equal(isDefaultRouteCidr('::0/0'), true)
	assert.equal(isDefaultRouteCidr('0:0::0/0'), true)
	assert.equal(isDefaultRouteCidr('10.0.1.0/24'), false)

	assert.equal(normalizeControlUrl(''), '')
	assert.equal(normalizeControlUrl('https://hs.example.com/'), 'https://hs.example.com')
	assert.throws(() => normalizeControlUrl('http://hs.example.com'), /https:\/\//)
	assert.throws(() => normalizeControlUrl('https://user:pass@hs.example.com'), /credentials/)
})

test('parseTailscaleStatus extracts tailnet, self, prefs, peers, direct/relay, and exit nodes', () => {
	const parsed = parseTailscaleStatus(MOCK_STATUS, MOCK_PREFS, {operator: true})
	assert.equal(parsed.available, true)
	assert.equal(parsed.operator, true)
	assert.equal(parsed.tailnet, 'kdegeek.github')
	assert.equal(parsed.self.dnsName, 'omarchy-2.tail8dd7d.ts.net')
	assert.equal(parsed.self.advertisingExitNode, true)
	assert.deepEqual(parsed.self.subnetRoutes, ['10.0.1.0/24'])
	assert.equal(parsed.summary.totalPeers, 2)
	assert.equal(parsed.summary.onlinePeers, 1)
	assert.equal(parsed.summary.directPeers, 1)
	assert.equal(parsed.summary.exitNodeOptions, 1)
	assert.equal(parsed.peers[0].id, 'peer-mac')
	assert.equal(parsed.peers[0].direct, true)
	assert.equal(parsed.peers[1].lastSeen, '2026-11-20T12:00:00Z')
})

test('tailscale RPCs patch prefs safely, validate peer IPs on ping, and handle missing socket', async () => {
	const patches = []
	const audited = []
	let prefs = {...MOCK_PREFS}
	const ts = createTailscale({
		currentUser: 'nate',
		audit: {record: async (e) => audited.push(e)},
		localApi: async (method, path, body) => {
			if (method === 'GET' && path === 'status') return JSON.stringify(MOCK_STATUS)
			if (method === 'GET' && path === 'prefs') return JSON.stringify(prefs)
			if (method === 'PATCH' && path === 'prefs') {
				patches.push(body)
				if (body.AdvertiseRoutesSet) prefs = {...prefs, AdvertiseRoutes: body.AdvertiseRoutes}
				if (body.RunSSHSet) prefs = {...prefs, RunSSH: body.RunSSH}
				if (body.ControlURLSet) prefs = {...prefs, ControlURL: body.ControlURL}
				if (body.ExitNodeIDSet) prefs = {...prefs, ExitNodeID: body.ExitNodeID}
				return JSON.stringify(prefs)
			}
			if (method === 'POST' && path.startsWith('ping?')) {
				return JSON.stringify({LatencySeconds: 0.0024, Endpoint: '10.0.1.5:41641', DERPRegionCode: ''})
			}
			throw new Error(`Unexpected ${method} ${path}`)
		},
	})

	// status read does NOT write to prefs
	const initial = await ts.procedures['tailscale.status'].run()
	assert.equal(initial.operator, true)
	assert.equal(patches.length, 0)

	// Rejects advertising exit node and using an exit node simultaneously
	await assert.rejects(ts.procedures['tailscale.setPrefs'].run({exitNodeId: 'peer-mac'}), /at the same time/)

	const updated = await ts.procedures['tailscale.setPrefs'].run({
		runSsh: true,
		advertiseExitNode: false,
		subnetRoutes: ['192.168.50.0/24'],
		exitNodeId: 'peer-mac',
		controlUrl: 'https://hs.example.com',
	})
	assert.equal(updated.prefs.runSsh, true)
	assert.equal(updated.prefs.advertiseExitNode, false)
	assert.deepEqual(updated.prefs.subnetRoutes, ['192.168.50.0/24'])
	assert.equal(updated.prefs.exitNodeId, 'peer-mac')
	assert.equal(updated.prefs.controlUrl, 'https://hs.example.com')
	assert.equal(patches[0].ExitNodeIP, '')
	assert.equal(patches[0].ExitNodeIPSet, true)
	assert.equal(audited.length, 1)

	// Rejects default route spellings in subnetRoutes and host-bits CIDRs
	await assert.rejects(ts.procedures['tailscale.setPrefs'].run({subnetRoutes: ['::0/0']}), /Advertise as exit node/)
	await assert.rejects(ts.procedures['tailscale.setPrefs'].run({subnetRoutes: ['192.168.1.5/24']}), /host bits/)

	// Non-operator user gets read-only status and FORBIDDEN on setPrefs
	const ro = createTailscale({
		currentUser: 'other-user',
		localApi: async (method, path) => {
			if (method === 'GET' && path === 'status') return JSON.stringify(MOCK_STATUS)
			if (method === 'GET' && path === 'prefs') return JSON.stringify(prefs)
			throw new Error(`Unexpected ${method} ${path}`)
		},
	})
	assert.equal((await ro.procedures['tailscale.status'].run()).operator, false)
	await assert.rejects(ro.procedures['tailscale.setPrefs'].run({runSsh: false}), /operator/)

	// Rejects unknown exit node & unknown ping IP (SSRF protection)
	await assert.rejects(ts.procedures['tailscale.setPrefs'].run({exitNodeId: 'peer-unknown'}), /exit node/)
	await assert.rejects(ts.procedures['tailscale.ping'].run({ip: '127.0.0.1'}), /tailnet/)

	const ping = await ts.procedures['tailscale.ping'].run({ip: '100.68.10.2'})
	assert.equal(ping.direct, true)
	assert.equal(ping.latencyMs, 2.4)

	// Missing socket returns unavailable cleanly
	const offline = createTailscale({
		localApi: async () => {
			const e = new Error('no sock')
			e.code = 'ENOENT'
			throw e
		},
	})
	const st = await offline.procedures['tailscale.status'].run()
	assert.equal(st.available, false)
})
