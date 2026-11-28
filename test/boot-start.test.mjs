// A server with no screen must come back by itself after a restart or a power cut.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
const unit = (name) => {
	const m = new RegExp(`cat >"\\$UNITS/${name}" <<EOF\\n([\\s\\S]*?)\\nEOF`).exec(script)
	assert.ok(m, `${name} unit`)
	return m[1]
}

test('both services start at boot and never stop retrying', () => {
	for (const name of ['omarchyd.service', 'omarchy-server-web.service']) {
		const u = unit(name)
		assert.match(u, /^WantedBy=default\.target$/m, name)
		assert.match(u, /^Restart=on-failure$/m, name)
		assert.match(u, /^StartLimitIntervalSec=0$/m, `${name} must not give up after a few fast failures at boot`)
	}
	assert.match(script, /systemctl --user enable omarchyd\.service omarchy-server-web\.service/)
})

test('linger is turned on without sudo when allowed, never waits on a password in an in-app update, and says so when it fails', () => {
	const block = script.slice(script.indexOf('# Start at boot and keep running'), script.indexOf('# Everything above succeeded'))
	assert.match(block, /loginctl enable-linger "\$USER" 2>\/dev\/null \|\|/)
	assert.match(block, /sudo -n loginctl enable-linger/)
	assert.match(block, /stays off until you sign in/)
})

test('an encrypted system disk is reported, so Settings and Restart can say it waits for the disk password', async () => {
	const {mkdtemp, rm} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {openAccounts} = await import('../omarchyd/accounts.mjs')
	const {startOmarchyd} = await import('../omarchyd/server.mjs')
	const root = await mkdtemp(join(os.tmpdir(), 'omarchy-lock-'))
	const accounts = await openAccounts(join(root, 'd'))
	await accounts.createOwner({name: 'Chris', password: 'correct horse'})
	const d = await startOmarchyd({port: 0, dataDir: join(root, 'd'), home: root, machineOptions: {diskLock: {encrypted: true, unlocksItself: false}}})
	try {
		const login = await (await fetch(`${d.url}/trpc/user.loginNative`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({userId: 'owner', password: 'correct horse', client: {id: 's'}})})).json()
		const res = await (await fetch(`${d.url}/trpc/system.bootStart`, {headers: {authorization: `Bearer ${login.result.data.accessToken}`}})).json()
		assert.deepEqual(res.result.data.diskLock, {encrypted: true, unlocksItself: false})
	} finally {
		await d.close()
		await rm(root, {recursive: true, force: true})
	}
})

// The unattended-boot block from install.sh, run for real in bash with stand-ins for findmnt, lsblk and
// sudo, and with the files it reads moved into a temporary folder. Nothing touches this machine's disk.
async function runUnattended({fromApp = '0', encrypted = true, confExists = false, cmdline = 'cryptdevice=PARTUUID=x:root root=/dev/mapper/root'} = {}) {
	const {mkdtemp, writeFile, chmod, rm} = await import('node:fs/promises')
	const os = await import('node:os')
	const {join} = await import('node:path')
	const {spawnSync} = await import('node:child_process')
	const t = await mkdtemp(join(os.tmpdir(), 'modc-unattended-'))
	try {
		const start = script.indexOf('# --- Unattended boot')
		const end = script.indexOf('# --- end unattended boot')
		assert.ok(start > 0 && end > start, 'unattended boot block')
		const block = script
			.slice(start, end)
			.replaceAll('/etc/mkinitcpio.conf.d/zz-modc-unattended.conf', `${t}/conf`)
			.replaceAll('/proc/cmdline', `${t}/cmdline`)
			.replaceAll('/etc/crypttab', `${t}/crypttab`)
			.replaceAll('/usr/lib/initcpio/install/clevis', `${t}/clevis`)
		await writeFile(join(t, 'cmdline'), cmdline + '\n')
		if (confExists) await writeFile(join(t, 'conf'), 'FILES+=(/crypto_keyfile.bin)\n')
		const stub = async (name, body) => {
			await writeFile(join(t, name), `#!/bin/bash\n${body}\n`)
			await chmod(join(t, name), 0o755)
		}
		await stub('findmnt', `echo '/dev/mapper/root[/@]'`)
		await stub('lsblk', encrypted ? `printf '/dev/mapper/root crypt\\n/dev/sdb2 crypto_LUKS\\n'` : `printf '/dev/sda2 btrfs\\n'`)
		await stub('sudo', `echo "$*" >>"${t}/sudo.log"; exit 1`)
		await writeFile(join(t, 'run.sh'), `set -euo pipefail\nsay() { printf '==> %s\\n' "$*"; }\nFROM_APP=${fromApp}\n${block}\necho FINISHED\n`)
		const r = spawnSync('bash', [join(t, 'run.sh')], {encoding: 'utf8', input: '', env: {...process.env, PATH: `${t}:${process.env.PATH}`}})
		const sudo = await readFile(join(t, 'sudo.log'), 'utf8').catch(() => '')
		return {status: r.status, out: r.stdout + r.stderr, sudo}
	} finally {
		await rm(t, {recursive: true, force: true})
	}
}

