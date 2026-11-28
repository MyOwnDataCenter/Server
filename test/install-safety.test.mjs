// Installer, ISO, connector syntax check, and README safety fixes.
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const installPath = fileURLToPath(new URL('../install.sh', import.meta.url))
const connectorPath = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const setupPath = fileURLToPath(new URL('../iso/target/target-setup.sh', import.meta.url))
const livePath = fileURLToPath(new URL('../iso/live/omarchy-server-setup', import.meta.url))
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))

const installSh = await readFile(installPath, 'utf8')
const connectorSh = await readFile(connectorPath, 'utf8')

function extract(script, name) {
	const re = new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm')
	const m = script.match(re)
	assert.ok(m, `script must define ${name}()`)
	return m[0]
}

function runBash(body, env = {}) {
	return new Promise((resolve) => {
		execFile('bash', ['-c', body], {env: {...process.env, ...env}, timeout: 15_000}, (error, stdout, stderr) => {
			resolve({code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr), error})
		})
	})
}

function runFile(file, env = {}) {
	return new Promise((resolve) => {
		execFile(file, [], {env: {...process.env, ...env}, timeout: 15_000}, (error, stdout, stderr) => {
			resolve({code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr), error})
		})
	})
}

async function exists(path) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

const die = `die() { printf 'Error: %s\\n' "$*" >&2; exit 1; }`
const say = `say() { printf '%s\\n' "$*"; }`

