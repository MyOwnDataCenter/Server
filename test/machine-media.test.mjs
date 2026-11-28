// What a new machine is given so it installs itself: cloud-init, the Omarchy ISO's install files and the
// Windows answer file. These are pure functions, so nothing here starts a machine.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
	PUBLIC_KEY,
	WINDOWS_PRO_SETUP_KEY,
	cloudMetaData,
	cloudUserData,
	hostnameFor,
	isWindowsClientLabel,
	isWindowsLabel,
	omarchyConfiguration,
	omarchyCredentials,
	windowsAnswerFile,
} from '../omarchyd/machine-media.mjs'

const ED25519 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl fred@laptop'
const RSA = `ssh-rsa ${'A'.repeat(40)}`
const ECDSA = `ecdsa-sha2-nistp256 ${'B'.repeat(40)} work`

test('a machine’s hostname is made from its name, or from its id when nothing usable is left', () => {
	assert.equal(hostnameFor('My Server!', 3), 'my-server')
	assert.equal(hostnameFor('  --Web 01--  ', 3), 'web-01')
	assert.equal(hostnameFor('!!!', 7), 'machine-7')
	assert.equal(hostnameFor('', 7), 'machine-7')
	assert.equal(hostnameFor('a'.repeat(100), 1), 'a'.repeat(63), 'at most 63 characters')
	// A machine name can be 64 characters. Cutting it to 63 must not leave a hostname that ends in a hyphen.
	assert.equal(hostnameFor(`${'a'.repeat(62)} b`, 1), 'a'.repeat(62), 'no hyphen at the end after the cut')
	assert.equal(hostnameFor(`${'a'.repeat(60)} - - b`, 1), 'a'.repeat(60))
})

test('SSH keys: public keys of the usual types are accepted, anything else is not', () => {
	for (const k of [ED25519, RSA, ECDSA, `sk-ssh-ed25519@openssh.com ${'C'.repeat(40)}`]) assert.ok(PUBLIC_KEY.test(k), k)
	assert.ok(!PUBLIC_KEY.test('-----BEGIN OPENSSH PRIVATE KEY-----'), 'a private key is never accepted')
	assert.ok(!PUBLIC_KEY.test('ssh-foo AAAAAAAAAAAAAAAAAAAAAAAA'), 'unknown key type')
	assert.ok(!PUBLIC_KEY.test('ssh-ed25519 AAAA'), 'too short to be a key')
	assert.ok(!PUBLIC_KEY.test(`${ED25519}\nssh-rsa ${'A'.repeat(40)}`), 'one key per line')
	assert.ok(!PUBLIC_KEY.test(`ssh-ed25519 ${'A'.repeat(40)} it's`), 'a quote in the comment could end the YAML string')
	assert.ok(!PUBLIC_KEY.test(`ssh-ed25519 ${'A'.repeat(40)} say "hi"`), 'a double quote in the comment')
})

test('cloud-init user data: the account, its password hash and its group', () => {
	const ud = cloudUserData({host: 'box', username: 'chris', hash: '$6$salt$hash'})
	assert.ok(ud.startsWith('#cloud-config\n') && ud.endsWith('\n'))
	assert.match(ud, /hostname: box\n/)
	assert.match(ud, /  - name: chris\n    groups: \[sudo\]\n    sudo: 'ALL=\(ALL\) ALL'\n    shell: \/bin\/bash\n    lock_passwd: false\n    passwd: '\$6\$salt\$hash'\n/)
	assert.match(ud, /ssh_pwauth: true\n/)
	assert.ok(!ud.includes('chpasswd'), 'a new account does not need a password reset')
	assert.ok(!ud.includes('package_update') && !ud.includes('runcmd') && !ud.includes('power_state'), 'nothing extra unless the image asks')

	assert.match(cloudUserData({host: 'h', username: 'u', hash: 'x', cloudInit: {adminGroup: 'wheel'}}), /groups: \[wheel\]/)
	assert.match(cloudUserData({host: 'h', username: 'u', hash: 'x', cloudInit: {adminGroup: 'admin'}}), /groups: \[sudo\]/, 'only wheel is special')
	assert.match(cloudUserData({host: 'h', username: 'u', hash: 'x', cloudInit: {shell: '/bin/zsh'}}), /shell: \/bin\/zsh/)
	assert.doesNotMatch(cloudUserData({host: 'h', username: 'u'}), /^\s+passwd:/m, 'no hash, no password line')
})

