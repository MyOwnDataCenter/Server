// Apps that run on the server itself rather than in a container. They appear in the App Store and
// in your apps like any other (Open, Start, Stop, logs, uninstall), but are installed through the
// root helper instead of Podman.
//
// Tailscale is one because it can't safely run in a container here. Containers run rootless, and a
// rootless Tailscale can only use its userspace networking, in which every connection to the
// server's Tailscale address is handed to 127.0.0.1 on the same port (wgengine/netstack: dialIP =
// 127.0.0.1). Everything My Own Data Center keeps on localhost would then be open to the whole tailnet:
// omarchyd itself and each app's private port behind the sign-in gateway. Installed on the system,
// the way Omarchy's own menu does it, Tailscale gets a real network interface, so the tailnet
// reaches only what the server offers to the network anyway (My Own Data Center and your apps'
// ports, behind their sign-in).
import {execFile, spawn as nodeSpawn} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import http from 'node:http'

import {RpcError} from './rpc.mjs'
import {stoppedMessage} from './exec-error.mjs'

export const TAILSCALE_SOCKET = '/run/tailscale/tailscaled.sock'
const HELPER_FILE = '/usr/local/libexec/omarchy-server/helper.mjs'
// The one-time setup, for a server whose helper is older than Tailscale support: the same steps as
// Omarchy's own menu, typed by you in a terminal (so you give sudo your password, not us).
export const TAILSCALE_SETUP_COMMAND = 'sudo pacman -S --needed tailscale && sudo systemctl enable --now tailscaled && sudo tailscale set --operator="$(id -un)"'

const execRun = (cmd, args) =>
	new Promise((resolve, reject) => execFile(cmd, args, {timeout: 30_000, maxBuffer: 4 * 1024 * 1024}, (error, stdout, stderr) => (error ? reject(new Error(stoppedMessage(cmd, error, 30_000) ?? String(stderr || error.message).trim())) : resolve(String(stdout)))))

export const SYSTEM_PERMISSIONS = {
	'system-software': {
		label: 'Install software on the server itself',
		detail: 'It isn’t a container: it is installed on your server with administrator rights, as Omarchy’s own menu installs it, and runs as a system service. You become its operator, so My Own Data Center can sign it in and out for you.',
	},
}

const TAILSCALE_LISTING = {
	id: 'tailscale',
	name: 'Tailscale',
	tagline: 'Reach your server and its apps from anywhere, privately',
	icon: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/tailscale.png',
	category: 'networking',
	port: 8240,
	path: '',
	description: [
		'Tailscale puts this server on your own private network (your tailnet), together with your phone, laptop and other devices, wherever they are. Open My Own Data Center and your apps at the server’s Tailscale address from anywhere, without opening any port to the internet. Connections are end-to-end encrypted with WireGuard.',
		'Open it and choose Log in to connect it to your Tailscale account. Its page then shows this server’s Tailscale name and address: on your other devices, install Tailscale, sign in to the same account, and go to http://that-address:7780.',
		'It is installed on the server itself, the same way Omarchy’s menu installs Tailscale (the official package and its service), not in a container. If you already installed Tailscale from Omarchy’s menu, this adds its page here and leaves your setup as it is; uninstalling then leaves Tailscale installed.',
	].join('\n\n'),
	developer: 'Tailscale Inc.',
	website: 'https://tailscale.com',
	repo: 'https://github.com/tailscale/tailscale',
	gallery: [],
	dependencies: [],
	shared: false,
	permissions: ['system-software'],
	system: true,
}

