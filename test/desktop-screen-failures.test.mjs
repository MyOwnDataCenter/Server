import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {diffPrefsPatch} from '../web/src/prefsSync.ts'
import {desktopIconKeysApply, iconSelectionClearsOnFocus} from '../web/src/desktop/iconKeys.ts'
import {ignoreRepeatedDesktopShortcut} from '../web/src/desktop/shortcutRepeat.ts'
import {nextStarting} from '../web/src/desktop/startingWatch.ts'
import {desktopMachineStatus, machineOpenAction} from '../web/src/desktop/machineOpen.ts'
import {consoleShouldTakeFocus} from '../web/src/consoleFocus.ts'
import {caughtScreenError, retryScreen, screenErrorView} from '../web/src/screenError.ts'
import {storageDrivesView, storageStatusMessage} from '../web/src/storageList.ts'
import {backupListView} from '../web/src/machines/backupList.ts'
import {applyPrefsUpdate, prefsAfterPhotoUpload, prefsChoosingYourPhoto, resolvePrefsUpdate} from '../web/src/photoPrefs.ts'

const el = (hits) => ({closest: (sel) => (hits.includes(sel) ? {} : null)})

test('desktop icon shortcuts run only while focus is inside the desktop surface', () => {
	assert.equal(desktopIconKeysApply(el(['.desk-surface'])), true)
	assert.equal(desktopIconKeysApply(el(['.desk-surface', '.desk-icon'])), true)
	// Clicking plain text in a window leaves focus on the page body, which is not the desktop.
	assert.equal(desktopIconKeysApply(el([])), false)
	assert.equal(desktopIconKeysApply(null), false)
	assert.equal(desktopIconKeysApply(undefined), false)
	// A focused window is not the desktop, so Ctrl+A / Enter / Delete must not reach the icons.
	assert.equal(desktopIconKeysApply(el(['.win'])), false)

	assert.equal(iconSelectionClearsOnFocus(el(['.win'])), true)
	assert.equal(iconSelectionClearsOnFocus(el(['.win', '.win-body'])), true)
	assert.equal(iconSelectionClearsOnFocus(el(['.desk-surface'])), false)
	assert.equal(iconSelectionClearsOnFocus(el(['.win', '.desk-surface'])), false)
	assert.equal(iconSelectionClearsOnFocus(el([])), false)
	assert.equal(iconSelectionClearsOnFocus(null), false)
})

test('one-shot desktop chords do not repeat, arrow focus and console keys do', () => {
	const once = (over) => ignoreRepeatedDesktopShortcut({repeat: true, terminalChord: false, action: null, forwardsToConsole: false, ...over})
	assert.equal(once({terminalChord: true}), true)
	assert.equal(once({action: {type: 'terminal'}}), true)
	assert.equal(once({action: {type: 'close'}}), true)
	assert.equal(once({action: {type: 'grab-toggle'}}), true)
	assert.equal(once({action: {type: 'workspace'}}), true)
	assert.equal(once({action: {type: 'focus'}}), false)
	assert.equal(once({action: {type: 'swap'}}), false)
	assert.equal(once({forwardsToConsole: true, action: null}), false)
	assert.equal(ignoreRepeatedDesktopShortcut({repeat: false, terminalChord: true, action: {type: 'close'}, forwardsToConsole: false}), false)
	assert.equal(once({action: null}), false)
})

test('a machine leaves the starting list when it is running, failed, stopped, or gone', () => {
	const watch = [{id: 'vm', listUpdatedAt: 100}]
	const same = (machines) => nextStarting(watch, machines, 100)
	const fresh = (machines) => nextStarting(watch, machines, 250)

	// The list from before start() returned still says stopped. Keep waiting.
	assert.deepEqual(same([{id: 'vm', state: 'stopped'}]), {keep: watch, open: []})
	assert.deepEqual(same([{id: 'vm', state: 'hibernated'}]), {keep: watch, open: []})
	// Already running on that same list: open the console.
	assert.deepEqual(same([{id: 'vm', state: 'running'}]), {keep: [], open: ['vm']})
	// No list yet is not "deleted".
	assert.deepEqual(same(undefined), {keep: watch, open: []})

	assert.deepEqual(fresh([{id: 'vm', state: 'running'}]), {keep: [], open: ['vm']})
	assert.deepEqual(fresh([{id: 'vm', state: 'starting'}]), {keep: watch, open: []})
	assert.deepEqual(fresh([{id: 'vm', state: 'stopped'}]), {keep: [], open: []})
	assert.deepEqual(fresh([{id: 'vm', state: 'error'}]), {keep: [], open: []})
	assert.deepEqual(fresh([]), {keep: [], open: []})
	assert.deepEqual(fresh([{id: 'other', state: 'running'}]), {keep: [], open: []})

	const kept = fresh([{id: 'vm', state: 'starting'}, {id: 'other', state: 'running'}])
	assert.deepEqual(kept.keep.map((w) => w.id), ['vm'])
	assert.deepEqual(kept.open, [])
})

