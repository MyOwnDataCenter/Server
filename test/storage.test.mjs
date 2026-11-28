// The root helper's checks (with simulated commands and files) and omarchyd's storage module.
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import {createHelper} from '../helper/helper.mjs'
import {createFiles} from '../omarchyd/files.mjs'
import {createStorage} from '../omarchyd/storage.mjs'

const user = {name: 'chris', uid: 1000, gid: 1000, home: '/home/chris'}
const lsblk = {
	blockdevices: [
		{name: 'nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 512e9, rota: false, tran: 'nvme', serial: 'NV1', children: [{name: 'nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', fstype: 'vfat', mountpoints: ['/boot']}, {name: 'nvme0n1p2', path: '/dev/nvme0n1p2', type: 'part', fstype: 'btrfs', uuid: '11111111-1111-1111-1111-111111111111', mountpoints: ['/', '/home']}]},
		{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-A', model: 'WD Red', mountpoints: [null]},
		{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 4e12, rota: '1', tran: 'sata', serial: 'WD-B', mountpoints: [null]},
		{name: 'sdc', path: '/dev/sdc', type: 'disk', size: 2e12, rota: true, tran: 'sata', serial: 'OLD', children: [{name: 'sdc1', path: '/dev/sdc1', type: 'part', fstype: 'ntfs', mountpoints: [null]}]},
		{name: 'sdd', path: '/dev/sdd', type: 'disk', size: 1e12, rota: false, tran: 'sata', serial: 'SSD1', fstype: 'btrfs', uuid: '22222222-2222-2222-2222-222222222222', label: 'media', mountpoints: [null]},
	],
}

function fakeFs(initial = {}) {
	const files = new Map(Object.entries(initial))
	return {
		files,
		readFile: async (p) => {
			if (!files.has(p)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
			return files.get(p)
		},
		writeFile: async (p, t) => void files.set(p, t),
		rename: async (a, b) => void (files.set(b, files.get(a)), files.delete(a)),
		mkdir: async () => {},
		chown: async () => {},
		realpath: async (p) => {
			if (p.includes('missing')) throw new Error('ENOENT')
			return p.replace('/home/chris/link-out', '/etc')
		},
	}
}
function fakeRun(log, extra = {}) {
	return async (cmd, args, opts) => {
		log.push([cmd, ...args, ...(opts?.input ? [`<stdin:${opts.input.split('\n')[0].length}>`] : [])])
		if (cmd === 'lsblk') return JSON.stringify(lsblk)
		if (cmd === 'wipefs') return JSON.stringify({signatures: []})
		if (cmd === 'blkid') return '33333333-3333-3333-3333-333333333333\n'
		if (cmd === 'ufw') return args[0] === 'status' ? 'Status: active\n' : ''
		if (extra[cmd]) return extra[cmd](args)
		return ''
	}
}

describe('helper', () => {
	test('desktop sign-in: once, for the owner only, never over someone’s session, file always removed', async () => {
		const files = {'/usr/lib/systemd/system/sddm.service': '', '/usr/share/wayland-sessions/omarchy.desktop': ''}
		let sessions = [] // [{user, type}]
		const log = []
		const loginctl = (args) =>
			args[0] === 'list-sessions'
				? sessions.map((x, i) => `${i + 1} 1000 ${x.user} seat0 tty1`).join('\n')
				: (({user: u, type}) => `Name=${u}\nType=${type}\nState=active\nClass=user\n`)(sessions[Number(args[1]) - 1])
		const fs = fakeFs(files)
		const h = createHelper({
			user,
			fs,
			run: fakeRun(log, {
				loginctl,
				systemctl: (args) => {
					assert.match(fs.files.get('/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'), /\[Autologin\]\nUser=chris\nSession=omarchy\.desktop\nRelogin=false/)
					if (args[0] === 'restart') sessions = [{user: 'chris', type: 'wayland'}]
					return ''
				},
				rm: (args) => (fs.files.delete(args.at(-1)), ''),
			}),
		})
		assert.equal(await h.handle('desktop-sign-in'), 'signed-in')
		assert.equal(fs.files.has('/etc/sddm.conf.d/zz-omarchy-server-sign-in.conf'), false, 'the one-time sign-in is gone')
		assert.ok(log.some((l) => l.join(' ') === 'faillock --user chris --reset'), 'a lockout is cleared')
		assert.equal(await h.handle('desktop-sign-in'), 'already', 'signed in already: nothing touched')
		sessions = [{user: 'guest', type: 'wayland'}]
		log.length = 0
		await assert.rejects(h.handle('desktop-sign-in'), /Someone else is signed in/)
		assert.ok(!log.some((l) => l[0] === 'systemctl'), 'another person’s session is never restarted')
	})

	test('refuses to run for root or an unknown user, and unknown verbs', async () => {
		assert.throws(() => createHelper({user: {...user, uid: 0}}), /sudo/)
		const h = createHelper({user, run: fakeRun([]), fs: fakeFs()})
		await assert.rejects(h.handle('rm', ['-rf', '/']), /Unknown action/)
	})

	test('pool-create: blank drives only, never the system drive; writes fstab and mounts in ~/Pools', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': 'UUID=1111 / btrfs defaults 0 0\n'})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('pool-create', ['Bad Name', 'single', '/dev/sda']), /Pool names/)
		await assert.rejects(h.handle('pool-create', ['tank', 'raid5', '/dev/sda', '/dev/sdb']), /single, raid1 or raid10/)
		await assert.rejects(h.handle('pool-create', ['tank', 'raid1', '/dev/sda']), /at least 2/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/nvme0n1']), /holds the system/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sdc']), /isn’t blank.*Format this drive first/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sda;reboot']), /Not a drive/)
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/etc/passwd']), /Not a drive/)
		assert.ok(!log.some((l) => l[0] === 'mkfs.btrfs'), 'nothing formatted by refused requests')
		const out = JSON.parse(await h.handle('pool-create', ['tank', 'raid1', '/dev/sda', '/dev/sdb']))
		assert.equal(out.mountpoint, '/home/chris/Pools/tank')
		assert.deepEqual(log.find((l) => l[0] === 'mkfs.btrfs'), ['mkfs.btrfs', '-L', 'omarchy-tank', '-d', 'raid1', '-m', 'raid1', '/dev/sda', '/dev/sdb'])
		const fstab = fs.files.get('/etc/fstab')
		assert.match(fstab, /^UUID=1111 \/ btrfs defaults 0 0$/m, 'existing lines kept')
		assert.match(fstab, /^UUID=33333333-3333-3333-3333-333333333333 \/home\/chris\/Pools\/tank btrfs .*nofail.* # omarchy-server pool tank$/m)
		assert.ok(log.some((l) => l[0] === 'mount' && l[1] === '/home/chris/Pools/tank'))
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sda']), /already a pool/)
	})

	test('pool-import mounts an existing Btrfs filesystem without changing it', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('pool-import', ['media', 'not-a-uuid']), /Choose a filesystem/)
		await h.handle('pool-import', ['media', '22222222-2222-2222-2222-222222222222'])
		assert.match(fs.files.get('/etc/fstab'), /UUID=22222222-2222-2222-2222-222222222222 \/home\/chris\/Pools\/media btrfs/)
		assert.ok(!log.some((l) => ['mkfs.btrfs', 'wipefs', 'btrfs'].includes(l[0]) && l[1] !== '--no-act'))
	})

	test('failed pool-import and pool-create roll back fstab so retry works; pool-forget removes unmounted pool', async () => {
		const log = []
		let failMount = true
		const fs = fakeFs({'/etc/fstab': 'UUID=1111 / btrfs defaults 0 0\n'})
		const h = createHelper({
			user,
			fs,
			run: fakeRun(log, {
				mount: () => {
					if (failMount) throw new Error('mount: wrong fs type, bad option, bad superblock')
					return ''
				},
				umount: () => {
					throw new Error('umount: /home/chris/Pools/media: not mounted.')
				},
			}),
		})
		await assert.rejects(h.handle('pool-import', ['media', '22222222-2222-2222-2222-222222222222']), /wrong fs type/)
		assert.equal(fs.files.get('/etc/fstab'), 'UUID=1111 / btrfs defaults 0 0\n')
		assert.ok(log.filter((l) => l.join(' ') === 'systemctl daemon-reload').length >= 2, 'daemon-reload runs after fstab rollback')

		// Retrying import is not blocked by a stale fstab line.
		failMount = false
		await h.handle('pool-import', ['media', '22222222-2222-2222-2222-222222222222'])
		assert.match(fs.files.get('/etc/fstab'), /# omarchy-server pool media/)
		assert.equal(await h.handle('pool-forget', ['media']), 'ok')
		assert.equal(fs.files.get('/etc/fstab'), 'UUID=1111 / btrfs defaults 0 0\n')

		// pool-create rolls back fstab if mount fails too.
		failMount = true
		await assert.rejects(h.handle('pool-create', ['tank', 'single', '/dev/sda']), /wrong fs type/)
		assert.equal(fs.files.get('/etc/fstab'), 'UUID=1111 / btrfs defaults 0 0\n')
	})

	test('pool-status reads profile, error counters and the last check', async () => {
		const fs = fakeFs({'/etc/fstab': 'UUID=x /home/chris/Pools/tank btrfs d 0 0 # omarchy-server pool tank\n'})
		const h = createHelper({
			user,
			fs,
			run: fakeRun([], {
				btrfs: (a) =>
					a[0] === 'filesystem'
						? 'Data, RAID1: total=1000, used=10\nMetadata, RAID1: total=100, used=1\n'
						: a[0] === 'device'
							? '[/dev/sda].write_io_errs    0\n[/dev/sda].corruption_errs  2\n[/dev/sdb].write_io_errs    0\n'
							: 'UUID: x\nScrub started:    Tue Nov 10 03:00:00 2026\nStatus:           finished\nError summary:    no errors found\n',
			}),
		})
		const s = JSON.parse(await h.handle('pool-status', ['tank']))
		assert.equal(s.profile, 'raid1')
		assert.equal(s.devices['/dev/sda'].corruption_errs, 2)
		assert.deepEqual(s.scrub, {state: 'finished', errors: '', started: 'Tue Nov 10 03:00:00 2026'})
		await assert.rejects(h.handle('pool-status', ['nope']), /No pool/)
	})

	test('shares: only folders inside home; a foreign smb.conf is kept and only gets an include', async () => {
		const log = []
		const fs = fakeFs({})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'etc', path: '/home/chris/link-out'}]})), /inside your home/)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'x]\n[evil', path: '/home/chris/Music'}]})), /Bad share name/)
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Global', path: '/home/chris/Music'}]})), /Bad share name/)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'homes', path: '/home/chris/Music'}]})), /Bad share name/)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'printers', path: '/home/chris/Music'}]})), /Bad share name/)
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Photos', path: '/home/chris/Photos 20%used'}]}))
		assert.match(fs.files.get('/etc/samba/smb.conf'), /path = \/home\/chris\/Photos 20%%used/)
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		const conf = fs.files.get('/etc/samba/smb.conf')
		assert.match(conf, /^# Managed by Omarchy Server/)
		assert.match(conf, /\[Music\]\n {3}path = \/home\/chris\/Music\n {3}valid users = chris/)
		assert.match(conf, /map to guest = never/)
		assert.ok(log.some((l) => l.join(' ') === 'ufw delete allow 445/tcp'), 'older unrestricted 445 is closed when shares are applied')
		assert.ok(!log.some((l) => l.join(' ') === 'ufw allow 445/tcp comment Omarchy Server shares'), '445 is not opened to the world')
		for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
			assert.ok(log.some((l) => l.join(' ') === `ufw delete allow from ${cidr} to any port 445 proto tcp`), cidr)
			assert.ok(log.some((l) => l.join(' ') === `ufw allow from ${cidr} to any port 445 proto tcp comment Omarchy Server shares`), cidr)
		}
		assert.ok(!log.some((l) => /100\.64\.0\.0\/10/.test(l.join(' '))), 'Tailscale is a second network')
		log.length = 0
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		assert.equal(log.filter((l) => l[0] === 'ufw' && l[1] === 'allow').length, 3, 're-applying replaces the LAN rules instead of stacking them')
		const fs2 = fakeFs({'/etc/samba/smb.conf': '[global]\n   workgroup = HOME\n'})
		await createHelper({user, run: fakeRun([]), fs: fs2}).handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		assert.match(fs2.files.get('/etc/samba/smb.conf'), /^\[global\]\n {3}workgroup = HOME\n[\s\S]*include = \/etc\/samba\/omarchy-server-shares.conf/)
		assert.match(fs2.files.get('/etc/samba/omarchy-server-shares.conf'), /\[Music\]/)
		// …but there Samba's guest settings are yours, so no-password shares are refused.
		await assert.rejects(createHelper({user, run: fakeRun([]), fs: fs2}).handle('shares-apply', [], JSON.stringify({shares: [{name: 'Open', path: '/home/chris/Open', guest: true}]})), /own Samba settings/)
	})

	test('shares without a password: guests only for those shares; guest writes are not forced as you; off again when none are left', async () => {
		const fs = fakeFs({})
		const h = createHelper({user, run: fakeRun([]), fs})
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}, {name: 'Open', path: '/home/chris/Open', guest: true, readOnly: true}]}))
		let conf = fs.files.get('/etc/samba/smb.conf')
		assert.match(conf, /map to guest = bad user/)
		assert.match(conf, /\[Music\]\n {3}path = \/home\/chris\/Music\n {3}valid users = chris\n {3}force user = chris/)
		assert.match(conf, /\[Open\]\n {3}path = \/home\/chris\/Open\n {3}guest ok = yes\n {3}read only = yes/)
		assert.doesNotMatch(conf.split('[Music]')[1].split('[Open]')[0], /guest ok/)
		assert.doesNotMatch(conf.split('[Open]')[1].split('[')[0], /force user/, 'guest writes are not forced as the owner')
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		conf = fs.files.get('/etc/samba/smb.conf')
		assert.match(conf, /map to guest = never/)
		assert.match(conf, /restrict anonymous = 2/)
		assert.doesNotMatch(conf, /guest ok/)
	})

	test('shares refuse hidden path components', async () => {
		const h = createHelper({user, run: fakeRun([]), fs: fakeFs()})
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'ssh', path: '/home/chris/.ssh'}]})), /hidden/i)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'cfg', path: '/home/chris/.config/code'}]})), /hidden/i)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'dot', path: '/home/chris/Music/.private'}]})), /hidden/i)
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
	})

	test('shares close the old world-open 445 rule and the LAN rules when none are left', async () => {
		const log = []
		const h = createHelper({user, run: fakeRun(log), fs: fakeFs()})
		await h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]}))
		log.length = 0
		await h.handle('shares-apply', [], JSON.stringify({shares: []}))
		assert.ok(log.some((l) => l.join(' ') === 'ufw delete allow 445/tcp'), 'older unrestricted 445 is closed')
		for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
			assert.ok(log.some((l) => l.join(' ') === `ufw delete allow from ${cidr} to any port 445 proto tcp`), cidr)
		}
	})

	test('sleep: hard drives only, valid times only, kept by serial', async () => {
		const log = []
		const fs = fakeFs({})
		const h = createHelper({user, run: fakeRun(log), fs})
		await assert.rejects(h.handle('sleep', ['/dev/sdd', '20']), /spinning/)
		await assert.rejects(h.handle('sleep', ['/dev/sda', '7']), /Choose/)
		await h.handle('sleep', ['/dev/sda', '30'])
		assert.ok(log.some((l) => l.join(' ') === 'hdparm -S 241 /dev/sda'))
		assert.match(fs.files.get('/etc/udev/rules.d/69-omarchy-server-sleep.rules'), /ID_SERIAL_SHORT}=="WD-A".*hdparm -S 241/)
		await h.handle('sleep', ['/dev/sda', '0'])
		assert.equal(fs.files.get('/etc/udev/rules.d/69-omarchy-server-sleep.rules'), '')
	})

	test('ZFS: blank drives only, stable drive names, layouts and mountpoint in ~/Pools', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		fs.readdir = async () => ['ata-WDC_WD80_A', 'ata-WDC_WD80_A-part1', 'wwn-0x5000a', 'ata-WDC_WD80_B']
		fs.realpath = async (p) => ({'/dev/disk/by-id/ata-WDC_WD80_A': '/dev/sda', '/dev/disk/by-id/wwn-0x5000a': '/dev/sda', '/dev/disk/by-id/ata-WDC_WD80_B': '/dev/sdb'})[p] ?? p
		const h = createHelper({user, fs, run: fakeRun(log, {zpool: (a) => (a[0] === 'list' ? '' : '')})})
		await assert.rejects(h.handle('zfs-create', ['tank', 'raidz1', '/dev/sda', '/dev/sdb']), /at least 3/)
		await assert.rejects(h.handle('zfs-create', ['tank', 'raidz9', '/dev/sda']), /Choose/)
		await assert.rejects(h.handle('zfs-create', ['tank', 'mirror', '/dev/sda', '/dev/sdc']), /isn’t blank/)
		await h.handle('zfs-create', ['tank', 'mirror', '/dev/sda', '/dev/sdb'])
		const create = log.find((l) => l[0] === 'zpool' && l[1] === 'create')
		assert.deepEqual(create.slice(-4), ['tank', 'mirror', '/dev/disk/by-id/ata-WDC_WD80_A', '/dev/disk/by-id/ata-WDC_WD80_B'])
		assert.ok(create.includes('mountpoint=/home/chris/Pools/tank'))
		assert.ok(create.includes('ashift=12'))
		assert.ok(log.some((l) => l.join(' ') === 'systemctl enable zfs-import-cache.service'))
	})

	test('ZFS import: setuid and devices off, refused if it would mount over a system folder, force only when asked', async () => {
		const log = []
		let mountpoints = 'tank\t/tank\ton\ntank/media\t/tank/media\ton\n'
		const fs = fakeFs({'/etc/fstab': 'UUID=1 / btrfs d 0 0\n'})
		const run = fakeRun(log, {zpool: (a) => (a[0] === 'list' ? '' : ''), zfs: (a) => (a[0] === 'list' ? mountpoints : '')})
		const h = createHelper({user, fs, run})
		await assert.rejects(h.handle('zfs-import', ['tank', 'yes']), /Bad option/)
		await h.handle('zfs-import', ['tank', 'force'])
		assert.ok(log.some((l) => l.join(' ') === 'zpool import -N -f tank'))
		assert.match(fs.files.get('/etc/fstab'), /^\/tank \/home\/chris\/Pools\/tank none bind,nosuid,nodev,nofail.* # omarchy-server zfs tank$/m)
		assert.deepEqual(log.filter((l) => l[0] === 'zfs' && l[1] === 'set').map((l) => l[2]), ['setuid=off', 'devices=off'], 'only setuid and devices are changed')
		mountpoints = 'evil\t/evil\ton\nevil/x\t/usr/local\ton\n'
		log.length = 0
		await assert.rejects(h.handle('zfs-import', ['evil']), /system folder/)
		assert.ok(log.some((l) => l.join(' ') === 'zpool export evil'), 'refused pool is exported again')
		assert.ok(!log.some((l) => l.join(' ') === 'zfs mount -a'))
	})

	test('ZFS pool names up to 64 characters work across import, scrub and export', async () => {
		const imported = new Set()
		const fs = fakeFs({'/etc/fstab': ''})
		const run = fakeRun([], {
			zpool: (a) => (a[0] === 'list' ? [...imported].join('\n') : ''),
			zfs: (a) => (a[0] === 'list' ? `${a.at(-1)}\t/pools/${a.at(-1)}\ton\n` : ''),
		})
		const h = createHelper({user, fs, run})
		for (const name of ['backup-archive-2019-photos-and-videos', 'a'.repeat(64)]) {
			imported.clear()
			assert.equal(await h.handle('zfs-import', [name]), 'ok')
			imported.add(name)
			assert.equal(await h.handle('zfs-scrub', [name]), 'ok')
			assert.equal(await h.handle('zfs-export', [name]), 'ok')
		}
		const tooLong = 'a'.repeat(65)
		imported.add(tooLong)
		for (const verb of ['zfs-import', 'zfs-scrub', 'zfs-export']) {
			await assert.rejects(h.handle(verb, [tooLong]), /Bad pool name/)
		}
	})

	test('ZFS status and import list are parsed', async () => {
		const status = `  pool: tank
 state: DEGRADED
  scan: scrub repaired 0B in 01:02:03 with 0 errors on Sun Nov  8 03:00:00 2026
config:

	NAME                                STATE     READ WRITE CKSUM
	tank                                DEGRADED     0     0     0
	  raidz1-0                          DEGRADED     0     0     0
	    /dev/disk/by-id/ata-A-part1     ONLINE       0     0     0
	    /dev/disk/by-id/ata-B-part1     FAULTED      3     1     0
	    /dev/disk/by-id/ata-C-part1     ONLINE       0     0     2

errors: No known data errors
`
		const importList = `   pool: oldtank
     id: 1234567890
  state: ONLINE
 status: The pool was last accessed by another system.
 action: The pool can be imported using its name or numeric identifier and
	the '-f' flag.
 config:
`
		const fs = fakeFs({'/etc/fstab': ''})
		const run = fakeRun([], {
			zpool: (a) => (a[0] === 'list' ? 'tank\t8000\t4000\t4000\tDEGRADED\n' : a[0] === 'status' ? status : a[0] === 'import' ? importList : ''),
			zfs: () => '/tank\n',
		})
		const h = createHelper({user, fs, run})
		const [pool] = JSON.parse(await h.handle('zfs-pools'))
		assert.equal(pool.layout, 'raidz1')
		assert.equal(pool.state, 'DEGRADED')
		assert.deepEqual(pool.devices.map((d) => d.errors), [0, 4, 2])
		assert.equal(pool.errors, 'No known data errors')
		assert.match(pool.scan, /with 0 errors/)
		const [imp] = JSON.parse(await h.handle('zfs-importable'))
		assert.deepEqual([imp.name, imp.state, imp.otherSystem], ['oldtank', 'ONLINE', true])
	})

	test('ZFS status ignores logs, cache, spares, special and dedup vdevs for layout and drive count', async () => {
		const statusWithAux = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:10:00 with 0 errors on Sun Nov  1 00:24:02 2026
config:

	NAME                                          STATE     READ WRITE CKSUM
	tank                                          ONLINE       0     0     0
	  raidz1-0                                    ONLINE       0     0     0
	    /dev/disk/by-id/ata-A-part1               ONLINE       0     0     0
	    /dev/disk/by-id/ata-B-part1               ONLINE       0     0     0
	    /dev/disk/by-id/ata-C-part1               ONLINE       0     0     0
	logs
	  mirror-1                                    ONLINE       0     0     0
	    /dev/disk/by-id/nvme-L1-part1             ONLINE       0     0     0
	    /dev/disk/by-id/nvme-L2-part1             ONLINE       0     0     0
	special
	  mirror-2                                    ONLINE       0     0     0
	    /dev/disk/by-id/nvme-S1-part1             ONLINE       0     0     0
	    /dev/disk/by-id/nvme-S2-part1             ONLINE       0     0     0
	dedup
	  mirror-3                                    ONLINE       0     0     0
	    /dev/disk/by-id/nvme-D1-part1             ONLINE       0     0     0
	    /dev/disk/by-id/nvme-D2-part1             ONLINE       0     0     0
	cache
	  /dev/disk/by-id/nvme-C1-part1               ONLINE       0     0     0
	spares
	  /dev/disk/by-id/ata-SPARE-part1             AVAIL

errors: No known data errors
`
		const mixedData = `  pool: mix
 state: ONLINE
config:

	NAME                                STATE     READ WRITE CKSUM
	mix                                 ONLINE       0     0     0
	  raidz1-0                          ONLINE       0     0     0
	    /dev/disk/by-id/ata-1           ONLINE       0     0     0
	    /dev/disk/by-id/ata-2           ONLINE       0     0     0
	    /dev/disk/by-id/ata-3           ONLINE       0     0     0
	  mirror-1                          ONLINE       0     0     0
	    /dev/disk/by-id/ata-4           ONLINE       0     0     0
	    /dev/disk/by-id/ata-5           ONLINE       0     0     0

errors: No known data errors
`
		const fs = fakeFs({'/etc/fstab': ''})
		const run = fakeRun([], {
			zpool: (a) =>
				a[0] === 'list'
					? 'tank\t8000\t1000\t7000\tONLINE\nmix\t9000\t1000\t8000\tONLINE\n'
					: a[0] === 'status'
						? a.at(-1) === 'mix'
							? mixedData
							: statusWithAux
						: '',
			zfs: () => '/tank\n',
		})
		const h = createHelper({user, fs, run})
		const pools = JSON.parse(await h.handle('zfs-pools'))
		const tank = pools.find((p) => p.name === 'tank')
		assert.equal(tank.layout, 'raidz1')
		assert.deepEqual(
			tank.devices.map((d) => d.path),
			['/dev/disk/by-id/ata-A-part1', '/dev/disk/by-id/ata-B-part1', '/dev/disk/by-id/ata-C-part1'],
		)
		const mix = pools.find((p) => p.name === 'mix')
		assert.equal(mix.layout, 'mirror+raidz1')
		assert.equal(mix.devices.length, 5)
	})

	test('ZFS pools report usable dataset space instead of raw pool capacity', async () => {
		const fs = fakeFs({'/etc/fstab': ''})
		const run = fakeRun([], {
			zpool: (a) =>
				a[0] === 'list'
					? 'tank\t12000000000000\t4000000000000\t8000000000000\tONLINE\nfallback\t6000\t1000\t5000\tONLINE\n'
					: '',
			zfs: (a) => {
				if (a[0] === 'get') return '/tank\n'
				if (a[0] === 'list' && a.at(-1) === 'tank') return '2500000000000\t5500000000000\n'
				if (a[0] === 'list' && a.at(-1) === 'fallback') return '-\t-\n'
				return ''
			},
		})
		const h = createHelper({user, fs, run})
		const pools = JSON.parse(await h.handle('zfs-pools'))
		const tank = pools.find((p) => p.name === 'tank')
		assert.equal(tank.used, 2500000000000)
		assert.equal(tank.free, 5500000000000)
		assert.equal(tank.size, 8000000000000)
		const fb = pools.find((p) => p.name === 'fallback')
		assert.equal(fb.used, 1000)
		assert.equal(fb.free, 5000)
		assert.equal(fb.size, 6000)
	})

	test('firewall: app ports only', async () => {
		const h = createHelper({user, run: fakeRun([]), fs: fakeFs()})
		for (const p of ['22', '2021', '5900', '70000', 'abc']) await assert.rejects(h.handle('firewall-open', [p]), /Bad port/)
		assert.equal(await h.handle('firewall-open', ['38780']), 'ok')
		assert.equal(await h.handle('firewall-open', ['53']), 'ok', 'system ports, for apps you allowed to use them')
		await assert.rejects(h.handle('firewall-close', ['7780']), /Bad port/)
		const log = []
		assert.equal(await createHelper({user, run: fakeRun(log), fs: fakeFs()}).handle('firewall-open', ['445']), 'ok')
		assert.ok(log.some((l) => l.join(' ') === 'ufw delete allow 445/tcp'), 'older unrestricted 445 is closed')
		assert.ok(!log.some((l) => l.join(' ') === 'ufw allow 445/tcp comment Omarchy Server app'), '445 is not opened to the world')
		assert.ok(log.some((l) => l.join(' ') === 'ufw allow from 10.0.0.0/8 to any port 445 proto tcp comment Omarchy Server app'))
		assert.ok(!log.some((l) => /100\.64\.0\.0\/10/.test(l.join(' '))), 'Tailscale is a second network')
	})
	test('pools never honour setuid programs or device files; older pools get hardened', async () => {
		// New Btrfs pool line
		const log = []
		const fs = fakeFs({
			'/etc/fstab': [
				'UUID=1 / btrfs defaults 0 0',
				'UUID=2 /home/chris/Pools/media btrfs defaults,noatime,compress=zstd:3,nofail,x-systemd.device-timeout=10s 0 0 # omarchy-server pool media',
				'/tank /home/chris/Pools/tank none bind,nofail,x-systemd.requires=zfs-mount.service 0 0 # omarchy-server zfs tank',
				'UUID=3 /home/chris/Pools/done btrfs defaults,nosuid,nodev 0 0 # omarchy-server pool done',
				'',
			].join('\n'),
		})
		const zfsProps = {'tank:setuid': 'on\tdefault', 'tank:devices': 'on\tdefault', 'other:setuid': 'on\tdefault', 'other:devices': 'on\tdefault'}
		const run = fakeRun(log, {
			zpool: (a) => (a[0] === 'list' ? 'tank\nother\n' : ''),
			zfs: (a) => (a[0] === 'get' && a.at(-2) === 'mountpoint' ? (a.at(-1) === 'tank' ? '/tank\n' : '/srv/other\n') : a[0] === 'get' ? zfsProps[`${a.at(-1)}:${a.at(-2)}`] ?? '' : ''),
		})
		const h = createHelper({user, fs, run})
		assert.deepEqual(JSON.parse(await h.handle('harden-pools', [])), {fstab: 2, zfs: 2})
		const tab = fs.files.get('/etc/fstab').split('\n')
		assert.equal(tab[0], 'UUID=1 / btrfs defaults 0 0', 'system mounts untouched')
		assert.match(tab[1], /btrfs defaults,noatime,compress=zstd:3,nofail,x-systemd.device-timeout=10s,nosuid,nodev 0 0 # omarchy-server pool media$/)
		assert.match(tab[2], /none bind,nofail,x-systemd.requires=zfs-mount.service,nosuid,nodev 0 0 # omarchy-server zfs tank$/)
		assert.equal(tab[3], 'UUID=3 /home/chris/Pools/done btrfs defaults,nosuid,nodev 0 0 # omarchy-server pool done')
		assert.ok(log.some((l) => l.join(' ') === 'mount -o remount,nosuid,nodev /home/chris/Pools/media'))
		assert.ok(log.some((l) => l.join(' ') === 'zfs set setuid=off tank'))
		assert.ok(!log.some((l) => l.join(' ').endsWith('off other')), 'a ZFS pool Omarchy Server doesn’t manage is left alone')
		// Running it again changes nothing.
		const before = fs.files.get('/etc/fstab')
		zfsProps['tank:setuid'] = 'off\tlocal'
		zfsProps['tank:devices'] = 'off\tlocal'
		assert.deepEqual(JSON.parse(await h.handle('harden-pools', [])), {fstab: 0, zfs: 0})
		assert.equal(fs.files.get('/etc/fstab'), before)
	})

	test('new and imported pools mount nosuid,nodev', async () => {
		const log = []
		const fs = fakeFs({'/etc/fstab': ''})
		fs.readdir = async () => ['ata-A', 'ata-B']
		fs.realpath = async (p) => ({'/dev/disk/by-id/ata-A': '/dev/sda', '/dev/disk/by-id/ata-B': '/dev/sdb'})[p] ?? p
		const h = createHelper({user, fs, run: fakeRun(log, {zpool: () => '', zfs: (a) => (a[0] === 'list' ? 'tank\t/tank\ton\n' : '')})})
		await h.handle('pool-create', ['media', 'single', '/dev/sda'])
		assert.match(fs.files.get('/etc/fstab'), /btrfs defaults,noatime,nosuid,nodev,/)
		await h.handle('zfs-create', ['vault', 'mirror', '/dev/sda', '/dev/sdb'])
		const create = log.find((l) => l[0] === 'zpool' && l[1] === 'create')
		assert.ok(create.includes('setuid=off') && create.includes('devices=off'))
		await h.handle('zfs-import', ['tank'])
		const i = log.findIndex((l) => l.join(' ') === 'zfs set setuid=off tank')
		assert.ok(i > 0 && i < log.findIndex((l) => l.join(' ') === 'zfs mount -a'), 'set before anything is mounted')
		assert.match(fs.files.get('/etc/fstab'), /none bind,nosuid,nodev,nofail/)
	})

	test('grow the system drive: last partition, then encryption (with the disk password), then the filesystem', async () => {
		const G = 1024 ** 3
		const layout = (lastPart = 'vda2', crypt = true) => ({
			findmnt: () => `${crypt ? '/dev/mapper/root[/@home]' : '/dev/vda2[/@home]'} btrfs /home\n`,
			lsblk: (a) =>
				a.includes('-s')
					? JSON.stringify({blockdevices: [crypt ? {name: 'root', path: '/dev/mapper/root', size: 98 * G, type: 'crypt', children: [{name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', children: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk'}]}]} : {name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', children: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk'}]}]})
					: JSON.stringify({blockdevices: [{name: 'vda', path: '/dev/vda', size: 200 * G, type: 'disk', children: [{name: 'vda1', path: '/dev/vda1', size: G, type: 'part', start: 2048}, {name: 'vda2', path: '/dev/vda2', size: 99 * G, type: 'part', start: lastPart === 'vda2' ? 2099200 : 1000}]}]}),
			sfdisk: (a) => (a[0] === '--dump' ? 'label: gpt\n' : ''),
		})
		let log = []
		let cryptOk = (input) => input === 'disk pass'
		const extra = {...layout(), cryptsetup: () => ''}
		const runWith = (ext) => async (cmd, args, opts) => {
			log.push([cmd, ...args, ...(opts?.input !== undefined ? [`<stdin:${opts.input}>`] : [])])
			if (cmd === 'cryptsetup' && !cryptOk(opts?.input)) throw new Error('cryptsetup: No key available with this passphrase.')
			return ext[cmd] ? ext[cmd](args) : ''
		}
		let h = createHelper({user, fs: fakeFs(), run: runWith(extra)})
		await assert.rejects(h.handle('grow-system', [], ''), /NEEDS_PASSWORD/)
		log = []
		const r = JSON.parse(await h.handle('grow-system', [], 'disk pass\n'))
		assert.deepEqual(r.grown, ['partition', 'encryption', 'filesystem'])
		const cmds = log.map((l) => l.join(' '))
		assert.ok(cmds.includes('sfdisk --relocate gpt-bak-std /dev/vda'), 'GPT backup header moved to the new end')
		assert.ok(cmds.includes('sfdisk --no-reread --force -N 2 /dev/vda <stdin:, +\n>'), 'only partition 2, to the end')
		assert.ok(cmds.includes('partx -u -n 2 /dev/vda'))
		assert.ok(cmds.includes('cryptsetup resize root --key-file - <stdin:disk pass>'))
		assert.ok(cmds.includes('btrfs filesystem resize max /home'))
		assert.ok(cmds.indexOf('partx -u -n 2 /dev/vda') < cmds.indexOf('btrfs filesystem resize max /home'), 'in order')
		// Not the last partition: refused, nothing touched.
		log = []
		h = createHelper({user, fs: fakeFs(), run: runWith({...layout('vda1'), cryptsetup: () => ''})})
		await assert.rejects(h.handle('grow-system', [], 'disk pass'), /isn’t the last partition/)
		assert.ok(!log.some((l) => l[0] === 'sfdisk' && l[1] !== '--dump'))
		// Unencrypted: no password needed.
		log = []
		h = createHelper({user, fs: fakeFs(), run: runWith(layout('vda2', false))})
		assert.deepEqual(JSON.parse(await h.handle('grow-system', [], '')).grown, ['partition', 'filesystem'])
		assert.ok(!log.some((l) => l[0] === 'cryptsetup'))
	})

	test('setting the share password works on a fresh Samba with no smb.conf', async () => {
		const fs = fakeFs({})
		const log = []
		await createHelper({user, fs, run: fakeRun(log)}).handle('smb-password', [], 'long enough pw\n')
		assert.match(fs.files.get('/etc/samba/smb.conf'), /^# Managed by Omarchy Server[\s\S]*\[global\][\s\S]*map to guest = never/)
		assert.ok(log.some((l) => l[0] === 'smbpasswd'))
	})

	test('a half-updated Samba (programs and libraries of different versions) gets a message that says how to fix it', async () => {
		const broken = () => {
			throw new Error("smbpasswd: /usr/lib/samba/libsamba3-util-private-samba.so: version `SAMBA_4.25.0_PRIVATE_SAMBA' not found (required by smbpasswd)")
		}
		const h = createHelper({user, fs: fakeFs({}), run: fakeRun([], {smbpasswd: broken, smbd: broken})})
		await assert.rejects(h.handle('smb-password', [], 'long enough pw\n'), /half-updated[\s\S]*Update the whole system once/)
		await assert.rejects(h.handle('shares-apply', [], JSON.stringify({shares: [{name: 'Music', path: '/home/chris/Music'}]})), /half-updated/)
		// Other failures still say what they are.
		const h2 = createHelper({user, fs: fakeFs({}), run: fakeRun([], {smbpasswd: () => { throw new Error('Failed to add entry for user chris.') }})})
		await assert.rejects(h2.handle('smb-password', [], 'long enough pw\n'), /Failed to add entry/)
	})

	test('Tailscale isn’t installed on top of waiting system updates (no partial update)', async () => {
		const log = []
		const h = createHelper({user, fs: fakeFs(), run: fakeRun(log, {pacman: (a) => {
			if (a[0] === '-Q') throw new Error('not found')
			if (a[0] === '-Qu') return 'samba 4.24.3-1 -> 4.25.0-1\n'
			return ''
		}})})
		await assert.rejects(h.handle('tailscale-setup', []), /updates waiting/)
		assert.ok(!log.some((l) => l[0] === 'pacman' && l[1] === '-S'))
	})

	test('Tailscale: installed the way Omarchy does it, the owner made its operator; removed only as asked', async () => {
		const log = []
		let installed = false
		let socketReady = 2 // tailscaled answers on the third try
		const run = fakeRun(log, {
			pacman: (a) => {
				if (a[0] === '-Q') {
					if (!installed) throw new Error('error: package \'tailscale\' was not found')
					return 'tailscale 1.104.7-1\n'
				}
				if (a[0] === '-S') installed = true
				if (a[0] === '-Rns') installed = false
				return ''
			},
			tailscale: (a) => {
				if (a[0] === 'set' && socketReady-- > 0) throw new Error('failed to connect to local tailscaled')
				return ''
			},
		})
		const h = createHelper({user, fs: fakeFs(), run})
		assert.deepEqual(JSON.parse(await h.handle('tailscale-setup', [])), {installedPackage: true})
		const cmds = log.map((l) => l.join(' '))
		assert.ok(cmds.includes('pacman -S --needed --noconfirm tailscale'))
		assert.ok(cmds.includes('systemctl enable --now tailscaled.service'))
		assert.ok(cmds.includes('tailscale set --operator=chris'), 'the owner, from the sudo caller, never from an argument')
		assert.ok(!cmds.some((c) => /tailscale up|accept-routes|--ssh|exit-node/.test(c)), 'no other Tailscale settings')

		// Already there (installed from Omarchy's menu, say): not reinstalled, and reported as not ours.
		log.length = 0
		socketReady = 0
		assert.deepEqual(JSON.parse(await h.handle('tailscale-setup', ['--ignored', 'x'])), {installedPackage: false})
		assert.ok(!log.some((l) => l[0] === 'pacman' && l[1] === '-S'))

		log.length = 0
		assert.equal(await h.handle('tailscale-remove', []), 'ok')
		assert.deepEqual(
			log.filter((l) => l[0] !== 'pacman' || l[1] !== '-Q').map((l) => l.join(' ')),
			['tailscale logout', 'systemctl disable --now tailscaled.service', 'pacman -Rns --noconfirm tailscale'],
		)
		log.length = 0
		assert.equal(await h.handle('tailscale-remove', []), 'ok', 'nothing to remove')
		assert.deepEqual(log.map((l) => l.join(' ')), ['pacman -Q tailscale'])
	})

	test('low ports: only ever lowers the limit, and remembers it', async () => {
		const log = []
		let now = 1024
		const fs = fakeFs()
		const h = createHelper({user, fs, run: fakeRun(log, {sysctl: (args) => (args[0] === '-n' ? `${now}\n` : ((now = Number(args[1].split('=')[1])), ''))})})
		await h.handle('low-ports', ['53'])
		assert.equal(now, 53)
		assert.match(fs.files.get('/etc/sysctl.d/60-omarchy-server-ports.conf'), /ip_unprivileged_port_start = 53/)
		await h.handle('low-ports', ['443'])
		assert.equal(now, 53, 'never raised again by another app')
		await assert.rejects(h.handle('low-ports', ['0']), /Bad port/)
	})

	test('umount and format: refuse system, pool, mounted, and junk paths; format wipes then mkfs', async () => {
		const log = []
		const lsblkMounted = {
			blockdevices: [
				...lsblk.blockdevices,
				{
					name: 'sde',
					path: '/dev/sde',
					type: 'disk',
					size: 32e9,
					rota: false,
					tran: 'usb',
					serial: 'USB1',
					model: 'SanDisk',
					children: [{name: 'sde1', path: '/dev/sde1', type: 'part', fstype: 'exfat', mountpoints: ['/run/media/chris/stick']}],
				},
				// Nothing mounted, but in use: an unlocked encrypted volume, and a running RAID array.
				{name: 'sdf', path: '/dev/sdf', type: 'disk', size: 4e12, children: [{name: 'sdf1', path: '/dev/sdf1', type: 'part', fstype: 'crypto_LUKS', mountpoints: [null], children: [{name: 'luks-x', path: '/dev/mapper/luks-x', type: 'crypt', fstype: 'ext4', mountpoints: [null]}]}]},
				{name: 'sdg', path: '/dev/sdg', type: 'disk', size: 4e12, fstype: 'linux_raid_member', children: [{name: 'md0', path: '/dev/md0', type: 'raid1', mountpoints: [null]}]},
			],
		}
		const run = async (cmd, args) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(lsblkMounted)
			if (cmd === 'wipefs') return JSON.stringify({signatures: []})
			return ''
		}
		const fs = fakeFs({
			'/etc/fstab': 'UUID=22222222-2222-2222-2222-222222222222 /home/chris/Pools/media btrfs d 0 0 # omarchy-server pool media\n',
			'/dev/disk/by-id/usb-SanDisk_USB1': '/dev/sde',
		})
		fs.realpath = async (p) => {
			if (p === '/dev/disk/by-id/usb-SanDisk_USB1') return '/dev/sde'
			if (p.includes('..')) throw new Error('ENOENT')
			return p
		}
		const h = createHelper({user, run, fs})
		await assert.rejects(h.handle('umount', ['/dev/nvme0n1']), /holds the system/)
		await assert.rejects(h.handle('format', ['/dev/nvme0n1', 'blank']), /holds the system/)
		await assert.rejects(h.handle('format', ['/dev/sdd', 'blank']), /pool|in a pool/)
		await assert.rejects(h.handle('format', ['/dev/sde', 'ext4']), /in use|Unmount/)
		await assert.rejects(h.handle('format', ['/etc/passwd', 'blank']), /Not a drive/)
		await assert.rejects(h.handle('format', ['/dev/disk/by-id/../passwd', 'blank']), /Not a drive/)
		await assert.rejects(h.handle('format', ['/dev/sda', 'ntfs']), /blank, ext4 or exfat/)
		await assert.rejects(h.handle('format', ['/dev/sdf', 'blank']), /encryption, LVM or RAID/)
		await assert.rejects(h.handle('format', ['/dev/sdg', 'ext4']), /encryption, LVM or RAID/)
		assert.ok(!log.some((l) => l[0] === 'wipefs' && l[1] === '-a'), 'refused format never wipes')
		assert.ok(!log.some((l) => l[0] === 'umount'))

		const log2 = []
		const h2 = createHelper({user, run: fakeRun(log2), fs: fakeFs()})
		assert.equal(await h2.handle('format', ['/dev/sdc', 'blank']), 'ok')
		assert.ok(log2.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/sdc'))
		assert.ok(!log2.some((l) => l[0] === 'mkfs.ext4' || l[0] === 'mkfs.exfat'))
		log2.length = 0
		assert.equal(await h2.handle('format', ['/dev/sdc', 'ext4']), 'ok')
		assert.ok(log2.some((l) => l[0] === 'mkfs.ext4' && l.includes('-F') && l.includes('/dev/sdc')))
		log2.length = 0
		assert.equal(await h2.handle('format', ['/dev/sdc', 'exfat']), 'ok')
		assert.ok(log2.some((l) => l[0] === 'mkfs.exfat' && l.includes('/dev/sdc')))

		log.length = 0
		assert.equal(await h.handle('umount', ['/dev/sde']), 'ok')
		assert.ok(log.some((l) => l[0] === 'umount' && l[1] === '/run/media/chris/stick'))
	})

	test('mount: extra data disk only, one filesystem each at /run/media/$USER', async () => {
		const log = []
		const mkdirs = []
		const chowns = []
		const lsblkMount = {
			blockdevices: [
				...lsblk.blockdevices,
				{
					name: 'sde',
					path: '/dev/sde',
					type: 'disk',
					size: 32e9,
					rota: false,
					tran: 'usb',
					serial: 'USB1',
					model: 'SanDisk',
					children: [{name: 'sde1', path: '/dev/sde1', type: 'part', fstype: 'exfat', mountpoints: ['/run/media/chris/stick']}],
				},
				{
					name: 'sdf',
					path: '/dev/sdf',
					type: 'disk',
					size: 1e9,
					children: [
						{name: 'sdf1', path: '/dev/sdf1', type: 'part', fstype: 'crypto_LUKS', mountpoints: [null]},
						{name: 'sdf2', path: '/dev/sdf2', type: 'part', fstype: 'swap', mountpoints: [null]},
					],
				},
				{
					name: 'sdg',
					path: '/dev/sdg',
					type: 'disk',
					size: 8e9,
					fstype: 'ext4',
					uuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
					label: 'My Disk / 2',
					mountpoints: [null],
				},
			],
		}
		const run = async (cmd, args) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(lsblkMount)
			if (cmd === 'wipefs') return JSON.stringify({signatures: []})
			return ''
		}
		const fs = fakeFs({
			'/etc/fstab': 'UUID=22222222-2222-2222-2222-222222222222 /home/chris/Pools/media btrfs d 0 0 # omarchy-server pool media\n',
		})
		fs.mkdir = async (p) => void mkdirs.push(p)
		fs.chown = async (p, uid, gid) => void chowns.push([p, uid, gid])
		const h = createHelper({user, run, fs})
		await assert.rejects(h.handle('mount', ['/dev/nvme0n1']), /holds the system/)
		await assert.rejects(h.handle('mount', ['/dev/sdd']), /pool|in a pool/)
		await assert.rejects(h.handle('mount', ['/dev/sda']), /Nothing to mount/)
		await assert.rejects(h.handle('mount', ['/dev/sde']), /already mounted/)
		await assert.rejects(h.handle('mount', ['/dev/sdf']), /Nothing to mount/)
		await assert.rejects(h.handle('mount', ['/etc/passwd']), /Not a drive/)
		assert.ok(!log.some((l) => l[0] === 'mount'))

		log.length = 0
		mkdirs.length = 0
		chowns.length = 0
		assert.equal(await h.handle('mount', ['/dev/sdc']), 'ok')
		assert.ok(log.some((l) => l[0] === 'mount' && l.includes('/dev/sdc1') && l.includes('/run/media/chris/sdc1') && l.some((a) => String(a).includes('uid=1000,gid=1000'))))
		assert.ok(mkdirs.includes('/run/media/chris/sdc1'))
		assert.ok(chowns.some((c) => c[0] === '/run/media/chris/sdc1' && c[1] === 1000 && c[2] === 1000))

		log.length = 0
		assert.equal(await h.handle('mount', ['/dev/sdg']), 'ok')
		assert.ok(log.some((l) => l[0] === 'mount' && l.includes('/dev/sdg') && l.includes('/run/media/chris/My_Disk_2')))
		assert.ok(log.some((l) => l[0] === 'mount' && l.includes('-o') && l.includes('nosuid,nodev') && l.includes('/dev/sdg')))
		assert.ok(!log.some((l) => l[0] === 'mount' && String(l).includes('uid=')))
	})

	test('mount: FAT chown after mount is skipped so a USB stick still mounts', async () => {
		const log = []
		const chowns = []
		const mounted = new Set()
		const run = async (cmd, args) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			if (cmd === 'mount') {
				mounted.add(args.at(-1))
				return ''
			}
			return ''
		}
		const fs = fakeFs({'/etc/fstab': ''})
		fs.chown = async (p, uid, gid) => {
			if (mounted.has(p)) throw Object.assign(new Error('EPERM: Operation not permitted'), {code: 'EPERM'})
			chowns.push([p, uid, gid])
		}
		const h = createHelper({user, run, fs})
		assert.equal(await h.handle('mount', ['/dev/sdc']), 'ok')
		assert.ok(chowns.some((c) => c[0] === '/run/media/chris/sdc1' && c[1] === 1000 && c[2] === 1000))
		assert.ok(chowns.some((c) => c[0] === '/run/media/chris' && c[1] === 1000 && c[2] === 1000))
		const call = log.find((l) => l[0] === 'mount' && l.includes('/dev/sdc1'))
		assert.ok(call)
		assert.match(call.find((a) => String(a).includes('uid=')) ?? '', /nosuid,nodev/)
	})

	test('mount: a second disk with the same label is mounted beside the first', async () => {
		const log = []
		const mkdirs = []
		const chowns = []
		const sameLabel = {
			blockdevices: [
				{
					name: 'sda',
					path: '/dev/sda',
					type: 'disk',
					children: [{name: 'sda1', path: '/dev/sda1', type: 'part', fstype: 'exfat', label: 'USB', mountpoints: ['/run/media/chris/USB']}],
				},
				{
					name: 'sdb',
					path: '/dev/sdb',
					type: 'disk',
					children: [{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'exfat', label: 'USB', mountpoints: [null]}],
				},
			],
		}
		const run = async (cmd, args) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(sameLabel)
			return ''
		}
		const fs = fakeFs({'/etc/fstab': ''})
		fs.mkdir = async (p) => void mkdirs.push(p)
		fs.chown = async (p, uid, gid) => void chowns.push([p, uid, gid])
		const h = createHelper({user, run, fs})
		assert.equal(await h.handle('mount', ['/dev/sdb']), 'ok')
		const mounted = log.find((l) => l[0] === 'mount')
		assert.ok(mounted)
		assert.equal(mounted.at(-2), '/dev/sdb1')
		assert.equal(mounted.at(-1), '/run/media/chris/USB-2')
		assert.ok(mkdirs.includes('/run/media/chris/USB-2'))
		assert.ok(chowns.some((c) => c[0] === '/run/media/chris/USB-2' && c[1] === 1000 && c[2] === 1000))
		assert.ok(!chowns.some((c) => c[0] === '/run/media/chris/USB'))
		assert.ok(!mkdirs.includes('/run/media/chris/USB'))
		assert.ok(chowns.some((c) => c[0] === '/run/media/chris'))

		const twoParts = {
			blockdevices: [
				{
					name: 'sdc',
					path: '/dev/sdc',
					type: 'disk',
					children: [
						{name: 'sdc1', path: '/dev/sdc1', type: 'part', fstype: 'exfat', label: 'USB', mountpoints: [null]},
						{name: 'sdc2', path: '/dev/sdc2', type: 'part', fstype: 'exfat', label: 'USB', mountpoints: [null]},
					],
				},
			],
		}
		const log2 = []
		const run2 = async (cmd, args) => {
			log2.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(twoParts)
			return ''
		}
		const h2 = createHelper({user, run: run2, fs: fakeFs({'/etc/fstab': ''})})
		assert.equal(await h2.handle('mount', ['/dev/sdc']), 'ok')
		const dests = log2.filter((l) => l[0] === 'mount').map((l) => [l.at(-2), l.at(-1)])
		assert.deepEqual(dests, [
			['/dev/sdc1', '/run/media/chris/USB'],
			['/dev/sdc2', '/run/media/chris/USB-2'],
		])

		const safeName = {
			blockdevices: [
				{
					name: 'sdd',
					path: '/dev/sdd',
					type: 'disk',
					children: [{name: 'sdd1', path: '/dev/sdd1', type: 'part', fstype: 'ext4', label: 'My Disk', mountpoints: ['/run/media/chris/My_Disk']}],
				},
				{
					name: 'sde',
					path: '/dev/sde',
					type: 'disk',
					children: [{name: 'sde1', path: '/dev/sde1', type: 'part', fstype: 'ext4', label: 'My Disk', mountpoints: [null]}],
				},
			],
		}
		const log3 = []
		const run3 = async (cmd, args) => {
			log3.push([cmd, ...args])
			if (cmd === 'lsblk') return JSON.stringify(safeName)
			return ''
		}
		const h3 = createHelper({user, run: run3, fs: fakeFs({'/etc/fstab': ''})})
		assert.equal(await h3.handle('mount', ['/dev/sde']), 'ok')
		const safe = log3.find((l) => l[0] === 'mount')
		assert.ok(safe)
		assert.equal(safe.at(-2), '/dev/sde1')
		assert.equal(safe.at(-1), '/run/media/chris/My_Disk-2')
	})

	test('SD cards and eMMC (mmcblkN): whole disks work, boot/rpmb and partitions are rejected', async () => {
		const mmcLsblk = {
			blockdevices: [
				{
					name: 'mmcblk0',
					path: '/dev/mmcblk0',
					type: 'disk',
					size: 62534975488,
					rota: false,
					tran: 'mmc',
					serial: 'SD1',
					children: [{name: 'mmcblk0p1', path: '/dev/mmcblk0p1', type: 'part', fstype: 'exfat', label: 'SDCARD', mountpoints: [null]}],
				},
				{name: 'mmcblk0boot0', path: '/dev/mmcblk0boot0', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
				{name: 'mmcblk0boot1', path: '/dev/mmcblk0boot1', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
				{name: 'mmcblk0rpmb', path: '/dev/mmcblk0rpmb', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
			],
		}
		let mounted = false
		const log = []
		const run = async (cmd, args) => {
			log.push([cmd, ...args])
			if (cmd === 'lsblk') {
				return JSON.stringify({
					blockdevices: mmcLsblk.blockdevices.map((d) =>
						d.name === 'mmcblk0' && mounted ? {...d, children: [{...d.children[0], mountpoints: ['/run/media/chris/SDCARD']}]} : d,
					),
				})
			}
			if (cmd === 'wipefs') return JSON.stringify({signatures: []})
			if (cmd === 'smartctl') return JSON.stringify({smart_status: {passed: true}})
			return ''
		}
		const h = createHelper({user, run, fs: fakeFs()})
		await assert.rejects(h.handle('mount', ['/dev/mmcblk0p1']), /Not a drive/)
		await assert.rejects(h.handle('mount', ['/dev/mmcblk0boot0']), /Not a drive/)
		await assert.rejects(h.handle('format', ['/dev/mmcblk0rpmb', 'blank']), /Not a drive/)
		assert.equal(await h.handle('mount', ['/dev/mmcblk0']), 'ok')
		assert.ok(log.some((l) => l[0] === 'mount' && l.includes('/dev/mmcblk0p1') && l.includes('/run/media/chris/SDCARD')))
		mounted = true
		assert.equal(await h.handle('umount', ['/dev/mmcblk0']), 'ok')
		assert.ok(log.some((l) => l[0] === 'umount' && l[1] === '/run/media/chris/SDCARD'))
		mounted = false
		assert.equal(await h.handle('format', ['/dev/mmcblk0', 'blank']), 'ok')
		assert.ok(log.some((l) => l[0] === 'wipefs' && l[1] === '-a' && l[2] === '/dev/mmcblk0'))
		assert.ok(JSON.parse(await h.handle('smart', ['/dev/mmcblk0'])).smart_status.passed)
	})

	test('smart runs smartctl with -n standby so sleeping drives are not woken', async () => {
		const log = []
		const h = createHelper({
			user,
			fs: fakeFs(),
			run: fakeRun(log, {smartctl: () => JSON.stringify({smart_status: {passed: true}})}),
		})
		await h.handle('smart', ['/dev/sda'])
		assert.deepEqual(log.find((l) => l[0] === 'smartctl'), ['smartctl', '-n', 'standby', '-j', '-a', '/dev/sda'])
	})

	test('drives mounted under /var, /usr, /opt, /srv, /nix or owner home are protected as system drives', async () => {
		const sysPaths = ['/var/lib/docker', '/var/lib/containers', '/var/log', '/usr/local', '/opt', '/opt/apps', '/srv', '/nix', '/home/chris']
		const dataPaths = ['/run/media/chris/stick', '/varnish', '/home/chris/Pools/media', '/home/chris/extra']
		const all = [...sysPaths, ...dataPaths]
		const devs = all.map((mp, i) => ({
			name: `sd${String.fromCharCode(97 + i)}`,
			path: `/dev/sd${String.fromCharCode(97 + i)}`,
			type: 'disk',
			size: 1e12,
			rota: true,
			children: [{name: `sd${String.fromCharCode(97 + i)}1`, path: `/dev/sd${String.fromCharCode(97 + i)}1`, type: 'part', fstype: 'ext4', mountpoints: [mp]}],
		}))
		const h = createHelper({user, fs: fakeFs(), run: async (cmd) => (cmd === 'lsblk' ? JSON.stringify({blockdevices: devs}) : cmd === 'wipefs' ? JSON.stringify({signatures: []}) : '')})
		for (let i = 0; i < sysPaths.length; i++) {
			const dev = devs[i].path
			await assert.rejects(h.handle('umount', [dev]), /holds the system/, `${sysPaths[i]} umount`)
			await assert.rejects(h.handle('format', [dev, 'blank']), /holds the system/, `${sysPaths[i]} format`)
			await assert.rejects(h.handle('pool-create', ['tank', 'single', dev]), /holds the system/, `${sysPaths[i]} pool-create`)
		}
		for (let i = sysPaths.length; i < all.length; i++) {
			const dev = devs[i].path
			await assert.rejects(h.handle('format', [dev, 'blank']), /in use|pool/, `${all[i]} is not treated as system`)
		}
	})
})

describe('omarchyd storage', () => {
	let root, fstab
	before(async () => {
		root = await mkdtemp(join(os.tmpdir(), 'omarchyd-s-'))
		fstab = join(root, 'fstab')
		await writeFile(fstab, 'UUID=22222222-2222-2222-2222-222222222222 /x/Pools/media btrfs d 0 0 # omarchy-server pool media\n')
	})
	after(() => rm(root, {recursive: true, force: true}))

	test('drives get roles and health; shares go through the helper with real paths', async () => {
		const calls = []
		let sambaVersions = {samba: '2:4.25.0-1', smbclient: '2:4.25.0-1', libwbclient: '2:4.25.0-1'}
		let onOmarchy = true
		const run = async (cmd, args, opts) => {
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			if (cmd === 'sh') return onOmarchy ? '/usr/bin/omarchy\n' : ''
			if (cmd === 'pacman' && args[0] === '-Q') {
				if (!sambaVersions[args[1]]) throw new Error(`error: package '${args[1]}' was not found`)
				return `${args[1]} ${sambaVersions[args[1]]}\n`
			}
			calls.push({args, input: opts?.input})
			const verb = args[2]
			if (verb === 'ping') return 'ok\n'
			if (verb === 'smart') return JSON.stringify({smart_status: {passed: true}, temperature: {current: 34}, power_on_time: {hours: 9000}, ata_smart_attributes: {table: [{id: 5, raw: {value: 0}}]}})
			return 'ok\n'
		}
		const files = {resolve: async (p) => ({real: p.replace('/Home', '/home/chris'), top: p.startsWith('/Home') ? 'Home' : 'Trash'})}
		const data = join(root, 'data')
		await mkdir(data)
		// No smb.conf yet (Arch's samba doesn't ship one): it's written before the password is set.
		const smbConf = join(root, 'smb.conf')
		// An older helper, not the one installed on this machine. That one may already know guests.
		const oldHelper = join(root, 'old-helper.mjs')
		await writeFile(oldHelper, 'export {}\n')
		const s = createStorage({dataDir: data, home: '/home/chris', files, run, fstabPath: fstab, smbConf, helperFile: oldHelper})
		const disks = await s.procedures['storage.disks'].run()
		const role = Object.fromEntries(disks.map((d) => [d.name, d.role]))
		assert.deepEqual(role, {nvme0n1: 'system', sda: 'blank', sdb: 'blank', sdc: 'data', sdd: 'pool'})
		assert.equal(disks.find((d) => d.name === 'sda').health.temperature, 34)
		assert.equal(disks.find((d) => d.name === 'sda').kind, 'hdd')
		const imp = await s.procedures['storage.importable'].run()
		assert.deepEqual(imp, [])
		await s.procedures['files.addShare'].run({path: '/Home/Music'})
		await s.procedures['files.addShare'].run({path: '/Home/Other/Music'})
		const shares = await s.procedures['files.shares'].run()
		assert.deepEqual(shares.map((x) => x.name), ['Music', 'Music 2'])
		const verbs = calls.map((c) => c.args[2]).filter((v) => v === 'shares-apply' || v === 'smb-password')
		assert.deepEqual(verbs.slice(0, 2), ['shares-apply', 'smb-password'], 'smb.conf is written before smbpasswd runs')
		const pw = await s.procedures['files.sharePassword'].run()
		assert.match(pw, /^[a-z0-9x]{4}(-[a-z0-9x]{4}){3}$/)
		assert.equal(calls.filter((c) => c.args[2] === 'smb-password').length, 1, 'password set once')
		const last = calls.filter((c) => c.args[2] === 'shares-apply').at(-1)
		assert.deepEqual(JSON.parse(last.input).shares.map((x) => x.path), ['/home/chris/Music', '/home/chris/Other/Music'])
		assert.equal((await readFile(join(data, 'share-password'), 'utf8')).trim(), pw)
		await assert.rejects(s.procedures['files.addShare'].run({path: '/Home'}), /inside Home/)

		// Without a password: only once the installed helper knows how (an older one is never asked).
		assert.deepEqual(await s.procedures['files.shareOptions'].run(), {noPassword: false, samba: {ok: true}})
		await assert.rejects(s.procedures['files.addShare'].run({path: '/Home/Open', password: false}), /installer to run once more/)
		await assert.rejects(s.procedures['files.updateShare'].run({path: '/Home/Music', password: false}), /installer to run once more/)
		const helperFile = join(root, 'helper.mjs')
		await writeFile(helperFile, "const who = s.guest === true ? `   guest ok = yes\\n` : ''")
		const s2 = createStorage({dataDir: data, home: '/home/chris', files, run, fstabPath: fstab, helperFile})
		assert.deepEqual(await s2.procedures['files.shareOptions'].run(), {noPassword: true, samba: {ok: true}})
		await s2.procedures['files.addShare'].run({path: '/Home/Open', password: false, readOnly: true})
		await s2.procedures['files.updateShare'].run({path: '/Home/Music', readOnly: true})
		let listed = await s2.procedures['files.shares'].run()
		assert.deepEqual(listed.map((x) => [x.name, x.password, x.readOnly]), [['Music', true, true], ['Music 2', true, false], ['Open', false, true]])
		let sent = JSON.parse(calls.filter((c) => c.args[2] === 'shares-apply').at(-1).input).shares
		assert.deepEqual(sent.find((x) => x.name === 'Open'), {name: 'Open', path: '/home/chris/Open', readOnly: true, guest: true})
		await s2.procedures['files.updateShare'].run({path: '/Home/Open', password: true})
		sent = JSON.parse(calls.filter((c) => c.args[2] === 'shares-apply').at(-1).input).shares
		assert.equal(sent.find((x) => x.name === 'Open').guest, undefined)
		await assert.rejects(s2.procedures['files.updateShare'].run({path: '/Home/Nope', readOnly: true}), /isn’t shared/)
		// Your own password.
		await assert.rejects(s2.procedures['files.setSharePassword'].run({password: 'short'}), /8 to 128/)
		await s2.procedures['files.setSharePassword'].run({password: 'my own words'})
		assert.equal(calls.filter((c) => c.args[2] === 'smb-password').at(-1).input, 'my own words\n')
		assert.equal(await s2.procedures['files.sharePassword'].run(), 'my own words')

		// Samba's parts out of step (a partial update): said plainly, with the fix, before the helper is asked.
		assert.deepEqual((await s2.procedures['files.shareOptions'].run()).samba, {ok: true})
		sambaVersions = {samba: '2:4.25.0-1', smbclient: '2:4.24.6-1', libwbclient: '2:4.24.6-1'}
		const health = (await s2.procedures['files.shareOptions'].run()).samba
		assert.equal(health.ok, false)
		assert.equal(health.problem, 'mismatch')
		// On Omarchy the system is updated its own way (it blocks a direct pacman -Syu).
		assert.equal(health.command, 'omarchy update')
		const before = calls.length
		await assert.rejects(s2.procedures['files.addShare'].run({path: '/Home/Pictures'}), /half-updated \(samba 2:4.25.0-1, its libraries 2:4.24.6-1\)[\s\S]*omarchy update/)
		onOmarchy = false
		assert.equal((await s2.procedures['files.shareOptions'].run()).samba.command, 'sudo pacman -Syu --needed samba')
		onOmarchy = true
		await assert.rejects(s2.procedures['files.setSharePassword'].run({password: 'another one'}), /half-updated/)
		assert.equal(calls.length, before, 'the helper isn’t asked')
		sambaVersions = {smbclient: '2:4.24.6-1'}
		assert.equal((await s2.procedures['files.shareOptions'].run()).samba.problem, 'missing')
		assert.equal((await s2.procedures['files.shareOptions'].run()).samba.command, 'omarchy update && omarchy pkg add samba')
		await assert.rejects(s2.procedures['files.addShare'].run({path: '/Home/Pictures'}), /isn’t installed/)
	})

	test('storage.format and storage.unmount go through the helper; disks report mounts', async () => {
		const calls = []
		const run = async (cmd, args) => {
			if (cmd === 'lsblk') return JSON.stringify(lsblk)
			if (cmd === 'sudo') {
				calls.push(args.slice(2))
				const verb = args[2]
				if (verb === 'ping') return 'ok\n'
				if (verb === 'smart') return JSON.stringify({smart_status: {passed: true}, temperature: {current: 34}})
				if (verb === 'format' || verb === 'umount' || verb === 'mount') return 'ok\n'
				return 'ok\n'
			}
			return ''
		}
		const files = {resolve: async (p) => ({real: p.replace('/Home', '/home/chris'), top: p.startsWith('/Home') ? 'Home' : 'Trash'})}
		const data = join(root, 'format-data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files, run, fstabPath: fstab, smbConf: join(root, 'format-smb.conf')})
		const disks = await s.procedures['storage.disks'].run()
		const sdc = disks.find((d) => d.name === 'sdc')
		assert.equal(sdc.role, 'data')
		assert.equal(sdc.mounted, false)
		assert.deepEqual(sdc.mounts, [])
		assert.ok(sdc.id)
		const sys = disks.find((d) => d.name === 'nvme0n1')
		assert.equal(sys.mounted, true)
		assert.ok(sys.mounts.includes('/'))
		await s.procedures['storage.format'].run({device: '/dev/sdc', filesystem: 'ext4'})
		assert.deepEqual(calls.filter((a) => a[0] === 'format').at(-1), ['format', '/dev/sdc', 'ext4'])
		await s.procedures['storage.unmount'].run({device: '/dev/sdc'})
		assert.deepEqual(calls.filter((a) => a[0] === 'umount').at(-1), ['umount', '/dev/sdc'])
		await s.procedures['storage.mount'].run({device: '/dev/sdc'})
		assert.deepEqual(calls.filter((a) => a[0] === 'mount').at(-1), ['mount', '/dev/sdc'])
		await assert.rejects(s.procedures['storage.format'].run({device: '/dev/sdc', filesystem: 'ntfs'}), /blank, ext4 or exfat/)
	})

	test('a reserved Samba name is not used, and shares saved together all remain', async () => {
		const scratch = await mkdtemp(join(os.tmpdir(), 'omarchy-shares-'))
		await mkdir(join(scratch, 'home'))
		const home = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(join(home, 'A'), {recursive: true})
		await mkdir(join(home, 'B'))
		await mkdir(join(home, 'C'))
		await mkdir(join(home, 'One', 'Music'), {recursive: true})
		await mkdir(join(home, 'Two', 'Music'), {recursive: true})
		for (const name of ['global', 'homes', 'printers', 'Global']) await mkdir(join(home, name))
		await mkdir(data)
		const calls = []
		const run = async (cmd, args, opts) => {
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			if (cmd === 'pacman' && args[0] === '-Q') return `${args[1]} 1\n`
			calls.push({args, input: opts?.input})
			if (args[2] === 'shares-apply') await new Promise((r) => setTimeout(r, 40))
			if (args[2] === 'ping' || args[2] === 'shares-apply' || args[2] === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run, fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		const add = (path) => storage.procedures['files.addShare'].run({path})
		try {
			const settled = await Promise.allSettled([add('/Home/A'), add('/Home/B'), add('/Home/C')])
			assert.deepEqual(settled.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled'])
			const together = (await storage.procedures['files.shares'].run()).map((s) => s.path).sort()
			assert.deepEqual(together, ['/Home/A', '/Home/B', '/Home/C'])
			const last = JSON.parse(calls.filter((c) => c.args[2] === 'shares-apply').at(-1).input).shares.map((s) => s.path)
			assert.equal(last.length, 3)
			await Promise.all([add('/Home/One/Music'), add('/Home/Two/Music')])
			const music = (await storage.procedures['files.shares'].run()).filter((s) => s.path.includes('Music')).map((s) => s.name).sort()
			assert.deepEqual(music, ['Music', 'Music 2'])
			for (const name of ['global', 'homes', 'printers', 'Global']) await add(`/Home/${name}`)
			const reserved = (await storage.procedures['files.shares'].run()).map((s) => s.name)
			assert.equal(reserved.some((n) => ['global', 'homes', 'printers'].includes(n.toLowerCase())), false)
		} finally {
			await rm(scratch, {recursive: true, force: true})
		}
	})

	test('renaming, moving or trashing a shared folder updates the share', async () => {
		const scratch = await mkdtemp(join(os.tmpdir(), 'omarchy-share-move-'))
		await mkdir(join(scratch, 'home'))
		const home = await realpath(join(scratch, 'home'))
		const data = join(scratch, 'data')
		await mkdir(join(home, 'Music', 'Live'), {recursive: true})
		await mkdir(join(home, 'MusicVideos'))
		await mkdir(join(home, 'Docs'))
		await mkdir(join(home, 'Photos'))
		await mkdir(join(home, 'Archive'))
		await mkdir(data)
		const calls = []
		const run = async (cmd, args, opts) => {
			if (cmd === 'sh') return '/usr/bin/omarchy\n'
			if (cmd === 'pacman' && args[0] === '-Q') return `${args[1]} 1\n`
			calls.push({args, input: opts?.input})
			if (args[2] === 'ping' || args[2] === 'shares-apply' || args[2] === 'smb-password') return 'ok\n'
			return 'ok\n'
		}
		const files = createFiles({home, dataDir: data})
		const storage = createStorage({dataDir: data, home, files, run, fstabPath: join(scratch, 'fstab'), smbConf: join(scratch, 'smb.conf')})
		const add = (path) => storage.procedures['files.addShare'].run({path})
		const listed = () => storage.procedures['files.shares'].run()
		const applied = () => calls.filter((c) => c.args[2] === 'shares-apply').map((c) => JSON.parse(c.input).shares.map((s) => s.path))
		try {
			await add('/Home/Music')
			await add('/Home/Music/Live')
			await add('/Home/MusicVideos')
			await files.procedures['files.rename'].run({path: '/Home/Music', newName: 'Tunes'})
			const afterRename = await listed()
			assert.deepEqual(afterRename.map((s) => s.path).sort(), ['/Home/MusicVideos', '/Home/Tunes', '/Home/Tunes/Live'])
			assert.equal(afterRename.every((s) => s.available), true)
			assert.equal(afterRename.find((s) => s.path === '/Home/Tunes').name, 'Music')
			assert.ok(applied().at(-1).every((p) => p.endsWith('/Tunes') || p.endsWith('/Tunes/Live') || p.endsWith('/MusicVideos')))
			await add('/Home/Photos')
			await files.procedures['files.move'].run({path: '/Home/Photos', toDirectory: '/Home/Archive'})
			assert.equal((await listed()).find((s) => s.name === 'Photos').path, '/Home/Archive/Photos')
			await files.procedures['files.copy'].run({path: '/Home/Archive/Photos', toDirectory: '/Home'})
			assert.equal((await listed()).find((s) => s.name === 'Photos').path, '/Home/Archive/Photos')
			await add('/Home/Docs')
			await files.procedures['files.trash'].run({path: '/Home/Docs'})
			assert.equal((await listed()).find((s) => s.path === '/Home/Docs'), undefined)
			assert.equal(applied().at(-1).some((p) => p.endsWith('/Docs')), false)
		} finally {
			await rm(scratch, {recursive: true, force: true})
		}
	})

	test('storage.disks lists mmcblkN and hides mmcblk boot and rpmb nodes', async () => {
		const mmcLsblk = {
			blockdevices: [
				{
					name: 'mmcblk0',
					path: '/dev/mmcblk0',
					type: 'disk',
					size: 62534975488,
					rota: false,
					tran: 'mmc',
					serial: 'SD1',
					children: [{name: 'mmcblk0p1', path: '/dev/mmcblk0p1', type: 'part', fstype: 'exfat', label: 'SDCARD', mountpoints: [null]}],
				},
				{name: 'mmcblk0boot0', path: '/dev/mmcblk0boot0', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
				{name: 'mmcblk0boot1', path: '/dev/mmcblk0boot1', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
				{name: 'mmcblk0rpmb', path: '/dev/mmcblk0rpmb', type: 'disk', size: 4194304, rota: false, mountpoints: [null]},
			],
		}
		const run = async (cmd, args) => {
			if (cmd === 'lsblk') return JSON.stringify(mmcLsblk)
			if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
			if (cmd === 'sudo' && args[2] === 'zfs-available') return 'no\n'
			if (cmd === 'sudo' && args[2] === 'smart') return JSON.stringify({smart_status: {passed: true}})
			return ''
		}
		const data = join(root, 'mmc-data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files: {resolve: async () => ({real: '', top: 'Home'})}, run, fstabPath: fstab})
		const disks = await s.procedures['storage.disks'].run()
		assert.deepEqual(disks.map((d) => ({name: d.name, role: d.role})), [{name: 'mmcblk0', role: 'data'}])
	})

	test('storage.disks keeps last known SMART reading when a drive goes into standby', async () => {
		let clock = 1_000_000
		let sdaStandby = false
		let smartCalls = 0
		const twoHdds = {
			blockdevices: [
				{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-A', mountpoints: [null]},
				{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-B', mountpoints: [null]},
			],
		}
		const standbyJson = JSON.stringify({smartctl: {exit_status: 2, messages: [{string: 'Device is in STANDBY mode, exit(2)'}]}})
		const run = async (cmd, args) => {
			if (cmd === 'lsblk') return JSON.stringify(twoHdds)
			if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
			if (cmd === 'sudo' && args[2] === 'zfs-available') return 'no\n'
			if (cmd === 'sudo' && args[2] === 'smart') {
				smartCalls++
				if (args[3] === '/dev/sda' && !sdaStandby) {
					return JSON.stringify({smart_status: {passed: true}, temperature: {current: 34}, power_on_time: {hours: 9000}, ata_smart_attributes: {table: [{id: 5, raw: {value: 0}}]}})
				}
				return standbyJson
			}
			return ''
		}
		const data = join(root, 'standby-data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files: {resolve: async () => ({real: '', top: 'Home'})}, run, fstabPath: fstab, now: () => clock})

		let disks = await s.procedures['storage.disks'].run()
		assert.equal(disks.find((d) => d.name === 'sda').health.temperature, 34)
		assert.equal(disks.find((d) => d.name === 'sdb').health, null)
		assert.equal(smartCalls, 2)

		// Cache expires and sda is now in standby: keep previous reading instead of wiping it.
		clock += 11 * 60_000
		sdaStandby = true
		disks = await s.procedures['storage.disks'].run()
		assert.equal(disks.find((d) => d.name === 'sda').health.temperature, 34)
		assert.equal(disks.find((d) => d.name === 'sda').health.passed, true)
		assert.equal(disks.find((d) => d.name === 'sdb').health, null)
		assert.equal(smartCalls, 4)

		// Subsequent 30s poll uses the refreshed cache entry.
		clock += 30_000
		await s.procedures['storage.disks'].run()
		assert.equal(smartCalls, 4)
	})

	test('storage.disks treats mounts under /var, /usr, /opt, /srv, /nix or owner home as system', async () => {
		const sysPaths = ['/var/lib/docker', '/var/log', '/usr/local', '/opt', '/srv', '/nix', '/home/chris']
		const dataPaths = ['/run/media/chris/stick', '/varnish', '/home/chris/extra']
		const devs = [...sysPaths, ...dataPaths].map((mp, i) => ({
			name: `sd${String.fromCharCode(97 + i)}`,
			path: `/dev/sd${String.fromCharCode(97 + i)}`,
			type: 'disk',
			size: 1e12,
			rota: false,
			children: [{name: `sd${String.fromCharCode(97 + i)}1`, path: `/dev/sd${String.fromCharCode(97 + i)}1`, type: 'part', fstype: 'ext4', mountpoints: [mp]}],
		}))
		const run = async (cmd, args) => {
			if (cmd === 'lsblk') return JSON.stringify({blockdevices: devs})
			if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
			if (cmd === 'sudo' && args[2] === 'zfs-available') return 'no\n'
			return ''
		}
		const data = join(root, 'sysmounts-data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files: {resolve: async () => ({real: '', top: 'Home'})}, run, fstabPath: fstab})
		const byMount = Object.fromEntries((await s.procedures['storage.disks'].run()).map((d) => [d.mounts[0], d.role]))
		for (const mp of sysPaths) assert.equal(byMount[mp], 'system', mp)
		for (const mp of dataPaths) assert.equal(byMount[mp], 'data', mp)
	})

	test('a zfs_member is in the imported pool only when its guid matches', async () => {
		const real = '1111111111111111111'
		const foreign = '2222222222222222222'
		const tree = {
			blockdevices: [
				{name: 'sda', path: '/dev/sda', type: 'disk', size: 1e12, children: [{name: 'sda1', path: '/dev/sda1', type: 'part', fstype: 'zfs_member', label: 'tank', uuid: real, mountpoints: [null]}]},
				{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 1e12, children: [{name: 'sdb1', path: '/dev/sdb1', type: 'part', fstype: 'zfs_member', label: 'tank', uuid: foreign, mountpoints: [null]}]},
			],
		}
		const run = async (cmd, args) => {
			if (cmd === 'lsblk') return JSON.stringify(tree)
			if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
			if (cmd === 'sudo' && args[2] === 'zfs-available') return 'yes\n'
			if (cmd === 'sudo' && args[2] === 'zfs-pools') return `${JSON.stringify([{name: 'tank', size: 10, used: 1, free: 9, health: 'ONLINE', mountpoint: '/tank', folder: null, state: 'ONLINE', scan: '', errors: 'No known data errors', layout: 'stripe', devices: []}])}\n`
			if (cmd === 'sudo' && args[2] === 'smart') return `${JSON.stringify({smart_status: {passed: true}})}\n`
			if (cmd === 'zpool' && args[0] === 'get') return `${real}\n`
			return ''
		}
		const data = join(root, 'zfs-guid-data')
		await mkdir(data)
		const s = createStorage({dataDir: data, home: '/home/chris', files: {resolve: async () => ({real: '', top: 'Home'})}, run, fstabPath: fstab})
		const by = Object.fromEntries((await s.procedures['storage.disks'].run()).map((d) => [d.name, d]))
		assert.equal(by.sda.role, 'pool')
		assert.equal(by.sda.pool, 'tank')
		assert.equal(by.sdb.role, 'data')
		assert.equal(by.sdb.pool, null)
		assert.deepEqual(by.sdb.zfs, {pool: 'tank'})
	})

	test('storage.disks ids a drive by its by-id link, preferring ata- over wwn-', async () => {
		const byIdDir = join(root, 'by-id')
		await mkdir(byIdDir)
		// The partition link resolves to the same disk. It must not win just because its name starts with ata-.
		await symlink('/dev/sda', join(byIdDir, 'ata-WDC_WD80EFAX-68LHPN0_WD-A-part1'))
		await symlink('/dev/sda', join(byIdDir, 'wwn-0x5000cca0b0c0d0e0'))
		await symlink('/dev/sda', join(byIdDir, 'ata-WDC_WD80EFAX-68LHPN0_WD-A'))
		const run = async (cmd, args) => {
			if (cmd === 'lsblk')
				return JSON.stringify({
					blockdevices: [
						{name: 'sda', path: '/dev/sda', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-A', mountpoints: [null]},
						{name: 'sdb', path: '/dev/sdb', type: 'disk', size: 4e12, rota: true, tran: 'sata', serial: 'WD-B', mountpoints: [null]},
					],
				})
			if (cmd === 'sudo' && args[2] === 'ping') return 'ok\n'
			if (cmd === 'sudo' && args[2] === 'zfs-available') return 'no\n'
			return ''
		}
		const data = join(root, 'byid-data')
		await mkdir(data)
		const s = createStorage({
			dataDir: data,
			home: '/home/chris',
			files: {resolve: async () => ({real: '', top: 'Home'})},
			run,
			fstabPath: fstab,
			byIdDir,
			byIdFs: {
				readdir: (dir) => readdir(dir),
				realpath: async (p) => (p.startsWith(`${byIdDir}/`) ? readlink(p) : p),
			},
		})
		const disks = await s.procedures['storage.disks'].run()
		const sda = disks.find((d) => d.name === 'sda')
		const sdb = disks.find((d) => d.name === 'sdb')
		assert.equal(sda.path, '/dev/sda')
		assert.equal(sda.id, '/dev/disk/by-id/ata-WDC_WD80EFAX-68LHPN0_WD-A')
		assert.equal(sdb.path, '/dev/sdb')
		assert.equal(sdb.id, '/dev/sdb')
	})
})
