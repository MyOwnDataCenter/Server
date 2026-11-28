// A headless run (no controlling terminal) must not open /dev/tty just because the
// device node is world-readable. has-owner failure needs a clear "run it again from
// a terminal" error. An owner that already exists still gets the services.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const installPath = fileURLToPath(new URL('../install.sh', import.meta.url))
const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false

async function stub(bin, name, body) {
	const path = join(bin, name)
	await writeFile(path, `#!/bin/bash\n${body}\n`)
	await chmod(path, 0o755)
}

async function runHeadless(hasOwnerExit, extraEnv = {}) {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-tty-'))
	const bin = join(dir, 'bin')
	const home = join(dir, 'home')
	const data = join(home, '.local/share')
	const config = join(home, '.config')
	await mkdir(bin, {recursive: true})
	await mkdir(home, {recursive: true})
	await stub(bin, 'pacman', 'case "$1" in -Qi) exit 0;; -Q) printf "%s\\n" "samba 1" "smbclient 1" "libwbclient 1"; exit 0;; esac\nexit 0')
	await stub(bin, 'sudo', 'exit 0')
	await stub(bin, 'id', '[ "$1" = -u ] && { echo 1000; exit; }; exec /usr/bin/id "$@"')
	await stub(bin, 'uname', '[ "$1" = -m ] && { echo x86_64; exit; }; exec /usr/bin/uname "$@"')
	await stub(bin, 'systemctl', 'exit 0')
	await stub(bin, 'loginctl', '[ "$1" = show-user ] && { echo yes; exit; }; exit 0')
	await stub(bin, 'podman', 'exit 0')
	await stub(bin, 'npm', 'exit 0')
	await stub(bin, 'ufw', 'exit 0')
	await stub(
		bin,
		'git',
		`if [ "$1" = clone ]; then
  dest="\${!#}"
  mkdir -p "$dest/bin" "$dest/helper" "$dest/omarchyd" "$dest/.git"
  printf '%s\\n' '#!/bin/bash' 'exit 0' > "$dest/bin/omarchy-server"
  chmod +x "$dest/bin/omarchy-server"
  printf '%s\\n' '' > "$dest/helper/helper.mjs"
  printf '%s\\n' '' > "$dest/omarchyd/cli.mjs"
fi
exit 0`,
	)
	await stub(
		bin,
		'node',
		`if [ "$1" = -e ]; then exit 0; fi
for arg in "$@"; do
  case "$arg" in
    has-owner) exit ${hasOwnerExit} ;;
    create-owner) echo "CREATE-OWNER"; exit 0 ;;
  esac
done
exit 0`,
	)
	const out = spawnSync('setsid', ['-w', 'bash', installPath], {
		encoding: 'utf8',
		env: {
			PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
			HOME: home,
			USER: 'tester',
			XDG_DATA_HOME: data,
			XDG_CONFIG_HOME: config,
			OMARCHY_SERVER_SOURCE: '',
			OMARCHY_SERVER_APP_STORE: '',
			OMARCHY_SERVER_REPO: '',
			OMARCHY_SERVER_FROM_APP: '',
			OMARCHY_PATH: '',
			...extraEnv,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
	})
	const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '')
	const units = join(config, 'systemd/user')
	return {dir, text, out, units}
}

test('no terminal and no owner: say to run the installer again, do not open /dev/tty', {skip}, async () => {
	const {dir, text, out} = await runHeadless(1)
	try {
		assert.match(text, /No terminal to type a password in/)
		assert.match(text, /ssh -t/)
		assert.doesNotMatch(text, /No such device or address/)
		assert.notEqual(out.status, 0)
		assert.equal(out.signal, null)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#421: a local source path with a space is one quoted Environment assignment', {skip}, async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-space-'))
	const source = join(dir, 'My Projects', 'omarchy-server')
	const store = join(dir, 'My Projects', 'app store')
	await mkdir(join(source, '.git'), {recursive: true})
	await mkdir(join(store, '.git'), {recursive: true})
	const {dir: homeDir, out, units} = await runHeadless(0, {
		OMARCHY_SERVER_SOURCE: source,
		OMARCHY_SERVER_APP_STORE: store,
	})
	try {
		assert.equal(out.status, 0, out.stderr + out.stdout)
		const unit = await readFile(join(units, 'omarchyd.service'), 'utf8')
		assert.ok(unit.includes(`Environment="OMARCHY_SERVER_SOURCE=${source}"`), unit)
		assert.ok(unit.includes(`Environment="OMARCHY_SERVER_APP_STORE=${store}"`), unit)
		assert.equal(unit.split('\n').some((line) => line.startsWith('Environment=') && !line.startsWith('Environment="')), false, unit)
	} finally {
		await rm(homeDir, {recursive: true, force: true})
		await rm(dir, {recursive: true, force: true})
	}
})

test('no terminal but an owner already exists: services are still created', {skip}, async () => {
	const {dir, text, out, units} = await runHeadless(0)
	try {
		assert.doesNotMatch(text, /No terminal to type a password in/)
		assert.doesNotMatch(text, /No such device or address/)
		const omarchyd = await readFile(join(units, 'omarchyd.service'), 'utf8')
		const web = await readFile(join(units, 'omarchy-server-web.service'), 'utf8')
		const desktop = await readFile(join(units, 'omarchy-server-desktop.service'), 'utf8')
		assert.match(omarchyd, /ExecStart=/)
		assert.match(web, /ExecStart=/)
		assert.match(desktop, /ExecStart=/)
		assert.equal(out.status, 0)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('omarchyd kills only its own process so libvirt guests survive a restart', {skip}, async () => {
	const {dir, out, units} = await runHeadless(0)
	try {
		assert.equal(out.status, 0, out.stderr + out.stdout)
		const omarchyd = await readFile(join(units, 'omarchyd.service'), 'utf8')
		assert.match(omarchyd, /^KillMode=process$/m, omarchyd)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
