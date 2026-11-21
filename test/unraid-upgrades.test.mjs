import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

import {
	containerPlan,
	createUnraid,
	detectContainerStacks,
	matchStoreApp,
	mergeContainerStack,
	parseUnraidShareCfg,
	sanitizeRsyncExcludes,
	vmPlan,
} from '../omarchyd/unraid.mjs'

async function waitJob(u, dir, id) {
	for (let i = 0; i < 200; i++) {
		const st = await u.procedures['unraid.status'].run()
		const saved = await readFile(join(dir, 'unraid', 'job.json'), 'utf8').catch(() => '')
		if (st.job?.endedAt && saved.includes(`"id": "${id}"`) && /"endedAt": \d/.test(saved)) return st.job
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('Job timed out')
}

test('preserveSettings translates GPU, shm_size, tmpfs, dns, extra_hosts, limits, entrypoint, and named Docker volumes', () => {
	const frigate = {
		Name: '/frigate',
		State: {Running: true},
		Config: {Image: 'ghcr.io/blakeblackshear/frigate:stable', Env: [], Entrypoint: ['python3', '-u', '-m', 'frigate']},
		HostConfig: {
			NetworkMode: 'bridge',
			PortBindings: {'5000/tcp': [{HostPort: '5000'}]},
			Devices: [{PathOnHost: '/dev/dri', PathInContainer: '/dev/dri'}],
			Runtime: 'nvidia',
			DeviceRequests: [{Driver: 'nvidia', Count: -1, Capabilities: [['gpu']]}],
			ShmSize: 256 * 1024 * 1024,
			Dns: ['1.1.1.1'],
			ExtraHosts: ['mqtt:192.168.1.20'],
			Memory: 2 * 1024 * 1024 * 1024,
			CpusetCpus: '0,1',
			Tmpfs: {'/tmp/cache': 'rw,size=64m'},
		},
		Mounts: [
			{Type: 'bind', Source: '/mnt/user/appdata/frigate', Destination: '/config', RW: true},
			{Type: 'volume', Name: 'frigate_db', Source: '/var/lib/docker/volumes/frigate_db/_data', Destination: '/db', RW: true},
		],
	}
	const p = containerPlan(frigate, {preserveSettings: true, portOverride: 5055})
	const svc = YAML.parse(p.files['docker-compose.yml']).services.frigate
	const app = YAML.parse(p.files['omarchy-app.yml'])
	assert.equal(app.port, 5055)
	assert.deepEqual(svc.ports, ['5055:5000'])
	assert.equal(svc.shm_size, '256m')
	assert.deepEqual(svc.dns, ['1.1.1.1'])
	assert.deepEqual(svc.extra_hosts, ['mqtt:192.168.1.20'])
	assert.equal(svc.mem_limit, '2g')
	assert.equal(svc.cpuset, '0,1')
	assert.deepEqual(svc.entrypoint, ['python3', '-u', '-m', 'frigate'])
	assert.deepEqual(svc.tmpfs, ['/tmp/cache:rw,size=64m'])
	assert.deepEqual(svc.devices, ['/dev/dri:/dev/dri'])
	assert.equal(svc.deploy?.resources?.reservations?.devices?.[0]?.driver, 'nvidia')
	assert.ok(p.copies.some((c) => c.volume && c.from === '/var/lib/docker/volumes/frigate_db/_data'))
	assert.ok(svc.volumes.includes('${APP_DATA_DIR:-.}/data/_volumes/frigate-db:/db'))
})

test('detectContainerStacks & mergeContainerStack wire VPN service:<parent> and hoist ports', () => {
	const gluetun = containerPlan(
		{
			Name: '/gluetun',
			State: {Running: true},
			Config: {Image: 'qmcgaw/gluetun:latest'},
			HostConfig: {NetworkMode: 'bridge', PortBindings: {'8888/tcp': [{HostPort: '8888'}]}},
			Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/gluetun', Destination: '/gluetun', RW: true}],
		},
		{preserveSettings: true},
	)
	const qbit = containerPlan(
		{
			Name: '/qbittorrent',
			State: {Running: true},
			Config: {Image: 'lscr.io/linuxserver/qbittorrent:latest', Labels: {'net.unraid.docker.webui': 'http://[IP]:[PORT:8080]/'}},
			HostConfig: {NetworkMode: 'container:gluetun', PortBindings: {'8080/tcp': [{HostPort: '8080'}]}},
			Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/qbit', Destination: '/config', RW: true}],
		},
		{preserveSettings: true, peers: new Map([['gluetun', 'gluetun']])},
	)
	const stacks = detectContainerStacks([gluetun, qbit])
	assert.equal(stacks.length, 1)
	assert.equal(stacks[0].kind, 'vpn')
	const merged = mergeContainerStack([gluetun, qbit], {stackId: stacks[0].id, stackName: stacks[0].name})
	const compose = YAML.parse(merged.files['docker-compose.yml'])
	assert.equal(compose.services.qbittorrent.network_mode, 'service:gluetun')
	assert.deepEqual(compose.services.qbittorrent.depends_on, ['gluetun'])
	assert.equal(compose.services.qbittorrent.ports, undefined)
	assert.ok(compose.services.gluetun.ports.includes('8080:8080'))
	assert.ok(merged.copies.some((c) => c.to === 'qbittorrent/qbit'))
	assert.ok(merged.copies.some((c) => c.to === 'gluetun/gluetun'))

	// Shared network stack preserves original container name as DNS alias
	const pg = containerPlan({Name: '/immich_postgres', Config: {Image: 'postgres:15'}, NetworkSettings: {Networks: {immich_net: {}}}})
	const web = containerPlan({Name: '/immich_server', Config: {Image: 'ghcr.io/immich-app/immich-server:release'}, NetworkSettings: {Networks: {immich_net: {}}}})
	const netMerged = mergeContainerStack([pg, web], {stackName: 'immich'})
	const netCompose = YAML.parse(netMerged.files['docker-compose.yml'])
	assert.deepEqual(netCompose.services['immich-postgres'].networks?.default?.aliases, ['immich_postgres'])
})

test('App Store matching, Unraid share cfg parser, and rsync exclude sanitizer', () => {
	const registries = [
		{apps: [{id: 'plex', name: 'Plex Media Server', image: 'plexinc/pms-docker:latest', icon: 'plex.png'}]},
		{apps: [{id: 'jellyfin', name: 'Jellyfin', icon: 'jf.png'}]},
	]
	assert.equal(matchStoreApp('lscr.io/linuxserver/jellyfin:latest', registries)?.id, 'jellyfin')
	assert.equal(matchStoreApp('plexinc/pms-docker:1.40', registries)?.id, 'plex')
	assert.equal(matchStoreApp('custom/unknown-widget:1', registries), null)

	const cfg = parseUnraidShareCfg('shareComment="Family Movies"\nshareExport="e"\nshareSecurity="private"\nshareUseCache="yes"\n')
	assert.deepEqual(cfg, {comment: 'Family Movies', export: 'e', security: 'private', useCache: 'yes', splitLevel: ''})

	assert.deepEqual(sanitizeRsyncExcludes(['.DS_Store', '--delete', '-e', 'Thumbs.db', 'bad\nline', '.DS_Store']), ['.DS_Store', 'Thumbs.db'])
})

test('SSH key auth, custom port, preflight port conflicts, icon download, NVRAM + graceful VM shutdown, and delta resync', async () => {
	const dir = await mkdtemp(join(os.tmpdir(), 'unraid-upgrades-'))
	await mkdir(join(dir, 'tree', 'Home'), {recursive: true})
	const sshCalls = []
	const rsyncCalls = []
	let vmState = 'running'
	const adoptedVms = []

	const webContainer = {
		Name: '/plex',
		State: {Running: true},
		Config: {
			Image: 'lscr.io/linuxserver/plex:latest',
			Labels: {'net.unraid.docker.webui': 'http://[IP]:[PORT:32400]/web', 'net.unraid.docker.icon': 'https://icons.example.com/plex.png'},
		},
		HostConfig: {PortBindings: {'32400/tcp': [{HostPort: '32400'}]}, ShmSize: 512 * 1024 * 1024},
		Mounts: [{Type: 'bind', Source: '/mnt/user/appdata/plex', Destination: '/config', RW: true}],
	}
	const vmXml = `<domain type='kvm'><name>Win11</name><memory unit='KiB'>4194304</memory><vcpu>2</vcpu>
<os><loader readonly='yes' type='pflash'>/usr/share/qemu/ovmf-x64/OVMF_CODE.fd</loader><nvram>/etc/libvirt/qemu/nvram/Win11_VARS.fd</nvram><type arch='x86_64' machine='pc-q35-7.2'>hvm</type></os>
<devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/mnt/user/domains/Win11/vdisk1.img'/><target dev='hdc' bus='virtio'/></disk></devices></domain>`

	const run = async (cmd, argv = []) => {
		if (cmd === 'ssh-keygen') return {stdout: '256 SHA256:abc123 root@tower (ED25519)\n', stderr: ''}
		if (cmd === 'rsync') {
			rsyncCalls.push(argv)
			// Simulate creating copied NVRAM file locally so importVm sees it
			const dst = argv[argv.length - 1]
			if (String(argv[argv.length - 2]).includes('Win11_VARS.fd')) {
				await writeFile(join(dst, 'Win11_VARS.fd'), 'nvram-bytes')
			}
			return {stdout: '', stderr: ''}
		}
		sshCalls.push(argv)
		const remote = String(argv[argv.length - 1] ?? '')
		if (remote.includes('unraid-version')) return {stdout: 'version="7.0.2"\nhas-rsync\nhas-docker\nhas-virsh\n', stderr: ''}
		if (remote.includes('/mnt/user/*/')) return {stdout: 'Media\t1024\nappdata\t2048\n', stderr: ''}
		if (remote.includes('/boot/config/shares/')) return {stdout: '===SHARE:Media===\nshareComment="Movies & TV"\nshareSecurity="private"\n', stderr: ''}
		if (remote.startsWith('docker ps')) return {stdout: 'plex\n', stderr: ''}
		if (remote.startsWith('docker inspect -f')) return {stdout: `${remoteRunning}\n`, stderr: ''}
		if (remote.startsWith('docker start')) {
			dockerStarts.push(remote)
			return {stdout: '', stderr: ''}
		}
		if (remote.startsWith('docker inspect')) return {stdout: JSON.stringify([webContainer]), stderr: ''}
		if (remote.includes('du -sb')) return {stdout: '/mnt/user/appdata/plex\t2048\td\n', stderr: ''}
		if (remote.includes('virsh list')) return {stdout: 'Win11\n', stderr: ''}
		if (remote.includes('virsh dumpxml')) return {stdout: vmXml, stderr: ''}
		if (remote.includes('virsh shutdown')) {
			vmState = 'shut off'
			return {stdout: 'Domain Win11 is being shutdown\n', stderr: ''}
		}
		if (remote.includes('virsh domstate')) return {stdout: `${vmState}\n`, stderr: ''}
		if (remote.includes('stat -c %s')) return {stdout: '4096\n', stderr: ''}
		if (remote.includes('user.scripts/scripts')) return {stdout: '===SCRIPT:clean_tmp===\nNAME:Clean Temp\nDESC:Clears scratch\nBODY:\n#!/bin/bash\necho hi\n', stderr: ''}
		if (remote.includes('schedule.json')) return {stdout: JSON.stringify({s1: {script: '/boot/config/plugins/user.scripts/scripts/clean_tmp/script', frequency: 'daily'}}), stderr: ''}
		return {stdout: '', stderr: ''}
	}
	const files = {resolve: async (v) => ({real: join(dir, 'tree', String(v).replace(/^\//, '')), top: 'Home'})}
	const pausedLocal = []
	const resumedLocal = []
	let remoteRunning = false
	const dockerStarts = []
	const apps = {
		importedStoreDir: join(dir, 'store'),
		appDirFor: (id) => join(dir, 'apps', id),
		installed: () => false,
		installImported: async () => {},
		importState: () => ({done: true, error: null}),
		pauseForBackup: async (id) => pausedLocal.push(id),
		resumeAfterBackup: async (id) => resumedLocal.push(id),
		procedures: {
			'apps.list': {run: async () => [{id: 'existing-plex', name: 'Existing Plex', port: 32400}]},
			'appStore.registry': {run: async () => [{apps: [{id: 'plex', name: 'Plex', icon: 'plex.png'}]}]},
		},
	}
	const machines = {
		importVm: async (spec) => {
			adoptedVms.push(spec)
			return {id: 'vm-1'}
		},
		importState: () => ({done: true, error: null, name: 'Win11'}),
	}
	const u = createUnraid({
		dataDir: dir,
		files,
		apps,
		machines,
		storage: null,
		run,
		checkIconUrl: async () => ({ok: true}),
		fetchImpl: async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {status: 200, headers: {'content-type': 'image/png'}}),
	})

	try {
		// Connect using pasted SSH key + custom port 2222
		const conn = await u.procedures['unraid.connect'].run({
			host: 'tower.local',
			port: 2222,
			authMode: 'key',
			privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
		})
		assert.equal(conn.port, 2222)
		assert.equal(conn.authMode, 'key')
		const firstSsh = sshCalls[0]
		assert.ok(firstSsh.includes('-i'))
		assert.ok(firstSsh.includes('PubkeyAuthentication=yes'))
		assert.ok(firstSsh.includes('2222'))

		// Scan surfaces share config, storeMatch, userScripts, and VM nvram
		const scan = await u.procedures['unraid.scan'].run()
		assert.equal(scan.shares.find((s) => s.name === 'Media')?.config?.comment, 'Movies & TV')
		assert.equal(scan.containers[0].storeMatch?.id, 'plex')
		assert.equal(scan.userScripts.length, 1)
		assert.equal(scan.userScripts[0].schedule, 'daily')
		assert.equal(scan.vms[0].nvram, '/etc/libvirt/qemu/nvram/Win11_VARS.fd')

		// Preflight detects port 32400 conflict & suggests 32401, and checks free space
		const pf = await u.procedures['unraid.preflight'].run({shares: ['Media'], containers: ['unraid-plex'], vms: ['Win11'], destination: '/Home/Unraid'})
		assert.equal(pf.spaceOk, true)
		assert.equal(pf.portConflicts.length, 1)
		assert.equal(pf.portConflicts[0].suggestedPort, 32401)
		assert.equal(pf.runningVms.length, 1)

		// Start with port override, bwlimit, excludes, checksum verify, preserveSettings, graceful VM shutdown
		const started = await u.procedures['unraid.start'].run({
			shares: ['Media'],
			containers: ['unraid-plex'],
			vms: ['Win11'],
			destination: '/Home/Unraid',
			preserveSettings: true,
			shutdownRunningVms: true,
			bwlimitMbps: 25,
			excludes: ['.DS_Store', '--bad'],
			verifyChecksum: true,
			portOverrides: {'unraid-plex': 32401},
		})
		const doneJob = await waitJob(u, dir, started.id)
		assert.deepEqual(doneJob.items.map((x) => [x.key, x.status]), [['Media', 'done'], ['unraid-plex', 'done'], ['Win11', 'done']])

		// Verify icon URL verified & preserved for apps.mjs, shm_size + port override written, bwlimit/excludes/checksum passed, NVRAM copied!
		const appYml = YAML.parse(await readFile(join(dir, 'store', 'unraid-plex', 'omarchy-app.yml'), 'utf8'))
		assert.equal(appYml.port, 32401)
		assert.equal(appYml.icon, 'https://icons.example.com/plex.png')
		const compYml = YAML.parse(await readFile(join(dir, 'store', 'unraid-plex', 'docker-compose.yml'), 'utf8'))
		assert.equal(compYml.services.plex.shm_size, '512m')
		assert.ok(rsyncCalls.some((a) => a.includes('--bwlimit=25000') && a.includes('--checksum') && a.includes('.DS_Store') && !a.includes('--bad')))
		assert.ok(adoptedVms[0]?.nvram?.endsWith('Win11_VARS.fd'))
		assert.ok(!(doneJob.items.find((x) => x.key === 'Win11')?.note ?? '').includes('NVRAM'))

		// Incremental cutover re-sync pauses local app before syncing, resumes after, and does NOT restart a stopped Unraid container!
		dockerStarts.length = 0
		remoteRunning = false
		const resyncStarted = await u.procedures['unraid.resync'].run({deleteRemoved: true})
		const resyncDone = await waitJob(u, dir, resyncStarted.id)
		assert.equal(resyncDone.resync, true)
		assert.ok(rsyncCalls.some((a) => a.includes('--delete')))
		assert.deepEqual(pausedLocal, ['unraid-plex'])
		assert.deepEqual(resumedLocal, ['unraid-plex'])
		assert.equal(dockerStarts.length, 0, 'stopped remote Unraid container must not be restarted during resync')

		// Disconnect deletes temp SSH key file
		const keyIdx = firstSsh.indexOf('-i')
		const keyPath = firstSsh[keyIdx + 1]
		await u.procedures['unraid.disconnect'].run()
		await assert.rejects(stat(keyPath), {code: 'ENOENT'})
	} finally {
		u.close()
		await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50})
	}
})
