// Swarm machine glance: the same rings as Home, from connector metrics.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {batteryColor, extraDisks, swarmGaugeItems} from '../web/src/swarm/gauges.ts'

const metrics = (over = {}) => ({
	cpu: 18,
	cores: 16,
	mem: {total: 16 * 1024 ** 3, used: 6.2 * 1024 ** 3},
	disks: [
		{mount: '/', total: 1000 * 1e9, used: 720 * 1e9},
		{mount: '/home', total: 500 * 1e9, used: 100 * 1e9},
	],
	gpus: [],
	batteries: [],
	...over,
})

test('swarmGaugeItems: CPU, memory and root storage; extra mounts are not rings', () => {
	const items = swarmGaugeItems(metrics())
	assert.deepEqual(
		items.map((g) => g.k),
		['CPU', 'Memory', 'Storage'],
	)
	assert.equal(items[0].p, 18)
	assert.equal(items[0].sub, '18%')
	assert.equal(items[0].ready, true)
	assert.equal(Math.round(items[2].p), 72)
	assert.equal(extraDisks(metrics().disks).map((d) => d.mount).join(), '/home')
})

test('swarmGaugeItems: no metrics means no rings', () => {
	assert.deepEqual(swarmGaugeItems(null), [])
	assert.deepEqual(swarmGaugeItems({}), [])
	assert.deepEqual(swarmGaugeItems({swap: {total: 1024, used: 1}}), [])
})

test('swarmGaugeItems: swap sits after memory only when the machine has swap space', () => {
	assert.deepEqual(
		swarmGaugeItems(metrics()).map((g) => g.k),
		['CPU', 'Memory', 'Storage'],
	)
	assert.deepEqual(
		swarmGaugeItems(metrics({swap: {total: 0, used: 0}})).map((g) => g.k),
		['CPU', 'Memory', 'Storage'],
	)
	const items = swarmGaugeItems(metrics({swap: {total: 8 * 1024 ** 3, used: 2 * 1024 ** 3}}))
	assert.deepEqual(
		items.map((g) => g.k),
		['CPU', 'Memory', 'Swap', 'Storage'],
	)
	const swap = items.find((g) => g.k === 'Swap')
	assert.equal(swap.icon, 'swap')
	assert.equal(Math.round(swap.p), 25)
	assert.match(swap.sub, /of /)
})

test('swarmGaugeItems: one GPU is a GPU ring; two are GPU 0 and GPU 1', () => {
	const one = swarmGaugeItems(metrics({gpus: [{id: 'gpu-0', index: 0, name: 'NVIDIA GeForce RTX 3060', used: 32}]}))
	assert.equal(one.at(-1).k, 'GPU')
	assert.equal(one.at(-1).p, 32)
	assert.equal(one.at(-1).sub, 'RTX 3060')
	const two = swarmGaugeItems(
		metrics({
			gpus: [
				{id: 'gpu-0', index: 0, name: 'NVIDIA GeForce RTX 3060', used: 32},
				{id: 'gpu-1', index: 1, name: 'NVIDIA GeForce RTX 3060', used: 4},
			],
		}),
	)
	assert.equal(two.at(-2).k, 'GPU 0')
	assert.equal(two.at(-1).k, 'GPU 1')
	assert.equal(two.at(-1).p, 4)
	assert.equal(two.at(-2).key, 'gpu-0')
	assert.equal(two.at(-1).key, 'gpu-1')
})

test('swarmGaugeItems: two battery packs are still one Battery ring', () => {
	const items = swarmGaugeItems(
		metrics({
			batteries: [
				{
					id: 'BAT0',
					index: 0,
					name: 'Internal',
					percent: 40,
					status: 'discharging',
					secondsRemaining: 14400,
					power: 10,
					energyNow: 40_000_000,
					energyFull: 100_000_000,
				},
				{
					id: 'BAT1',
					index: 1,
					name: 'Bay',
					percent: 80,
					status: 'discharging',
					secondsRemaining: 28800,
					power: 10,
					energyNow: 80_000_000,
					energyFull: 100_000_000,
				},
			],
		}),
	)
	const bat = items.find((g) => g.k === 'Battery')
	assert.equal(bat.p, 60)
	assert.equal(bat.sub, '60%')
	assert.equal(bat.color, batteryColor(60))
	assert.equal(items.filter((g) => g.k.startsWith('Battery')).length, 1)
})

test('swarmGaugeItems: battery subtitle is the percent; missing pack percent is not ready', () => {
	const charging = swarmGaugeItems(
		metrics({
			batteries: [{id: 'BAT0', index: 0, name: 'Internal', percent: 64, status: 'charging', secondsRemaining: 600, power: 10, energyNow: 1, energyFull: 2}],
		}),
	).find((g) => g.k === 'Battery')
	assert.equal(charging.sub, '64%')
	const missing = swarmGaugeItems(
		metrics({
			batteries: [{id: 'BAT0', index: 0, name: 'Internal', percent: null, status: 'unknown', secondsRemaining: null, power: null, energyNow: null, energyFull: null}],
		}),
	).find((g) => g.k === 'Battery')
	assert.equal(missing.ready, false)
})

test('batteryColor: low is red, high is green', () => {
	assert.equal(batteryColor(10), 'var(--red)')
	assert.equal(batteryColor(20), 'var(--yellow)')
	assert.equal(batteryColor(80), 'var(--green)')
})
