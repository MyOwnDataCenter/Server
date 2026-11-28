// `bin/omarchy-server` option handling, help output, and service status exit codes.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'omarchy-server')
const root = await mkdtemp(join(os.tmpdir(), 'omarchy-server-cli-'))
after(() => rm(root, {recursive: true, force: true}))

async function makeSandbox(name, overrides = {}) {
	const home = join(root, name)
	const bin = join(root, `${name}-bin`)
	const log = join(root, `${name}.log`)
	await mkdir(home, {recursive: true})
	await mkdir(bin, {recursive: true})

	const stubs = {
		systemctl: overrides.systemctl ?? 'echo "systemctl $*" >>"$FAKE_LOG"\nexit 0',
		journalctl: overrides.journalctl ?? 'echo "journalctl $*" >>"$FAKE_LOG"\nexit 0',
		'xdg-open': overrides['xdg-open'] ?? 'echo "xdg-open $*" >>"$FAKE_LOG"\nexit 0',
		ip: overrides.ip ?? 'exit 1',
		'notify-send': overrides['notify-send'] ?? 'exit 0',
	}
	for (const [cmd, body] of Object.entries(stubs)) {
		await writeFile(join(bin, cmd), `#!/bin/sh\n${body}\n`)
		await chmod(join(bin, cmd), 0o755)
	}
	return {home, bin, log}
}