test('a hibernated machine starts from the desktop and shows as stopped', () => {
	assert.equal(desktopMachineStatus('hibernated'), 'stopped')
	assert.equal(desktopMachineStatus('stopped'), 'stopped')
	assert.equal(desktopMachineStatus('error'), 'stopped')
	assert.equal(desktopMachineStatus('running'), 'running')
	assert.equal(desktopMachineStatus('starting'), 'busy')
	assert.equal(desktopMachineStatus('suspended'), 'busy')
	assert.equal(desktopMachineStatus(undefined), undefined)

	assert.equal(machineOpenAction('hibernated'), 'start')
	assert.equal(machineOpenAction('stopped'), 'start')
	assert.equal(machineOpenAction('error'), 'start')
	assert.equal(machineOpenAction('suspended'), 'start')
	assert.equal(machineOpenAction('running'), 'open')
	assert.equal(machineOpenAction('starting'), 'wait')
	assert.equal(machineOpenAction('stopping'), 'wait')
})

test('a console takes focus on the first connect, or when its window already has focus', () => {
	const inside = {id: 'in'}
	const outside = {id: 'out'}
	const windowEl = {contains: (node) => node === inside}
	assert.equal(consoleShouldTakeFocus({firstConnect: true, activeElement: outside, windowEl}), true)
	assert.equal(consoleShouldTakeFocus({firstConnect: true, activeElement: null, windowEl: null}), true)
	assert.equal(consoleShouldTakeFocus({firstConnect: false, activeElement: inside, windowEl}), true)
	assert.equal(consoleShouldTakeFocus({firstConnect: false, activeElement: outside, windowEl}), false)
	assert.equal(consoleShouldTakeFocus({firstConnect: false, activeElement: null, windowEl}), false)
	assert.equal(consoleShouldTakeFocus({firstConnect: false, activeElement: inside, windowEl: null}), false)
})

test('a screen load failure can be shown and then remounted', () => {
	assert.equal(screenErrorView({error: null}), null)
	const failed = {error: null, retry: 0, ...caughtScreenError(new Error('chunk'))}
	const view = screenErrorView(failed)
	assert.equal(view?.message, "This screen couldn't load")
	assert.equal(typeof view?.retryLabel, 'string')
	assert.ok(view.retryLabel.length > 0)
	const again = retryScreen(failed)
	assert.equal(again.error, null)
	assert.equal(again.retry, 1)
	assert.equal(screenErrorView(again), null)
	const second = {...again, ...caughtScreenError(new Error('chunk'))}
	assert.equal(second.retry, 1)
	assert.equal(screenErrorView(second)?.message, "This screen couldn't load")
})

test('a failed drives or status query is an error, not an empty drive list', () => {
	assert.deepEqual(storageDrivesView({isLoading: true, error: null, data: undefined}), {loading: true, error: null, showList: false})
	assert.deepEqual(storageDrivesView({isLoading: false, error: new Error('computer offline'), data: undefined}), {loading: false, error: 'computer offline', showList: false})
	assert.deepEqual(storageDrivesView({isLoading: false, error: new Error('computer offline'), data: []}), {loading: false, error: 'computer offline', showList: false})
	assert.deepEqual(storageDrivesView({isLoading: false, error: null, data: []}), {loading: false, error: null, showList: true})
	assert.equal(storageDrivesView({isLoading: false, error: null, data: [{path: '/dev/sda'}]}).showList, true)
	assert.equal(storageStatusMessage({error: new Error('helper down'), data: undefined}), 'helper down')
	assert.equal(storageStatusMessage({error: null, data: undefined}), null)
	assert.equal(storageStatusMessage({error: new Error('stale'), data: {helperAvailable: false}}), null)
	assert.equal(storageStatusMessage({error: null, data: {helperAvailable: false}}), null)
})

test('a failed backups query is an error row, not an empty table', () => {
	const failed = backupListView({isLoading: false, error: new Error("Your files aren't available"), data: undefined})
	assert.equal(failed.error, "Your files aren't available")
	assert.equal(failed.showEmpty, false)
	assert.equal(failed.loading, false)
	assert.deepEqual(backupListView({isLoading: false, error: new Error('disk full'), data: []}), {loading: false, error: 'disk full', showEmpty: false})
	assert.deepEqual(backupListView({isLoading: true, error: null, data: undefined}), {loading: true, error: null, showEmpty: false})
	assert.deepEqual(backupListView({isLoading: false, error: null, data: []}), {loading: false, error: null, showEmpty: true})
	assert.deepEqual(backupListView({isLoading: false, error: null, data: [{id: 'b1'}]}), {loading: false, error: null, showEmpty: false})
	assert.equal(backupListView({isLoading: false, error: new Error('later'), data: [{id: 'b1'}]}).error, null)
})

