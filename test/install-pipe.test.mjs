// `curl … | bash` feeds install.sh through a pipe that bash reads while the script runs. A step that reads
// its input (pacman, `omarchy update`) used to swallow the rest of the script, so the download and build
// were skipped and it failed later with "touch: cannot touch …/.widget-offered". These run the real
// installer through a pipe with stand-in commands: the stand-in pacman reads all of its input.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {dirname, join} from 'node:path'
import {test} from 'node:test'

const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false

test('install.sh is read in full before it runs', () => {
	const lines = script.trimEnd().split('\n')
	assert.equal(lines.at(-1), 'main "$@"; exit')
	assert.match(script, /^main\(\) \{\n/m)
	// The steps read the terminal (or nothing), never the rest of the piped script.
	assert.match(script, /^if \(: <\/dev\/tty\) 2>\/dev\/null; then exec <\/dev\/tty; else exec <\/dev\/null; fi$/m)
	// The app still finds the revision.
	assert.match(script, /^INSTALLER_REVISION=\d+$/m)
})

test('piped into bash, a package step that reads its input does not skip the rest', {skip}, async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-pipe-'))
	try {
		const bin = join(dir, 'bin')
		const tools = join(dir, 'tools')
		const home = join(dir, 'home')
		await mkdir(bin, {recursive: true})
		await mkdir(tools, {recursive: true})
		await mkdir(home, {recursive: true})
		// Real tools the script needs, and not this machine's omarchy. Finding omarchy skips
		// pacman -Syu and asks for a terminal, which is not the pipe this test is checking.
		for (const name of ['sed', 'systemctl', 'uname', 'awk', 'sort', 'wc', 'mkdir', 'cat']) {
			await symlink(`/usr/bin/${name}`, join(tools, name))
		}
		await symlink(process.execPath, join(tools, 'node'))
		const stub = async (name, body) => {
			await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`)
			await chmod(join(bin, name), 0o755)
		}
		await stub('pacman', 'case "$1" in -Qi) exit 1;; -Q) echo "samba 1"; exit 0;; esac\ncat >/dev/null\necho "PACMAN $*"')
		await stub('sudo', 'exec "$@"')
		await stub('id', '[ "$1" = -u ] && { echo 1000; exit; }; exec /usr/bin/id "$@"')
		// Stop at the download: reaching it is the point.
		await stub('git', 'echo "GIT $*"; exit 7')
		const out = spawnSync('/usr/bin/bash', [], {
			input: script,
			encoding: 'utf8',
			env: {PATH: `${bin}:${tools}`, HOME: home, USER: 'tester'},
			// No terminal here, as on a machine without one: the steps read nothing instead.
			detached: true,
			timeout: 30_000,
		})
		const text = (out.stdout + out.stderr).replace(/\x1b\[[0-9;]*m/g, '')
		assert.match(text, /PACMAN -Syu/)
		assert.match(text, /==> Downloading My Own Data Center/)
		assert.match(text, /GIT clone --depth 1 --branch main /)
		assert.doesNotMatch(text, /cannot touch/)
		assert.equal(out.status, 7)
		assert.ok((await stat(join(home, '.local/share/omarchy-server'))).isDirectory())
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('with no terminal, the Omarchy system update isn’t started (it would wait forever to be confirmed)', {skip, timeout: 30_000}, async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'install-notty-'))
	try {
		const bin = join(dir, 'bin')
		const home = join(dir, 'home')
		await mkdir(bin, {recursive: true})
		await mkdir(home, {recursive: true})
		const stub = async (name, body) => {
			await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`)
			await chmod(join(bin, name), 0o755)
		}
		await stub('pacman', 'case "$1" in -Qi) exit 1;; -Q) echo "samba 1"; exit 0;; esac\necho "PACMAN $*"')
		await stub('sudo', 'exec "$@"')
		await stub('id', '[ "$1" = -u ] && { echo 1000; exit; }; exec /usr/bin/id "$@"')
		await stub('omarchy', 'echo "OMARCHY $*"; sleep 60')
		const out = spawnSync('bash', [], {
			input: script,
			encoding: 'utf8',
			env: {PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USER: 'tester'},
			detached: true,
			timeout: 20_000,
		})
		const text = (out.stdout + out.stderr).replace(/\x1b\[[0-9;]*m/g, '')
		assert.match(text, /needs a terminal to confirm in\. Run this from a terminal \(ssh -t\)/)
		assert.doesNotMatch(text, /OMARCHY update/)
		assert.notEqual(out.status, 0)
		assert.equal(out.signal, null, 'it stopped by itself, not by the test’s timeout')
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})
