// What this server runs and whether its OS has updates waiting, for the assistant (#442).
// Only checks: Omarchy's own omarchy-version and omarchy-update-available, and pacman-contrib's
// checkupdates, which syncs into a temporary database and never touches the system's.
import {execFile} from 'node:child_process'
import {access} from 'node:fs/promises'
import os from 'node:os'
import {delimiter, join} from 'node:path'

const CHECK_TTL_MS = 30 * 60 * 1000
const CHECK_TIMEOUT_MS = 60_000
const MAX_LISTED = 20

// Resolves with the exit code and output; a missing program is code 127.
const execRun = (cmd, args, {env, timeout = CHECK_TIMEOUT_MS} = {}) =>
	new Promise((resolve) =>
		execFile(cmd, args, {env, timeout, maxBuffer: 4 * 1024 * 1024}, (error, stdout) =>
			resolve({code: error ? (error.code === 'ENOENT' ? 127 : typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? '')}),
		),
	)
const exists = (p) => access(p).then(() => true, () => false)
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)

export function createOsInfo({release, home = os.homedir(), env = process.env, run = execRun, now = Date.now, kernel = os.release(), dirs} = {}) {
	const omarchyPath = env.OMARCHY_PATH || '/usr/share/omarchy'
	// dirs lets a test describe a machine with no Omarchy install. The default still looks at
	// the usual places, including this computer's /usr/share/omarchy.
	const bins = dirs ?? [...new Set([join(omarchyPath, 'bin'), '/usr/share/omarchy/bin', join(home, '.local', 'share', 'omarchy', 'bin')])]
	let cache = null
	let pending = null

	async function omarchyBin() {
		for (const dir of bins) if (await exists(join(dir, 'omarchy-version'))) return dir
		return null
	}
	async function check() {
		const dir = await omarchyBin()
		// Omarchy's scripts call each other by name, so its bin goes first on PATH.
		const childEnv = {...env, OMARCHY_PATH: env.OMARCHY_PATH || omarchyPath, PATH: [dir, env.PATH].filter(Boolean).join(delimiter)}
		const out = {os: release?.pretty ?? 'Linux', kernel, omarchy: null, packages: null, checkedAt: now()}
		if (dir) {
			const version = await run(join(dir, 'omarchy-version'), [], {env: childEnv})
			// Exit 0 lists what is waiting; exit 1 prints "Omarchy is up to date".
			const update = await run(join(dir, 'omarchy-update-available'), [], {env: childEnv})
			out.omarchy = {
				version: version.code === 0 ? lines(version.stdout)[0] ?? null : null,
				updateAvailable: update.code === 0 ? true : update.code === 1 ? false : null,
				...(update.code === 0 ? {waiting: lines(update.stdout).slice(0, MAX_LISTED)} : {}),
			}
		}
		// checkupdates: exit 0 with one line per package, 2 when there is nothing, anything else is an error.
		const pkgs = await run('checkupdates', ['--nocolor'], {env: childEnv})
		if (pkgs.code === 0 || pkgs.code === 2) {
			const list = pkgs.code === 0 ? lines(pkgs.stdout) : []
			out.packages = {waiting: list.length, sample: list.slice(0, MAX_LISTED)}
		}
		return out
	}
	// A check reaches the mirrors, so one result serves everyone for half an hour.
	async function get() {
		if (cache && now() - cache.checkedAt < CHECK_TTL_MS) return cache
		pending ??= check().then(
			(value) => ((cache = value), (pending = null), value),
			(error) => ((pending = null), Promise.reject(error)),
		)
		return pending
	}
	return {get}
}
