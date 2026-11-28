// Apps opened from the screen-share view open on the screen being shared, not on the headless RAIL-1
// display that desktop-mode app windows use (opening the shared screen puts focus back on it).
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createHyprland} from '../omarchyd/hyprland.mjs'

async function setup(monitors) {
	const dir = await mkdtemp(join(os.tmpdir(), 'hypr-focus-'))
	await writeFile(join(dir, 'wayland-1'), '')
	await mkdir(join(dir, 'hypr', 'sig123'), {recursive: true})
	await writeFile(join(dir, 'hypr', 'sig123', '.socket.sock'), '')
	const sent = []
	const hypr = createHyprland({
		dataDir: join(dir, 'data'),
		runtimeDir: dir,
		vaapiDevice: join(dir, 'none'),
		async exec(cmd, args) {
			if (cmd === 'hyprctl' && args[0] === 'monitors') return {ok: true, stdout: JSON.stringify(monitors), stderr: ''}
			if (cmd === 'hyprctl' && (args[0] === 'eval' || args[0] === 'dispatch')) return sent.push(args), {ok: true, stdout: 'ok\n', stderr: ''}
			return {ok: false, stdout: '', stderr: ''}
		},
	})
	return {hypr, sent, done: () => rm(dir, {recursive: true, force: true})}
}

test('focus on the headless display goes back to the shared screen', async () => {
	const t = await setup([
		{id: 0, name: 'eDP-1', width: 1920, height: 1200, focused: false, activeWorkspace: {id: 2}},
		{id: 1, name: 'RAIL-1', width: 3840, height: 2160, focused: true, activeWorkspace: {id: 11}},
	])
	try {
		assert.equal(await t.hypr.focusSharedScreen(), true)
		const all = t.sent.map((a) => a.join(' ')).join('\n')
		assert.match(all, /workspace = 2|workspace 2/)
		assert.doesNotMatch(all, /11/)
	} finally {
		await t.done()
	}
})

test('nothing happens when the shared screen already has focus, or there is no headless display', async () => {
	for (const mons of [
		[
			{id: 0, name: 'eDP-1', focused: true, activeWorkspace: {id: 1}},
			{id: 1, name: 'RAIL-1', focused: false, activeWorkspace: {id: 11}},
		],
		[{id: 0, name: 'eDP-1', focused: true, activeWorkspace: {id: 1}}],
	]) {
		const t = await setup(mons)
		try {
			assert.equal(await t.hypr.focusSharedScreen(), false)
			assert.equal(t.sent.length, 0)
		} finally {
			await t.done()
		}
	}
})
