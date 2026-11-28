import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {EventEmitter} from 'node:events'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {PassThrough} from 'node:stream'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {openAccounts} from '../omarchyd/accounts.mjs'
import {backpressureBudgets, createFrameReader, createHyprland, isPcmSilent, parseDesktopEntry, scoreProfileCandidate} from '../omarchyd/hyprland.mjs'
import {startOmarchyd} from '../omarchyd/server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STREAM_PY = join(HERE, '..', 'omarchyd', 'hypr-stream.py')
const RAIL_C = join(HERE, '..', 'omarchyd', 'hypr-rail-capture.c')

function framePacket(type, payloadBuf) {
	const hdr = Buffer.alloc(5)
	hdr[0] = type
	hdr.writeUInt32BE(payloadBuf.length, 1)
	return Buffer.concat([hdr, payloadBuf])
}

test('createFrameReader reassembles fragmented multi-chunk frames and rejects oversized headers', () => {
	const reader = createFrameReader()
	const p1 = framePacket(1, Buffer.from('{"width":3840,"height":2160}'))
	const p2 = framePacket(2, Buffer.alloc(4096, 0xab))
	const wire = Buffer.concat([p1, p2])
	const out = []
	// Feed tiny 3-byte slices to force split headers and split payloads across chunk boundaries
	for (let i = 0; i < wire.length; i += 3) {
		reader.push(wire.subarray(i, Math.min(wire.length, i + 3)))
		assert.equal(
			reader.drain((type, payload) => out.push({type, len: payload.length, first: payload[0]})),
			true,
		)
	}
	assert.equal(out.length, 2)
	assert.equal(out[0].type, 1)
	assert.equal(out[1].type, 2)
	assert.equal(out[1].len, 4096)
	assert.equal(out[1].first, 0xab)

	const bad = Buffer.alloc(5)
	bad[0] = 2
	bad.writeUInt32BE(32 * 1024 * 1024, 1)
	reader.push(bad)
	assert.equal(reader.drain(() => {}), false)
})

test('isPcmSilent detects near-silent PCM frames and passes audible signal', () => {
	const quiet = Buffer.alloc(3840, 0)
	assert.equal(isPcmSilent(quiet), true)
	quiet.writeInt16LE(12, 100)
	assert.equal(isPcmSilent(quiet), true)
	const loud = Buffer.alloc(3840, 0)
	loud.writeInt16LE(-800, 120)
	assert.equal(isPcmSilent(loud), false)
})

test('backpressureBudgets stays tight on WAN bitrates and scales up cleanly for 100+ Mbps LAN streams', () => {
	const wan = backpressureBudgets(16000)
	const high = backpressureBudgets(45000)
	const ultra = backpressureBudgets(100000)
	assert.equal(wan.deltaDropBytes, 500_000)
	assert.ok(high.deltaDropBytes > 1_200_000, '45 Mbps should absorb 685 KB keyframes')
	assert.ok(ultra.deltaDropBytes >= 3_000_000, '100 Mbps LAN should absorb 1.7 MiB near-lossless 4K keyframes without false delta drops')
	assert.ok(ultra.hardDropBytes > ultra.deltaDropBytes * 2)
})

