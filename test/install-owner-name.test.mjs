// #810: a directory login name (@ or backslash) must not abort the installer after the password.
// The create-owner step validates the name first and passes --name. Stand-in commands only.
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

function runPty(env) {
	const py = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1]])
buf = b''
end = time.time() + 30
status = None
while True:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            chunk = b''
        if chunk:
            buf += chunk
        else:
            _, status = os.waitpid(pid, 0)
            break
    else:
        wpid, st = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            status = st
            break
        if time.time() > end:
            os.kill(pid, 15)
            _, status = os.waitpid(pid, 0)
            break
code = os.waitstatus_to_exitcode(status)
sys.stderr.write('__EXIT__%s\\n' % code)
sys.stdout.buffer.write(buf)
`
	return spawnSync('python3', ['-c', py, installPath], {env, encoding: 'utf8', timeout: 40_000})
}

async function installWithLogin(login) {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-owner-name-'))
	const bin = join(dir, 'bin')
	const home = join(dir, 'home')
	const data = join(home, '.local/share')
	const config = join(home, '.config')
	await mkdir(bin, {recursive: true})
	await mkdir(home, {recursive: true})
	await stub(bin, 'pacman', 'case "$1" in -Qi) exit 0;; -Q) printf "%s\\n" "samba 1" "smbclient 1" "libwbclient 1"; exit 0;; esac\nexit 0')
	await stub(bin, 'sudo', 'exit 0')
	await stub(bin, 'id', 'case "$1" in -u) echo 1000; exit 0;; -un) printf "%s\\n" "$FAKE_LOGIN"; exit 0;; esac\nexec /usr/bin/id "$@"')
	await stub(bin, 'uname', '[ "$1" = -m ] && { echo x86_64; exit; }; exec /usr/bin/uname "$@"')
	await stub(bin, 'systemctl', 'exit 0')
	await stub(bin, 'loginctl', '[ "$1" = show-user ] && { echo yes; exit; }; exit 0')
	await stub(bin, 'podman', 'exit 0')
	await stub(bin, 'npm', 'exit 0')
	await stub(bin, 'ufw', 'exit 0')
	// This computer's disk is not part of the test. An encrypted root would stop at the unattended-boot question.
	await stub(bin, 'findmnt', 'exit 0')
	await stub(bin, 'lsblk', 'exit 0')
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
		`if [ "$1" = -e ]; then exec "$REAL_NODE" "$@"; fi
printf 'NODE %s\\n' "$*"
for arg in "$@"; do
  case "$arg" in
    has-owner) exit 1 ;;
    create-owner) exit 0 ;;
  esac
done
exit 0`,
	)
	const env = {
		PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: home,
		USER: 'tester',
		FAKE_LOGIN: login,
		REAL_NODE: process.execPath,
		XDG_DATA_HOME: data,
		XDG_CONFIG_HOME: config,
		OMARCHY_SERVER_SOURCE: '',
		OMARCHY_SERVER_APP_STORE: '',
		OMARCHY_SERVER_REPO: '',
		OMARCHY_SERVER_FROM_APP: '',
		OMARCHY_PATH: '',
		TERM: 'xterm',
	}
	const out = runPty(env)
	const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '')
	return {dir, text, unit: join(config, 'systemd/user/omarchyd.service')}
}

test('#810: a login name with @ is replaced before create-owner, and the installer finishes', {skip}, async () => {
	const {dir, text, unit} = await installWithLogin('jdoe@corp.example.com')
	try {
		const hint = text.indexOf('--name')
		const call = text.indexOf('NODE ')
		const create = text.indexOf('create-owner --name jdoecorp.example.com')
		assert.ok(hint >= 0, text)
		assert.ok(create > hint, text)
		assert.ok(call === -1 || create >= 0, text)
		assert.match(text, /__EXIT__0/)
		assert.match(await readFile(unit, 'utf8'), /ExecStart=/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#810: a login name with a backslash is replaced before create-owner', {skip}, async () => {
	const {dir, text, unit} = await installWithLogin('DOMAIN\\jdoe')
	try {
		assert.match(text, /--name/)
		assert.match(text, /create-owner --name DOMAINjdoe/)
		assert.match(text, /__EXIT__0/)
		assert.match(await readFile(unit, 'utf8'), /ExecStart=/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