test('a finished photo upload keeps prefs that changed while it was uploading and clears a solid colour', () => {
	const atStart = {theme: 'horizon', accent: 'blue', solidColor: '#112233', customBrandHsl: null, backgroundVersion: null, omarchyBackground: 'abcdabcdabcdabcd', assistantLook: {name: 'Ada'}}
	const latest = {...atStart, accent: 'teal', assistantLook: {name: 'Bea'}}
	const phone = prefsAfterPhotoUpload(latest, {hsl: '12 40% 50%', backgroundVersion: 7}, {setThemeCustom: true})
	assert.equal(phone.accent, 'teal')
	assert.equal(phone.theme, 'custom')
	assert.equal(phone.solidColor, null)
	assert.equal(phone.customBrandHsl, '12 40% 50%')
	assert.equal(phone.backgroundVersion, 7)
	assert.equal(phone.omarchyBackground, atStart.omarchyBackground)
	assert.deepEqual(phone.assistantLook, {name: 'Bea'})

	const desktop = prefsAfterPhotoUpload(latest, {hsl: '1 2% 3%', backgroundVersion: 8}, {setThemeCustom: false})
	assert.equal(desktop.theme, 'horizon')
	assert.equal(desktop.accent, 'teal')
	assert.equal(desktop.solidColor, null)
	assert.equal(desktop.backgroundVersion, 8)

	const stale = {...atStart, theme: 'custom', customBrandHsl: '12 40% 50%', backgroundVersion: 7}
	const reverted = diffPrefsPatch(latest, stale)
	assert.equal(reverted.accent, 'blue')
	const patch = diffPrefsPatch(latest, phone)
	assert.equal(patch.accent, undefined)
	assert.equal(patch.assistantLook, undefined)
	assert.equal(patch.theme, 'custom')
	assert.equal(patch.solidColor, null)
	assert.equal(patch.customBrandHsl, '12 40% 50%')

	const chosen = prefsChoosingYourPhoto(latest)
	assert.equal(chosen.theme, 'custom')
	assert.equal(chosen.solidColor, null)
	assert.equal(chosen.accent, 'teal')
	assert.deepEqual(chosen.assistantLook, latest.assistantLook)

	let current = atStart
	const setPrefs = (next) => {
		current = resolvePrefsUpdate(current, next)
	}
	current = {...current, accent: 'peach'}
	applyPrefsUpdate(setPrefs, (now) => prefsAfterPhotoUpload(now, {hsl: '9 9% 9%', backgroundVersion: 2}, {setThemeCustom: true}))
	assert.equal(current.accent, 'peach')
	assert.equal(current.theme, 'custom')
	assert.equal(current.solidColor, null)
	assert.equal(resolvePrefsUpdate(atStart, {...atStart, accent: 'green'}).accent, 'green')
})

test('the screens call the decision helpers', async () => {
	const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
	const desktop = await read('../web/src/desktop/Desktop.tsx')
	assert.match(desktop, /desktopIconKeysApply\(/)
	assert.match(desktop, /iconSelectionClearsOnFocus\(/)
	assert.match(desktop, /ignoreRepeatedDesktopShortcut\(/)
	assert.match(desktop, /nextStarting\(/)
	assert.match(desktop, /desktopMachineStatus\(/)
	assert.match(desktop, /machineOpenAction\(/)
	const consoleSrc = await read('../web/src/Console.tsx')
	assert.match(consoleSrc, /consoleShouldTakeFocus\(/)
	const storage = await read('../web/src/screens/Storage.tsx')
	assert.match(storage, /storageDrivesView\(/)
	assert.match(storage, /storageStatusMessage\(/)
	assert.match(storage, /poolsProblem/)
	const panels = await read('../web/src/machines/panels.tsx')
	assert.match(panels, /backupListView\(/)
	const more = await read('../web/src/screens/More.tsx')
	const personalize = await read('../web/src/desktop/Personalize.tsx')
	const ui = await read('../web/src/ui.tsx')
	assert.match(more, /prefsAfterPhotoUpload\(/)
	assert.match(more, /applyPrefsUpdate\(/)
	const chooser = await read('../web/src/ThemeChooser.tsx')
	assert.match(chooser, /prefsChoosingYourPhoto\(/)
	assert.match(chooser, /applyPrefsUpdate\(/)
	assert.match(personalize, /prefsAfterPhotoUpload\(/)
	assert.match(personalize, /applyPrefsUpdate\(/)
	assert.match(ui, /resolvePrefsUpdate\(/)
})
