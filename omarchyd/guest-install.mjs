// How a guest reaches this server, and which connector that guest can run.
// Pairing still lives in connector.mjs; this file stays free of I/O so tests stay cheap.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const HTTPS_BASE = /^https:\/\/[^/?#\s]+/i

export const GUEST_PAIR_TTL = 6 * 60 * 60_000
export const LINUX_CONNECTOR_ALLOW = ['terminal', 'desktop', 'manage', 'files']

function skipSet(exclude) {
	const skip = new Set(LOOPBACK)
	for (const value of Array.isArray(exclude) ? exclude : []) {
		const address = String(value ?? '').trim().toLowerCase()
		if (address) skip.add(address)
	}
	return skip
}

function httpsUrl(host, port) {
	const address = String(host ?? '').trim()
	if (!address) return ''
	return address.includes(':') ? `https://[${address}]:${port}` : `https://${address}:${port}`
}

export function guestReachableUrl({addresses = [], port, exclude = [], gateway} = {}) {
	const n = Number(port)
	if (!Number.isInteger(n) || n < 1 || n > 65535) return ''
	const skip = skipSet(exclude)
	const rows = (Array.isArray(addresses) ? addresses : []).filter((row) => {
		const address = String(row?.address ?? '').trim()
		return address && !skip.has(address.toLowerCase())
	})
	const lan = rows.find((row) => !row.tailscale)
	if (lan) return httpsUrl(lan.address, n)
	const gw = String(gateway ?? '').trim()
	if (gw && !skip.has(gw.toLowerCase())) return httpsUrl(gw, n)
	const chosen = rows[0]
	if (chosen) return httpsUrl(chosen.address, n)
	return ''
}

export function guestOwnAddresses(ifaces = []) {
	const out = []
	for (const iface of Array.isArray(ifaces) ? ifaces : []) {
		for (const row of Array.isArray(iface?.['ip-addresses']) ? iface['ip-addresses'] : []) {
			const address = String(row?.['ip-address'] ?? '').trim()
			if (address && !LOOPBACK.has(address.toLowerCase())) out.push(address)
		}
	}
	return out
}

export function guestDefaultGateway(routes = []) {
	for (const row of Array.isArray(routes) ? routes : []) {
		if (Number(row?.version) !== 4 || String(row?.destination ?? '') !== '0.0.0.0') continue
		const gw = String(row?.gateway ?? '').trim()
		if (gw && gw !== '0.0.0.0') return gw
	}
	return ''
}

function isAlpine(osId = '', familyId = '') {
	return /alpine/.test(String(osId).toLowerCase()) || String(familyId).toLowerCase() === 'alpine'
}

function isFedora(osId = '', familyId = '') {
	return /fedora|rhel|centos|rocky|alma/.test(`${osId} ${familyId}`.toLowerCase())
}

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,127}$/

function extraPackageCommand(names) {
	const list = names.map((n) => String(n))
	if (!list.length || list.some((n) => !PACKAGE_NAME.test(n))) return null
	const quoted = list.map((n) => `'${n}'`).join(' ')
	return ['bash', '-lc', [
		`if command -v apt-get >/dev/null 2>&1; then apt-get install -y -- ${quoted}`,
		`elif command -v dnf >/dev/null 2>&1; then dnf install -y -- ${quoted}`,
		`elif command -v pacman >/dev/null 2>&1; then pacman -S --needed --noconfirm -- ${quoted}`,
		`elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install -- ${quoted}`,
		`elif command -v apk >/dev/null 2>&1; then apk add --no-cache -- ${quoted}`,
		'else exit 1; fi',
	].join('; ')]
}

export function guestConnectorReadyCommand({username} = {}) {
	const user = String(username ?? '').trim()
	if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root') {
		return {path: 'bash', args: ['-lc', 'exit 1']}
	}
	return {path: 'bash', args: ['-lc', [
		`id ${user} >/dev/null 2>&1`,
		'! test -e /run/archiso',
		'! test -e /run/archinstall',
		'! test -d /run/live',
	].join(' && ')]}
}

export function connectorKind(osId = '') {
	const id = String(osId).toLowerCase()
	// The connector runs on Linux with systemd or Alpine OpenRC. Windows, macOS, and Home Assistant do not run it.
	if (/win|macos|osx|darwin|haos|home-?assistant/.test(id)) return 'unsupported'
	return 'linux'
}

export function connectorCloudInit(img = {}) {
	const alpine = isAlpine(img.osId, img.familyId)
	const fedora = isFedora(img.osId, img.familyId)
	const python = img.familyId === 'arch' ? 'python' : 'python3'
	const given = img.cloudInit && typeof img.cloudInit === 'object' ? img.cloudInit : {}
	const extra = Array.isArray(given.packages) ? given.packages : []
	const packages = alpine ? ['qemu-guest-agent', 'python3', 'bash', 'curl', 'runuser', ...extra] : ['qemu-guest-agent', python]
	const enableGa = alpine
		? [['rc-update', 'add', 'qemu-guest-agent', 'default'], ['rc-service', 'qemu-guest-agent', 'start']]
		: [['systemctl', 'enable', '--now', 'qemu-guest-agent']]
	const commands = [...enableGa]
	const username = String(img.username ?? '').trim()
	if (username && !alpine) commands.push(['loginctl', 'enable-linger', username])
	if (fedora) {
		commands.push(['/usr/sbin/setsebool', '-P', 'virt_qemu_ga_run_unconfined', '1'])
		commands.push(['systemctl', 'restart', 'qemu-guest-agent'])
	}
	if (!alpine && extra.length) {
		const extraCmd = extraPackageCommand(extra)
		if (extraCmd) commands.push(extraCmd)
	}
	commands.push(...(Array.isArray(given.commands) ? given.commands : []))
	return {...given, packages, commands}
}

