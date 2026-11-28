// Terminal for omarchyd: your login shell (or a shell inside an app's container) in a real pseudo-
// terminal, over a WebSocket. The pty comes from util-linux `script`, which every Arch system has,
// so there is no native module to build. Runs as you, like the rest of omarchyd.
//
// Shells persist: closing the terminal (or losing the connection, or switching devices) leaves the
// shell running, and opening it again picks up where you left off, with what was on screen. A shell
// ends when you `exit` it or ask for a new one. With tmux installed, your shell also outlives
// omarchyd itself (a restart or an update): it runs in a tmux session of its own, started outside
// omarchyd's service, and the terminal attaches to it. Without tmux, it ends when omarchyd stops.
import {execFile, spawn} from 'node:child_process'
import {mkdir, readdir, readFile, readlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname} from 'node:path'

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Start a shell in a pty. `command` is an argv run instead of the login shell (for app shells).
export function openShell({cols, rows, command = null, cwd = os.homedir(), env = process.env, home = os.homedir()}) {
	const shell = env.SHELL && /^\/[\w/.-]+$/.test(env.SHELL) ? env.SHELL : '/bin/bash'
	const inner = command ? command.map(quote).join(' ') : `${quote(shell)} -l`
	// -ixon: Ctrl+S no longer pauses the terminal (it looked frozen until Ctrl+Q). Programs that want
	// Ctrl+S, like nano, still get it.
	return spawn('script', ['-q', '-f', '-e', '-c', `stty cols ${cols} rows ${rows} -ixon 2>/dev/null; exec ${inner}`, '/dev/null'], {
		cwd,
		env: {...env, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env.LANG || 'C.UTF-8'},
	})
}

// ---- tmux: shells that outlive omarchyd -------------------------------------------------------
// Its own server (-L omarchy) and settings, so your own tmux setup is untouched. No status bar, the
// normal screen (so the terminal's own scrollback keeps working), and the latest device's size.
export const TMUX_CONF = `# My Own Data Center's terminal sessions. Written by omarchyd; changes here are replaced.
set -g status off
set -g history-limit 50000
set -g default-terminal "screen-256color"
set -s escape-time 0
set -g mouse off
set -g set-clipboard on
set -g window-size latest
set -g aggressive-resize on
set -ga terminal-overrides ',xterm*:smcup@:rmcup@'
# Ctrl+S must not pause the terminal (it looked frozen until Ctrl+Q).
set -g default-command 'stty -ixon 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l'
`
const TMUX_NAME = /^[A-Za-z0-9._-]{1,40}$/

export function createTmux({conf, socket = 'omarchy', exec = execFile} = {}) {
	const run = (cmd, args, timeout = 10_000) =>
		new Promise((resolve) => exec(cmd, args, {timeout}, (error, stdout) => resolve({ok: !error, stdout: String(stdout ?? '')})))
	const base = () => ['-L', socket, '-f', conf]
	let ready = null
	const available = () =>
		(ready ??= (async () => {
			if (!(await run('tmux', ['-V'])).ok) return false
			await mkdir(dirname(conf), {recursive: true}).catch(() => {})
			await writeFile(conf, TMUX_CONF, {mode: 0o600}).catch(() => {})
			return true
		})())
	const has = async (name) => (await run('tmux', [...base(), 'has-session', '-t', `=${name}`])).ok
	return {
		available,
		has,
		/** The argv that attaches to session `name`, starting it first (outside omarchyd's service) if needed; null without tmux. */
		async attachCommand(name, cols, rows) {
			if (!TMUX_NAME.test(name) || !(await available())) return null
			if (!(await has(name))) {
				const create = [...base(), 'new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows)]
				// Its own scope, so stopping or restarting omarchyd doesn't stop it. Without a user
				// systemd it still runs, and lasts as long as omarchyd does.
				const scoped = await run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'tmux', ...create], 20_000)
				if (!scoped.ok && !(await has(name)) && !(await run('tmux', create)).ok) return null
			}
			return ['tmux', ...base(), 'attach-session', '-t', `=${name}`]
		},
		async kill(name) {
			if (TMUX_NAME.test(name) && (await available())) await run('tmux', [...base(), 'kill-session', '-t', `=${name}`])
		},
	}
}

// The pty `script` made for the shell: the terminal device its child reads from (/dev/pts/N).
async function ptyOf(pid) {
	for (const p of await readdir('/proc').catch(() => [])) {
		if (!/^\d+$/.test(p)) continue
		const stat = await readFile(`/proc/${p}/stat`, 'utf8').catch(() => '')
		// pid (comm) state ppid ... — comm can hold spaces and parentheses, so read after the last ')'.
		if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== pid) continue
		const tty = await readlink(`/proc/${p}/fd/0`).catch(() => '')
		if (/^\/dev\/pts\/\d+$/.test(tty)) return tty
	}
	return null
}

