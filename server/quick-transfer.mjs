// Quick transfer: a phone scans a QR code to download one file, or to upload into one folder,
// without signing in. The link itself is the permission: 192 random bits, good for 10 minutes,
// for exactly one file or one folder, acting as the person who made it (their access, their
// session). Signing out, or stopping the share, ends it at once.
import {randomBytes} from 'node:crypto'

export const TRANSFER_TTL_MS = 10 * 60 * 1000
const MAX_PER_SESSION = 20

// Theme variables the portal copies from the app, and the values they may hold (colours only).
export const THEME_VARS = ['--bg', '--bg-solid', '--fg', '--fg-2', '--muted', '--glass', '--glass-2', '--line', '--sheet', '--accent', '--accent-text', '--on-accent']
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/a-z-]{1,60}\)|transparent)$/i

export function cleanTheme(theme) {
	const out = {}
	if (!theme || typeof theme !== 'object') return out
	for (const k of THEME_VARS) {
		const v = typeof theme[k] === 'string' ? theme[k].trim() : ''
		if (v && v.length <= 64 && COLOR.test(v)) out[k] = v
	}
	return out
}

// The app's own background, from the address the app shows it at. Anything else: none.
export function cleanBackground(bg) {
	if (typeof bg !== 'string') return null
	const color = bg.trim()
	if (/^#[0-9a-f]{6}$/i.test(color)) return {kind: 'color', value: color.toLowerCase()}
	let u
	try {
		u = new URL(bg, 'http://x')
	} catch {
		return null
	}
	if (u.host !== 'x' && !/^https?:$/.test(u.protocol)) return null
	let m = /^\/api\/wallpaper\/(\d{1,3})$/.exec(u.pathname)
	if (m) return {kind: 'wallpaper', id: m[1]}
	m = /^\/api\/omarchy\/background\/(current|[0-9a-f]{16})$/.exec(u.pathname)
	if (m) return {kind: 'omarchy', id: m[1]}
	if (u.pathname === '/api/background') return {kind: 'photo'}
	return null
}

// A name for a file arriving from a phone: one plain name, nothing that climbs or hides.
export function cleanUploadName(name) {
	if (typeof name !== 'string') return null
	const n = name
		.normalize('NFC')
		.replace(/[\u0000-\u001f\u007f/\\]/g, '_')
		.trim()
	if (!n || n === '.' || n === '..' || n.startsWith('.') || Buffer.byteLength(n) > 240) return null
	return n
}

export function createQuickTransfer({ttlMs = TRANSFER_TTL_MS, now = () => Date.now()} = {}) {
	const shares = new Map()
	const sweep = () => {
		const t = now()
		for (const [k, s] of shares) if (s.expiresAt <= t) shares.delete(k)
	}
	return {
		create({kind, path, name, size, sid, accountId, theme, bg}) {
			sweep()
			if (kind !== 'download' && kind !== 'upload') throw new Error('kind')
			let mine = 0
			for (const s of shares.values()) if (s.sid === sid) mine += 1
			if (mine >= MAX_PER_SESSION) {
				// Oldest of this session's goes first.
				const oldest = [...shares.entries()].filter(([, s]) => s.sid === sid).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
				if (oldest) shares.delete(oldest[0])
			}
			const token = randomBytes(24).toString('base64url')
			const share = {kind, path, name, size: Number.isFinite(size) && size >= 0 ? size : null, sid, accountId, theme: cleanTheme(theme), bg: cleanBackground(bg), expiresAt: now() + ttlMs, uploads: 0}
			shares.set(token, share)
			return {token, expiresAt: share.expiresAt}
		},
		// The share for a link, if it is still good (and its maker still signed in).
		get(token, {sessionAlive = () => true} = {}) {
			if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null
			const s = shares.get(token)
			if (!s) return null
			if (s.expiresAt <= now() || !sessionAlive(s.sid)) {
				shares.delete(token)
				return null
			}
			return s
		},
		revoke(token, sid) {
			const s = shares.get(token)
			if (!s || s.sid !== sid) return false
			return shares.delete(token)
		},
		endSession(sid) {
			for (const [k, s] of shares) if (s.sid === sid) shares.delete(k)
		},
		size: () => (sweep(), shares.size),
	}
}

// The portal page. Script and styles come from /transfer-portal.js and inline styles, which the
// app's Content-Security-Policy allows; nothing else is loaded from anywhere.
export function portalHtml() {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>My Own Data Center · Quick transfer</title>
<style>
:root{--bg:#0b0b10;--fg:#f3f3f5;--fg-2:#c8c8d0;--muted:#8a8a96;--glass:rgba(22,22,30,.72);--line:rgba(255,255,255,.12);--accent:hsl(24 90% 50%);--on-accent:#fff;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg-solid,var(--bg));color:var(--fg);font:16px/1.45 'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
.bg{position:fixed;inset:0;background:var(--bg-solid,var(--bg)) center/cover no-repeat;z-index:0}
.bg::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.55))}
main{position:relative;z-index:1;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px max(16px,env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.card{width:100%;max-width:420px;background:var(--glass);border:1px solid var(--line);border-radius:26px;padding:22px;backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);box-shadow:0 18px 50px rgba(0,0,0,.35)}
.brand{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font-size:22px;margin:0 0 4px;word-break:break-word}
.sub{color:var(--fg-2);margin:0 0 18px;font-size:14px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:52px;border:0;border-radius:16px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn[aria-disabled=true],.btn:disabled{opacity:.5;pointer-events:none}
.timer{margin:14px 0 0;text-align:center;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
ul{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:8px}
li{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;font-size:14px}
li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li .ok{color:#40a02b}li .bad{color:#e64553}
.gone{text-align:center}
input[type=file]{display:none}
</style>
</head>
<body>
<div class="bg" id="bg"></div>
<main><div class="card" id="card"><p class="brand">My Own Data Center</p><h1>Opening…</h1></div></main>
<script src="/transfer-portal.js"></script>
</body>
</html>`
}

export const PORTAL_JS = `(() => {
	const token = location.pathname.split('/')[2] || ''
	const base = '/t/' + encodeURIComponent(token)
	const card = document.getElementById('card')
	const el = (tag, attrs, ...kids) => {
		const n = document.createElement(tag)
		for (const [k, v] of Object.entries(attrs || {})) k === 'text' ? (n.textContent = v) : n.setAttribute(k, v)
		for (const k of kids) n.append(k)
		return n
	}
	const size = (b) => b == null ? '' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB'
	const gone = (msg) => card.replaceChildren(el('p', {class: 'brand', text: 'My Own Data Center'}), el('h1', {class: 'gone', text: 'This link has ended'}), el('p', {class: 'sub gone', text: msg || 'Quick transfer links last 10 minutes. Ask for a new QR code.'}))
	let ends = 0
	const timer = el('p', {class: 'timer'})
	const tick = () => {
		const left = Math.max(0, ends - Date.now())
		if (!left) return gone()
		const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60
		timer.textContent = 'Link ends in ' + m + ':' + String(s).padStart(2, '0')
	}
	fetch(base + '/info', {cache: 'no-store'}).then((r) => r.ok ? r.json() : null).then((info) => {
		if (!info) return gone()
		for (const [k, v] of Object.entries(info.theme || {})) document.documentElement.style.setProperty(k, v)
		if (info.background) document.getElementById('bg').style.backgroundImage = 'url(' + base + '/background)'
		ends = Date.now() + info.remainingMs
		setInterval(tick, 1000)
		tick()
		if (info.kind === 'download') {
			const a = el('a', {class: 'btn', href: base + '/file', download: info.name, text: 'Download'})
			card.replaceChildren(el('p', {class: 'brand', text: 'My Own Data Center'}), el('h1', {text: info.name}), el('p', {class: 'sub', text: size(info.size) || 'File'}), a, timer)
			return
		}
		const input = el('input', {type: 'file', multiple: ''})
		const pick = el('button', {class: 'btn', type: 'button', text: 'Choose files to upload'})
		const list = el('ul')
		pick.onclick = () => input.click()
		input.onchange = async () => {
			const files = [...input.files]
			input.value = ''
			pick.disabled = true
			for (const f of files) {
				const state = el('span', {text: '0%'})
				list.append(el('li', {}, el('span', {text: f.name}), state))
				const ok = await new Promise((done) => {
					const x = new XMLHttpRequest()
					x.open('POST', base + '/upload?name=' + encodeURIComponent(f.name))
					x.setRequestHeader('x-modc-transfer', '1')
					x.setRequestHeader('content-type', 'application/octet-stream')
					x.upload.onprogress = (e) => { if (e.lengthComputable) state.textContent = Math.floor((e.loaded / e.total) * 100) + '%' }
					x.onload = () => {
						let msg = ''
						try { msg = JSON.parse(x.responseText).error?.message || '' } catch {}
						done(x.status >= 200 && x.status < 300 ? true : msg || 'Failed')
					}
					x.onerror = () => done('Failed')
					x.send(f)
				})
				state.textContent = ok === true ? 'Sent' : ok
				state.className = ok === true ? 'ok' : 'bad'
				if (ok !== true && /ended/i.test(ok)) break
			}
			pick.disabled = Date.now() >= ends
		}
		card.replaceChildren(el('p', {class: 'brand', text: 'My Own Data Center'}), el('h1', {text: 'Upload to ' + info.name}), el('p', {class: 'sub', text: 'Files go straight into this folder on the server.'}), pick, input, list, timer)
	}, () => gone('Can’t reach the server. Are you on the same network?'))
})()
`