test('hyprland status, windows, strict dispatch allowlist, and WebSocket H.264 stream bridge with WAN backpressure', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-test-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const dispatched = []
		const luaDispatched = []
		const spawned = []
		const clients = [
			{address: '0x55a1b2c3d4e0', title: 'Chrome', class: 'chromium', workspace: {id: 1}, at: [10, 10], size: [1200, 800], mapped: true, floating: false, fullscreen: false, pid: 1234},
			{address: '0xbad', title: 'Invalid', mapped: true},
		]
		const monitors = [{id: 0, name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1200, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 1}}]

		const fakeChild = new EventEmitter()
		fakeChild.stdin = new PassThrough()
		fakeChild.stdout = new PassThrough()
		fakeChild.stderr = new PassThrough()
		fakeChild.killed = false
		fakeChild.kill = () => {
			fakeChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'ffmpeg' || cmd === 'python3') return {ok: true, stdout: 'ok', stderr: ''}
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: 'no pkg-config in mock'}
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify(monitors), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'output' && args[1] === 'create') {
					monitors.push({id: 1, name: 'RAIL-1', x: 1920, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}})
					return {ok: true, stdout: 'ok', stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify(clients), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'eval') {
					if (args[1].includes('0x55a1b2c3d4e0') && args[1].includes('hl.dsp.focus')) {
						return {ok: true, stdout: 'unknown request\n', stderr: ''}
					}
					luaDispatched.push(args[1])
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'dispatch') {
					dispatched.push(args)
					return {ok: true, stdout: 'ok', stderr: ''}
				}
				return {ok: false, stdout: '', stderr: 'unknown'}
			},
			spawnImpl(cmd, args) {
				spawned.push({cmd, args})
				return fakeChild
			},
		})

		const st = await hypr.procedures['hyprland.status'].run()
		assert.equal(st.available, true)
		assert.equal(st.wayland, 'wayland-1')
		assert.equal(st.vaapi, true)
		assert.equal(st.encoder, 'h264_vaapi')
		assert.equal(st.monitors[0].name, 'eDP-1')

		const wins = await hypr.procedures['hyprland.windows'].run()
		assert.equal(wins.length, 1)
		assert.equal(wins[0].address, '0x55a1b2c3d4e0')
		assert.equal(wins[0].title, 'Chrome')

		// Strict allowlist for dispatch (both legacy fallback and Hyprland 0.57 Lua path)
		await hypr.procedures['hyprland.dispatch'].run({action: 'focus', address: '0x55a1b2c3d4e0'})
		await hypr.procedures['hyprland.dispatch'].run({action: 'workspace', workspace: 2})
		await hypr.procedures['hyprland.dispatch'].run({action: 'resize', address: '0x55a1b2c3d4e0', width: 1280, height: 720})
		await hypr.procedures['hyprland.dispatch'].run({action: 'moveToRail', address: '0x55a1b2c3d4e0'})
		assert.deepEqual(dispatched, [['dispatch', 'focuswindow', 'address:0x55a1b2c3d4e0']])
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.focus({workspace = 2})')))
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.window.float({window = "address:0x55a1b2c3d4e0", action = "set"})')))
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.window.resize({window = "address:0x55a1b2c3d4e0", x = 1280, y = 720, relative = false})')))
		assert.ok(luaDispatched.some((x) => x.includes('hl.dsp.window.move({window = "address:0x55a1b2c3d4e0", workspace = 11, silent = true})')))
		await assert.rejects(() => hypr.procedures['hyprland.dispatch'].run({action: 'exec', command: 'id'}), /Unsupported/)
		await assert.rejects(() => hypr.procedures['hyprland.dispatch'].run({action: 'focus', address: '0x12;rm -rf /'}), /Invalid window address/)

		// Attach a mock WebSocket and verify binary H.264 framing + input sanitization + tight 384 KiB WAN backpressure
		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		const stdinChunks = []
		fakeChild.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))

		await hypr.attachStream(fakeWs, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60, bitrate: 10000})
		const streamSpawn = spawned.at(-1)
		assert.ok(streamSpawn.args.includes('--mode') && streamSpawn.args.includes('window') && streamSpawn.args.includes('0x55a1b2c3d4e0'))

		// Emit metadata + keyframe + delta frame under 512 KiB backpressure (>384 KiB ceiling)
		fakeChild.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1200, height: 800, fps: 60, encoder: 'h264_vaapi_dmabuf'}))))
		const keyPayload = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x28])])
		fakeChild.stdout.write(framePacket(2, keyPayload))
		fakeWs.bufferedAmount = 512 * 1024
		const deltaPayload = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x41, 0x9a])])
		fakeChild.stdout.write(framePacket(2, deltaPayload))

		// Once socket drains below 64 KiB, next frame triggers deferred keyframe recovery
		fakeWs.bufferedAmount = 0
		fakeChild.stdout.write(framePacket(2, deltaPayload))

		// Forward allowed input, drop disallowed input & strip injected nested fields
		fakeWs.emit('message', JSON.stringify({type: 'pointer_move', x: 0.25, y: 0.75, extra: {type: 'win_rect', x: 999}}), false)
		fakeWs.emit('message', JSON.stringify({type: 'exec', cmd: 'evil'}), false)
		await new Promise((r) => setTimeout(r, 40))

		assert.equal(sent.length, 2, 'only meta + keyframe should be delivered while waiting for recovery keyframe')
		assert.equal(JSON.parse(sent[0].data).type, 'meta')
		assert.equal(sent[1].binary, true)
		const stdinText = stdinChunks.join('')
		assert.ok(stdinText.includes('"type":"keyframe"'), 'deferred keyframe should fire once send buffer drains')
		assert.ok(stdinText.includes('{"type":"pointer_move","x":0.25,"y":0.75}'), 'sanitized input should strip extra fields')
		assert.ok(stdinText.includes('"win_rect"'), 'initial window rect should be pushed for C-level pointer mapping')
		assert.ok(!stdinText.includes('evil'))
		assert.ok(!stdinText.includes('999'))

		fakeWs.emit('close')
		assert.equal(fakeChild.killed, true)
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('live PipeWire PCM audio suppresses silent chunks, streams audible chunks with 0x02 tag, and stops on mute', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-audio-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const videoChild = new EventEmitter()
		videoChild.stdin = new PassThrough()
		videoChild.stdout = new PassThrough()
		videoChild.stderr = new PassThrough()
		videoChild.killed = false
		videoChild.kill = () => {
			videoChild.killed = true
		}

		const audioChild = new EventEmitter()
		audioChild.stdout = new PassThrough()
		audioChild.killed = false
		audioChild.kill = () => {
			audioChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent'),
			async exec(cmd, args) {
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: false, stdout: '', stderr: ''}
			},
			spawnImpl(cmd) {
				return cmd === 'parec' ? audioChild : videoChild
			},
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'output', audio: true})
		// Emit 2 silent 20ms PCM frames -> must be silence-gated (0 bytes sent)
		audioChild.stdout.write(Buffer.alloc(3840 * 2, 0))
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(sent.filter((s) => s.binary && s.data[0] === 2).length, 0, 'silent audio must not consume TCP bandwidth')

		// Emit 1 audible 20ms PCM frame -> must stream with 0x02 tag
		audioChild.stdout.write(Buffer.alloc(3840, 0x2a))
		await new Promise((r) => setTimeout(r, 30))

		const audioPkts = sent.filter((s) => s.binary && s.data[0] === 2)
		assert.equal(audioPkts.length, 1, 'should emit one tagged 0x02 PCM audio packet')
		assert.equal(audioPkts[0].data.length, 3841)

		fakeWs.emit('message', JSON.stringify({type: 'audio', enabled: false}), false)
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(audioChild.killed, true, 'muting audio must terminate parec immediately')

		fakeWs.emit('close')
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('real hypr-stream.py FrameWriter big-endian wire format decodes cleanly in hyprland.mjs and browser DataView', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-wire-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		const pyCode = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("hs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
w = mod.FrameWriter()
w.send_json(1, {"width": 1920, "height": 1200, "fps": 60, "encoder": "h264_vaapi"})
w.send_video(True, 12345678, b"\\x00\\x00\\x00\\x01\\x67\\x42\\xe0\\x28")
`
		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent-vaapi'),
			spawnImpl() {
				return spawn('python3', ['-c', pyCode, STREAM_PY], {stdio: ['pipe', 'pipe', 'pipe']})
			},
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data, opts) => sent.push({data, binary: !!opts?.binary})
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'output'})
		const deadline = Date.now() + 3000
		while (sent.length < 2 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 20))
		}

		assert.equal(sent.length, 2, `expected meta + keyframe from real Python FrameWriter, got ${sent.length}`)
		const meta = JSON.parse(sent[0].data)
		assert.equal(meta.type, 'meta')
		assert.equal(meta.width, 1920)
		assert.equal(meta.height, 1200)
		assert.equal(sent[1].binary, true)
		const payload = sent[1].data
		assert.equal(payload[0], 1, 'isKey flag')
		const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
		const ts = view.getUint32(1, false) * 4294967296 + view.getUint32(5, false)
		assert.equal(ts, 12345678, 'big-endian 64-bit timestamp must match browser DataView decode')
		assert.deepEqual([...payload.subarray(9)], [0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x28])
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('session lock status is pushed to active streams and cleared on notifyUnlocked', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-lock-'))
	try {
		await writeFile(join(dir, 'wayland-1'), '')
		await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')

		let locked = true
		const focused = []
		const fakeChild = new EventEmitter()
		fakeChild.stdin = new PassThrough()
		fakeChild.stdout = new PassThrough()
		fakeChild.stderr = new PassThrough()
		fakeChild.killed = false
		fakeChild.kill = () => {
			fakeChild.killed = true
		}

		const hypr = createHyprland({
			dataDir: join(dir, 'data'),
			runtimeDir: dir,
			vaapiDevice: join(dir, 'nonexistent'),
			async exec(cmd, args) {
				if (cmd === 'ffmpeg' || cmd === 'python3') return {ok: true, stdout: 'ok', stderr: ''}
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'activewindow') return {ok: true, stdout: locked ? '{}' : JSON.stringify({address: '0x55a1b2c3d4e0'}), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: JSON.stringify([{id: 0, name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1200, scale: 1, activeWorkspace: {id: 1}}]), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'App', class: 'app', workspace: {id: 1}, at: [10, 10], size: [800, 600], mapped: true, floating: true}]), stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'eval') {
					if (args[1].includes('hl.dsp.focus')) focused.push(args[1])
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				return {ok: false, stdout: '', stderr: ''}
			},
			spawnImpl: () => fakeChild,
		})

		const sent = []
		const fakeWs = new EventEmitter()
		fakeWs.OPEN = 1
		fakeWs.readyState = 1
		fakeWs.bufferedAmount = 0
		fakeWs.send = (data) => sent.push(JSON.parse(data))
		fakeWs.close = () => {
			fakeWs.readyState = 3
		}

		await hypr.attachStream(fakeWs, {mode: 'window', address: '0x55a1b2c3d4e0'})
		await new Promise((r) => setTimeout(r, 40))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === true), 'initial locked state must be reported to viewer')

		locked = false
		await hypr.notifyUnlocked()
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === false), 'notifyUnlocked must broadcast unlocked state')
		assert.ok(focused.length >= 1, 'notifyUnlocked should re-focus active window streams')

		fakeWs.emit('close')
		hypr.close()
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('omarchyd hyprland RPC routes enforce owner-only authorization', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-http-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	let d
	try {
		await mkdir(home, {recursive: true})
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')

		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))

		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			updaterOptions: {autoCheck: false, installerCheck: true},
			hyprlandOptions: {
				runtimeDir: root,
				vaapiDevice: join(root, 'nonexistent'),
				async exec(cmd, args) {
					if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'Demo', class: 'demo', workspace: {id: 1}, at: [0, 0], size: [640, 480], mapped: true}]), stderr: ''}
					return {ok: false, stdout: '', stderr: ''}
				},
			},
		})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			const body = await r.json()
			return {authorization: `Bearer ${body.result.data.accessToken}`}
		}
		const owner = await login('owner')
		const member = await login('member')

		assert.equal((await fetch(`${d.url}/trpc/hyprland.status`, {headers: member})).status, 403)
		assert.equal((await fetch(`${d.url}/trpc/hyprland.windows`, {headers: member})).status, 403)
		assert.equal((await fetch(`${d.url}/trpc/hyprland.status`, {headers: owner})).status, 200)
	} finally {
		if (d) await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('cursor shape events (msgType 4) and unlock_check probes flow cleanly over the stream WebSocket', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-cur-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		let locked = true
		let remoteUnlockCount = 0
		let fakeChild
		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			vaapiDevice: join(root, 'nonexistent'),
			onRemoteUnlock: () => {
				remoteUnlockCount++
			},
			async exec(cmd, args) {
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: locked ? ['LOCK'] : []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'Chrome', class: 'google-chrome', workspace: {id: 11}, at: [0, 0], size: [1200, 800], mapped: true}]), stderr: ''}
				}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				fakeChild = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
					},
				})
				return fakeChild
			},
		})
		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data) {
				if (typeof data === 'string') sent.push(JSON.parse(data))
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60})
		const curPayload = Buffer.from(JSON.stringify({cursor: 'pointer'}), 'utf8')
		const hdr = Buffer.alloc(5)
		hdr[0] = 4
		hdr.writeUInt32BE(curPayload.length, 1)
		fakeChild.stdout.write(Buffer.concat([hdr, curPayload]))
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(sent.some((m) => m.type === 'cursor' && m.cursor === 'pointer'))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === true))

		locked = false
		ws.emit('message', Buffer.from(JSON.stringify({type: 'unlock_check'})), false)
		await new Promise((r) => setTimeout(r, 420))
		assert.ok(sent.some((m) => m.type === 'lock' && m.locked === false))
		assert.equal(remoteUnlockCount, 1, 'remote unlock while viewer is connected must arm Lock-after-viewing-remotely')

		locked = true
		ws.emit('message', Buffer.from(JSON.stringify({type: 'unlock_check'})), false)
		await new Promise((r) => setTimeout(r, 420))
		assert.ok(sent.filter((m) => m.type === 'lock' && m.locked === true).length >= 2)
		locked = false
		ws.close()
		await new Promise((r) => setTimeout(r, 60))
		assert.equal(remoteUnlockCount, 2, 'unlock observed on last-viewer disconnect must arm relock')

		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('full binary input fast paths (0x10/0x11/0x12/0x13), focus-delayed drag ordering, EPIPE safety, and SIGKILL escalation', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-bin-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-capture')
		await writeFile(fakeBin, '#!/bin/sh\n')

		const stdinChunks = []
		const killSignals = []
		let focusRelease = null
		let modeScenario = 'stream'
		let lastChild = null

		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					return {ok: true, stdout: JSON.stringify([{address: '0x55a1b2c3d4e0', title: 'App', class: 'app', workspace: {id: 11}, at: [0, 0], size: [1200, 800], mapped: true}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'eval' && args[1].includes('hl.dsp.focus') && focusRelease) {
					await focusRelease
					return {ok: true, stdout: 'ok\n', stderr: ''}
				}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				const ch = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill(sig) {
						this.killed = true
						killSignals.push(sig || 'SIGTERM')
						if (modeScenario !== 'sigkill' || sig === 'SIGKILL') {
							this.exitCode = 0
							setImmediate(() => {
								this.emit('exit', 0, sig || null)
								this.emit('close', 0, sig || null)
							})
						}
					},
				})
				lastChild = ch
				ch.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))
				return ch
			},
		})

		const st = await hypr.procedures['hyprland.status'].run()
		assert.equal(st.sessionLocked, false)

		let unlockFocus
		focusRelease = new Promise((r) => (unlockFocus = r))
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'window', address: '0x55a1b2c3d4e0', fps: 60, bitrate: 16000, codec: 'hevc', quality: 20, compression: 5})

		const mkMove = (ux, uy) => {
			const b = Buffer.alloc(5)
			b[0] = 0x10
			b.writeUInt16BE(ux, 1)
			b.writeUInt16BE(uy, 3)
			return b
		}
		const mkBtn = (btnOff, down, ux, uy) => {
			const b = Buffer.alloc(7)
			b[0] = 0x11
			b[1] = btnOff
			b[2] = down
			b.writeUInt16BE(ux, 3)
			b.writeUInt16BE(uy, 5)
			return b
		}
		const mkScroll = (dx256, dy256) => {
			const b = Buffer.alloc(9)
			b[0] = 0x12
			b.writeInt32BE(dx256, 1)
			b.writeInt32BE(dy256, 5)
			return b
		}
		const mkKey = (code, down, mods) => Buffer.from([0x13, code, down, mods])

		// Binary button-down triggers focus switch; drag moves coalesce behind it; scroll + key follow cleanly
		ws.emit('message', mkBtn(0, 1, 6554, 6554), true)
		ws.emit('message', mkMove(10000, 10000), true)
		ws.emit('message', mkMove(32768, 16384), true)
		ws.emit('message', mkScroll(0, 512), true)
		ws.emit('message', mkKey(28, 1, 4), true)
		unlockFocus()
		await new Promise((r) => setTimeout(r, 40))

		const joined = stdinChunks.join('')
		const btnIdx = joined.indexOf('B 272 1 6554 6554\n')
		const moveIdx = joined.indexOf('M 32768 16384\n')
		const scrollIdx = joined.indexOf('S 0 512\n')
		const keyIdx = joined.indexOf('K 28 1 4\n')
		assert.ok(btnIdx >= 0 && moveIdx > btnIdx, `binary button-down must precede coalesced drag move, got:\n${joined}`)
		assert.ok(!joined.includes('M 10000 10000'), 'intermediate drag move during focus stall should coalesce')
		assert.ok(scrollIdx > moveIdx && keyIdx > scrollIdx, `scroll and key must preserve FIFO order, got:\n${joined}`)

		// Async EPIPE on child.stdin must be handled cleanly without uncaught exception
		lastChild.stdin.emit('error', Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}))
		ws.close()

		// Worker ignoring SIGTERM must be escalated to SIGKILL
		modeScenario = 'sigkill'
		killSignals.length = 0
		const ws2 = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws2, {mode: 'output', output: 'RAIL-1', fps: 60})
		ws2.close()
		await new Promise((r) => setTimeout(r, 1650))
		assert.ok(killSignals.includes('SIGTERM') && killSignals.includes('SIGKILL'), `expected SIGTERM then SIGKILL escalation, got: ${killSignals}`)

		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('live zero-reconnect reconfig, RTT 0x14/0x04 ping-pong, msgType 5 telemetry, and 10ms Opus 0x03 with PCM fallback', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-r2-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-capture')
		await writeFile(fakeBin, '#!/bin/sh\n')

		let videoChild = null
		let opusChild = null
		let parecCount = 0
		const stdinChunks = []
		const spawned = []

		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl(cmd, args) {
				spawned.push({cmd, args})
				const ch = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
						this.exitCode = 0
					},
				})
				if (cmd === 'parec') {
					parecCount++
					return ch
				}
				if (args.includes('--opus-stdin')) {
					opusChild = ch
					return ch
				}
				videoChild = ch
				ch.stdin.on('data', (c) => stdinChunks.push(c.toString('utf8')))
				return ch
			},
		})

		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data, opts) {
				sent.push({data, binary: !!opts?.binary})
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})

		await hypr.attachStream(ws, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 20000, codec: 'hevc444', audio: true, audioCodec: 'opus'})
		assert.ok(spawned.some((s) => s.args.includes('hevc444')), 'should forward hevc444 codec flag')
		assert.ok(opusChild, 'should spawn --opus-stdin encoder when audioCodec=opus')

		// Emit framed Opus packet ([u16be len][payload]) -> must forward as binary 0x03
		const fakeOpus = Buffer.from([0xf8, 0x11, 0x22, 0x33, 0x44])
		const opusHdr = Buffer.alloc(2)
		opusHdr.writeUInt16BE(fakeOpus.length, 0)
		opusChild.stdout.write(Buffer.concat([opusHdr, fakeOpus]))

		// Emit msgType 5 telemetry JSON -> must forward as {type:'stats', ...}
		videoChild.stdout.write(framePacket(5, Buffer.from(JSON.stringify({encMs: 10.4, encP95Ms: 11.3, mbps: 42.1, polish: 2, roi: 9, slices: 4}))))

		// Send 9-byte binary RTT ping (0x14) -> immediate 9-byte 0x04 pong echo with identical payload
		const ping = Buffer.alloc(9)
		ping[0] = 0x14
		ping.writeDoubleBE(1234.5, 1)
		ws.emit('message', ping, true)

		// Send zero-reconnect live reconfig -> forwards R <bitrate> <quality> <codec>; unnumbered and startup meta (reconfigGen=0) must NOT consume the pending reconfig_applied ack!
		ws.emit('message', JSON.stringify({type: 'reconfig', bitrate: 100000, quality: 12, codec: 'hevc444'}), false)
		videoChild.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, bitrate: 20000, quality: 20, encoder: 'h264_vaapi_dmabuf', codec: 'avc1.640033'}))))
		videoChild.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, bitrate: 20000, quality: 20, reconfigGen: 0, encoder: 'h264_vaapi_dmabuf', codec: 'avc1.640033'}))))
		videoChild.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, bitrate: 100000, quality: 12, reconfigGen: 1, encoder: 'hevc444_vaapi_dmabuf', codec: 'hev1.4.10.L153.BE.8'}))))
		ws.bufferedAmount = 1_800_000 // > 20 Mbps delta cap, but well under 100 Mbps delta cap (~3.1 MB)
		const deltaPayload = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x02, 0x01])])
		videoChild.stdout.write(framePacket(2, deltaPayload))

		await new Promise((r) => setTimeout(r, 40))

		const opusPkt = sent.find((m) => m.binary && m.data[0] === 0x03)
		assert.ok(opusPkt && opusPkt.data.length === 1 + fakeOpus.length, 'should forward 0x03 Opus packet')
		const pongPkt = sent.find((m) => m.binary && m.data[0] === 0x04)
		assert.ok(pongPkt && pongPkt.data.length === 9 && pongPkt.data.readDoubleBE(1) === 1234.5, 'should echo 0x04 RTT pong immediately')
		const statsMsg = sent.find((m) => !m.binary && JSON.parse(m.data).type === 'stats')
		assert.ok(statsMsg && JSON.parse(statsMsg.data).slices === 4, 'should forward msgType 5 telemetry stats')
		const ackMsgs = sent.filter((m) => !m.binary).map((m) => JSON.parse(m.data)).filter((m) => m.type === 'reconfig_applied')
		assert.equal(ackMsgs.length, 1, 'startup meta (reconfigGen=0) must not consume live reconfig_applied ack')
		assert.equal(ackMsgs[0].codec, 'hevc444')
		assert.equal(ackMsgs[0].bitrate, 100000)
		assert.equal(ackMsgs[0].reconfigGen, 1)
		assert.ok(stdinChunks.join('').includes('R 100000 12 hevc444\n'), 'reconfig should write compact R line to capture stdin')
		assert.ok(sent.some((m) => m.binary && m.data[0] === 0), 'live reconfig to 100 Mbps should raise backpressure budget immediately')

		// Simulate --opus-stdin exiting with code 2 (missing libopus.so.0) -> must fall back cleanly to parec 20ms PCM
		opusChild.exitCode = 2
		opusChild.emit('exit', 2, null)
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(parecCount >= 2, 'missing libopus.so.0 exit(2) must fall back transparently to PCM parec')

		ws.close()
		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('session revocation closes active streams, lock probe failure does not invent unlock, double congestion recovers, and Python AU framing assembles multi-slice pictures', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-hard-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	let d
	try {
		await mkdir(home, {recursive: true})
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-cap')
		await writeFile(fakeBin, '#!/bin/sh\n')

		// 1. Lock probe failure (hyprctl error) must NOT invent an unlock or invoke onRemoteUnlock
		let lockMode = 'locked'
		let remoteUnlockCount = 0
		const stdinLines = []
		let capChild = null
		const hypr = createHyprland({
			dataDir: join(root, 'd1'),
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			onRemoteUnlock: () => remoteUnlockCount++,
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					if (lockMode === 'error') return {ok: false, stdout: '', stderr: 'socket busy'}
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: lockMode === 'locked' ? ['LOCK'] : []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl() {
				capChild = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill() {
						this.killed = true
						this.exitCode = 0
					},
				})
				capChild.stdin.on('data', (c) => stdinLines.push(c.toString('utf8')))
				return capChild
			},
		})
		const sent = []
		const ws = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send(data, opts) {
				sent.push({data, binary: !!opts?.binary})
			},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(ws, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 10000})
		await new Promise((r) => setTimeout(r, 30))
		assert.ok(sent.some((m) => !m.binary && JSON.parse(m.data).type === 'lock' && JSON.parse(m.data).locked === true))
		lockMode = 'error'
		ws.emit('message', JSON.stringify({type: 'unlock_check'}), false)
		await new Promise((r) => setTimeout(r, 360))
		assert.equal(remoteUnlockCount, 0, 'failed lock probe must not invent a remote unlock')
		assert.ok(!sent.some((m) => !m.binary && JSON.parse(m.data).type === 'lock' && JSON.parse(m.data).locked === false))

		// 2. Two congestion episodes inside one 1500ms cooldown must still schedule and emit a recovery keyframe without extra frames arriving
		const delta = Buffer.concat([Buffer.from([0]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x41, 0x9a])])
		const key = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([0, 0, 0, 1, 0x65, 0x88])])
		ws.bufferedAmount = 512 * 1024
		capChild.stdout.write(framePacket(2, delta))
		ws.bufferedAmount = 0
		capChild.stdout.write(framePacket(2, delta)) // triggers immediate 1st 'F\n'
		capChild.stdout.write(framePacket(2, key)) // recovers 1st drop
		ws.bufferedAmount = 512 * 1024
		capChild.stdout.write(framePacket(2, delta)) // 2nd congestion inside 1500ms cooldown!
		ws.bufferedAmount = 0 // socket drains, no more video frames arrive (static desktop)
		await new Promise((r) => setTimeout(r, 1700))
		const fCount = stdinLines.join('').split('\n').filter((l) => l === 'F').length
		assert.ok(fCount >= 2, `expected scheduled 2nd recovery keyframe after cooldown, got ${fCount}`)
		// Calling synchronous __omarchyRevoke must immediately block subsequent input before the 'close' event even fires
		const beforeRevokeCount = stdinLines.join('').length
		let closeCalled = false
		ws.close = () => {
			closeCalled = true
		}
		ws.__omarchyRevoke(1008, 'Session ended')
		assert.equal(closeCalled, true)
		ws.emit('message', Buffer.from([0x13, 28, 1, 0]), true)
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(stdinLines.join('').length, beforeRevokeCount, 'synchronous revoke must discard input immediately before close event')

		// 2b. Final lock probe transient failure on disconnect must retry and still arm remote unlock
		lockMode = 'locked'
		const wsRetry = Object.assign(new EventEmitter(), {
			OPEN: 1,
			readyState: 1,
			bufferedAmount: 0,
			send() {},
			close() {
				this.readyState = 3
				this.emit('close')
			},
		})
		await hypr.attachStream(wsRetry, {mode: 'output', output: 'RAIL-1', fps: 60, bitrate: 10000})
		await new Promise((r) => setTimeout(r, 30))
		// Transient error on first disconnect probe, then unlocked on retry!
		lockMode = 'error'
		setTimeout(() => {
			lockMode = 'unlocked'
		}, 120)
		wsRetry.close()
		await new Promise((r) => setTimeout(r, 520))
		assert.equal(remoteUnlockCount, 1, 'final disconnect lock probe must retry across unknown result and still arm remote unlock')
		hypr.close()

		// 3. Python _read_loop assembles multi-slice NALs into 1 Access Unit per picture, flushes at clean EOF,
		//    discards partial pictures on cancellation, and validates SHM layouts strictly
		const pyOut = execFileSync(
			'python3',
			[
				'-c',
				`
import importlib.util, io, sys
spec = importlib.util.spec_from_file_location("hs", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# Two slices for picture 1 (IDR: slice1 first_mb=0 0x88, slice2 first_mb>0 0x01) + AUD + picture 2 (P-frame, 2 slices)
bitstream = (
    b"\\x00\\x00\\x00\\x01\\x67\\x42\\xe0\\x28"
    b"\\x00\\x00\\x00\\x01\\x68\\xce\\x38\\x80"
    b"\\x00\\x00\\x00\\x01\\x65\\x88\\x01\\x02"
    b"\\x00\\x00\\x00\\x01\\x65\\x01\\x03\\x04"
    b"\\x00\\x00\\x00\\x01\\x09\\x30"
    b"\\x00\\x00\\x00\\x01\\x41\\x9a\\x05\\x06"
    b"\\x00\\x00\\x00\\x01\\x41\\x01\\x07\\x08"
)
out = []
class W:
    def send_video(self, is_key, ts, data):
        out.append((is_key, len(data)))
enc = object.__new__(mod.H264Encoder)
enc.stop_event = __import__("threading").Event()
enc.writer = W()
enc.proc = type("P", (), {"stdout": io.BytesIO(bitstream)})()
enc._read_loop()

# Cancelled mid-IDR must NOT emit a truncated keyframe
out2 = []
class W2:
    def send_video(self, is_key, ts, data):
        out2.append((is_key, len(data)))
class CancellingStream:
    def __init__(self, ev):
        self.ev = ev
        self.done = False
    def read(self, _n):
        if self.done:
            return b""
        self.done = True
        self.ev.set()
        return b"\\x00\\x00\\x00\\x01\\x65\\x88\\x01\\x02"
ev2 = __import__("threading").Event()
enc2 = object.__new__(mod.H264Encoder)
enc2.stop_event = ev2
enc2.writer = W2()
enc2.proc = type("P", (), {"stdout": CancellingStream(ev2)})()
enc2._read_loop()

# SHM layout allowlist & bounds
shm_ok = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 1920, 1080, 1920 * 4)
shm_bad_fmt = mod.is_valid_shm_layout(0x36314752, 1920, 1080, 1920 * 4)
shm_bad_stride = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 1920, 1080, 100)
shm_bad_size = mod.is_valid_shm_layout(mod.WL_SHM_FORMAT_XRGB8888, 8192, 8192, 0x40000000)
print(len(out), out[0][0], out[1][0], len(out2), shm_ok, shm_bad_fmt, shm_bad_stride, shm_bad_size)
`,
				STREAM_PY,
			],
			{encoding: 'utf8'},
		).trim()
		assert.equal(pyOut, '2 True False 0 True False False False', `unexpected Python AU/cancellation/SHM validation result: ${pyOut}`)

		// 4. omarchyd user.logout immediately revokes outstanding tickets and closes an active /hyprland/stream socket
		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			updaterOptions: {autoCheck: false, installerCheck: true},
			hyprlandOptions: {
				runtimeDir: root,
				vaapiDevice: join(root, 'nonexistent'),
				async exec(cmd, args) {
					if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
					return {ok: true, stdout: 'ok', stderr: ''}
				},
				spawnImpl() {
					return Object.assign(new EventEmitter(), {
						stdin: new PassThrough(),
						stdout: new PassThrough(),
						stderr: new PassThrough(),
						killed: false,
						exitCode: null,
						kill() {
							this.killed = true
							this.exitCode = 0
						},
					})
				},
			},
		})
		const loginRes = await fetch(`${d.url}/trpc/user.loginNative`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 'dev-1'}}),
		})
		const tok = (await loginRes.json()).result.data.accessToken
		const authHdr = {authorization: `Bearer ${tok}`, 'content-type': 'application/json'}
		const t1 = (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: authHdr, body: JSON.stringify({target: 'hyprland'})})).json()).result.data
		const t2 = (await (await fetch(`${d.url}/trpc/user.createWebSocketTicket`, {method: 'POST', headers: authHdr, body: JSON.stringify({target: 'hyprland'})})).json()).result.data

		const {WebSocket} = await import('ws')
		const wsUrl = d.url.replace(/^http/, 'ws')
		const liveWs = new WebSocket(`${wsUrl}/hyprland/stream?mode=output&ticket=${encodeURIComponent(t1)}`)
		await new Promise((resolve, reject) => {
			liveWs.once('open', resolve)
			liveWs.once('error', reject)
		})
		const closedP = new Promise((resolve) => liveWs.once('close', (code) => resolve(code)))
		await fetch(`${d.url}/trpc/user.logout`, {method: 'POST', headers: authHdr, body: '{}'})
		const closeCode = await Promise.race([closedP, new Promise((r) => setTimeout(() => r(-1), 2000))])
		assert.equal(closeCode, 1008, 'user.logout must immediately close active /hyprland/stream sockets')

		// Outstanding unused ticket t2 from the revoked session must be rejected (401)
		const rejectedStatus = await new Promise((resolve) => {
			const wsBad = new WebSocket(`${wsUrl}/hyprland/stream?mode=output&ticket=${encodeURIComponent(t2)}`)
			wsBad.once('unexpected-response', (_req, res) => {
				res.resume()
				resolve(res.statusCode)
			})
			wsBad.once('open', () => {
				wsBad.close()
				resolve(200)
			})
			wsBad.once('error', () => {})
		})
		assert.equal(rejectedStatus, 401, 'revoked session ticket must be rejected with 401')
	} finally {
		if (d) await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('stream control state preserves saved 4:4:4 preference on non-4:4:4 clients and keeps meta-confirmed codec on reconfig_unsupported', async () => {
	const {
		createStreamControlState,
		shouldReplayHandshakeReconfig,
		applyMetaToStreamControl,
		applyReconfigUnsupportedToStreamControl,
	} = await import('../web/src/hyprlandStreamState.mjs')

	// Case A: Saved 4:4:4 preference on a client lacking 4:4:4 decode support must not trigger an onopen reconfig or overwrite the saved preference on rejection
	const non444 = createStreamControlState({tier: 'high', chroma444Pref: true, effective444: false, codec: 'h264'})
	assert.equal(shouldReplayHandshakeReconfig(non444, {tier: 'high', chroma444Pref: true, supportsHevc444: false}), false)
	const rbA = applyReconfigUnsupportedToStreamControl(non444)
	assert.equal(rbA.tier, 'high')
	assert.equal(rbA.chroma444Pref, true)
	assert.equal(rbA.codec, 'h264')

	// Case B: Handshake requests hevc444, fallback reports h264 via meta, later tier-only reconfig is rejected -> confirmed codec stays h264 while preferences stay intact
	let fallback = createStreamControlState({tier: 'high', chroma444Pref: true, effective444: true, codec: 'hevc444'})
	const metaRes = applyMetaToStreamControl(fallback, 'h264_python_shm')
	fallback = metaRes.state
	assert.equal(metaRes.actualCodec, 'h264')
	const rbB = applyReconfigUnsupportedToStreamControl(fallback)
	assert.equal(rbB.tier, 'high')
	assert.equal(rbB.chroma444Pref, true)
	assert.equal(rbB.codec, 'h264')

	// Case C (profiled stream): Handshake requests hevc444 with null overrides, fallback meta confirms h264, then tier-only reconfig is rejected -> confirmed codec stays h264 while nullable overrides remain null
	const {
		applyMetaToProfiledStreamState,
		applyReconfigUnsupportedToProfiledStreamState,
	} = await import('../web/src/hyprlandStreamState.mjs')
	let profiledCfg = {codec: 'hevc444', bitrate: 100000, quality: 12, tierOverride: null, chromaOverride: null, codecFallback: null}
	const profiledMeta = applyMetaToProfiledStreamState(profiledCfg, 'h264_python')
	profiledCfg = profiledMeta.appliedCfg
	assert.equal(profiledMeta.actualCodec, 'h264')
	assert.equal(profiledCfg.codec, 'h264')
	assert.equal(profiledCfg.tierOverride, null)
	assert.equal(profiledCfg.chromaOverride, null)
	const rbC = applyReconfigUnsupportedToProfiledStreamState(profiledCfg)
	assert.equal(rbC.codec, 'h264')
	assert.equal(rbC.tierOverride, null)
	assert.equal(rbC.chromaOverride, null)
	assert.equal(rbC.codecFallback, null)
})

test('adaptive WAN RTT/jitter smoothing preserves LAN defaults and expands cushions on high-RTT/jitter links', async () => {
	const {
		createRttStats,
		updateRttStats,
		computeAudioJitterBudget,
		computeVideoDropPolicy,
		classifyNetworkQuality,
	} = await import('../web/src/hyprlandStreamState.mjs')

	let st = createRttStats()
	assert.equal(classifyNetworkQuality(st), 'unknown')
	assert.deepEqual(computeAudioJitterBudget({...st, mode: 'opus'}), {targetSec: 0.025, minLeadSec: 0.004, maxLeadSec: 0.14})
	assert.deepEqual(computeAudioJitterBudget({...st, mode: 'pcm'}), {targetSec: 0.035, minLeadSec: 0.005, maxLeadSec: 0.16})
	assert.deepEqual(computeVideoDropPolicy(st), {queueThreshold: 4, sustainMs: 80, hardCap: 12})

	// Invalid samples are ignored without mutating state
	assert.equal(updateRttStats(st, -5), st)
	assert.equal(updateRttStats(st, Number.NaN), st)
	assert.equal(updateRttStats(st, 15000), st)

	// LAN samples keep exact low-latency baseline
	let lan = updateRttStats(st, 2.0)
	lan = updateRttStats(lan, 2.4)
	assert.equal(classifyNetworkQuality(lan), 'lan')
	assert.deepEqual(computeAudioJitterBudget({...lan, mode: 'opus'}), {targetSec: 0.025, minLeadSec: 0.004, maxLeadSec: 0.14})
	assert.deepEqual(computeVideoDropPolicy(lan), {queueThreshold: 4, sustainMs: 80, hardCap: 12})

	// Moderate direct WAN link
	let wan = updateRttStats(st, 28)
	wan = updateRttStats(wan, 30)
	assert.equal(classifyNetworkQuality(wan), 'wan')
	const wanAudio = computeAudioJitterBudget({...wan, mode: 'opus'})
	assert.ok(wanAudio.targetSec > 0.025 && wanAudio.targetSec < 0.06, `expected moderate WAN cushion, got ${wanAudio.targetSec}`)
	const wanDrop = computeVideoDropPolicy(wan)
	assert.equal(wanDrop.hardCap, 14)
	assert.ok(wanDrop.sustainMs > 80 && wanDrop.sustainMs <= 200)

	// Relayed / DERP high-RTT + jitter link expands cushion and burst tolerance while clamping safely
	let derp = updateRttStats(st, 45)
	derp = updateRttStats(derp, 62)
	derp = updateRttStats(derp, 41)
	assert.equal(classifyNetworkQuality(derp), 'high-jitter')
	const derpOpus = computeAudioJitterBudget({...derp, mode: 'opus'})
	const derpPcm = computeAudioJitterBudget({...derp, mode: 'pcm'})
	assert.ok(derpOpus.targetSec >= 0.05 && derpOpus.targetSec <= 0.12, `expected 50-120ms Opus cushion, got ${derpOpus.targetSec}`)
	assert.ok(derpPcm.targetSec >= 0.06 && derpPcm.targetSec <= 0.14, `expected 60-140ms PCM cushion, got ${derpPcm.targetSec}`)
	assert.ok(derpOpus.maxLeadSec >= derpOpus.targetSec + 0.12)
	const derpDrop = computeVideoDropPolicy(derp)
	assert.equal(derpDrop.hardCap, 16)
	assert.ok(derpDrop.sustainMs >= 120 && derpDrop.sustainMs <= 200)

	// Extreme RTT clamps safely to upper bounds
	const extreme = {rttMs: 500, jitterMs: 80, samples: 10}
	assert.equal(computeAudioJitterBudget({...extreme, mode: 'opus'}).targetSec, 0.12)
	assert.equal(computeAudioJitterBudget({...extreme, mode: 'pcm'}).targetSec, 0.14)
	assert.equal(computeVideoDropPolicy(extreme).sustainMs, 200)
})

test('parseDesktopEntry extracts metadata and skips hidden/non-app entries', () => {
	const ok = parseDesktopEntry(
		`[Desktop Entry]
Type=Application
Name=Chromium Web Browser
Name[fr]=Navigateur Chromium
Comment=Access the Internet
Exec=/usr/bin/chromium %U
Icon=chromium
Categories=Network;WebBrowser;
StartupWMClass=chromium

[Desktop Action new-window]
Name=New Window
Exec=/usr/bin/chromium --new-window
`,
		'chromium',
	)
	assert.deepEqual(ok, {
		id: 'chromium',
		name: 'Chromium Web Browser',
		comment: 'Access the Internet',
		icon: 'chromium',
		categories: ['Network', 'WebBrowser'],
		terminal: false,
		wmClass: 'chromium',
	})

	assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Hidden\nExec=foo\nNoDisplay=true\n', 'h'), null)
	assert.equal(parseDesktopEntry('[Desktop Entry]\nType=Link\nName=Link\nURL=https://example.com\n', 'l'), null)
})

test('RAIL .desktop scanner, jailed icons, clipboard bridge, icon/SSE auth, and simultaneous WM-class launch correlation', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-rail-'))
	const home = join(root, 'home')
	const data = join(root, 'data')
	const appsDir = join(root, 'apps')
	const lowAppsDir = join(root, 'apps-low')
	const iconDir = join(home, '.local', 'share', 'icons', 'hicolor', 'scalable', 'apps')
	let d
	try {
		await mkdir(appsDir, {recursive: true})
		await mkdir(lowAppsDir, {recursive: true})
		await mkdir(iconDir, {recursive: true})
		await writeFile(join(iconDir, 'demo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
		await writeFile(join(root, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')
		await symlink(join(root, 'outside.svg'), join(iconDir, 'escaped.svg'))
		await writeFile(join(appsDir, 'demo.desktop'), '[Desktop Entry]\nType=Application\nName=Demo\nExec=/usr/bin/demo\nIcon=demo\nStartupWMClass=demo\n')
		await writeFile(join(appsDir, 'evil.desktop'), `[Desktop Entry]\nType=Application\nName=Evil\nExec=/usr/bin/evil\nIcon=${join(root, 'outside.svg')}\n`)
		await writeFile(join(appsDir, 'sym.desktop'), '[Desktop Entry]\nType=Application\nName=Sym\nExec=/usr/bin/sym\nIcon=escaped\n')
		await writeFile(join(appsDir, 'alpha.desktop'), '[Desktop Entry]\nType=Application\nName=Alpha\nExec=/usr/bin/alpha\nStartupWMClass=alpha-app\n')
		await writeFile(join(appsDir, 'beta.desktop'), '[Desktop Entry]\nType=Application\nName=Beta\nExec=/usr/bin/beta\nStartupWMClass=beta-app\n')
		await writeFile(join(appsDir, 'shadowed.desktop'), '[Desktop Entry]\nType=Application\nName=Shadowed\nExec=/usr/bin/shadowed\nHidden=true\n')
		await writeFile(join(lowAppsDir, 'shadowed.desktop'), '[Desktop Entry]\nType=Application\nName=Shadowed Visible\nExec=/usr/bin/shadowed\n')
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')

		let clipText = ''
		let failCopy = false
		let pasteMode = 'ok'
		let railMissing = false
		let clientsFail = false
		let spawnMode = 'ok'
		let moveOffRailOnWake = false
		let moveOffRailOnLuaResize = false
		let openOnPhysical = false
		const mutatedAddrs = []
		let betaLaunchSeq = 0
		const clients = [{address: '0x55a1b2c3d4e0', title: 'Demo', class: 'demo', workspace: {id: 1}, at: [0, 0], size: [640, 480], mapped: true}]

		const hypr = createHyprland({
			dataDir: join(root, 'd1'),
			home,
			runtimeDir: root,
			appDirs: [appsDir, lowAppsDir],
			vaapiDevice: join(root, 'nonexistent'),
			async exec(cmd, args, opts) {
				if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					if (railMissing) return {ok: true, stdout: JSON.stringify([{id: 0, name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 1}}]), stderr: ''}
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') {
					if (clientsFail) return {ok: false, stdout: '', stderr: 'hyprctl failed'}
					return {ok: true, stdout: JSON.stringify(clients), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'output') {
					return railMissing ? {ok: false, stdout: '', stderr: 'cannot create headless output'} : {ok: true, stdout: 'ok', stderr: ''}
				}
				if (cmd === 'hyprctl' && moveOffRailOnWake && (args.join(' ').includes('dpms'))) {
					// Simulate user moving the newly launched window onto physical workspace 1 during wakeRailOutput()
					const target = clients.find((c) => c.address === '0x55a1000000cc')
					if (target) target.workspace = {id: 1}
				}
				if (cmd === 'hyprctl' && moveOffRailOnLuaResize && args[0] === 'eval' && args[1]?.includes('window.resize') && args[1]?.includes('0x55a1000000dd')) {
					// Simulate Lua resize failing while the window moves to physical workspace 1 before legacy fallback runs
					const target = clients.find((c) => c.address === '0x55a1000000dd')
					if (target) target.workspace = {id: 1}
					return {ok: false, stdout: '', stderr: 'eval unsupported'}
				}
				if (cmd === 'hyprctl' && /float|resize|movewindowpixel|window\.move/.test(args.join(' '))) {
					mutatedAddrs.push(args.join(' '))
				}
				// A window that opened on the physical display, sent to RAIL-1's workspace.
				const moveTo = /window\.move\(\{window = "address:(0x[0-9a-f]+)", workspace = (\d+), silent = true/.exec(args.join(' '))
				if (cmd === 'hyprctl' && moveTo) {
					const target = clients.find((c) => c.address === moveTo[1])
					if (target) target.workspace = {id: Number(moveTo[2])}
				}
				if (cmd === 'wl-copy') {
					if (failCopy) return {ok: false, stdout: '', stderr: 'wl-copy failed'}
					clipText = opts?.input ?? ''
					return {ok: true, stdout: '', stderr: ''}
				}
				if (cmd === 'wl-paste') {
					if (pasteMode === 'empty') return {ok: false, stdout: '', stderr: 'Nothing is copied'}
					if (pasteMode === 'error') return {ok: false, stdout: '', stderr: 'Failed to connect to a compositor'}
					return {ok: true, stdout: clipText, stderr: ''}
				}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl(cmd, args) {
				const p = new EventEmitter()
				p.unref = () => {}
				if (cmd === 'gtk-launch') {
					if (spawnMode === 'enoent') {
						setTimeout(() => p.emit('error', Object.assign(new Error('spawn gtk-launch ENOENT'), {code: 'ENOENT'})), 5)
						return p
					}
					if (spawnMode === 'exit1') {
						setTimeout(() => p.emit('exit', 1, null), 5)
						return p
					}
					if (args[0] === 'alpha') {
						setTimeout(() => {
							clients.push({address: '0x55a100000001', title: 'Alpha build log', class: 'foot', workspace: {id: 1}, at: [0, 0], size: [400, 300], mapped: true, floating: true})
						}, 15)
						setTimeout(() => {
							clients.push({address: '0x55a1000000aa', title: 'Alpha Main', class: 'alpha-app', workspace: {id: 11}, at: [0, 0], size: [900, 600], mapped: true, floating: true})
						}, 80)
					} else if (args[0] === 'beta') {
						const seq = ++betaLaunchSeq
						const addr = moveOffRailOnWake
							? '0x55a1000000cc'
							: moveOffRailOnLuaResize
								? '0x55a1000000dd'
								: seq === 1
									? '0x55a1000000bb'
									: `0x55a1000000b${seq}`
						setTimeout(() => {
							clients.push({address: openOnPhysical ? '0x55a1000000ee' : addr, title: `Beta Main ${seq}`, class: 'beta-app', workspace: {id: openOnPhysical ? 1 : 11}, at: [0, 0], size: [900, 600], mapped: true, floating: !moveOffRailOnWake})
						}, 40)
					}
				}
				return p
			},
		})

		const catalog = await hypr.procedures['hyprland.apps'].run()
		assert.equal(catalog.find((a) => a.id === 'demo')?.hasIcon, true)
		assert.equal(catalog.find((a) => a.id === 'evil')?.hasIcon, false, 'outside .svg path must be rejected by icon jail')
		assert.equal(catalog.find((a) => a.id === 'shadowed'), undefined, 'Hidden=true in higher-priority dir must shadow lower-priority .desktop')
		assert.ok((await hypr.readAppIcon('demo'))?.data.toString('utf8').includes('<svg'), 'inside .svg positive control must succeed')
		assert.equal(await hypr.readAppIcon('evil'), null, 'outside .svg must be refused by readAppIcon')
		assert.equal(await hypr.readAppIcon('sym'), null, 'symlinks escaping iconRoots to an outside .svg must be refused')
		assert.equal(await hypr.readAppIcon('../outside'), null)

		await hypr.procedures['hyprland.clipboardWrite'].run({text: 'hello-rail'})
		assert.equal((await hypr.procedures['hyprland.clipboardRead'].run()).text, 'hello-rail')
		pasteMode = 'empty'
		assert.equal((await hypr.procedures['hyprland.clipboardRead'].run()).text, '', 'empty clipboard stderr should return empty text')
		pasteMode = 'error'
		await assert.rejects(() => hypr.procedures['hyprland.clipboardRead'].run(), /Failed to connect to a compositor/)
		pasteMode = 'ok'
		await assert.rejects(() => hypr.procedures['hyprland.clipboardWrite'].run({text: '\u{1F600}'.repeat(40_000)}), /Clipboard text too large/)
		failCopy = true
		await assert.rejects(() => hypr.procedures['hyprland.clipboardWrite'].run({text: 'fail'}), /wl-copy failed/)
		failCopy = false

		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: '../evil'}), /Invalid application ID/)
		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: 'not-installed'}), /not installed/)

		// Failed RAIL-1 setup must refuse launch before spawning
		railMissing = true
		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: 'alpha'}), /RAIL-1/)
		railMissing = false

		// Failed baseline inventory must refuse launch rather than claiming physical windows
		clientsFail = true
		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: 'alpha'}), /hyprctl/)
		clientsFail = false

		// Missing gtk-launch and non-zero exit must fail fast
		spawnMode = 'enoent'
		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: 'alpha'}), /Failed to launch/)
		spawnMode = 'exit1'
		await assert.rejects(() => hypr.procedures['hyprland.launch'].run({id: 'alpha'}), /exited with status 1/)
		spawnMode = 'ok'

		const [resA, resB] = await Promise.all([
			hypr.procedures['hyprland.launch'].run({id: 'alpha'}),
			hypr.procedures['hyprland.launch'].run({id: 'beta'}),
		])
		assert.equal(resA.window?.address, '0x55a1000000aa')
		assert.equal(resB.window?.address, '0x55a1000000bb')

		// Concurrent indistinguishable same-class launches must return ambiguous instead of swapping windows
		const [dup1, dup2] = await Promise.all([
			hypr.procedures['hyprland.launch'].run({id: 'beta'}),
			hypr.procedures['hyprland.launch'].run({id: 'beta'}),
		])
		assert.equal(dup1.ambiguous, true)
		assert.equal(dup2.ambiguous, true)
		assert.equal(dup1.window, null)
		assert.equal(dup2.window, null)

		// If a window moves to a physical workspace during wakeRailOutput(), launch must NOT float, resize, or move it
		mutatedAddrs.length = 0
		moveOffRailOnWake = true
		const movedRes = await hypr.procedures['hyprland.launch'].run({id: 'beta'})
		moveOffRailOnWake = false
		assert.equal(movedRes.window, null)
		assert.equal(
			mutatedAddrs.some((s) => s.includes('0x55a1000000cc')),
			false,
			`must not float/resize/move window after it moved off RAIL-1, saw: ${mutatedAddrs.join('; ')}`,
		)

		// An app whose window opens on the physical display (focus left RAIL-1, or it reused a running
		// process) is still found, and brought to RAIL-1, instead of the launch giving up after 15 s.
		mutatedAddrs.length = 0
		openOnPhysical = true
		const physicalRes = await hypr.procedures['hyprland.launch'].run({id: 'beta'})
		openOnPhysical = false
		assert.equal(physicalRes.window?.address, '0x55a1000000ee')
		assert.equal(physicalRes.window?.workspace, 11)
		assert.ok(mutatedAddrs.some((m) => m.includes('window.move') && m.includes('0x55a1000000ee') && m.includes('workspace = 11')), mutatedAddrs.join('; '))

		// If Lua resize fails and the window leaves RAIL-1 before the legacy resizewindowpixel fallback runs, fallback must NOT dispatch
		mutatedAddrs.length = 0
		moveOffRailOnLuaResize = true
		const movedOnLuaRes = await hypr.procedures['hyprland.launch'].run({id: 'beta'})
		moveOffRailOnLuaResize = false
		assert.equal(movedOnLuaRes.window, null)
		assert.equal(
			mutatedAddrs.some((s) => s.includes('0x55a1000000dd') && (s.includes('resizewindowpixel') || s.includes('movewindowpixel') || s.includes('window.move'))),
			false,
			`must not send legacy resizewindowpixel or window move after window left RAIL-1 during failed Lua resize, saw: ${mutatedAddrs.join('; ')}`,
		)

		// Synchronous 8-launch cap must reject the 9th concurrent launch immediately before any await
		spawnMode = 'exit1'
		const nine = await Promise.allSettled(
			Array.from({length: 9}, () => hypr.procedures['hyprland.launch'].run({id: 'alpha'})),
		)
		assert.ok(
			nine.some((r) => r.status === 'rejected' && /Too many applications are launching/.test(r.reason?.message || '')),
			'9th concurrent launch must be rejected synchronously by MAX_PENDING_LAUNCHES',
		)
		spawnMode = 'ok'

		// windowsSnapshot() must reject empty stdout
		const hyprEmpty = createHyprland({
			dataDir: join(root, 'd2'),
			home,
			runtimeDir: root,
			vaapiDevice: join(root, 'nonexistent'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
		})
		await assert.rejects(() => hyprEmpty.windowsSnapshot())
		hyprEmpty.close()
		hypr.close()

		// Real Unix .socket2.sock live event + instance-change reconnect + HTTP 413 clipboard + SSE logout revocation + clean shutdown
		const sock2Path = join(root, 'hypr', 'sig123', '.socket2.sock')
		const sock2Sockets = []
		const sock2Server = net.createServer((c) => {
			sock2Sockets.push(c)
		})
		await new Promise((resolve) => sock2Server.listen(sock2Path, resolve))
		let sock2Server2 = null

		const accounts = await openAccounts(data)
		await accounts.createOwner({name: 'Chris', password: 'correct horse'})
		const state = JSON.parse(await readFile(join(data, 'accounts.json'), 'utf8'))
		state.users.push({...state.users[0], userId: 'member', name: 'Pat', role: 'member'})
		await writeFile(join(data, 'accounts.json'), JSON.stringify(state, null, '\t'))

		const readNextSseEvent = async (reader, bufRef, timeoutMs = 4000) => {
			const deadline = Date.now() + timeoutMs
			while (true) {
				const sep = bufRef.buf.indexOf('\n\n')
				if (sep >= 0) {
					const block = bufRef.buf.slice(0, sep)
					bufRef.buf = bufRef.buf.slice(sep + 2)
					const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
					if (dataLines.length) return JSON.parse(dataLines.join('\n'))
					continue
				}
				const rem = deadline - Date.now()
				if (rem <= 0) throw new Error('Timed out waiting for SSE event')
				const next = await Promise.race([
					reader.read(),
					new Promise((_, rej) => setTimeout(() => rej(new Error('SSE read timeout')), rem)),
				])
				if (next.done) return null
				bufRef.buf += Buffer.from(next.value).toString('utf8')
			}
		}

		let liveWindows = [{address: '0x55a1b2c3d4e0', title: 'Demo', class: 'demo', workspace: {id: 1}, at: [0, 0], size: [640, 480], mapped: true}]
		d = await startOmarchyd({
			port: 0,
			dataDir: data,
			home,
			updaterOptions: {autoCheck: false, installerCheck: true},
			hyprlandOptions: {
				runtimeDir: root,
				appDirs: [appsDir],
				vaapiDevice: join(root, 'nonexistent'),
				async exec(cmd, args) {
					if (cmd === 'pkg-config') return {ok: false, stdout: '', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: '[]', stderr: ''}
					if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: JSON.stringify(liveWindows), stderr: ''}
					return {ok: false, stdout: '', stderr: ''}
				},
			},
		})
		const login = async (userId) => {
			const r = await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId, password: 'correct horse', client: {id: 't'}})})
			const body = await r.json()
			return {authorization: `Bearer ${body.result.data.accessToken}`}
		}
		const owner = await login('owner')
		const member = await login('member')

		assert.equal((await fetch(`${d.url}/hyprland/app-icon?id=demo`)).status, 401)
		assert.equal((await fetch(`${d.url}/hyprland/events`)).status, 401)
		assert.equal((await fetch(`${d.url}/hyprland/app-icon?id=demo`, {headers: member})).status, 403)
		assert.equal((await fetch(`${d.url}/hyprland/events`, {headers: member})).status, 403)

		// Oversized clipboardWrite must map PAYLOAD_TOO_LARGE -> HTTP 413
		const bigClipRes = await fetch(`${d.url}/trpc/hyprland.clipboardWrite`, {
			method: 'POST',
			headers: {...owner, 'content-type': 'application/json'},
			body: JSON.stringify({text: 'x'.repeat(130 * 1024)}),
		})
		assert.equal(bigClipRes.status, 413, 'oversized clipboard write must return HTTP 413')

		const iconRes = await fetch(`${d.url}/hyprland/app-icon?id=demo`, {headers: owner})
		assert.equal(iconRes.status, 200)
		assert.equal(iconRes.headers.get('content-type'), 'image/svg+xml')
		assert.equal(iconRes.headers.get('content-security-policy'), 'sandbox')
		assert.equal(iconRes.headers.get('x-content-type-options'), 'nosniff')

		const ac = new AbortController()
		const sseRes = await fetch(`${d.url}/hyprland/events`, {headers: owner, signal: ac.signal})
		assert.equal(sseRes.status, 200)
		const reader = sseRes.body.getReader()
		const bufRef = {buf: ''}
		const firstEvt = await readNextSseEvent(reader, bufRef)
		assert.equal(firstEvt?.type, 'windows')
		assert.equal(firstEvt?.authoritative, true)
		assert.equal(firstEvt?.instanceId, 'sig123')
		assert.equal(firstEvt?.windows?.[0]?.address, '0x55a1b2c3d4e0')

		// Emit a real .socket2.sock openwindow event and verify SSE delivers it
		sock2Sockets[0].write('openwindow>>55a1b2c3d4ee,11,demo,Live Window\n')
		let liveEvt = null
		for (let i = 0; i < 4; i++) {
			const e = await readNextSseEvent(reader, bufRef, 3000)
			if (e?.type === 'openwindow') {
				liveEvt = e
				break
			}
		}
		assert.equal(liveEvt?.address, '0x55a1b2c3d4ee')

		// Simulate compositor restart with a new instance signature (sig456) and verify reconnect emits authoritative snapshot with new instanceId
		await mkdir(join(root, 'hypr', 'sig456'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig456', '.socket.sock'), '')
		sock2Server2 = net.createServer((c) => {
			sock2Sockets.push(c)
		})
		await new Promise((resolve) => sock2Server2.listen(join(root, 'hypr', 'sig456', '.socket2.sock'), resolve))
		await rm(join(root, 'hypr', 'sig123', '.socket.sock'), {force: true})
		liveWindows = [{address: '0x55a1b2c3d4ff', title: 'After Restart', class: 'demo', workspace: {id: 11}, at: [0, 0], size: [800, 600], mapped: true}]
		for (const s of sock2Sockets) s.destroy()
		const reconnectedEvt = await readNextSseEvent(reader, bufRef, 5000)
		assert.equal(reconnectedEvt?.type, 'windows')
		assert.equal(reconnectedEvt?.authoritative, true)
		assert.equal(reconnectedEvt?.instanceId, 'sig456')
		assert.equal(reconnectedEvt?.windows?.[0]?.address, '0x55a1b2c3d4ff')

		// user.logout must terminate the live SSE stream immediately
		await fetch(`${d.url}/trpc/user.logout`, {method: 'POST', headers: {...owner, 'content-type': 'application/json'}, body: '{}'})
		const afterLogout = await readNextSseEvent(reader, bufRef, 2000)
		assert.equal(afterLogout, null, 'user.logout must end active /hyprland/events SSE response')
		ac.abort()
		await reader.cancel().catch(() => {})

		// Open a fresh SSE subscriber and verify d.close() completes cleanly without hanging
		const owner2 = await login('owner')
		const sseRes2 = await fetch(`${d.url}/hyprland/events`, {headers: owner2})
		assert.equal(sseRes2.status, 200)
		const reader2 = sseRes2.body.getReader()
		const bufRef2 = {buf: ''}
		await readNextSseEvent(reader2, bufRef2)
		const closedOk = await Promise.race([
			d.close().then(() => true),
			new Promise((r) => setTimeout(() => r(false), 3000)),
		])
		d = null
		assert.equal(closedOk, true, 'daemon close() must complete promptly with an active SSE subscriber')
		await reader2.cancel().catch(() => {})
		await new Promise((resolve) => sock2Server.close(resolve))
		if (sock2Server2) await new Promise((resolve) => sock2Server2.close(resolve))
	} finally {
		if (d) await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

test('scoreProfileCandidate ranks 60 FPS HEVC above stuttery 10-bit and rewards WAN-sized streams on high RTT', () => {
	const failed = scoreProfileCandidate({ok: false, fps: 0, targetFps: 60, p95Ms: 999, codec: 'hevc', quality: 20, bitrate: 16000}, {rttMs: 46})
	assert.equal(failed, 0)

	const hevc60Wan = scoreProfileCandidate(
		{ok: true, fps: 59.8, targetFps: 60, p95Ms: 17.4, keyKb: 320, codec: 'hevc', quality: 20, bitrate: 16000},
		{rttMs: 46},
	)
	const hevc10Slow = scoreProfileCandidate(
		{ok: true, fps: 42.9, targetFps: 60, p95Ms: 26.5, keyKb: 490, codec: 'hevc10', quality: 21, bitrate: 16000},
		{rttMs: 46},
	)
	const h26460Wan = scoreProfileCandidate(
		{ok: true, fps: 59.9, targetFps: 60, p95Ms: 17.1, keyKb: 390, codec: 'h264', quality: 21, bitrate: 16000},
		{rttMs: 46},
	)
	const bloatedWan = scoreProfileCandidate(
		{ok: true, fps: 59.8, targetFps: 60, p95Ms: 17.4, keyKb: 720, codec: 'hevc', quality: 20, bitrate: 34000},
		{rttMs: 60},
	)
	const ultraLanOnLan = scoreProfileCandidate(
		{ok: true, fps: 60.5, targetFps: 60, p95Ms: 17.3, keyKb: 1550, codec: 'hevc', quality: 14, bitrate: 80000},
		{rttMs: 3},
	)
	const lowBitrateOnLan = scoreProfileCandidate(
		{ok: true, fps: 60.5, targetFps: 60, p95Ms: 17.3, keyKb: 300, codec: 'hevc', quality: 21, bitrate: 16000},
		{rttMs: 3},
	)

	assert.ok(hevc60Wan > hevc10Slow + 20, `locked 60 FPS HEVC (${hevc60Wan}) must beat 42.9 FPS HEVC10 (${hevc10Slow})`)
	assert.ok(hevc60Wan > h26460Wan, `HEVC (${hevc60Wan}) should beat H.264 (${h26460Wan}) at matched FPS`)
	assert.ok(hevc60Wan > bloatedWan, `WAN-sized stream (${hevc60Wan}) should beat oversized bitrate/keyframe (${bloatedWan}) on high RTT`)
	assert.ok(ultraLanOnLan > lowBitrateOnLan, `Ultra LAN 80 Mbps QP 14 (${ultraLanOnLan}) must beat 16 Mbps QP 21 (${lowBitrateOnLan}) on low-RTT LAN`)
})

test('stream profiler runs benchmarks safely, handles encoder fallback, serializes concurrent saves, and rejects corrupted stores', async () => {
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-prof-'))
	try {
		await writeFile(join(root, 'wayland-1'), '')
		await mkdir(join(root, 'hypr', 'sig123'), {recursive: true})
		await writeFile(join(root, 'hypr', 'sig123', '.socket.sock'), '')
		const fakeBin = join(root, 'fake-capture')
		await writeFile(fakeBin, '#!/bin/sh\n')

		let modeScenario = 'bench-ok'
		const spawnedCodecArgs = []
		const hypr = createHyprland({
			dataDir: join(root, 'data'),
			home: root,
			runtimeDir: root,
			captureBin: fakeBin,
			vaapiDevice: join(root, 'wayland-1'),
			async exec(cmd, args) {
				if (cmd === 'hyprctl' && args[0] === 'monitors') {
					return {ok: true, stdout: JSON.stringify([{id: 1, name: 'RAIL-1', x: 0, y: 0, width: 3840, height: 2160, scale: 1, refreshRate: 60, dpmsStatus: true, activeWorkspace: {id: 11}, solitaryBlockedBy: []}]), stderr: ''}
				}
				if (cmd === 'hyprctl' && args[0] === 'clients') return {ok: true, stdout: '[]', stderr: ''}
				return {ok: true, stdout: 'ok', stderr: ''}
			},
			spawnImpl(_cmd, args) {
				const codecIdx = args.indexOf('--codec')
				const reqCodec = codecIdx >= 0 ? args[codecIdx + 1] : 'h264'
				spawnedCodecArgs.push(reqCodec)
				const ch = Object.assign(new EventEmitter(), {
					stdin: new PassThrough(),
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					killed: false,
					exitCode: null,
					kill(sig) {
						if (this.killed) return
						this.killed = true
						setImmediate(() => {
							if (this.exitCode !== null) return
							this.exitCode = 0
							this.emit('exit', 0, sig || null)
							this.emit('close', 0, sig || null)
						})
					},
				})
				if (modeScenario === 'bench-ok' || modeScenario === 'bench-fallback-h264') {
					const reportedEnc = modeScenario === 'bench-fallback-h264' ? 'h264_vaapi_dmabuf' : `${reqCodec}_vaapi_dmabuf`
					setImmediate(() => {
						ch.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, encoder: reportedEnc, codec: 'hev1'}))))
						let count = 0
						const iv = setInterval(() => {
							if (ch.killed || ch.exitCode !== null) {
								clearInterval(iv)
								return
							}
							const pl = Buffer.concat([Buffer.from([count === 0 ? 1 : 0]), Buffer.alloc(8), Buffer.alloc(1200)])
							ch.stdout.write(framePacket(2, pl))
							count++
						}, 14)
						ch.once('exit', () => clearInterval(iv))
					})
				} else if (modeScenario === 'bench-fail') {
					setImmediate(() => {
						ch.stdout.write(framePacket(3, Buffer.from(JSON.stringify({error: 'VA-API busy'}))))
					})
				} else if (modeScenario === 'bench-late-error') {
					setImmediate(() => {
						ch.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, encoder: `${reqCodec}_vaapi_dmabuf`, codec: 'hev1'}))))
						let count = 0
						const iv = setInterval(() => {
							if (ch.killed || ch.exitCode !== null) {
								clearInterval(iv)
								return
							}
							if (count < 8) {
								const pl = Buffer.concat([Buffer.from([count === 0 ? 1 : 0]), Buffer.alloc(8), Buffer.alloc(1200)])
								ch.stdout.write(framePacket(2, pl))
								count++
							} else {
								clearInterval(iv)
								ch.stdout.write(framePacket(3, Buffer.from(JSON.stringify({error: 'GPU hang mid-stream'}))))
							}
						}, 16)
						ch.once('exit', () => clearInterval(iv))
					})
				} else if (modeScenario === 'bench-early-crash') {
					setImmediate(() => {
						ch.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, encoder: `${reqCodec}_vaapi_dmabuf`, codec: 'hev1'}))))
						let count = 0
						const iv = setInterval(() => {
							if (ch.killed || ch.exitCode !== null) {
								clearInterval(iv)
								return
							}
							if (count < 8) {
								const pl = Buffer.concat([Buffer.from([count === 0 ? 1 : 0]), Buffer.alloc(8), Buffer.alloc(1200)])
								ch.stdout.write(framePacket(2, pl))
								count++
							} else {
								clearInterval(iv)
								ch.exitCode = 1
								ch.emit('exit', 1, null)
								ch.emit('close', 1, null)
							}
						}, 16)
						ch.once('exit', () => clearInterval(iv))
					})
				} else if (modeScenario === 'bench-burst-stall') {
					// Even after a 950 ms cold startup delay, a 24-frame burst followed by silence must observe the full 750 ms window and fail
					setTimeout(() => {
						if (ch.killed || ch.exitCode !== null) return
						ch.stdout.write(framePacket(1, Buffer.from(JSON.stringify({width: 1920, height: 1080, fps: 60, encoder: `${reqCodec}_vaapi_dmabuf`, codec: 'hev1'}))))
						let count = 0
						const iv = setInterval(() => {
							if (ch.killed || ch.exitCode !== null || count >= 24) {
								clearInterval(iv)
								return
							}
							const pl = Buffer.concat([Buffer.from([count === 0 ? 1 : 0]), Buffer.alloc(8), Buffer.alloc(1200)])
							ch.stdout.write(framePacket(2, pl))
							count++
						}, 16)
						ch.once('exit', () => clearInterval(iv))
					}, 950)
				}
				return ch
			},
		})

		const ran = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'mac-studio-chrome',
			deviceName: 'macOS · Chrome',
			deviceHint: 'Chrome · macOS · 5120x2880',
			clientCodecs: ['hevc', 'h264'],
			clientRttMs: 46,
			saveAsActive: true,
		})
		assert.ok(ran.winner && ran.winner.id === 'mac-studio-chrome')
		assert.equal(ran.winner.codec, 'hevc')
		assert.equal(ran.winner.fps, 60)
		assert.ok(ran.winner.measuredFps >= 35, `sustained benchmark FPS should stay high, got ${ran.winner.measuredFps}`)
		assert.equal(ran.activeByDevice['mac-studio-chrome'], 'mac-studio-chrome')

		// Unmeasured RTT (undefined) must NOT fabricate measuredRttMs: 20 on the saved profile
		const noRtt = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'no-rtt-dev',
			clientCodecs: ['hevc444'],
			saveAsActive: true,
		})
		assert.equal(noRtt.rttMs, null)
		assert.equal(noRtt.winner?.codec, 'hevc444', 'hevc444-only client on non-LAN RTT must benchmark RTT-appropriate hevc444 and never inject h264')
		assert.equal(noRtt.winner?.measuredRttMs, undefined, 'unmeasured RTT must not be stored as fabricated 20 ms')
		assert.ok(spawnedCodecArgs.at(-1) === 'hevc444', 'must only spawn advertised hevc444 codec')

		await assert.rejects(
			() => hypr.procedures['hyprland.profileRun'].run({deviceId: 'none-dev', clientCodecs: [], clientRttMs: 20}),
			/no supported WebCodecs/i,
		)

		// Fatal error packet AFTER 8 good frames must fail the candidate (never persist as winner)
		modeScenario = 'bench-late-error'
		const lateErrRun = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'late-err-dev',
			clientCodecs: ['hevc'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		assert.equal(lateErrRun.winner, null, 'worker emitting fatal error after good frames must be rejected')
		assert.equal(lateErrRun.results[0]?.ok, false)

		// Unexpected early exit AFTER 8 good frames must fail the candidate
		modeScenario = 'bench-early-crash'
		const crashRun = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'crash-dev',
			clientCodecs: ['hevc'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		assert.equal(crashRun.winner, null, 'worker exiting prematurely before benchmark window must be rejected')
		assert.equal(crashRun.results[0]?.ok, false)

		// 24-frame burst followed by silence through the 750ms window must FAIL (never win/activate even as sole codec!)
		modeScenario = 'bench-burst-stall'
		const stallRun = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'mac-studio-chrome',
			clientCodecs: ['h264'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		assert.equal(stallRun.winner, null, 'stalled encoder must not win or replace existing active profile')
		assert.equal(stallRun.results[0]?.ok, false, 'stalled encoder candidate must be marked ok=false')
		assert.equal(stallRun.activeByDevice['mac-studio-chrome'], 'mac-studio-chrome')

		modeScenario = 'bench-fallback-h264'
		const unadvertisedFallback = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'hevc-only-dev',
			deviceName: 'HEVC Only',
			clientCodecs: ['hevc'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		assert.equal(unadvertisedFallback.winner, null, 'must not activate unadvertised fallback codec')

		const advertisedFallback = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'fallback-dev',
			deviceName: 'Fallback',
			clientCodecs: ['hevc', 'h264'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		assert.equal(advertisedFallback.winner?.codec, 'h264')
		assert.ok(advertisedFallback.winner?.name.includes('H.264'), `fallback winner label must reflect actual codec H.264, got ${advertisedFallback.winner?.name}`)

		modeScenario = 'bench-fail'
		const failedRun = await hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'mac-studio-chrome',
			clientCodecs: ['hevc'],
			clientRttMs: 46,
			saveAsActive: true,
		})
		assert.equal(failedRun.winner, null)
		assert.equal(failedRun.activeByDevice['mac-studio-chrome'], 'mac-studio-chrome')

		// Strict validation on profileSave: reject invalid string IDs, non-string numeric IDs, and unsupported codecs
		await hypr.procedures['hyprland.profileSave'].run({profile: {id: '7', name: 'String Seven', codec: 'hevc', fps: 60, bitrate: 20000}})
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 7, name: 'Numeric Seven', codec: 'h264', fps: 60, bitrate: 16000}}),
			/Invalid profile ID/,
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: null, name: 'Null ID', codec: 'h264', fps: 60, bitrate: 16000}}),
			/Invalid profile ID/,
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({id: '   ', codec: 'h264', fps: 60, bitrate: 16000}),
			/Invalid profile ID/,
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'ok-id', name: 'Null Dev', codec: 'h264', fps: 60, bitrate: 16000}, deviceId: null}),
			/Invalid device ID/,
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'ok-id', name: 'Empty Dev', codec: 'h264', fps: 60, bitrate: 16000}, deviceId: ''}),
			/Invalid device ID/,
		)
		assert.equal(
			(await hypr.procedures['hyprland.profiles'].run()).profiles.find((p) => p.id === '7')?.name,
			'String Seven',
			'numeric id: 7 must not overwrite existing string id "7"',
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: '../bad/id', name: 'Bad', codec: 'hevc', fps: 60, bitrate: 20000}}),
			/Invalid profile ID/,
		)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'bad-codec', name: 'Bad', codec: 'av1', fps: 60, bitrate: 20000}}),
			/Unsupported video codec/,
		)

		// Factory reset clears saved profiles and prevents an in-flight profileRun from persisting stale data
		modeScenario = 'bench-ok'
		const inFlight = hypr.procedures['hyprland.profileRun'].run({
			deviceId: 'pre-reset-dev',
			clientCodecs: ['hevc'],
			clientRttMs: 20,
			saveAsActive: true,
		})
		await new Promise((r) => setTimeout(r, 80))
		await hypr.resetProfiles()
		const afterResetRun = await inFlight
		assert.equal(afterResetRun.winner, null, 'in-flight profileRun interrupted by factory reset must not save a winner')
		const postResetStore = await hypr.procedures['hyprland.profiles'].run()
		assert.equal(postResetStore.profiles.length, 0, 'resetProfiles must leave saved profiles empty')

		await Promise.all([
			hypr.procedures['hyprland.profileSave'].run({
				profile: {id: 'lan-a', name: 'LAN Ultra', codec: 'hevc', fps: 60, bitrate: 120000, quality: 12, compression: 7},
				deviceId: 'dev-a',
				activate: true,
			}),
			hypr.procedures['hyprland.profileSave'].run({
				profile: {id: 'lan-b', name: 'LAN B', codec: 'h264', fps: 60, bitrate: 20000, quality: 20, compression: 7},
				deviceId: 'dev-b',
				activate: true,
			}),
		])
		const listed = await hypr.procedures['hyprland.profiles'].run()
		const lanA = listed.profiles.find((p) => p.id === 'lan-a')
		assert.ok(lanA && listed.profiles.some((p) => p.id === 'lan-b'))
		assert.equal(lanA.bitrate, 120000)
		assert.equal(lanA.quality, 12)
		assert.equal(listed.activeByDevice['dev-a'], 'lan-a')
		assert.equal(listed.activeByDevice['dev-b'], 'lan-b')

		// Malformed JSON, wrong-shape JSON, and invalid activeByDevice/defaultProfileId references must fail strict reads & list RPC
		await writeFile(
			join(root, 'data', 'hyprland-profiles.json'),
			JSON.stringify({
				profiles: [{id: '7', name: 'Seven', codec: 'h264', fps: 60, bitrate: 20000, quality: 20, compression: 7}],
				activeByDevice: {laptop: 7},
				defaultProfileId: '7',
			}),
		)
		await assert.rejects(() => hypr.procedures['hyprland.profiles'].run(), /corrupted/i)
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'should-fail', name: 'X', codec: 'h264', fps: 60, bitrate: 16000}}),
			/corrupted/i,
		)
		await writeFile(join(root, 'data', 'hyprland-profiles.json'), '{"profiles":"not-an-array"}')
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'should-fail', name: 'X', codec: 'h264', fps: 60, bitrate: 16000}}),
			/corrupted/i,
		)
		await writeFile(join(root, 'data', 'hyprland-profiles.json'), '{not-valid-json')
		await assert.rejects(
			() => hypr.procedures['hyprland.profileSave'].run({profile: {id: 'should-fail', name: 'X', codec: 'h264', fps: 60, bitrate: 16000}}),
			/corrupted/i,
		)

		hypr.close()
	} finally {
		await rm(root, {recursive: true, force: true})
	}
})

test('native C capture engine compiles cleanly with -Wall -Wextra -Werror when Linux VA-API headers are present', async (t) => {
	const pkgs = ['gbm', 'libdrm', 'libva', 'libva-drm', 'libavcodec', 'libavfilter', 'libavutil']
	try {
		execFileSync('gcc', ['--version'], {stdio: 'ignore'})
		execFileSync('pkg-config', ['--exists', ...pkgs], {stdio: 'ignore'})
	} catch {
		t.skip('gcc + Linux gbm/libdrm/libva/libavcodec pkg-config packages not present on this host')
		return
	}
	const dir = await mkdtemp(join(os.tmpdir(), 'omarchy-hypr-c-'))
	try {
		const flags = execFileSync('pkg-config', ['--cflags', '--libs', ...pkgs], {encoding: 'utf8'}).trim().split(/\s+/)
		const out = join(dir, 'hypr-rail-capture')
		execFileSync('gcc', ['-O2', '-Wall', '-Wextra', '-Werror', '-pthread', RAIL_C, '-o', out, ...flags, '-ldl'], {stdio: 'pipe'})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