export function createSystemApps({helper, helperFile = HELPER_FILE, run = execRun, spawn = nodeSpawn, socketPath = TAILSCALE_SOCKET, tailscaleBin = 'tailscale', restartDelayMs = 3000, ports = {}}) {
	const listing = {...TAILSCALE_LISTING, ...(ports.tailscale ? {port: ports.tailscale} : {})}
	const webs = new Map()

	// Tailscale's own local API, over its socket. As the operator, the owner may read and change it.
	function localApi(method, path, body) {
		return new Promise((resolve, reject) => {
			const req = http.request({socketPath, path: `/localapi/v0/${path}`, method, timeout: 10_000, headers: {host: 'local-tailscaled.sock', ...(body ? {'content-type': 'application/json'} : {})}}, (res) => {
				let data = ''
				res.setEncoding('utf8')
				res.on('data', (c) => (data += c))
				res.on('end', () => (res.statusCode < 300 ? resolve(data) : reject(new Error(`Tailscale answered ${res.statusCode}: ${data.trim().slice(0, 200)}`))))
			})
			req.on('timeout', () => req.destroy(new Error('Tailscale didn’t answer')))
			req.on('error', reject)
			req.end(body ? JSON.stringify(body) : undefined)
		})
	}
	const setRunning = (on) => localApi('PATCH', 'prefs', {WantRunning: on, WantRunningSet: true})
	const helperSays = async (verb) => {
		try {
			return await helper(verb, [])
		} catch (e) {
			if (/Unknown action/i.test(e.message)) throw needsSetup()
			throw e
		}
	}
	// Already usable without root: Tailscale is installed, running, and you're its operator (an empty
	// change to its settings is accepted only from its operator or root).
	const canDrive = () => localApi('PATCH', 'prefs', {}).then(() => true, () => false)
	// Whether the installed helper knows a verb, without running it. An older helper simply lacks it.
	// If the file can't be read, assume it does and let the helper answer.
	const helperCan = (verb) => readFile(helperFile, 'utf8').then((t) => t.includes(`'${verb}'`), () => true)
	const needsSetup = () => new RpcError('PRECONDITION_FAILED', `Tailscale needs a one-time setup on the server first. In a terminal, run:\n${TAILSCALE_SETUP_COMMAND}\nThen install it again.`)
	// Make sure Tailscale is installed, running and yours to drive: nothing to do if it already is,
	// else the helper sets it up, else (older helper) you're asked to run the setup once yourself.
	async function ensure(app) {
		if (await canDrive()) return
		if (!(await helperCan('tailscale-setup'))) throw needsSetup()
		const r = JSON.parse(await helperSays('tailscale-setup'))
		// Only what My Own Data Center installed is removed again; a Tailscale you set up yourself stays.
		if (r.installedPackage) app.installedPackage = true
	}
	async function version() {
		return (await run(tailscaleBin, ['version'])).split('\n')[0].trim() || undefined
	}

	// Its page: `tailscale web` (Tailscale's sign-in page), run as the owner on a private port that
	// only the app's gateway (behind My Own Data Center's sign-in) forwards to. On a normal Linux system
	// this page has no sign-in of its own, so it must never listen anywhere else.
	function startWeb(app) {
		stopWeb(app)
		const w = {stopping: false, child: null, timer: null, log: []}
		const keep = (text) => {
			w.log.push(...String(text).split('\n').filter(Boolean))
			if (w.log.length > 500) w.log.splice(0, w.log.length - 500)
		}
		const launch = () => {
			const child = spawn(tailscaleBin, ['web', '--listen', `127.0.0.1:${app.internalPort}`], {stdio: ['ignore', 'pipe', 'pipe']})
			w.child = child
			child.stdout?.on('data', keep)
			child.stderr?.on('data', keep)
			child.on('error', (e) => keep(`Couldn’t start Tailscale’s page: ${e.message}`))
			child.on('close', (code, signal) => {
				w.child = null
				if (w.stopping) return
				keep(`Tailscale’s page stopped (${code ?? signal}); starting it again.`)
				w.timer = setTimeout(launch, restartDelayMs)
				w.timer.unref?.()
			})
		}
		launch()
		webs.set(app.id, w)
	}
	function stopWeb(app) {
		const w = webs.get(app.id)
		if (!w) return
		w.stopping = true
		clearTimeout(w.timer)
		w.child?.kill('SIGTERM')
		webs.delete(app.id)
	}

	return {
		listings: () => [{...listing}],
		isSystem: (id) => id === listing.id,
		permissions: (id) => (id === listing.id ? [{id: 'system-software', ...SYSTEM_PERMISSIONS['system-software'], what: ['the “tailscale” package from Arch’s repositories', 'the tailscaled system service']}] : []),

		// For the install review: null when nothing is needed from you, else the command to run once.
		async setup(id) {
			if (id !== listing.id) return null
			if ((await canDrive()) || (await helperCan('tailscale-setup'))) return null
			return {command: TAILSCALE_SETUP_COMMAND}
		},
		async install(app) {
			await ensure(app)
			app.version = (await version().catch(() => null)) ?? app.version
			startWeb(app)
		},
		// After omarchyd starts: bring its page back.
		resume(app) {
			startWeb(app)
		},
		// "running" while Tailscale is connected or waiting for you to log in; "stopped" when you
		// stopped it (or its service isn't running).
		async liveState() {
			try {
				const st = JSON.parse(await localApi('GET', 'status?peers=false'))
				return st.BackendState === 'Stopped' ? 'stopped' : 'running'
			} catch {
				return 'stopped'
			}
		},
		async start(app) {
			try {
				await setRunning(true)
			} catch {
				// Its service isn't running (stopped, or the package was removed): set it up again.
				await ensure(app)
				await setRunning(true)
			}
			if (!webs.has(app.id)) startWeb(app)
		},
		async stop() {
			await setRunning(false)
		},
		async restart(app) {
			await setRunning(false).catch(() => {})
			await setRunning(true)
			startWeb(app)
		},
		async uninstall(app) {
			// Stop the page only after the package is gone. A failed remove must leave it running.
			if (app.installedPackage) await helperSays('tailscale-remove')
			stopWeb(app)
		},
		async logs(app) {
			const service = await run('journalctl', ['-u', 'tailscaled.service', '-n', '300', '--no-pager', '-o', 'short-iso']).catch(() => 'Reading the tailscaled service’s log needs administrator rights here. In a terminal: sudo journalctl -u tailscaled\n')
			return `tailscaled (system service)\n${service}\nTailscale’s page (tailscale web)\n${(webs.get(app.id)?.log ?? []).join('\n')}\n`
		},
		close() {
			for (const id of [...webs.keys()]) stopWeb({id})
		},
	}
}
