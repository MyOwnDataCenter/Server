import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {formatServerDiskGb} from '../web/src/machines/formatServerDisk.ts'
import {cpuStatusText, pointsInLastHour} from '../web/src/machines/statsWindow.ts'

const HOUR = 60 * 60 * 1000

test('chart points keep only the last hour by timestamp', () => {
	const now = 10_000_000_000
	const points = [
		{t: now - HOUR - 1, cpu: 9},
		{t: now - HOUR, cpu: 4},
		{t: now - 1000, cpu: 8},
	]
	assert.deepEqual(pointsInLastHour(points, now).map((p) => p.cpu), [4, 8])
	assert.deepEqual(pointsInLastHour([], now), [])
})

test('CPU status is a dash while the machine is not running', () => {
	assert.equal(cpuStatusText(false, {cpu: 12}, 4), '–')
	assert.equal(cpuStatusText(true, {cpu: 12}, 4), '12% of 4 CPUs')
	assert.equal(cpuStatusText(true, {cpu: 1}, 1), '1% of 1 CPU')
	assert.equal(cpuStatusText(true, null, 2), '–')
})

test('server disk GiB is decimal, so a tebibyte reads 1 TB', () => {
	assert.equal(formatServerDiskGb((1000 ** 4) / (1024 ** 3)), '1 TB')
	assert.equal(formatServerDiskGb(931), '1 TB')
	assert.match(formatServerDiskGb(20), /GB$/)
	assert.doesNotMatch(formatServerDiskGb(20), /TB/)
})

test('the machine panels filter the hour, dash a stopped CPU, and format server disk', async () => {
	const src = await readFile(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')
	assert.match(src, /pointsInLastHour\(/)
	assert.match(src, /cpuStatusText\(/)
	assert.match(src, /formatServerDiskGb\(node\.data\.storage\.freeGb\)/)
	assert.doesNotMatch(src, /freeGb\} GB free/)
})

test('memory status shows only the size while the machine is not running', async () => {
	const {memoryStatusText} = await import('../web/src/machines/statsWindow.ts')
	const fmt = (mb) => `${mb} MiB`
	assert.equal(memoryStatusText(false, {memMb: 900}, 2048, fmt), '2048 MiB')
	assert.equal(memoryStatusText(true, {memMb: 900}, 2048, fmt), '900 MiB of 2048 MiB')
	assert.equal(memoryStatusText(true, null, 2048, fmt), '2048 MiB')
	const src = await readFile(new URL('../web/src/machines/panels.tsx', import.meta.url), 'utf8')
	assert.match(src, /memoryStatusText\(/)
})