function runCli(box, args, extraEnv = {}) {
	const r = spawnSync('bash', [SCRIPT, ...args], {
		env: {
			HOME: box.home,
			PATH: `${box.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
			FAKE_LOG: box.log,
			...extraEnv,
		},
		encoding: 'utf8',
		timeout: 15_000,
	})
	return {status: r.status, stdout: r.stdout, stderr: r.stderr}
}

const readLog = (box) => readFile(box.log, 'utf8').catch(() => '')

test('#607: --help and -h after any command print help to stdout, exit 0, and run nothing', async () => {
	const box = await makeSandbox('help-after-cmd')
	const cases = [
		['stop', '--help'],
		['restart', '-h'],
		['start', '--help'],
		['open', '--help'],
		['status', '--help'],
		['waybar', '--help'],
		['widget', '--help'],
		['widget', 'on', '--help'],
		['logs', '--help'],
		['uninstall', '--help'],
		['uninstall', '--purge', '--help'],
		['reset-password', '--help'],
	]
	for (const args of cases) {
		const r = runCli(box, args)
		assert.equal(r.status, 0, `${args.join(' ')} status: stderr=${r.stderr}`)
		assert.equal(r.stderr, '', `${args.join(' ')} stderr should be empty`)
		assert.match(r.stdout, /omarchy-server/, `${args.join(' ')} stdout should show usage`)
	}
	assert.equal(await readLog(box), '', 'no side-effect binaries should be called for --help/-h')

	const helpStop = runCli(box, ['help', 'stop'])
	assert.equal(helpStop.status, 0, helpStop.stderr)
	assert.match(helpStop.stdout, /omarchy-server stop/)

	const helpUnknown = runCli(box, ['help', 'bogus'])
	assert.equal(helpUnknown.status, 2)
	assert.match(helpUnknown.stderr, /Unknown command: bogus/)
})

test('#607: unknown or extra options after commands are refused with exit 2 and run nothing', async () => {
	const box = await makeSandbox('extra-args')
	const cases = [
		['start', '--version'],
		['stop', '--bogus'],
		['restart', '--bogus'],
		['open', '--bogus'],
		['status', '--bogus'],
		['waybar', '--bogus'],
		['widget', 'on', 'extra'],
		['widget', 'bogus'],
		['logs', '--bogus'],
		['logs', '-n', 'abc'],
		['logs', '-n'],
		['logs', '--lines=abc'],
		['logs', '--since'],
	]
	for (const args of cases) {
		const r = runCli(box, args)
		assert.equal(r.status, 2, `${args.join(' ')} expected exit 2, got ${r.status} (stdout=${r.stdout} stderr=${r.stderr})`)
		assert.match(r.stderr, /Use: omarchy-server /, `${args.join(' ')} should print Use: on stderr`)
	}
	assert.equal(await readLog(box), '', 'no side-effect binaries should be called on bad options')
})

test('#607: logs handles -f, --follow, -n, --lines, and --since', async () => {
	const box = await makeSandbox('logs-opts')

	assert.equal(runCli(box, ['logs']).status, 0)
	assert.equal(runCli(box, ['logs', '-f']).status, 0)
	assert.equal(runCli(box, ['logs', '--follow']).status, 0)
	assert.equal(runCli(box, ['logs', '-n', '200']).status, 0)
	assert.equal(runCli(box, ['logs', '-n200']).status, 0)
	assert.equal(runCli(box, ['logs', '--lines=200']).status, 0)
	assert.equal(runCli(box, ['logs', '--since', 'today']).status, 0)
	assert.equal(runCli(box, ['logs', '--follow', '-n', '50']).status, 0)

	const lines = (await readLog(box)).trim().split('\n')
	assert.deepEqual(lines, [
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -n 80 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -f',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -f',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -n 200 --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now --since today --no-pager',
		'journalctl --user -u omarchyd -u omarchy-server-web -u omarchy-server-desktop -u omarchy-server-desktop-now -n 50 -f',
	])
})

test('#260: start and restart exit 1 when services fail or are inactive', async () => {
	const failBox = await makeSandbox('start-fail', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\ncase "$*" in *is-active*) exit 3;; esac\nexit 1',
	})
	for (const cmd of ['start', 'restart']) {
		const r = runCli(failBox, [cmd])
		assert.equal(r.status, 1, `${cmd} should exit 1 when systemctl fails`)
		assert.match(r.stdout, /Didn't start\. See: omarchy-server logs/)
	}

	const crashBox = await makeSandbox('start-crash', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\ncase "$*" in *is-active*) exit 3;; esac\nexit 0',
	})
	for (const cmd of ['start', 'restart']) {
		const r = runCli(crashBox, [cmd])
		assert.equal(r.status, 1, `${cmd} should exit 1 when services are inactive after start`)
		assert.match(r.stdout, /Didn't start\. See: omarchy-server logs/)
	}

	const okBox = await makeSandbox('start-ok', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\nexit 0',
	})
	for (const cmd of ['start', 'restart']) {
		const r = runCli(okBox, [cmd])
		assert.equal(r.status, 0, `${cmd} should exit 0 when services are active`)
		assert.match(r.stdout, /^Running$/m)
		assert.doesNotMatch(r.stdout, /http:\/\/:/)
	}

	const addressed = await makeSandbox('start-address', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\nexit 0',
		ip: 'echo "1.1.1.1 via 192.0.2.1 dev eth0 src 192.0.2.10"',
	})
	const up = runCli(addressed, ['start'])
	assert.equal(up.status, 0, up.stdout + up.stderr)
	assert.match(up.stdout, /Running at http:\/\/192\.0\.2\.10:7780/)
})

test('#619: stop exits 1 unless systemctl succeeds and both services are inactive', async () => {
	const failBox = await makeSandbox('stop-fail', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\nexit 1',
	})
	const r1 = runCli(failBox, ['stop'])
	assert.equal(r1.status, 1)
	assert.match(r1.stdout, /Couldn't stop\. See: omarchy-server logs/)
	assert.doesNotMatch(r1.stdout, /\bStopped\b/)

	const stillOneBox = await makeSandbox('stop-partial', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\ncase "$*" in\n  *"is-active --quiet omarchyd.service"*) exit 0;;\n  *"is-active --quiet omarchy-server-web.service"*) exit 3;;\nesac\nexit 0',
	})
	const r2 = runCli(stillOneBox, ['stop'])
	assert.equal(r2.status, 1)
	assert.match(r2.stdout, /Couldn't stop\. See: omarchy-server logs/)
	assert.doesNotMatch(r2.stdout, /\bStopped\b/)

	const okBox = await makeSandbox('stop-ok', {
		systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\ncase "$*" in *is-active*) exit 3;; esac\nexit 0',
	})
	const r3 = runCli(okBox, ['stop'])
	assert.equal(r3.status, 0)
	assert.match(r3.stdout, /^Stopped$/m)
})

test('#556: widget on and off keep a symlinked top-bar file as a symlink', async () => {
	const box = await makeSandbox('widget-link')
	const dots = join(box.home, 'dots', 'shell.json')
	const link = join(box.home, '.config', 'omarchy', 'shell.json')
	const original = `${JSON.stringify({bar: {layout: {right: ['clock']}}}, null, 2)}\n`
	await mkdir(join(box.home, 'dots'), {recursive: true})
	await writeFile(dots, original)
	await mkdir(join(box.home, '.config', 'omarchy'), {recursive: true})
	await symlink(dots, link)
	const env = {XDG_CONFIG_HOME: join(box.home, '.config'), OMARCHY_PATH: join(box.home, 'no-omarchy')}
	const on = runCli(box, ['widget', 'on'], env)
	assert.equal(on.status, 0, on.stdout + on.stderr)
	assert.equal((await lstat(link)).isSymbolicLink(), true, 'widget on must not replace the symlink')
	assert.equal(await readlink(link), dots)
	const updated = await readFile(dots, 'utf8')
	assert.match(updated, /"id": "omarchy-server"/)
	assert.doesNotMatch(original, /omarchy-server/)
	const bak = await readFile(`${dots}.omarchy-server.bak`, 'utf8')
	assert.equal(bak, original)
	assert.equal((await lstat(link)).isSymbolicLink(), true)
	const off = runCli(box, ['widget', 'off'], env)
	assert.equal(off.status, 0, off.stdout + off.stderr)
	assert.equal((await lstat(link)).isSymbolicLink(), true, 'widget off must not replace the symlink')
	assert.equal(await readlink(link), dots)
	assert.doesNotMatch(await readFile(dots, 'utf8'), /omarchy-server/)
})

test('#565: logs include the desktop screen-sharing (wayvnc) units the failed-desktop message sends people to', async () => {
	const box = await makeSandbox('logs-desktop')
	assert.equal(runCli(box, ['logs']).status, 0)
	const line = (await readLog(box)).trim()
	assert.match(line, /-u omarchy-server-desktop /)
	assert.match(line, /-u omarchy-server-desktop-now /)
})

test('#919: reset-password stops omarchyd, runs the backend’s reset with the unit’s node and data, and starts it again', async () => {
	const box = await makeSandbox('reset-password', {systemctl: 'echo "systemctl $*" >>"$FAKE_LOG"\n[ "$2" = is-active ] && exit 0\nexit 0'})
	const units = join(box.home, '.config', 'systemd', 'user')
	await mkdir(units, {recursive: true})
	const fakeNode = join(box.bin, 'unit-node')
	await writeFile(fakeNode, '#!/bin/sh\necho "node $*" >>"$FAKE_LOG"\nexit 3\n')
	await chmod(fakeNode, 0o755)
	await writeFile(join(units, 'omarchyd.service'), `[Service]\nExecStart=${fakeNode} /app/omarchyd/cli.mjs serve --port 2021 --web-port 7780 --data /data/omarchyd\n`)
	const r = runCli(box, ['reset-password', '--name', 'Ada'])
	const log = await readLog(box)
	assert.notEqual(r.status, 0, 'a failed reset is not reported as success')
	const stop = log.indexOf('systemctl --user stop omarchyd.service')
	const start = log.indexOf('systemctl --user start omarchyd.service')
	assert.ok(stop >= 0 && start > stop, `stops first and starts again even after a failure:\n${log}`)
	// Without a terminal the reset itself cannot run (it reads from /dev/tty); with one it gets these arguments.
	if (log.includes('node ')) assert.match(log, /node \/app\/omarchyd\/cli\.mjs reset-password --name Ada --data \/data\/omarchyd/)
})

test('#919: reset-password without an installed backend, or with an unknown option, runs nothing', async () => {
	const box = await makeSandbox('reset-password-missing')
	const missing = runCli(box, ['reset-password'])
	assert.equal(missing.status, 1)
	assert.match(missing.stderr, /Can't find the MODC backend service/)
	const bad = runCli(box, ['reset-password', '--bogus'])
	assert.equal(bad.status, 2)
	assert.equal(await readLog(box), '')
})
