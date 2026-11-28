// connector/install.sh --uninstall, in a temporary home, with stand-ins for sudo and systemctl.
// A sudo that cannot ask for a password must not be reported as a finished uninstall.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const root = await mkdtemp(join(os.tmpdir(), 'connector-uninstall-'))
after(() => rm(root, {recursive: true, force: true}))

async function bin() {
	const dir = join(root, `bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(dir)
	await writeFile(join(dir, 'sudo'), `#!/bin/sh
echo "sudo $*" >>"$FAKE_LOG"
if [ -n "$FAKE_SUDO_FAILS" ]; then
	echo "sudo: a terminal is required to read the password" >&2
	exit 1
fi
exit 0
`)
	await writeFile(join(dir, 'systemctl'), `#!/bin/sh
echo "systemctl $*" >>"$FAKE_LOG"
exit 0
`)
	await chmod(join(dir, 'sudo'), 0o755)
	await chmod(join(dir, 'systemctl'), 0o755)
	return dir
}

function run(home, dir, extra = {}) {
	const log = join(home, 'log')
	const r = spawnSync('bash', [SCRIPT, '--uninstall'], {
		env: {HOME: home, PATH: `${dir}:/usr/bin:/bin`, FAKE_LOG: log, ...extra},
		encoding: 'utf8',
		detached: true,
		timeout: 20000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`, log}
}

test('uninstall removes the connector sleep udev rule when sudo succeeds', async () => {
	const home = join(root, 'udev-ok')
	await mkdir(home)
	const r = run(home, await bin())
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /sudo rm -f[^\n]*\/etc\/udev\/rules\.d\/69-omarchy-connector-sleep\.rules/)
	assert.match(log, /sudo udevadm control --reload/)
})

test('when sudo fails, the printed command includes the connector udev rule', async () => {
	const home = join(root, 'udev-fail')
	await mkdir(home)
	const r = run(home, await bin(), {FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1)
	assert.match(r.out, /sudo rm -f[^\n]*\/etc\/udev\/rules\.d\/69-omarchy-connector-sleep\.rules/)
	assert.doesNotMatch(r.out, /Done\./)
})

test('uninstall says it could not remove the helper when sudo fails, and exits 1', async () => {
	const home = join(root, 'fail')
	await mkdir(home)
	const r = run(home, await bin(), {FAKE_SUDO_FAILS: '1'})
	assert.equal(r.status, 1)
	assert.match(r.out, /sudo rm -f \/usr\/local\/libexec\/omarchy-connector\/helper.py \/etc\/sudoers\.d\/omarchy-connector/)
	assert.doesNotMatch(r.out, /Done\./)
})

test('uninstall removes the user files and exits 0 when sudo succeeds', async () => {
	const home = join(root, 'ok')
	const data = join(home, '.local/share/omarchy-connector')
	await mkdir(join(home, '.config/systemd/user'), {recursive: true})
	await mkdir(data, {recursive: true})
	await writeFile(join(data, 'agent.py'), 'x')
	await writeFile(join(home, '.config/systemd/user/omarchy-connector.service'), 'x')
	const r = run(home, await bin())
	assert.equal(r.status, 0)
	assert.match(r.out, /Done\./)
	assert.match(await readFile(r.log, 'utf8'), /sudo rm -f \/usr\/local\/libexec\/omarchy-connector\/helper.py \/etc\/sudoers\.d\/omarchy-connector/)
	await assert.rejects(readFile(join(data, 'agent.py')))
})

test('uninstall removes the connector cache and keeps Restored', async () => {
	const home = join(root, 'cache')
	const cache = join(home, '.cache/omarchy-connector')
	const restored = join(home, 'Restored')
	await mkdir(join(cache, 'restic'), {recursive: true})
	await mkdir(restored, {recursive: true})
	await writeFile(join(cache, 'restic', 'index'), 'cached')
	await writeFile(join(restored, 'photo'), 'mine')
	const r = run(home, await bin())
	assert.equal(r.status, 0, r.out)
	await assert.rejects(readFile(join(cache, 'restic', 'index')))
	assert.equal(await readFile(join(restored, 'photo'), 'utf8'), 'mine')
})

test('OpenRC uninstall stops the system service and removes the init script', async () => {
	const home = join(root, 'openrc')
	await mkdir(home)
	const dir = join(root, `openrc-bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(dir)
	await writeFile(join(dir, 'sudo'), `#!/bin/sh
echo "sudo $*" >>"$FAKE_LOG"
exit 0
`)
	await writeFile(join(dir, 'rc-service'), `#!/bin/sh
echo "rc-service $*" >>"$FAKE_LOG"
exit 0
`)
	await writeFile(join(dir, 'rc-update'), `#!/bin/sh
echo "rc-update $*" >>"$FAKE_LOG"
exit 0
`)
	await chmod(join(dir, 'sudo'), 0o755)
	await chmod(join(dir, 'rc-service'), 0o755)
	await chmod(join(dir, 'rc-update'), 0o755)
	for (const name of ['uname', 'id', 'rm', 'bash']) {
		await writeFile(join(dir, name), `#!/bin/sh\nexec /usr/bin/${name} "$@"\n`)
		await chmod(join(dir, name), 0o755)
	}
	const r = run(home, dir, {PATH: dir})
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /rc-service omarchy-connector stop/)
	assert.match(log, /rc-update del omarchy-connector/)
	assert.match(log, /sudo rm -f[^\n]*\/etc\/init\.d\/omarchy-connector/)
	assert.doesNotMatch(log, /systemctl/)
	assert.match(r.out, /Done\./)
})

