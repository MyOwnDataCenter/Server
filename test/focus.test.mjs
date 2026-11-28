// Unit tests for the modal stack, keyboard focus management, live regions, and Field accessibility helpers.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {afterEach, test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {
	canRestoreFocus,
	checkLiveText,
	dialogStackSize,
	fieldAria,
	getFocusable,
	getInitialFocusTarget,
	getMenuItems,
	getTabTrapTarget,
	hasOpenDialog,
	isElementFocusable,
	isTopDialog,
	liveRegionText,
	nextMenuIndex,
	pickFocusTarget,
	popDialog,
	pushDialog,
	resetDialogStack,
	restoreFocus,
	topDialogElement,
} from '../web/src/focus.ts'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeMockEl(opts = {}) {
	const attrs = new Map(Object.entries(opts.attrs ?? {}))
	return {
		id: opts.id ?? 'el',
		disabled: opts.disabled ?? false,
		tabIndex: opts.tabIndex,
		isConnected: opts.isConnected ?? true,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		closest: opts.closest ?? (() => null),
		focus: opts.focus ?? (() => {}),
	}
}

function makeMockContainer(children = [], opts = {}) {
	const autoTarget = opts.autoTarget ?? null
	const set = new Set(children)
	const container = {
		...makeMockEl({id: opts.id ?? 'dialog', tabIndex: -1}),
		contains: (node) => node === container || set.has(node) || !!opts.extraContains?.(node),
		querySelector: (sel) => (sel.includes('autofocus') ? autoTarget : null),
		querySelectorAll: () => children,
	}
	return container
}

afterEach(() => {
	resetDialogStack()
})

test('modal stack tracks nested dialogs and lets only the top dialog handle Escape', () => {
	assert.equal(hasOpenDialog(), false)
	assert.equal(dialogStackSize(), 0)
	assert.equal(topDialogElement(), null)

	const sheetEl = {id: 'app-sheet'}
	const confirmEl = {id: 'confirm-sheet'}
	const sheetId = pushDialog(undefined, sheetEl)
	assert.equal(hasOpenDialog(), true)
	assert.equal(dialogStackSize(), 1)
	assert.equal(isTopDialog(sheetId), true)
	assert.equal(topDialogElement(), sheetEl)

	// Confirm sheet opens over AppSheet: only Confirm is on top.
	const confirmId = pushDialog(undefined, confirmEl)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(sheetId), false)
	assert.equal(isTopDialog(confirmId), true)
	assert.equal(topDialogElement(), confirmEl)

	// Closing Confirm returns top status to AppSheet underneath.
	popDialog(confirmId)
	assert.equal(dialogStackSize(), 1)
	assert.equal(isTopDialog(sheetId), true)
	assert.equal(isTopDialog(confirmId), false)
	assert.equal(topDialogElement(), sheetEl)

	popDialog(sheetId)
	assert.equal(hasOpenDialog(), false)
	assert.equal(dialogStackSize(), 0)
	assert.equal(topDialogElement(), null)
})

test('modal stack handles out-of-order removal and re-push deduplication', () => {
	const firstEl = {id: 'first'}
	const secondEl = {id: 'second'}
	const thirdEl = {id: 'third'}

	const first = pushDialog(undefined, firstEl)
	const second = pushDialog(undefined, secondEl)
	const third = pushDialog(undefined, thirdEl)
	assert.equal(dialogStackSize(), 3)

	// Out-of-order pop removes the middle dialog without disturbing top.
	popDialog(second)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(third), true)

	// Re-pushing an existing id moves it to the top without creating a duplicate entry.
	pushDialog(first, firstEl)
	assert.equal(dialogStackSize(), 2)
	assert.equal(isTopDialog(first), true)
	assert.equal(isTopDialog(third), false)
	assert.equal(topDialogElement(), firstEl)
})

test('isElementFocusable and getFocusable filter disabled, negative tabindex, and inert controls', () => {
	const ok = makeMockEl({id: 'ok', tabIndex: 0})
	const disabled = makeMockEl({id: 'disabled', disabled: true, tabIndex: 0})
	const disabledAttr = makeMockEl({id: 'disabledAttr', attrs: {disabled: ''}})
	const negTab = makeMockEl({id: 'negTab', tabIndex: -1, attrs: {tabindex: '-1'}})
	const hiddenAncestor = makeMockEl({id: 'hidden', closest: (sel) => (sel.includes('inert') ? {} : null)})
	const container = makeMockContainer([disabled, disabledAttr, negTab, hiddenAncestor, ok])

	assert.equal(isElementFocusable(ok), true)
	assert.equal(isElementFocusable(disabled), false)
	assert.equal(isElementFocusable(disabledAttr), false)
	assert.equal(isElementFocusable(negTab), false)
	assert.equal(isElementFocusable(hiddenAncestor), false)
	assert.deepEqual(getFocusable(container), [ok])
})

