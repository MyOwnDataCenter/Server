import assert from 'node:assert/strict'
import {test} from 'node:test'

import {connectorCloudInit, connectorInstallCommand, connectorKind, guestConnectorExec, guestConnectorPrep, guestConnectorReadyCommand, guestDefaultGateway, guestOwnAddresses, guestReachableUrl} from '../omarchyd/guest-install.mjs'

test('guestReachableUrl skips loopback and prefers a LAN address', () => {
	assert.equal(guestReachableUrl({addresses: [], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: '127.0.0.1'}], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: 'localhost'}], port: 7780}), '')
	assert.equal(guestReachableUrl({addresses: [{address: '::1'}], port: 7780}), '')
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}, {address: '192.168.84.81'}], port: 7780}),
		'https://192.168.84.81:7780',
	)
	assert.equal(
		guestReachableUrl({addresses: [{address: '100.64.1.2', tailscale: true}], port: 7780}),
		'https://100.64.1.2:7780',
	)
	assert.equal(guestReachableUrl({addresses: [{address: '10.0.0.4'}], port: 8443}), 'https://10.0.0.4:8443')
})

test('guestReachableUrl skips a passt guest’s own LAN address', () => {
	assert.equal(
		guestReachableUrl({
			addresses: [{address: '100.64.1.2', tailscale: true}, {address: '192.168.84.81'}],
			port: 7780,
			exclude: ['192.168.84.81'],
			gateway: '192.168.86.1',
		}),
		'https://192.168.86.1:7780',
	)
	assert.equal(
		guestReachableUrl({
			addresses: [{address: '100.64.1.2', tailscale: true}, {address: '192.168.84.81'}],
			port: 7780,
			exclude: ['192.168.84.81'],
		}),
		'https://100.64.1.2:7780',
	)
	assert.equal(
		guestReachableUrl({
			addresses: [{address: '192.168.84.81'}],
			port: 7780,
			exclude: ['192.168.84.81'],
			gateway: '192.168.86.1',
		}),
		'https://192.168.86.1:7780',
	)
	assert.equal(
		guestReachableUrl({
			addresses: [{address: '192.168.84.81'}],
			port: 7780,
			exclude: ['192.168.84.81'],
		}),
		'',
	)
})

test('guestOwnAddresses and guestDefaultGateway read qemu-ga JSON', () => {
	assert.deepEqual(guestOwnAddresses(), [])
	assert.deepEqual(guestOwnAddresses([
		{name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }]},
		{name: 'enp1s0', 'ip-addresses': [
			{ 'ip-address-type': 'ipv4', 'ip-address': '192.168.84.81' },
			{ 'ip-address-type': 'ipv6', 'ip-address': 'fe80::1' },
		]},
	]), ['192.168.84.81', 'fe80::1'])
	assert.equal(guestDefaultGateway(), '')
	assert.equal(guestDefaultGateway([
		{version: 4, destination: '192.168.84.0', gateway: '0.0.0.0', mask: '255.255.252.0'},
		{version: 4, destination: '0.0.0.0', gateway: '192.168.86.1', mask: '0.0.0.0'},
	]), '192.168.86.1')
})

test('connectorKind matches Linux systemd guests', () => {
	assert.equal(connectorKind('ubuntu-24.04-server-amd64'), 'linux')
	assert.equal(connectorKind('debian-13-desktop-amd64'), 'linux')
	assert.equal(connectorKind('fedora-44-server-amd64'), 'linux')
	assert.equal(connectorKind('arch-server-amd64'), 'linux')
	assert.equal(connectorKind('omarchy-4.5.0-amd64'), 'linux')
	assert.equal(connectorKind('cachyos-desktop-amd64'), 'linux')
	assert.equal(connectorKind('linuxmint-22.3-cinnamon-amd64'), 'linux')
	assert.equal(connectorKind('opensuse-leap-16.1-amd64'), 'linux')
	assert.equal(connectorKind('rocky-10-server-amd64'), 'linux')
	assert.equal(connectorKind(''), 'linux')
	assert.equal(connectorKind('windows-11'), 'unsupported')
	assert.equal(connectorKind('windows-server'), 'unsupported')
	assert.equal(connectorKind('macos'), 'unsupported')
	assert.equal(connectorKind('haos'), 'unsupported')
	assert.equal(connectorKind('home-assistant'), 'unsupported')
	assert.equal(connectorKind('alpine-3.24.1-amd64'), 'linux')
})

