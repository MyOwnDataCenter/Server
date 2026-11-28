// New-machine disk steps, size limits, and username rules. The form uses these helpers.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

import {defaultCores, defaultMemoryGb, diskRange, machineUsernameHint, machineUsernameOk, nextDiskGb} from '../web/src/machineForm.ts'

const GiB = 1024 ** 3
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('disk More and Less undo each other around 100 GB', () => {
	const bounds = {min: 25, max: 4096}
	let v = 40
	for (let i = 0; i < 12; i++) v = nextDiskGb(v, 1, bounds)
	assert.equal(v, 100)
	assert.equal(nextDiskGb(100, -1, bounds), 95)
	assert.equal(nextDiskGb(95, 1, bounds), 100)
	assert.equal(nextDiskGb(100, 1, bounds), 120)
	assert.equal(nextDiskGb(120, -1, bounds), 100)
	const win = {min: 64, max: 4096}
	assert.equal(nextDiskGb(96, 1, win), 101)
	assert.equal(nextDiskGb(101, -1, win), 96)
	assert.equal(nextDiskGb(nextDiskGb(100, -1, win), 1, win), 100)
	assert.equal(nextDiskGb(4, -1, {min: 4, max: 4096}), 4)
	assert.equal(nextDiskGb(4096, 1, {min: 4, max: 4096}), 4096)
	assert.ok(nextDiskGb(4080, 1, {min: 4, max: 4096}) <= 4096)
})

test('disk floors match the server and the cap is 4096', () => {
	assert.deepEqual(diskRange({familyId: 'alpine', platform: 'linux'}, 2), {min: 4, max: 4096})
	assert.deepEqual(diskRange({familyId: 'custom', platform: 'linux'}, 1), {min: 4, max: 4096})
	assert.deepEqual(diskRange({familyId: 'omarchy', platform: 'linux'}, 25), {min: 25, max: 4096})
	assert.deepEqual(diskRange({familyId: 'omarchy', platform: 'linux'}, 10), {min: 20, max: 4096})
	assert.deepEqual(diskRange({id: 'cachyos-desktop-amd64', familyId: 'cachyos', platform: 'linux', manualSetup: true}, 10), {min: 20, max: 4096})
	assert.deepEqual(diskRange({id: 'local:mint.iso', familyId: 'custom', platform: 'linux', manualSetup: true}, 1), {min: 4, max: 4096})
	assert.deepEqual(diskRange({familyId: 'windows-11', platform: 'windows'}, 64), {min: 64, max: 4096})
	assert.deepEqual(diskRange({familyId: 'windows-xp', platform: 'windows'}, 2), {min: 64, max: 4096})
	assert.equal(diskRange({familyId: 'debian', platform: 'linux'}, 10).max, 4096)
})

test('usernames use the server patterns', () => {
	for (const ok of ['fred', 'a', '_svc', 'user_1', 'a'.repeat(32)]) assert.equal(machineUsernameOk(ok, false), true, ok)
	for (const bad of ['Fred', 'john.smith', '2fast', 'root', 'Root', '', 'has space', 'a'.repeat(33)]) assert.equal(machineUsernameOk(bad, false), false, bad)
	assert.equal(machineUsernameOk('Fred', true), true)
	assert.equal(machineUsernameOk('john.smith', true), true)
	assert.equal(machineUsernameOk('administrator', true), false)
	assert.equal(machineUsernameOk('Guest', true), false)
	assert.equal(machineUsernameOk('a'.repeat(21), true), false)
	assert.match(machineUsernameHint(false), /not root/)
	assert.doesNotMatch(machineUsernameHint(false), /dot/i)
	assert.match(machineUsernameHint(true), /Administrator|administrator/)
	assert.match(machineUsernameHint(true), /Guest|guest/)
})

test('cores and memory defaults use the host figures, not the cold fallback', () => {
	const ubuntu = {cores: 4, minCores: 2, memoryGb: 8, minMemoryGb: 4}
	assert.equal(defaultCores(ubuntu, 8), 4)
	assert.equal(defaultMemoryGb(ubuntu, {size: 16 * GiB, totalUsed: 2e9}), 8)
	assert.equal(defaultCores(ubuntu, 4), 2, 'the cold fallback of 4 threads is only 2 cores')
	assert.equal(defaultMemoryGb(ubuntu, null), 5, 'the cold fallback before memory loads')
	assert.equal(defaultMemoryGb(ubuntu, {size: 4 * GiB, totalUsed: 2e9}), 2)
})

test('the new-machine form waits for CPU and memory and uses the helpers', () => {
	const src = read('../web/src/CreateMachine.tsx')
	assert.match(src, /nextDiskGb/)
	assert.match(src, /diskRange/)
	assert.match(src, /machineUsernameOk/)
	assert.match(src, /defaultCores/)
	assert.match(src, /defaultMemoryGb/)
	assert.match(src, /maxLength=\{64\}/)
	assert.match(src, /isPending/)
	assert.doesNotMatch(src, /maxLength=\{100\}/)
	assert.doesNotMatch(src, /max=\{10_000\}/)
	assert.doesNotMatch(src, /diskSizeGb >= 100 \? 20 : 5/)
})