// The browser asks for a new size with a binary frame holding {"type":"resize","cols":…,"rows":…}.
// What you type is always text, so the two never mix. Anything else binary is ignored.
export function parseResize(data, isBinary) {
	if (!isBinary) return null
	try {
		const m = JSON.parse(Buffer.from(data).toString('utf8'))
		const cols = Number(m?.cols)
		const rows = Number(m?.rows)
		if (m?.type !== 'resize' || !Number.isInteger(cols) || !Number.isInteger(rows)) return null
		if (cols < 10 || cols > 500 || rows < 4 || rows > 300) return null
		return {cols, rows}
	} catch {
		return null
	}
}

const KEEP = 512 * 1024 // what's replayed when you come back: the most recent output, up to this much
const MAX_SESSIONS = 12 // per person (your shell plus app shells); the oldest unused one goes first

const GROUND = 0
const ESC = 1
const ESC_INTER = 2
const CSI = 3
const STRING = 4
const STRING_ESC = 5
const TRACKED_PRIVATE_MODES = new Set([1, 1000, 1002, 1003, 1004, 1006, 1015, 2004])
const ALT_SCREEN_MODES = new Set([47, 1047, 1049])
const MOUSE_TRACK_MODES = [1000, 1002, 1003]

function resetModes(modes) {
	modes.altScreen = null
	modes.hideCursor = false
	modes.privateModes.clear()
}

function applyCsiMode(modes, params, inter, finalByte) {
	if (params === '' && inter === '!' && finalByte === 0x70) return void resetModes(modes)
	if (inter !== '' || !params.startsWith('?') || (finalByte !== 0x68 && finalByte !== 0x6c)) return
	const enable = finalByte === 0x68
	for (const part of params.slice(1).split(';')) {
		if (!/^\d+$/.test(part)) continue
		const n = Number(part)
		if (ALT_SCREEN_MODES.has(n)) {
			modes.altScreen = enable ? n : null
		} else if (n === 25) {
			modes.hideCursor = !enable
		} else if (TRACKED_PRIVATE_MODES.has(n)) {
			if (enable) {
				if (MOUSE_TRACK_MODES.includes(n)) for (const m of MOUSE_TRACK_MODES) modes.privateModes.delete(m)
				modes.privateModes.add(n)
			} else {
				modes.privateModes.delete(n)
			}
		}
	}
}

function createAnsiScanner(modes = null) {
	let state = GROUND
	let params = ''
	let inter = ''
	const enterEsc = () => {
		state = ESC
		params = ''
		inter = ''
	}
	const stepEsc = (b) => {
		if (b === 0x5b) {
			state = CSI
			params = ''
			inter = ''
		} else if (b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
			state = STRING
		} else if (b >= 0x20 && b <= 0x2f) {
			state = ESC_INTER
		} else if (b >= 0x30 && b <= 0x7e) {
			if (b === 0x63 && modes) resetModes(modes)
			state = GROUND
		} else if (b >= 0x80) {
			state = GROUND
		}
	}
	const step = (b) => {
		if (state === STRING) {
			if (b === 0x07 || b === 0x18 || b === 0x1a) state = GROUND
			else if (b === 0x1b) state = STRING_ESC
			return
		}
		if (state === STRING_ESC) {
			if (b === 0x5c || b === 0x18 || b === 0x1a) state = GROUND
			else if (b === 0x1b) enterEsc()
			else {
				enterEsc()
				stepEsc(b)
			}
			return
		}
		if (b === 0x1b) return void enterEsc()
		if (b === 0x18 || b === 0x1a) {
			state = GROUND
			params = ''
			inter = ''
			return
		}
		if (state === GROUND) return
		if (state === ESC) return void stepEsc(b)
		if (state === ESC_INTER) {
			if ((b >= 0x30 && b <= 0x7e) || b >= 0x80) state = GROUND
			return
		}
		if (state === CSI) {
			if (b >= 0x30 && b <= 0x3f) {
				if (inter === '' && params.length < 256) params += String.fromCharCode(b)
			} else if (b >= 0x20 && b <= 0x2f) {
				if (inter.length < 16) inter += String.fromCharCode(b)
			} else if (b >= 0x40 && b <= 0x7e) {
				if (modes) applyCsiMode(modes, params, inter, b)
				state = GROUND
				params = ''
				inter = ''
			} else if (b >= 0x80) {
				state = GROUND
				params = ''
				inter = ''
			}
		}
	}
	return {step, inEscape: () => state !== GROUND}
}