test('getInitialFocusTarget respects autoFocus already inside dialog and chooses sensible fallbacks', () => {
	const closeBtn = makeMockEl({id: 'close', tabIndex: 0})
	const autoInput = makeMockEl({id: 'name', tabIndex: 0})
	const outsideBtn = makeMockEl({id: 'opener', tabIndex: 0})
	const dialog = makeMockContainer([closeBtn, autoInput], {autoTarget: autoInput})

	// If React already focused an autoFocus input inside the dialog, do not move focus away.
	assert.equal(getInitialFocusTarget(dialog, autoInput), null)

	// When opener is outside, prefer [data-autofocus]/[autofocus] over the first control.
	assert.equal(getInitialFocusTarget(dialog, outsideBtn), autoInput)

	// Without autofocus, pick the first focusable control.
	const plainDialog = makeMockContainer([closeBtn, autoInput])
	assert.equal(getInitialFocusTarget(plainDialog, outsideBtn), closeBtn)

	// If the dialog has no focusable controls, focus the dialog container itself.
	const emptyDialog = makeMockContainer([])
	assert.equal(getInitialFocusTarget(emptyDialog, outsideBtn), emptyDialog)

	// Preferred container overrides controls when requested.
	assert.equal(getInitialFocusTarget(plainDialog, outsideBtn, 'container'), plainDialog)
})

test('Sheet in ui.tsx delegates focus/Escape to useDialogFocus without onClose in lockPageScroll effect', () => {
	const ui = readFileSync(join(rootDir, 'web/src/ui.tsx'), 'utf8')
	assert.match(ui, /useDialogFocus\(open, ref, onClose\)/)
	assert.match(ui, /useEffect\(\(\) => \{\s*if \(!open\) return\s*return lockPageScroll\(\)\s*\}, \[open\]\)/)
})

test('getTabTrapTarget wraps forward/backward at edges, lets middle controls pass, and pulls outside focus back', () => {
	const first = makeMockEl({id: 'close', tabIndex: 0})
	const middle = makeMockEl({id: 'input', tabIndex: 0})
	const last = makeMockEl({id: 'submit', tabIndex: 0})
	const outside = makeMockEl({id: 'dock-btn', tabIndex: 0})
	const focusables = [first, middle, last]
	const dialog = makeMockContainer(focusables)

	// Wrapping from last -> first on Tab, and first -> last on Shift+Tab.
	assert.equal(getTabTrapTarget(focusables, last, false, dialog), first)
	assert.equal(getTabTrapTarget(focusables, first, true, dialog), last)

	// Middle elements advance naturally without interception.
	assert.equal(getTabTrapTarget(focusables, middle, false, dialog), null)
	assert.equal(getTabTrapTarget(focusables, middle, true, dialog), null)

	// Focus on the container or outside the dialog is pulled into the ends.
	assert.equal(getTabTrapTarget(focusables, dialog, false, dialog), first)
	assert.equal(getTabTrapTarget(focusables, dialog, true, dialog), last)
	assert.equal(getTabTrapTarget(focusables, outside, false, dialog), first)
	assert.equal(getTabTrapTarget(focusables, outside, true, dialog), last)

	// Empty dialog keeps focus on the container.
	const empty = makeMockContainer([])
	assert.equal(getTabTrapTarget([], empty, false, empty), empty)
	assert.equal(getTabTrapTarget([], empty, true, empty), empty)
})

test('pickFocusTarget and restoreFocus restore connected opener or fall back when opener is gone/inert', () => {
	const focused = []
	const opener = makeMockEl({id: 'opener', focus: (opts) => focused.push(['opener', opts])})
	const disconnected = makeMockEl({id: 'gone', isConnected: false, focus: () => focused.push(['gone'])})
	const disabled = makeMockEl({id: 'disabled', disabled: true, focus: () => focused.push(['disabled'])})
	const inert = makeMockEl({id: 'inert', closest: (sel) => (sel.includes('inert') ? {} : null), focus: () => focused.push(['inert'])})
	const fallback = makeMockEl({id: 'fallback', focus: (opts) => focused.push(['fallback', opts])})

	assert.equal(canRestoreFocus(opener), true)
	assert.equal(canRestoreFocus(disconnected), false)
	assert.equal(canRestoreFocus(disabled), false)
	assert.equal(canRestoreFocus(inert), false)

	assert.equal(pickFocusTarget([disconnected, disabled, inert, fallback]), fallback)
	assert.equal(restoreFocus(opener, fallback), true)
	assert.equal(restoreFocus(disconnected, fallback), true)
	assert.equal(restoreFocus(disconnected, inert), false)
	assert.deepEqual(focused, [
		['opener', {preventScroll: true}],
		['fallback', {preventScroll: true}],
	])
})