test('uninstall removes the cache at XDG_CACHE_HOME', async () => {
	const home = join(root, 'xdg-cache')
	const xdg = join(root, 'xdg-home')
	const cache = join(xdg, 'omarchy-connector')
	await mkdir(join(home, '.cache/omarchy-connector/restic'), {recursive: true})
	await mkdir(join(cache, 'restic'), {recursive: true})
	await writeFile(join(cache, 'restic', 'index'), 'cached')
	await writeFile(join(home, '.cache/omarchy-connector/restic', 'index'), 'other')
	const r = run(home, await bin(), {XDG_CACHE_HOME: xdg})
	assert.equal(r.status, 0, r.out)
	await assert.rejects(readFile(join(cache, 'restic', 'index')))
	assert.equal(await readFile(join(home, '.cache/omarchy-connector/restic', 'index'), 'utf8'), 'other')
})

test('uninstall keeps virtual machine disks and installed apps, and says where they are', async () => {
	const home = join(root, 'keeps-vms')
	const data = join(home, '.local/share/omarchy-connector')
	await mkdir(join(data, 'vms/abcd1234'), {recursive: true})
	await mkdir(join(data, 'vm-images'), {recursive: true})
	await mkdir(join(data, 'apps/notes'), {recursive: true})
	await writeFile(join(data, 'agent.py'), 'x')
	await writeFile(join(data, 'vm-helper.py'), 'x')
	await writeFile(join(data, 'vms/abcd1234/disk.qcow2'), 'disk')
	await writeFile(join(data, 'vm-images/debian-12'), 'image')
	await writeFile(join(data, 'apps/notes/compose.yml'), 'services: {}')
	const r = run(home, await bin())
	assert.equal(r.status, 0, r.out)
	await assert.rejects(readFile(join(data, 'agent.py')))
	await assert.rejects(readFile(join(data, 'vm-helper.py')))
	assert.equal(await readFile(join(data, 'vms/abcd1234/disk.qcow2'), 'utf8'), 'disk')
	assert.equal(await readFile(join(data, 'vm-images/debian-12'), 'utf8'), 'image')
	assert.equal(await readFile(join(data, 'apps/notes/compose.yml'), 'utf8'), 'services: {}')
	assert.match(r.out, /virtual machines/i)
	assert.match(r.out, /omarchy-connector/)
})
