// connector/install.sh on a Mac, in a temporary home with stand-ins for uname, curl, launchctl and
// the connector's enroll step. No sudo, a LaunchAgent, and only what a Mac can do is asked for.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile, access} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('../connector/install.sh', import.meta.url))
const AGENT = fileURLToPath(new URL('../connector/agent.py', import.meta.url))
const skip = process.platform !== 'linux' ? 'needs Linux and bash' : false
const root = await mkdtemp(join(os.tmpdir(), 'connector-mac-'))
after(() => rm(root, {recursive: true, force: true}))

// Any certificate will do: the installer only compares its SHA-256 with the command's fingerprint.
const PEM = `-----BEGIN CERTIFICATE-----\n${Buffer.from('not really a certificate, just bytes').toString('base64')}\n-----END CERTIFICATE-----\n`
const CA = createHash('sha256').update(Buffer.from('not really a certificate, just bytes')).digest('hex')

async function stubs() {
	const bin = join(root, `bin-${Math.random().toString(16).slice(2)}`)
	await mkdir(bin)
	const put = async (name, body) => (await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`), chmod(join(bin, name), 0o755))
	await put('uname', '[ "$1" = -s ] && { echo Darwin; exit; }; exec /usr/bin/uname "$@"')
	await put('id', '[ "$1" = -u ] && { echo 501; exit; }; exec /usr/bin/id "$@"')
	await put('sudo', 'echo "sudo $*" >>"$FAKE_LOG"; exit 1')
	await put('launchctl', 'echo "launchctl $*" >>"$FAKE_LOG"; exit 0')
	await put('curl', `out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
echo "curl $*" >>"$FAKE_LOG"
case "$*" in *ca.crt*) printf '%s' "$FAKE_PEM" >"$out" ;; *agent.py*) cp "$FAKE_AGENT" "$out" ;; esac`)
	await put('python3', `if [ "$2" = enroll ]; then echo "enroll $*" >>"$FAKE_LOG"; echo "Chris's MacBook Air"; exit 0; fi
exec /usr/bin/python3 "$@"`)
	return bin
}

function install(home, bin, args) {
	const log = join(home, 'log')
	const r = spawnSync('bash', [SCRIPT, ...args], {
		env: {HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_PEM: PEM, FAKE_AGENT: AGENT},
		encoding: 'utf8',
		timeout: 30000,
	})
	return {status: r.status, out: `${r.stdout}${r.stderr}`, log}
}

test('on a Mac it installs a LaunchAgent, never asks for sudo, and asks only for terminal, files and power', {skip}, async () => {
	const home = join(root, 'mac & co')
	await mkdir(home)
	const r = install(home, await stubs(), ['--server', 'https://192.168.1.20:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,desktop,manage,storage,backup,files'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.doesNotMatch(log, /^sudo/m)
	assert.match(log, /enroll https:\/\/192\.168\.1\.20:7780 abc123 terminal,manage,files$/m)
	const plist = await readFile(join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist'), 'utf8')
	assert.match(plist, /<string>org\.myowndatacenter\.connector<\/string>/)
	assert.ok(plist.includes(`<string>${home.replace('&', '&amp;')}/.local/share/omarchy-connector/agent.py</string>`), plist)
	assert.match(plist, /<string>\/opt\/homebrew\/bin:/)
	// A valid property list, as launchd reads it.
	const parsed = spawnSync('python3', ['-c', 'import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist')], {encoding: 'utf8'})
	assert.equal(JSON.parse(parsed.stdout).ProgramArguments[1], `${home}/.local/share/omarchy-connector/agent.py`)
	assert.match(plist, /<key>KeepAlive<\/key><true\/>/)
	assert.match(log, /launchctl bootstrap gui\/\d+ .*org\.myowndatacenter\.connector\.plist/)
	await access(join(home, '.config/omarchy-connector/server-ca.crt'))
	assert.match(r.out, /Chris's MacBook Air" is now in your server/)
})

test('a server with the wrong certificate is refused on a Mac too', {skip}, async () => {
	const home = join(root, 'mac-wrong')
	await mkdir(home)
	const r = install(home, await stubs(), ['--server', 'https://192.168.1.20:7780', '--ca', 'f'.repeat(64), '--token', 'abc123'])
	assert.equal(r.status, 1)
	assert.match(r.out, /isn't your server/)
	await assert.rejects(access(join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist')))
})

test('uninstall on a Mac removes the LaunchAgent and the connector without sudo', {skip}, async () => {
	const home = join(root, 'mac-un')
	await mkdir(join(home, 'Library/LaunchAgents'), {recursive: true})
	await mkdir(join(home, '.local/share/omarchy-connector'), {recursive: true})
	await writeFile(join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist'), 'x')
	const r = install(home, await stubs(), ['--uninstall'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.match(log, /launchctl bootout gui\/\d+\/org\.myowndatacenter\.connector/)
	assert.doesNotMatch(log, /^sudo/m)
	await assert.rejects(access(join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist')))
	await assert.rejects(access(join(home, '.local/share/omarchy-connector')))
})

test('on a Mac it skips LibreSSL 2.8 python3 on PATH and uses Homebrew OpenSSL Python for enroll and LaunchAgent', {skip}, async () => {
	const home = join(root, 'mac-libressl')
	const brewPrefix = join(root, 'fake-brew')
	await mkdir(home)
	await mkdir(join(brewPrefix, 'bin'), {recursive: true})
	const bin = await stubs()
	// Replace PATH python3 with one that mimics Apple's LibreSSL 2.8.3 /usr/bin/python3.
	await writeFile(
		join(bin, 'python3'),
		`#!/bin/bash
if [[ "$*" == *"OPENSSL_VERSION"* ]]; then
  exec /usr/bin/python3 -c 'import ssl, sys; ssl.OPENSSL_VERSION = "LibreSSL 2.8.3"; exec(sys.argv[1])' "$2"
fi
echo "wrong-python3 $*" >>"$FAKE_LOG"
exit 1
`,
	)
	await chmod(join(bin, 'python3'), 0o755)
	// Fake brew pointing at a Homebrew OpenSSL Python (python3.14, not shadowing python3).
	await writeFile(join(bin, 'brew'), `#!/bin/bash\n[ "$1" = "--prefix" ] && { echo "${brewPrefix}"; exit 0; }\nexit 0\n`)
	await chmod(join(bin, 'brew'), 0o755)
	const brewPy = join(brewPrefix, 'bin', 'python3.14')
	await writeFile(
		brewPy,
		`#!/bin/bash
if [ "$2" = enroll ]; then echo "brew-enroll $*" >>"$FAKE_LOG"; echo "Nate's Mac Studio"; exit 0; fi
exec /usr/bin/python3 "$@"
`,
	)
	await chmod(brewPy, 0o755)

	const r = install(home, bin, ['--server', 'https://100.68.115.94:7780', '--ca', CA, '--token', 'abc123', '--allow', 'terminal,files'])
	assert.equal(r.status, 0, r.out)
	const log = await readFile(r.log, 'utf8')
	assert.doesNotMatch(log, /wrong-python3/)
	assert.match(log, /brew-enroll .* enroll https:\/\/100\.68\.115\.94:7780 abc123 terminal,files$/m)
	const plist = await readFile(join(home, 'Library/LaunchAgents/org.myowndatacenter.connector.plist'), 'utf8')
	assert.ok(plist.includes(`<string>${brewPy}</string>`), plist)
})