test('cloud-init user data: only public keys get in, and an existing account can be given a new password', () => {
	const ud = cloudUserData({host: 'h', username: 'u', hash: 'x', sshKeys: [`  ${ED25519}\n`, '-----BEGIN OPENSSH PRIVATE KEY-----', `ssh-rsa ${'A'.repeat(40)} it's`, RSA]})
	assert.match(ud, /    ssh_authorized_keys:\n      - 'ssh-ed25519 [^']+'\n      - 'ssh-rsa A+'\n/, 'whitespace trimmed; the private key and the key with a quote are dropped')
	assert.equal(ud.match(/^ {6}- '/gm).length, 2)
	assert.ok(!cloudUserData({host: 'h', username: 'u', hash: 'x', sshKeys: ['nonsense']}).includes('ssh_authorized_keys'))

	const again = cloudUserData({host: 'h', username: 'u', hash: '$6$new', changePassword: true})
	assert.match(again, /chpasswd:\n  expire: false\n  users:\n    - \{name: u, password: '\$6\$new', type: hash\}\n/)
	assert.ok(!cloudUserData({host: 'h', username: 'u', changePassword: true}).includes('chpasswd'), 'nothing to set without a hash')
})

test('cloud-init user data: packages and commands from the catalog are checked before they are written', () => {
	const ud = cloudUserData({
		host: 'h',
		username: 'u',
		hash: 'x',
		cloudInit: {
			packages: ['openssh-server', '@gnome-desktop', 'libstdc++6', 'bad;rm -rf /', '-rf', 'two words', ''],
			commands: [['systemctl', 'enable', 'ssh'], 'rm -rf /', [], ['ok', 1], [], ['echo', 'it\'s "quoted"']],
			graphical: true,
		},
	})
	assert.match(ud, /package_update: true\npackages:\n  - 'openssh-server'\n  - '@gnome-desktop'\n  - 'libstdc\+\+6'\nruncmd:/)
	assert.ok(!ud.includes('rm -rf'), 'unsafe package names and a command given as a string are dropped')
	assert.match(ud, /runcmd:\n  - \["systemctl","enable","ssh"\]\n  - \["echo","it's \\"quoted\\""\]\n/, 'commands are argument lists, JSON-quoted')
	assert.match(ud, /power_state:\n  mode: reboot\n  message: Desktop installed, restarting\n  condition: true\n$/)
	const none = cloudUserData({host: 'h', username: 'u', hash: 'x', cloudInit: {packages: 'not-a-list'}})
	assert.ok(!none.includes('packages:'), 'a package list with the wrong shape adds nothing')
})

test('cloud-init meta data names the machine and is new every time', () => {
	const a = cloudMetaData('box')
	assert.match(a, /^instance-id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\nlocal-hostname: box\n$/)
	assert.notEqual(a, cloudMetaData('box'), 'a new instance id each time, so cloud-init runs again')
})

test('Omarchy install: one disk, a boot partition and Btrfs with the usual subvolumes', () => {
	const GiB = 1024 ** 3
	const MiB = 1024 ** 2
	const cfg = omarchyConfiguration({host: 'om', diskSizeGb: 64})
	assert.equal(cfg.hostname, 'om')
	assert.equal(cfg.timezone, 'UTC')
	assert.equal(omarchyConfiguration({host: 'om', diskSizeGb: 64, timezone: 'America/New_York'}).timezone, 'America/New_York')
	assert.equal(cfg.bootloader_config.bootloader, 'Limine')

	const [disk, ...others] = cfg.disk_config.device_modifications
	assert.equal(others.length, 0, 'the machine’s only disk')
	assert.equal(disk.device, '/dev/vda')
	assert.equal(disk.wipe, true)
	const [boot, root] = disk.partitions
	assert.equal(boot.mountpoint, '/boot')
	assert.deepEqual(boot.flags, ['boot', 'esp'])
	assert.equal(boot.size.value, 2 * GiB)
	assert.equal(root.fs_type, 'btrfs')
	assert.deepEqual(root.btrfs.map((s) => [s.name, s.mountpoint]), [['@', '/'], ['@home', '/home'], ['@log', '/var/log'], ['@pkg', '/var/cache/pacman/pkg']])
	assert.equal(root.start.value, boot.start.value + boot.size.value, 'the root partition starts where the boot partition ends')
	assert.ok(root.start.value + root.size.value <= 64 * GiB - MiB, 'room left at the end of the disk')
	assert.notEqual(boot.obj_id, root.obj_id)

	assert.deepEqual(omarchyCredentials({username: 'chris', hash: '$6$x'}), {users: [{username: 'chris', enc_password: '$6$x', sudo: true}]})
	assert.deepEqual(cfg.packages, ['qemu-guest-agent'])
	assert.deepEqual(cfg.services, ['qemu-guest-agent'])
})

test('Windows disc labels', () => {
	assert.equal(isWindowsClientLabel('CCCOMA_X64FRE_EN-US_DV9'), true)
	assert.equal(isWindowsClientLabel('cccoma_x64fre_en-us_dv9'), true, 'case does not matter')
	assert.equal(isWindowsClientLabel('CCCOMA_A64FRE_EN-US_DV9'), false, 'the Arm edition is not for these machines')
	assert.equal(isWindowsClientLabel('ARCH_202611'), false)
	assert.equal(isWindowsClientLabel(null), false)
	assert.equal(isWindowsClientLabel(undefined), false)
	for (const l of ['CCCOMA_X64FRE_EN-US_DV9', 'CPBA_A64FRE_EN-US_DV5', 'CCSA_X64FRE_EN-US_DV5', 'JCPRA_X64FRE_EN-US_DV5', 'GRMC_X64FRE', 'Win11_25H2_English_x64']) assert.equal(isWindowsLabel(l), true, l)
	for (const l of ['ARCH_202611', 'Fedora-Workstation-Live-44', 'ubuntu-24.04.3-desktop-amd64', 'OMARCHY_4_0_4', '']) assert.equal(isWindowsLabel(l), false, l)
	assert.equal(isWindowsLabel(null), false)
})

test('Windows answer file: names are cleaned, text is escaped and the password is not in plain text', () => {
	const xml = windowsAnswerFile({computerName: 'MY-PC & stuff', username: 'chris', password: 'hunter2 secret'})
	assert.match(xml, /<ComputerName>MY-PCstuff<\/ComputerName>/)
	assert.match(windowsAnswerFile({computerName: 'THIS-NAME-IS-WAY-TOO-LONG', username: 'u', password: 'p'}), /<ComputerName>THIS-NAME-IS-WA<\/ComputerName>/, 'Windows allows 15 characters')
	assert.match(windowsAnswerFile({computerName: '!!!', username: 'u', password: 'p'}), /<ComputerName>OMARCHY-WIN<\/ComputerName>/)

	const odd = windowsAnswerFile({computerName: 'pc', username: `a<b>&"'c`, password: 'p'})
	assert.match(odd, /<Name>a&lt;b&gt;&amp;&quot;&apos;c<\/Name>/)
	assert.match(odd, /<DisplayName>a&lt;b&gt;&amp;&quot;&apos;c<\/DisplayName>/)
	assert.ok(!odd.includes('a<b>'), 'the raw characters never reach the XML')

	// Windows wants base64 of UTF-16LE(password + "Password"); it must decode back, even with accents.
	const accented = windowsAnswerFile({computerName: 'pc', username: 'u', password: 'pässwörd'})
	const [, b64] = accented.match(/<Password><Value>([^<]+)<\/Value><PlainText>false<\/PlainText><\/Password>/)
	assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), 'pässwördPassword')
	assert.ok(!accented.includes('pässwörd<'), 'no plain-text password')

	assert.match(xml, new RegExp(`<Key>${WINDOWS_PRO_SETUP_KEY}</Key>`), 'the generic setup key by default')
	assert.match(windowsAnswerFile({computerName: 'pc', username: 'u', password: 'p', productKey: 'AAAAA-<&>'}), /<Key>AAAAA-&lt;&amp;&gt;<\/Key>/, 'a key is escaped too')
	for (const bypass of ['BypassTPMCheck', 'BypassSecureBootCheck', 'BypassRAMCheck', 'BypassNRO']) assert.match(xml, new RegExp(bypass))
	assert.equal(xml.match(/<component /g).length, xml.match(/<\/component>/g).length, 'every component is closed')
	assert.equal(xml.match(/<settings /g).length, 3)
	assert.doesNotMatch(xml, /FirstLogonCommands/)
})

test('a Windows answer file does not install the connector', () => {
	const none = windowsAnswerFile({computerName: 'pc', username: 'chris', password: 'hunter2 secret'})
	assert.doesNotMatch(none, /FirstLogonCommands/)
	assert.doesNotMatch(none, /AutoLogon/)
	assert.doesNotMatch(none, /install\.ps1/)
	assert.doesNotMatch(none, /powershell/i)
	assert.ok(!none.includes('hunter2'), 'password not in plain text')
	const passwords = [...none.matchAll(/<Password><Value>([^<]+)<\/Value><PlainText>false<\/PlainText><\/Password>/g)].map((m) => m[1])
	assert.equal(passwords.length, 1)
	for (const b64 of passwords) assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), 'hunter2 secretPassword')
})

test('a catalog entry whose commands isn’t a list is ignored, not a crash', () => {
	const ud = cloudUserData({host: 'h', username: 'u', hash: 'x', cloudInit: {commands: 'rm -rf /'}})
	assert.doesNotMatch(ud, /runcmd|rm -rf/)
})