test('#553 archzfs cleanup deletes every Server line of that section and keeps the next one', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'archzfs-'))
	try {
		const conf = join(dir, 'pacman.conf')
		const fixture = `[extra]
Include = /etc/pacman.d/mirrorlist

[archzfs]
Server = https://archzfs.com/$repo/$arch
Server = https://mirror.example/archzfs/$repo/$arch

[core]
Server = https://mirror.example/core/$repo/$arch
`
		await writeFile(conf, fixture)
		const prelude = `${say}\n${extract(installSh, 'remove_stale_archzfs')}`
		const r = await runBash(`${prelude}\nremove_stale_archzfs ${JSON.stringify(conf)}`)
		assert.equal(r.code, 0, r.stderr)
		const after = await readFile(conf, 'utf8')
		const bak = await readFile(`${conf}.bak`, 'utf8')
		assert.match(after, /\[extra\]/)
		assert.match(after, /Include = \/etc\/pacman\.d\/mirrorlist/)
		assert.match(after, /\[core\]/)
		assert.match(after, /Server = https:\/\/mirror\.example\/core\/\$repo\/\$arch/)
		assert.doesNotMatch(after, /archzfs/)
		assert.match(bak, /\[archzfs\]/)
		assert.match(bak, /Server = https:\/\/archzfs\.com\/\$repo\/\$arch/)
		assert.match(bak, /Server = https:\/\/mirror\.example\/archzfs\/\$repo\/\$arch/)
		assert.match(installSh, /\[ "\$conf" = \/etc\/pacman\.conf \]/)
		assert.match(installSh, /sudo cp -a -- "\$conf" "\$conf\.bak"/)
		assert.match(installSh, /remove_stale_archzfs \/etc\/pacman\.conf/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#553 a custom archzfs section is not rewritten', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'archzfs-custom-'))
	try {
		const conf = join(dir, 'pacman.conf')
		const fixture = `[extra]
Server = https://mirror.example/extra

[archzfs]
SigLevel = Optional TrustAll
Server = https://archzfs.com/$repo/$arch

[core]
Server = https://mirror.example/core
`
		await writeFile(conf, fixture)
		const prelude = `${say}\n${extract(installSh, 'remove_stale_archzfs')}`
		const r = await runBash(`${prelude}\nremove_stale_archzfs ${JSON.stringify(conf)}`)
		assert.equal(r.code, 0, r.stderr)
		assert.equal(await readFile(conf, 'utf8'), fixture)
		assert.equal(await exists(`${conf}.bak`), false)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#409 file, git, and scp URLs are not treated as local paths', async () => {
	const prelude = `${die}\n${extract(installSh, 'require_local_git')}\n${extract(installSh, 'require_repo')}`
	for (const repo of ['file:///tmp/x', 'git://host/x.git', 'me@host:repo.git']) {
		const r = await runBash(`${prelude}\nrequire_repo ${JSON.stringify(repo)}`)
		assert.equal(r.code, 0, `${repo}: ${r.stderr}`)
		assert.doesNotMatch(r.stderr, /not a git repository/)
	}
	const relative = await runBash(`${prelude}\nrequire_repo code/app-store`)
	assert.equal(relative.code, 1)
	assert.match(relative.stderr, /absolute path/)
	assert.match(installSh, /require_repo "\$REPO"/)
})

test('#409 a bare repo is accepted and a non-repo directory is not', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'repo-check-'))
	try {
		const bare = join(dir, 'bare.git')
		const empty = join(dir, 'empty')
		await mkdir(bare)
		await mkdir(empty)
		await writeFile(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
		const prelude = `${die}\n${extract(installSh, 'require_local_git')}`
		const ok = await runBash(`${prelude}\nrequire_local_git OMARCHY_SERVER_REPO ${JSON.stringify(bare)}`)
		assert.equal(ok.code, 0, ok.stderr)
		const bad = await runBash(`${prelude}\nrequire_local_git OMARCHY_SERVER_REPO ${JSON.stringify(empty)}`)
		assert.equal(bad.code, 1)
		assert.match(bad.stderr, /not a git repository/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

async function writeIp(dir, lines) {
	const bin = join(dir, 'bin')
	await mkdir(bin, {recursive: true})
	const ip = join(bin, 'ip')
	await writeFile(ip, `#!/bin/sh\ncat <<'EOF'\n${lines}\nEOF\n`)
	await chmod(ip, 0o755)
	return bin
}

test('#259 LAN addresses on 172.16 and 10.21 are printed and bridges are skipped', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'lan-ips-'))
	try {
		const bin = await writeIp(dir, `2: eth0    inet 172.16.0.5/24 brd 172.16.0.255 scope global eth0
3: eth1    inet 10.21.0.5/16 brd 10.21.255.255 scope global eth1
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
5: podman0    inet 10.88.0.1/16 scope global podman0
6: cni0    inet 10.89.0.1/16 scope global cni0
7: virbr0    inet 192.168.122.1/24 scope global virbr0
8: br-1234    inet 172.18.0.1/16 scope global br-1234`)
		const prelude = `${say}\n${extract(installSh, 'lan_urls')}`
		const r = await runBash(`${prelude}\nlan_urls 7780`, {PATH: `${bin}:${process.env.PATH}`})
		assert.equal(r.code, 0, r.stderr)
		assert.match(r.stdout, /http:\/\/172\.16\.0\.5:7780/)
		assert.match(r.stdout, /http:\/\/10\.21\.0\.5:7780/)
		assert.doesNotMatch(r.stdout, /172\.17\.0\.1/)
		assert.doesNotMatch(r.stdout, /10\.88\.0\.1/)
		assert.doesNotMatch(r.stdout, /10\.89\.0\.1/)
		assert.doesNotMatch(r.stdout, /192\.168\.122\.1/)
		assert.doesNotMatch(r.stdout, /172\.18\.0\.1/)
		assert.doesNotMatch(r.stdout, /VM behind NAT/)
		assert.match(installSh, /lan_urls "\$PORT"/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#259 the NAT note is only the QEMU user network 10.0.2.0/24', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'lan-nat-'))
	try {
		const bin = await writeIp(dir, '2: eth0    inet 10.0.2.15/24 brd 10.0.2.255 scope global eth0')
		const prelude = `${say}\n${extract(installSh, 'lan_urls')}`
		const r = await runBash(`${prelude}\nlan_urls 7780`, {PATH: `${bin}:${process.env.PATH}`})
		assert.equal(r.code, 0, r.stderr)
		assert.match(r.stdout, /http:\/\/10\.0\.2\.15:7780/)
		assert.match(r.stdout, /VM behind NAT/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#550 a failed widget on does not record the offer', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'widget-offer-'))
	try {
		const home = join(dir, 'home')
		const base = join(dir, 'base')
		const binDir = join(home, '.local/bin')
		await mkdir(binDir, {recursive: true})
		await mkdir(base)
		const bin = join(binDir, 'omarchy-server')
		await writeFile(bin, '#!/bin/sh\necho "No Omarchy top bar settings found"\nexit 1\n')
		await chmod(bin, 0o755)
		const prelude = extract(installSh, 'offer_top_bar_widget')
		const fail = await runBash(`${prelude}\noffer_top_bar_widget`, {HOME: home, BASE: base})
		assert.equal(fail.code, 0, fail.stderr)
		assert.equal(fail.stdout, '')
		assert.equal(await exists(join(base, '.widget-offered')), false)
		await writeFile(bin, '#!/bin/sh\necho "Added the Omarchy Server icon to the top bar."\nexit 0\n')
		const ok = await runBash(`${prelude}\noffer_top_bar_widget`, {HOME: home, BASE: base})
		assert.equal(ok.code, 0, ok.stderr)
		assert.match(ok.stdout, /Added the Omarchy Server icon/)
		assert.equal(await exists(join(base, '.widget-offered')), true)
		assert.match(installSh, /offer_top_bar_widget/)
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
})

test('#547 connector syntax check does not compile bytecode', async () => {
	assert.doesNotMatch(connectorSh, /py_compile/)
	assert.doesNotMatch(connectorSh, /compileall/)
	const base = `omarchy-syntax-${process.pid}`
	const file = join(os.tmpdir(), `${base}.py`)
	const cache = join(os.tmpdir(), '__pycache__')
	const ourPyc = async () => {
		try {
			return (await readdir(cache)).some((name) => name.startsWith(base))
		} catch {
			return false
		}
	}
	try {
		await writeFile(file, 'def hello():\n    return 1\n')
		assert.equal(await ourPyc(), false)
		const prelude = extract(connectorSh, 'python_ok')
		const ok = await runBash(`${prelude}\npython_ok ${JSON.stringify(file)}`)
		assert.equal(ok.code, 0, ok.stderr)
		assert.equal(await ourPyc(), false)
		await writeFile(file, 'def (\n')
		const bad = await runBash(`${prelude}\npython_ok ${JSON.stringify(file)}`)
		assert.notEqual(bad.code, 0)
		assert.equal(await ourPyc(), false)
	} finally {
		await rm(file, {force: true})
	}
})

function firstbootScript(setup) {
	const m = setup.match(/cat >\/usr\/local\/bin\/omarchy-server-firstboot <<'EOF'\n([\s\S]*?)\nEOF/)
	assert.ok(m, 'target-setup.sh must write omarchy-server-firstboot')
	return m[1]
}

async function runFirstboot(nmExit) {
	const setup = await readFile(setupPath, 'utf8')
	const dir = await mkdtemp(join(os.tmpdir(), 'firstboot-'))
	const bin = join(dir, 'bin')
	await mkdir(bin)
	const stub = async (name, body) => {
		const path = join(bin, name)
		await writeFile(path, body)
		await chmod(path, 0o755)
	}
	await stub('nm-online', `#!/bin/sh\nexit ${nmExit}\n`)
	await stub('curl', '#!/bin/sh\nexit 1\n')
	await stub('sudo', '#!/bin/sh\nexit 0\n')
	await stub('pacman', '#!/bin/sh\necho "pacman should not run" >&2\nexit 99\n')
	await stub('ufw', '#!/bin/sh\necho "ufw should not run" >&2\nexit 99\n')
	const script = join(dir, 'omarchy-server-firstboot')
	await writeFile(script, firstbootScript(setup))
	await chmod(script, 0o755)
	try {
		return await runFile(script, {PATH: `${bin}:${process.env.PATH}`})
	} finally {
		await rm(dir, {recursive: true, force: true})
	}
}

test('#257 first-boot exits non-zero when curl and nm-online fail', async () => {
	const r = await runFirstboot(1)
	assert.notEqual(r.code, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`)
	assert.doesNotMatch(r.stdout, /My Own Data Center is running/)
	assert.doesNotMatch(r.stdout, / ok/)
	assert.match(r.stdout, /didn't finish installing/)
	assert.doesNotMatch(r.stderr, /pacman should not run/)
	assert.doesNotMatch(r.stderr, /ufw should not run/)
})

test('#257 first-boot prints network ok only when nm-online succeeds', async () => {
	const r = await runFirstboot(0)
	assert.notEqual(r.code, 0, r.stdout)
	assert.match(r.stdout, / ok/)
	assert.doesNotMatch(r.stdout, /My Own Data Center is running/)
})

test('#765 the live installer does not ask you to sign in after the restart', async () => {
	const live = await readFile(livePath, 'utf8')
	assert.match(live, /signs you in by itself/)
	assert.match(live, /setup starts/)
	assert.match(live, /account password \(for sudo\)/)
	assert.doesNotMatch(live, /sign in on the screen that appears/)
})

test('#561 the local swarm steps list five abilities and their defaults', async () => {
	const readme = await readFile(readmePath, 'utf8')
	const swarm = readme.slice(readme.indexOf('## Local swarm'), readme.indexOf('## Security'))
	assert.match(swarm, /Terminal/)
	assert.match(swarm, /Desktop/)
	assert.match(swarm, /Manage/)
	assert.match(swarm, /Storage/)
	assert.match(swarm, /Backups/)
	assert.match(swarm, /format disks/)
	assert.match(swarm, /never delete/)
	assert.match(swarm, /Storage[\s\S]{0,80}off/)
	assert.match(swarm, /Backups[\s\S]{0,80}on/)
	assert.match(swarm, /only ever allows what you chose when it\s+joined/)
})

test('#552 README shows the piped --zfs command', async () => {
	const readme = await readFile(readmePath, 'utf8')
	const cmd = 'curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash -s -- --zfs'
	assert.equal(readme.split(cmd).length - 1, 2)
})

test('OMARCHY_SERVER_PORT that is not a port number stops the installer before anything is installed', async () => {
	for (const bad of ['abc', '0', '65536', '80 80', '-1', '7780/tcp', '123456']) {
		const r = await runFile(installPath, {OMARCHY_SERVER_PORT: bad, OMARCHY_SERVER_REPO: '', OMARCHY_SERVER_SOURCE: ''})
		assert.equal(r.code, 1, `${bad}: ${r.stderr}`)
		assert.match(r.stderr, /OMARCHY_SERVER_PORT is "[^"]*" but must be a number from 1 to 65535/, bad)
	}
})

test('a valid OMARCHY_SERVER_PORT is kept as a plain number', async () => {
	const fn = extract(installSh, 'check_port')
	for (const [given, want] of [['7780', '7780'], ['80', '80'], ['65535', '65535'], ['08080', '8080']]) {
		const r = await runBash(`${die}\n${fn}\nPORT=${given}\ncheck_port\nprintf '%s' "$PORT"`)
		assert.equal(r.code, 0, r.stderr)
		assert.equal(r.stdout, want)
	}
})