function trimReplay(all, keep, modes) {
	const target = Math.max(0, all.length - keep)
	const scanner = createAnsiScanner(modes)
	let i = 0
	while (i < target) scanner.step(all[i++])
	while (i < all.length && scanner.inEscape()) scanner.step(all[i++])
	while (i < all.length && (all[i] & 0xc0) === 0x80) i++
	const look = createAnsiScanner(null)
	const limit = Math.min(all.length, i + 4096)
	for (let j = i; j < limit; j++) {
		if (all[j] === 10 && !look.inEscape()) {
			while (i <= j) scanner.step(all[i++])
			break
		}
		look.step(all[j])
	}
	return Buffer.from(all.subarray(i))
}

function formatModePrefix(modes) {
	let out = ''
	if (modes.altScreen) out += `\x1b[?${modes.altScreen}h`
	for (const n of [...modes.privateModes].sort((a, b) => a - b)) out += `\x1b[?${n}h`
	if (modes.hideCursor) out += '\x1b[?25l'
	return out
}

// Rolling terminal output buffer that trims on escape/UTF-8 boundaries and remembers active modes.
export function createReplayHistory(keep = KEEP) {
	let chunks = []
	let size = 0
	const modes = {altScreen: null, hideCursor: false, privateModes: new Set()}
	return {
		push(d) {
			if (!d?.length) return
			chunks.push(d)
			size += d.length
			if (size > keep * 1.5) {
				const trimmed = trimReplay(Buffer.concat(chunks), keep, modes)
				chunks = trimmed.length ? [trimmed] : []
				size = trimmed.length
			}
		},
		snapshot() {
			const prefix = formatModePrefix(modes)
			return prefix ? Buffer.concat([Buffer.from(prefix, 'ascii'), ...chunks]) : Buffer.concat(chunks)
		},
	}
}