// qemu-ga is root. Linger is argv, not a shell. Python is installed only when neither name is on PATH.
const PYTHON_IF_MISSING = [
	'if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then exit 0; fi',
	'if command -v apt-get >/dev/null 2>&1; then apt-get install -y python3',
	'elif command -v dnf >/dev/null 2>&1; then dnf install -y python3',
	'elif command -v pacman >/dev/null 2>&1; then pacman -S --needed --noconfirm python',
	'elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install python3',
	'elif command -v apk >/dev/null 2>&1; then apk add --no-cache python3',
	'else exit 1; fi',
].join('; ')

export function guestConnectorPrep({username, osId} = {}) {
	const cmds = []
	if (!isAlpine(osId)) cmds.push({path: 'loginctl', args: ['enable-linger', String(username ?? '')]})
	cmds.push({path: 'bash', args: ['-lc', PYTHON_IF_MISSING]})
	return cmds
}

export function defaultConnectorAbilities(os) {
	if (os !== 'linux') return {}
	return Object.fromEntries(LINUX_CONNECTOR_ALLOW.map((k) => [k, true]))
}

export function connectorAllowList(os, abilities = {}) {
	if (os !== 'linux') return ''
	return LINUX_CONNECTOR_ALLOW.filter((k) => abilities[k] === true).join(',')
}

const sh = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function installParts({source, server, ca, token, allow}) {
	const given = String(source ?? '').trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = String(server ?? '').replace(/\/+$/, '')
	if (!/^https:\/\/[A-Za-z0-9._:-]+$/.test(origin) && !/^https:\/\/\[[0-9a-f:.]+\](?::[0-9]{1,5})?$/i.test(origin)) throw new Error('The server address has to be https')
	if (!/^[a-f0-9]{64}$/.test(String(ca ?? ''))) throw new Error('The certificate fingerprint is not valid')
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(token ?? ''))) throw new Error('The pairing code is not valid')
	const allowList = String(allow ?? '')
	if (allowList && !/^(?:terminal|desktop|manage|files|storage|backup|services|vms|containers)(?:,(?:terminal|desktop|manage|files|storage|backup|services|vms|containers))*$/.test(allowList)) throw new Error('The permission list is not valid')
	const src = remote ? given : `${origin}/api/connector`
	if (!HTTPS_BASE.test(src) && src !== `${origin}/api/connector`) throw new Error('The download address has to be https')
	const script = remote ? `${src}/main/connector/install.sh` : `${src}/install.sh`
	const args = `--server ${sh(origin)} --ca ${sh(ca)} --token ${sh(token)}${allowList ? ` --allow ${sh(allowList)}` : ''} --source ${sh(src)}`
	return {remote, script, args}
}

// A public catalog is fetched with the system trust store. This server's own copy is fetched
// with this server's certificate on stdin, never with verification turned off.
export function connectorInstallCommand({source, server, ca, token, allow, caPem}) {
	const {remote, script, args} = installParts({source, server, ca, token, allow})
	if (remote) return {command: `curl -fsSL --max-time 60 ${sh(script)} | bash -s -- ${args}`, input: undefined}
	if (typeof caPem !== 'string' || !caPem.includes('BEGIN CERTIFICATE')) throw new Error('This server’s certificate is required')
	const command = [`d=$(mktemp -d)`, `trap 'rm -rf "$d"' EXIT`, `cat > "$d/ca.crt"`, `curl -fsSL --cacert "$d/ca.crt" --max-time 60 ${sh(script)} | bash -s -- ${args}`].join('; ')
	return {command, input: caPem}
}

function alpineOpenrcFollowup(username) {
	const user = String(username)
	const dir = `/home/${user}/.local/share/omarchy-connector`
	const unit = [
		'#!/sbin/openrc-run',
		'name="omarchy-connector"',
		'command="/usr/bin/env"',
		`command_args="python3 ${dir}/agent.py"`,
		`command_user="${user}"`,
		'supervisor=supervise-daemon',
		'respawn_delay=5',
		'pidfile="/run/omarchy-connector.pid"',
		'start_pre() {',
		`  uid=$(id -u ${user})`,
		'  mkdir -p "/run/user/$uid"',
		`  chown ${user} "/run/user/$uid"`,
		'}',
		'',
	].join('\n')
	return [
		`cat > /etc/init.d/omarchy-connector <<'EOF'`,
		unit,
		'EOF',
		'chmod +x /etc/init.d/omarchy-connector',
		'rc-update add omarchy-connector default',
		'rc-service omarchy-connector start',
	].join('\n')
}

export function guestConnectorExec({os, osId, username, source, server, ca, token, allow, caPem}) {
	if (os !== 'linux') throw new Error('This operating system can’t run the connector.')
	if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(String(username ?? '')) || username === 'root') throw new Error('Use a lower-case username')
	const built = connectorInstallCommand({source, server, ca, token, allow, caPem})
	if (isAlpine(osId)) {
		const enroll = `${built.command} --user-enroll-only`
		const exec = {path: 'bash', args: ['-lc', `runuser -u ${username} -- bash -lc ${sh(enroll)} && ${alpineOpenrcFollowup(username)}`]}
		if (built.input) exec.input = built.input
		return exec
	}
	// qemu-ga runuser has no login session, so systemctl --user needs the user bus explicitly.
	const session = 'export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path="$XDG_RUNTIME_DIR/bus"'
	const exec = {path: 'runuser', args: ['-u', username, '--', 'bash', '-lc', `${session}; ${built.command} --user-enroll-only`]}
	if (built.input) exec.input = built.input
	return exec
}
