import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {averagePoints, createHistory, parseCpu, parseDisk, parseMem, parseNet, pointFrom} from '../omarchyd/history.mjs'

const NET = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  eth0: 1000000   900    0    0    0     0          0         0   200000     800    0    0    0     0       0          0
veth12:   300       3    0    0    0     0          0         0      300       3    0    0    0     0       0          0
tailscale0: 4000   9    0    0    0     0          0         0     8000       9    0    0    0     0       0          0
`
const DISK = `   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0
   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0
 259       0 nvme0n1 10 0 100 0 10 0 300 0 0 0 0
 259       1 nvme0n1p1 10 0 100 0 10 0 300 0 0 0 0
   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0
`

test('parsers read /proc counters and skip loopback, container links and partitions', () => {
	assert.deepEqual(parseCpu('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4'), {busy: 200, total: 1000})
	assert.equal(parseCpu('nonsense'), null)
	assert.deepEqual(parseMem('MemTotal:       1000 kB\nMemFree: 1 kB\nMemAvailable:    250 kB\n'), {total: 1024000, used: 768000})
	assert.deepEqual(Object.keys(parseNet(NET)), ['eth0', 'tailscale0'])
	assert.deepEqual(parseNet(NET).eth0, {rx: 1000000, tx: 200000})
	assert.deepEqual(parseDisk(DISK), {sda: {read: 2000 * 512, written: 4000 * 512}, nvme0n1: {read: 100 * 512, written: 300 * 512}})
})

test('a point turns two readings into percentages and bytes per second; a counter that went back reads 0', () => {
	const prev = {cpu: {busy: 200, total: 1000}, net: {eth0: {rx: 1000, tx: 500}}, disk: {sda: {read: 0, written: 1000}}}
	const cur = {cpu: {busy: 300, total: 1200}, mem: {total: 100, used: 25}, load: 0.456, net: {eth0: {rx: 11000, tx: 100}, new0: {rx: 9, tx: 9}}, disk: {sda: {read: 5120, written: 1000}}}
	assert.deepEqual(pointFrom(prev, cur, 10, 42), {t: 42, cpu: 50, mem: 25, load: 0.46, net: {eth0: [1000, 0]}, disk: {sda: [512, 0]}})
})

test('averaging keeps the mean of numbers and rates, and ignores missing values', () => {
	const avg = averagePoints([{t: 1, cpu: 10, mem: null, load: 1, net: {eth0: [100, 10]}, disk: {}}, {t: 2, cpu: 30, mem: 50, load: 3, net: {eth0: [300, 30]}, disk: {}}], 2)
	assert.deepEqual(avg, {t: 2, cpu: 20, mem: 50, load: 2, net: {eth0: [200, 20]}, disk: {}})
})

test('history fills the 1 h tier every sample, the 24 h tier every 6 and the 7 d tier every 30, and survives a restart', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'modc-history-'))
	let t = Date.now() - 60 * 60_000
	let busy = 0
	const read = async () => ((busy += 50), {cpu: {busy, total: busy * 2}, mem: {total: 100, used: 40}, load: 1, net: {eth0: {rx: busy * 10, tx: busy}}, disk: {}})
	const h = createHistory({dataDir, now: () => t, read})
	for (let i = 0; i < 31; i++) {
		await h.sample()
		t += 10_000
	}
	assert.equal(h.get('1h').points.length, 30)
	assert.equal(h.get('24h').points.length, 5)
	assert.equal(h.get('7d').points.length, 1)
	assert.equal(h.get('1h').points[0].cpu, 50)
	assert.deepEqual(h.get('1h').points[0].net.eth0, [50, 5])
	assert.throws(() => h.get('1y'), /Unknown range/)
	await h.save()
	const again = createHistory({dataDir, now: () => t, read})
	await again.load()
	assert.equal(again.get('1h').points.length, 30)
	assert.equal(again.get('24h').stepMs, 60_000)
})

test('a damaged or hostile history file is ignored or cleaned, never trusted', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'modc-history-'))
	const t = Date.now()
	await writeFile(join(dataDir, 'history.json'), JSON.stringify({v: 1, tiers: [[{t: t - 1000, cpu: 'x', net: {'../../etc': [1, 2], eth0: [1, -5], ok0: [3, 4]}}, {t: 'nope'}, {t: t + 1e9, cpu: 1}]]}))
	const h = createHistory({dataDir, now: () => t, read: async () => ({})})
	await h.load()
	assert.deepEqual(h.get('1h').points, [{t: t - 1000, cpu: null, mem: null, load: null, net: {ok0: [3, 4]}, disk: {}}])
	await writeFile(join(dataDir, 'history.json'), '{broken')
	const h2 = createHistory({dataDir, now: () => t, read: async () => ({})})
	await h2.load()
	assert.deepEqual(h2.get('1h').points, [])
	assert.match(await readFile(join(dataDir, 'history.json'), 'utf8'), /broken/)
})

test('live samples every second only while someone is reading, then stops after 30 s', async () => {
	let t = Date.now()
	let busy = 0
	const timers = []
	const read = async () => ((busy += 10), {cpu: {busy, total: busy * 4}, mem: {total: 10, used: 5}, load: 0.5, net: {eth0: {rx: busy, tx: busy}}, disk: {}})
	const h = createHistory({now: () => t, read, setIntervalFn: (fn) => (timers.push(fn), timers.length), clearIntervalFn: (id) => (timers[id - 1] = null)})
	assert.equal(h.get('live').stepMs, 1000)
	assert.equal(timers.length, 1, 'reading live starts one 1 s timer')
	await h.liveSample()
	for (let i = 0; i < 5; i++) {
		t += 1000
		await h.liveSample()
	}
	assert.equal(h.get('live').points.length, 5)
	assert.equal(h.get('live').points[0].cpu, 25)
	assert.equal(timers.length, 1, 'reading again does not start a second timer')
	t += 31_000
	await h.liveSample()
	assert.equal(timers[0], null, 'the timer stops 30 s after the last read')
	assert.deepEqual(h.get('live').points, [])
	assert.equal(timers.length, 2, 'the next read starts it again')
})