test('unattended boot: an encrypted disk gets the question, and no answer changes nothing', async () => {
	const r = await runUnattended()
	assert.equal(r.status, 0, r.out)
	assert.match(r.out, /Turn on unattended boot\?/)
	assert.match(r.out, /Left as is/)
	assert.match(r.out, /FINISHED/)
	assert.equal(r.sudo, '', 'nothing runs as root without a yes')
})

test('unattended boot: no question during an in-app update (FROM_APP=1)', async () => {
	const r = await runUnattended({fromApp: '1'})
	assert.equal(r.status, 0, r.out)
	assert.doesNotMatch(r.out, /unattended boot|disk password/i)
	assert.match(r.out, /FINISHED/)
	assert.equal(r.sudo, '')
})

test('unattended boot: no question when / is not encrypted', async () => {
	const r = await runUnattended({encrypted: false})
	assert.equal(r.status, 0, r.out)
	assert.doesNotMatch(r.out, /unattended boot|disk password/i)
	assert.equal(r.sudo, '')
})

test('unattended boot: no question when it is already on', async () => {
	const r = await runUnattended({confExists: true})
	assert.equal(r.status, 0, r.out)
	assert.doesNotMatch(r.out, /unattended boot|disk password/i)
	assert.equal(r.sudo, '')
})

test('unattended boot: a boot setup without cryptdevice= is explained, not changed', async () => {
	const r = await runUnattended({cmdline: 'rd.luks.name=x=root root=/dev/mapper/root'})
	assert.equal(r.status, 0, r.out)
	assert.match(r.out, /boot setup this installer doesn't handle yet/)
	assert.doesNotMatch(r.out, /Turn on unattended boot\?/)
	assert.equal(r.sudo, '')
})

test('restarting from the app is not blocked once the disk unlocks itself with the unattended-boot key file', async () => {
	const {UNATTENDED_BOOT_CONF} = await import('../omarchyd/server.mjs')
	assert.equal(UNATTENDED_BOOT_CONF, '/etc/mkinitcpio.conf.d/zz-modc-unattended.conf')
	assert.ok(script.includes(`MODC_INITCPIO_CONF=${UNATTENDED_BOOT_CONF}`), 'install.sh and the server agree on the file')
	const source = await readFile(new URL('../omarchyd/server.mjs', import.meta.url), 'utf8')
	const diskLock = source.slice(source.indexOf('async diskLock()'), source.indexOf('async function bootGuard'))
	assert.match(diskLock, /exists\(UNATTENDED_BOOT_CONF\)/)
	assert.match(diskLock, /unlocksItself: clevis \|\| unattended \|\|/)
})