test('AppViewer uses useDialogFocus with tabIndex={-1} and aria-modal="true"', () => {
	const src = readFileSync(join(rootDir, 'web/src/AppViewer.tsx'), 'utf8')
	assert.match(src, /useDialogFocus\(true, dialogRef, back\)/)
	assert.match(src, /role="dialog"\s+aria-modal="true"[\s\S]*?tabIndex=\{-1\}/)
})

test('FileViewer uses useDialogFocus with tabIndex={-1} and modal stack guard', () => {
	const src = readFileSync(join(rootDir, 'web/src/screens/viewer/FileViewer.tsx'), 'utf8')
	assert.match(src, /useDialogFocus\(!!f, dialogRef, \(\) => void close\(\)/)
	assert.match(src, /ref=\{dialogRef\}[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?tabIndex=\{-1\}/)
	assert.match(src, /if \(!isTop\(\)/)
})

test('nextMenuIndex and getMenuItems support arrow, Home/End navigation and skip disabled items', () => {
	assert.equal(nextMenuIndex(0, -1, 'ArrowDown'), null)
	assert.equal(nextMenuIndex(4, -1, 'ArrowDown'), 0)
	assert.equal(nextMenuIndex(4, -1, 'ArrowUp'), 3)
	assert.equal(nextMenuIndex(4, 3, 'ArrowDown'), 0)
	assert.equal(nextMenuIndex(4, 0, 'ArrowUp'), 3)
	assert.equal(nextMenuIndex(4, 2, 'Home'), 0)
	assert.equal(nextMenuIndex(4, 1, 'End'), 3)
	assert.equal(nextMenuIndex(4, 1, 'Enter'), null)

	const item1 = makeMockEl({id: 'open', tabIndex: 0})
	const disabled = makeMockEl({id: 'dis', disabled: true, tabIndex: 0})
	const ariaDisabled = makeMockEl({id: 'aria-dis', tabIndex: 0, attrs: {'aria-disabled': 'true'}})
	const item2 = makeMockEl({id: 'close', tabIndex: 0})
	const menu = makeMockContainer([item1, disabled, ariaDisabled, item2])
	assert.deepEqual(getMenuItems(menu), [item1, item2])

	const desk = readFileSync(join(rootDir, 'web/src/desktop/Desktop.tsx'), 'utf8')
	assert.match(desk, /className="menu-scrim" aria-label="Close menu" tabIndex=\{-1\}/)
	assert.match(desk, /useMenuFocus\(true, ref, onClose, menu\.opener\)/)
	assert.match(desk, /useMenuFocus\(p\.menu === 'system', sysRef, closeTopMenu\)/)
})

test('Activities overview sets inert on desktop surface and windows, traps focus, and places window picks right after search', () => {
	const desk = readFileSync(join(rootDir, 'web/src/desktop/Desktop.tsx'), 'utf8')
	assert.match(desk, /useInert\(surfaceRef, !!p\.inert\)/)
	assert.match(desk, /useInert\(el, !!inert\)/)
	assert.match(desk, /useDialogFocus\(true, layerRef, \(\) => setMode\(null\), \{initialFocus: ref\}\)/)
	const searchPos = desk.indexOf('<div className="ov-search">')
	const picksPos = desk.indexOf('<div className="ov-windows"')
	assert.ok(searchPos !== -1 && picksPos !== -1 && picksPos > searchPos, 'window picks must follow search inside Overview')
	assert.equal(desk.includes('onOverviewPick'), false, 'WindowFrame should no longer render .win-pick inside windows')
})

test('desktop windows are focusable with tabIndex={-1} and restore priority prefers opener then next window', () => {
	const desk = readFileSync(join(rootDir, 'web/src/desktop/Desktop.tsx'), 'utf8')
	assert.match(desk, /role="dialog"[\s\S]*?aria-label=\{title\}[\s\S]*?tabIndex=\{-1\}/)
	assert.match(desk, /pickFocusTarget\(\[/)

	const opener = makeMockEl({id: 'dock-settings'})
	const nextWin = makeMockEl({id: 'win-files'})
	const minimizedWin = makeMockEl({id: 'win-min', closest: (sel) => (sel.includes('.win.minimized') ? {} : null)})
	const dockFallback = makeMockEl({id: 'dock-fallback'})
	const deskSurface = makeMockEl({id: 'desk-surface'})

	// Connected opener wins.
	assert.equal(pickFocusTarget([opener, nextWin, dockFallback, deskSurface]), opener)

	// Disconnected opener falls back to next visible window (skipping minimized ones).
	const goneOpener = makeMockEl({id: 'gone', isConnected: false})
	assert.equal(pickFocusTarget([goneOpener, minimizedWin, nextWin, dockFallback, deskSurface]), nextWin)
	assert.equal(pickFocusTarget([goneOpener, minimizedWin, dockFallback, deskSurface]), dockFallback)
	assert.equal(pickFocusTarget([goneOpener, null, null, deskSurface]), deskSurface)
})

test('liveRegionText and checkLiveText route status vs alert text and keep persistent live regions mounted', () => {
	assert.deepEqual(liveRegionText(null), {status: '', alert: ''})
	assert.deepEqual(liveRegionText({text: 'Saved'}), {status: 'Saved', alert: ''})
	assert.deepEqual(liveRegionText({text: 'Wrong password', error: true}), {status: '', alert: 'Wrong password'})

	assert.deepEqual(checkLiveText(null, true), {status: 'Checking…', alert: ''})
	assert.deepEqual(checkLiveText(null, false), {status: '', alert: ''})
	assert.deepEqual(checkLiveText({ok: true, message: 'Connected'}), {status: 'Connected', alert: ''})
	assert.deepEqual(checkLiveText({ok: false, message: 'Invalid key'}), {status: '', alert: 'Invalid key'})

	// Toasts are spoken from two regions that stay mounted. A problem never replaces the status region.
	const toasts = readFileSync(join(rootDir, 'web/src/toasts/account.tsx'), 'utf8')
	assert.match(toasts, /liveRegionText\(announced/)
	assert.match(toasts, /<div className="sr-only" role="status" aria-live="polite" aria-atomic="true">\s*\{live\.status\}\s*<\/div>/)
	assert.match(toasts, /<div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">\s*\{live\.alert\}\s*<\/div>/)
	assert.doesNotMatch(toasts, /role=\{[^}]*\? 'alert' : 'status'\}/)

	const settings = readFileSync(join(rootDir, 'web/src/screens/Settings.tsx'), 'utf8')
	assert.match(settings, /<div role="status" aria-live="polite" aria-atomic="true">/)
	assert.match(settings, /<div role="alert" aria-live="assertive" aria-atomic="true">/)
	assert.match(settings, /<CheckLine check=\{k\.check \?\? null\}/)
})

test('fieldAria wires aria-describedby and aria-invalid and shared Field replaces duplicates', () => {
	assert.deepEqual(fieldAria('f1', {}), {hintId: 'f1-hint', errorId: 'f1-error'})
	assert.deepEqual(fieldAria('f1', {hasHint: true}), {
		hintId: 'f1-hint',
		errorId: 'f1-error',
		describedBy: 'f1-hint',
	})
	assert.deepEqual(fieldAria('f1', {hasError: true, hasHint: true}), {
		hintId: 'f1-hint',
		errorId: 'f1-error',
		describedBy: 'f1-error f1-hint',
		invalid: true,
	})
	assert.deepEqual(fieldAria('f1', {invalid: true, describedBy: 'extra'}), {
		hintId: 'f1-hint',
		errorId: 'f1-error',
		describedBy: 'extra',
		invalid: true,
	})

	const ui = readFileSync(join(rootDir, 'web/src/ui.tsx'), 'utf8')
	assert.match(ui, /export function Field\(/)
	assert.match(ui, /aria-describedby=\{a11y\.describedBy\}/)
	assert.match(ui, /aria-invalid=\{ariaInvalidProp \?\? a11y\.invalid\}/)

	for (const rel of ['web/src/screens/Settings.tsx', 'web/src/backups.tsx', 'web/src/unraid.tsx']) {
		const src = readFileSync(join(rootDir, rel), 'utf8')
		assert.equal(src.includes('function Field('), false, `${rel} should reuse Field from ui.tsx`)
	}
	for (const rel of ['web/src/CreateMachine.tsx', 'web/src/screens/Storage.tsx', 'web/src/beforeInstall.tsx', 'web/src/screens/Auth.tsx']) {
		const src = readFileSync(join(rootDir, rel), 'utf8')
		assert.match(src, /<Field\b/, `${rel} should use shared Field`)
	}
})