// Persistent shells, one per person and place (your own shell, or one per app).
export function createTerminalSessions({exec = execFile, tmux = null} = {}) {
	const sessions = new Map() // `${userId}:${appId || ''}` -> session

	// Resize to the latest size asked for, one at a time (a window being dragged asks many times).
	const resizeTo = (s, cols, rows) => {
		s.want = {cols, rows}
		s.resizing ??= (async () => {
			// Start on the next tick: if there were nothing to do, a synchronous finish would clear
			// s.resizing before it's even set, and leave it looking busy for good.
			await null
			try {
				while (s.want) {
					const {cols, rows} = s.want
					s.want = null
					if (s.child.exitCode === null && (cols !== s.cols || rows !== s.rows)) await resize(s, cols, rows)
				}
			} finally {
				s.resizing = null
				// What was typed while it resized goes in now, so it runs at the new size.
				const held = s.held ?? []
				s.held = null
				for (const d of held) if (s.child.stdin.writable) s.child.stdin.write(d)
			}
		})()
		return s.resizing
	}
	const resize = async (s, cols, rows) => {
		s.pty ??= await ptyOf(s.child.pid)
		if (!s.pty) return false
		// Setting the size signals the programs running in it (SIGWINCH), so full-screen ones redraw.
		// Bounded: what's typed is held while this runs, so a stuck stty froze the terminal for good.
		await new Promise((r) => exec('stty', ['-F', s.pty, 'cols', String(cols), 'rows', String(rows)], {timeout: 3_000}, () => r()))
		s.cols = cols
		s.rows = rows
		return true
	}

	const end = (key, s) => {
		if (sessions.get(key) === s) sessions.delete(key)
		// `script` ignores SIGHUP; on SIGTERM it stops and the kernel hangs up the shell inside.
		if (s.child.exitCode === null) s.child.kill('SIGTERM')
	}

	function start(key, {cols, rows, shell}) {
		const child = openShell({cols, rows, ...shell})
		// A keystroke can meet a pipe the shell just closed, before stdin is marked not writable.
		// Nothing else listens for that EPIPE, and it would take the whole daemon down.
		child.stdin.on('error', () => {})
		const s = {child, cols, rows, history: createReplayHistory(), sockets: new Set(), used: Date.now(), pty: null}
		const out = (d) => {
			s.history.push(d)
			for (const ws of s.sockets) {
				if (ws.readyState !== ws.OPEN) continue
				// A browser that stopped reading must not make the server queue the shell's output without
				// limit. Let it go: the shell keeps running and the next connection replays the history.
				if (ws.bufferedAmount > 1024 * 1024) {
					ws.terminate()
					continue
				}
				ws.send(d, {binary: true})
			}
		}
		child.stdout.on('data', out)
		child.stderr.on('data', out)
		const closeAll = (code, why) => {
			if (sessions.get(key) === s) sessions.delete(key)
			for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.close(code, why)
			s.sockets.clear()
		}
		child.on('exit', () => closeAll(1000, 'Shell ended'))
		child.on('error', () => closeAll(1011, 'Couldn’t start a shell'))
		// Never more than a few at once: the one left alone longest stops first.
		const mine = [...sessions].filter(([k]) => k.startsWith(key.split(':')[0] + ':'))
		if (mine.length >= MAX_SESSIONS) {
			const [oldKey, old] = mine.filter(([, x]) => !x.sockets.size).sort((a, b) => a[1].used - b[1].used)[0] ?? mine.sort((a, b) => a[1].used - b[1].used)[0]
			end(oldKey, old)
		}
		sessions.set(key, s)
		return s
	}

	// Attach a WebSocket: to the shell that's already there (resumed), or a new one.
	// `fresh` ends the old shell first. `shell` is how to start one ({command, cwd, env, home}).
	async function attach(ws, {userId, appId = '', cols, rows, fresh = false, shell = {}}) {
		const key = `${userId}:${appId}`
		let s = sessions.get(key)
		if (s && (fresh || s.child.exitCode !== null)) {
			end(key, s)
			s = null
		}
		let resumed = !!s
		if (!s) {
			// Your own shell (not an app's) lives in tmux when it's there, so it outlives omarchyd.
			// (Only the server's owner has a shell here, so one session.)
			if (tmux && !shell.command && !appId) {
				if (fresh) await tmux.kill('main')
				const kept = await tmux.has('main').catch(() => false)
				const command = await tmux.attachCommand('main', cols, rows).catch(() => null)
				if (command) {
					shell = {...shell, command}
					resumed = kept
				}
			}
			// Another device may have opened it while this one waited on tmux.
			s = sessions.get(key)
			if (s && s.child.exitCode === null) resumed = true
			else s = start(key, {cols, rows, shell})
		}
		const session = s
		session.used = Date.now()
		// Control messages are text frames; the shell's output is always binary.
		const tell = (to, m) => to.readyState === to.OPEN && to.send(JSON.stringify(m))
		// Everyone else watching this shell hears its new size, so their screens match.
		const tellOthers = () => {
			for (const other of session.sockets) if (other !== ws) tell(other, {type: 'size', cols: session.cols, rows: session.rows})
		}
		// Listen straight away: nothing typed (or resized) while a resumed screen is being set up is lost.
		ws.on('message', (d, isBinary) => {
			session.used = Date.now()
			if (isBinary) {
				// This device's window changed size: the shell takes it (the latest to ask wins).
				const size = parseResize(d, true)
				if (size) resizeTo(session, size.cols, size.rows).then(tellOthers)
				return
			}
			if (session.resizing) return void (session.held ??= []).push(d)
			if (session.child.stdin.writable) session.child.stdin.write(d)
		})
		// Closing the terminal only lets go of the shell; it keeps running.
		// Before any resume await: a tab that closes while the shell resizes must leave,
		// or it stays in session.sockets and keeps counting as attached.
		const leave = () => {
			session.sockets.delete(ws)
			session.used = Date.now()
		}
		ws.on('close', leave)
		ws.on('error', leave)
		if (resumed) {
			// What was on screen, at the size it was drawn, then this device's size (the terminal
			// reflows, and full-screen programs redraw for it).
			tell(ws, {type: 'session', resumed: true, cols: session.cols, rows: session.rows})
			const replay = session.history.snapshot()
			if (replay.length && ws.readyState === ws.OPEN) ws.send(replay, {binary: true})
			session.sockets.add(ws) // from here on it gets what the shell writes, like any other
			if (session.cols !== cols || session.rows !== rows) {
				await resizeTo(session, cols, rows)
				tell(ws, {type: 'size', cols: session.cols, rows: session.rows})
				tellOthers()
			} else {
				// Same size: nudge it anyway so full-screen programs repaint over the replay.
				await resizeTo(session, cols, Math.max(4, rows - 1))
				await resizeTo(session, cols, rows)
			}
		} else {
			tell(ws, {type: 'session', resumed: false, cols, rows})
			session.sockets.add(ws)
		}
		// A close during the resume await is normally handled above. If the socket is
		// already not open and that event was missed, drop it now.
		if (ws.readyState !== ws.OPEN) leave()
		return {resumed}
	}

	return {
		attach,
		// For tests and Settings: which shells are running.
		list: () => [...sessions].map(([key, s]) => ({key, cols: s.cols, rows: s.rows, attached: s.sockets.size, used: s.used})),
		close() {
			for (const [key, s] of sessions) end(key, s)
		},
	}
}