test('connectorCloudInit adds qemu-guest-agent and python without dropping catalog setup', () => {
	const debian = connectorCloudInit({
		familyId: 'debian',
		cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true, adminGroup: 'sudo'},
	})
	assert.deepEqual(debian.packages, ['qemu-guest-agent', 'python3'])
	assert.deepEqual(debian.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	const desktopPkg = debian.commands.find((c) => c.join(' ').includes('task-gnome-desktop'))
	assert.ok(desktopPkg, 'desktop packages install after qemu-ga is enabled')
	assert.equal(debian.commands.indexOf(desktopPkg) > 0, true)
	assert.deepEqual(debian.commands.at(-1), ['systemctl', 'set-default', 'graphical.target'])
	assert.equal(debian.graphical, true)
	assert.equal(debian.adminGroup, 'sudo')
	const arch = connectorCloudInit({familyId: 'arch'})
	assert.deepEqual(arch.packages, ['qemu-guest-agent', 'python'])
	for (const familyId of ['opensuse', 'rocky', 'ubuntu', 'debian']) {
		const seed = connectorCloudInit({familyId, username: 'chris', cloudInit: {adminGroup: familyId === 'ubuntu' || familyId === 'debian' ? 'sudo' : 'wheel'}})
		assert.ok(seed.packages.includes('qemu-guest-agent'), familyId)
		assert.ok(seed.packages.includes('python3'), familyId)
		assert.deepEqual(seed.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	}
	assert.deepEqual(arch.commands, [['systemctl', 'enable', '--now', 'qemu-guest-agent']])
	const withUser = connectorCloudInit({
		familyId: 'debian',
		username: 'chris',
		cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true, adminGroup: 'sudo'},
	})
	assert.deepEqual(withUser.packages, ['qemu-guest-agent', 'python3'])
	assert.deepEqual(withUser.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	assert.deepEqual(withUser.commands[1], ['loginctl', 'enable-linger', 'chris'])
	assert.equal(withUser.commands.some((c) => c.join(' ').includes('task-gnome-desktop')), true)
	assert.deepEqual(withUser.commands.at(-1), ['systemctl', 'set-default', 'graphical.target'])
	assert.equal(withUser.graphical, true)
	const without = connectorCloudInit({familyId: 'debian', cloudInit: {packages: ['task-gnome-desktop'], commands: [['systemctl', 'set-default', 'graphical.target']], graphical: true}})
	assert.equal(without.commands.some((c) => c[0] === 'loginctl'), false)
	assert.deepEqual(without.packages, ['qemu-guest-agent', 'python3'])
	assert.equal(without.graphical, true)
})

test('Fedora cloud-init lets qemu-ga guest-exec open TCP before enroll', () => {
	const fedora = connectorCloudInit({familyId: 'fedora', username: 'chris'})
	assert.deepEqual(fedora.packages, ['qemu-guest-agent', 'python3'])
	assert.deepEqual(fedora.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	assert.deepEqual(fedora.commands[1], ['loginctl', 'enable-linger', 'chris'])
	assert.deepEqual(fedora.commands[2], ['/usr/sbin/setsebool', '-P', 'virt_qemu_ga_run_unconfined', '1'])
	assert.deepEqual(fedora.commands[3], ['systemctl', 'restart', 'qemu-guest-agent'])
	const debian = connectorCloudInit({familyId: 'debian', username: 'chris'})
	assert.equal(debian.commands.some((c) => c.join(' ').includes('setsebool')), false)
})

test('catalog package names are quoted, and a shell character is left out', () => {
	const ok = connectorCloudInit({familyId: 'debian', cloudInit: {packages: ['task-gnome-desktop']}})
	const cmd = ok.commands.find((c) => c.join(' ').includes('task-gnome-desktop'))
	assert.ok(cmd)
	assert.match(cmd.join(' '), /apt-get install -y -- 'task-gnome-desktop'/)
	const bad = connectorCloudInit({familyId: 'debian', cloudInit: {packages: ['ok;curl evil']}})
	assert.equal(bad.commands.some((c) => c.join(' ').includes('curl') || c.join(' ').includes(';')), false)
	assert.deepEqual(bad.packages, ['qemu-guest-agent', 'python3'])
})

test('guestConnectorReadyCommand waits until the account exists and the live ISO is gone', () => {
	const ready = guestConnectorReadyCommand({username: 'chris'})
	assert.equal(ready.path, 'bash')
	assert.equal(ready.args[0], '-lc')
	assert.match(ready.args[1], /\bid chris\b/)
	assert.match(ready.args[1], /\/run\/archiso/)
	assert.match(ready.args[1], /\/run\/archinstall/)
	const missing = guestConnectorReadyCommand({username: ''})
	assert.match(missing.args[1], /exit 1/)
})

test('Alpine cloud-init installs qemu-ga, python3 and bash through OpenRC, without linger', () => {
	const alpine = connectorCloudInit({
		familyId: 'alpine',
		username: 'chris',
		cloudInit: {packages: ['sudo'], shell: '/bin/ash', adminGroup: 'wheel'},
	})
	assert.deepEqual(alpine.packages, ['qemu-guest-agent', 'python3', 'bash', 'curl', 'runuser', 'sudo'])
	assert.equal(alpine.commands.some((c) => c[0] === 'systemctl'), false)
	assert.equal(alpine.commands.some((c) => c[0] === 'loginctl'), false)
	assert.ok(alpine.commands.some((c) => c[0] === 'rc-update' && c.includes('qemu-guest-agent')))
	assert.ok(alpine.commands.some((c) => c[0] === 'rc-service' && c.includes('qemu-guest-agent') && c.includes('start')))
	assert.equal(alpine.shell, '/bin/ash')
	assert.equal(alpine.adminGroup, 'wheel')
	const debian = connectorCloudInit({familyId: 'debian', username: 'chris'})
	assert.equal(debian.packages.includes('bash'), false)
	assert.deepEqual(debian.commands[0], ['systemctl', 'enable', '--now', 'qemu-guest-agent'])
	assert.deepEqual(debian.commands[1], ['loginctl', 'enable-linger', 'chris'])
})

test('guestConnectorPrep enables linger as argv and installs python only when it is missing', () => {
	const prep = guestConnectorPrep({username: 'chris'})
	assert.equal(prep.length >= 1, true)
	assert.deepEqual(prep[0], {path: 'loginctl', args: ['enable-linger', 'chris']})
	const python = prep.find((cmd) => cmd.path === 'bash')
	assert.ok(python, 'python install is a generated bash command')
	assert.equal(python.args[0], '-lc')
	assert.match(python.args[1], /python3/)
	assert.match(python.args[1], /\bpython\b/)
	assert.match(python.args[1], /apt-get/)
	assert.match(python.args[1], /pacman/)
	assert.equal(python.args[1].includes('chris'), false)
	assert.equal(prep[0].args.join(' ').includes('bash'), false)
	assert.match(python.args[1], /apk add --no-cache python3/)
})

test('Alpine prep skips linger and still installs python through apk when it is missing', () => {
	const prep = guestConnectorPrep({username: 'chris', osId: 'alpine-3.24.1-amd64'})
	assert.equal(prep.some((cmd) => cmd.path === 'loginctl'), false)
	const python = prep.find((cmd) => cmd.path === 'bash')
	assert.ok(python, 'python install is a generated bash command')
	assert.match(python.args[1], /apk add --no-cache python3/)
	assert.match(python.args[1], /python3/)
})

test('guest-exec checks this server’s certificate and does not run on Windows', () => {
	const ca = 'a'.repeat(64)
	const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
	const linux = guestConnectorExec({
		os: 'linux',
		username: 'chris',
		source: 'https://example.test',
		server: 'https://192.168.84.81:7780',
		ca,
		token: 'tok',
		allow: 'terminal,desktop,manage,files',
	})
	assert.equal(linux.path, 'runuser')
	assert.deepEqual(linux.args.slice(0, 5), ['-u', 'chris', '--', 'bash', '-lc'])
	assert.equal(linux.args[5].includes('-k'), false)
	assert.equal(linux.args[5].includes('--user-enroll-only'), true)
	assert.match(linux.args[5], /XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\)/)
	assert.match(linux.args[5], /DBUS_SESSION_BUS_ADDRESS/)
	assert.equal(linux.args[5].includes('/etc/init.d/omarchy-connector'), false)
	assert.match(linux.args[5], /curl -fsSL --max-time 60 'https:\/\/example\.test\/main\/connector\/install\.sh'/)
	const local = connectorInstallCommand({source: '/home/x/omarchy-server', server: 'https://10.1.2.3:7780', ca, token: 't', allow: 'terminal', caPem: pem})
	assert.match(local.command, /curl -fsSL --cacert "\$d\/ca\.crt" --max-time 60 'https:\/\/10\.1\.2\.3:7780\/api\/connector\/install\.sh'/)
	assert.equal(local.command.includes('-k'), false)
	assert.equal(local.command.includes('SkipCertificateCheck'), false)
	assert.equal(local.input, pem)
	assert.throws(() => connectorInstallCommand({source: '/home/x/omarchy-server', server: 'https://10.1.2.3:7780', ca, token: 't', allow: 'terminal'}))
	assert.throws(() => guestConnectorExec({os: 'windows', username: 'chris', source: 'https://example.test', server: 'https://192.168.84.81:7780', ca, token: 'tok', allow: 'terminal'}))
})

test('Alpine guest-exec enrolls as the user then starts an OpenRC system service', () => {
	const ca = 'a'.repeat(64)
	const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
	const alpine = guestConnectorExec({
		os: 'linux',
		osId: 'alpine-3.24.1-amd64',
		username: 'chris',
		source: 'https://example.test',
		server: 'https://192.168.84.81:7780',
		ca,
		token: 'tok',
		allow: 'terminal,desktop,manage,files',
	})
	const text = [alpine.path, ...(alpine.args ?? [])].join(' ')
	assert.match(text, /runuser/)
	assert.match(text, /-u chris/)
	assert.match(text, /--user-enroll-only/)
	assert.equal(text.includes('DBUS_SESSION_BUS_ADDRESS'), false)
	assert.match(text, /\/etc\/init\.d\/omarchy-connector/)
	assert.match(text, /rc-update add omarchy-connector/)
	assert.match(text, /rc-service omarchy-connector start/)
	assert.match(text, /command_user=["']?chris/)
	assert.equal(text.indexOf('runuser') < text.indexOf('/etc/init.d/omarchy-connector'), true)
	assert.match(alpine.args[1], / && cat > \/etc\/init\.d\/omarchy-connector/)
	assert.equal(/;[\s\n]*cat > \/etc\/init\.d\/omarchy-connector/.test(alpine.args[1]), false)
	const local = guestConnectorExec({
		os: 'linux',
		osId: 'alpine-3.24.1-amd64',
		username: 'chris',
		source: '/home/x/omarchy-server',
		server: 'https://10.1.2.3:7780',
		ca,
		token: 't',
		allow: 'terminal',
		caPem: pem,
	})
	assert.equal(local.input, pem)
	const cmd = [local.path, ...(local.args ?? [])].join(' ')
	assert.match(cmd, /cat > "\$d\/ca\.crt"/)
	assert.equal(cmd.indexOf('runuser') < cmd.indexOf('/etc/init.d/omarchy-connector'), true)
})
