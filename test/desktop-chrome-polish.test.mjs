// Desktop chrome polish regressions: top-bar scoping, workspace pills, tooltips, menus, sheets, toasts, rows, and forms.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'

const CSS = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8')
const UI = readFileSync(new URL('../web/src/ui.tsx', import.meta.url), 'utf8')
const DESKTOP = readFileSync(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
// Delete lives on the shared book. screens/Clips.tsx only mounts that book.
const CLIP_BOOK = readFileSync(new URL('../web/src/clips/ClipBook.tsx', import.meta.url), 'utf8')

test('top-bar button rules are scoped to bar triggers and do not clobber popover controls or workspace pills', () => {
	assert.doesNotMatch(CSS, /\n\.desk-top button \{/)
	assert.match(CSS, /:where\(\.desk-top > button, \.top-left > button, \.top-right > button\) \{/)
	assert.match(CSS, /\.style-daylight \.desk-top \.top-bell:hover,\n\.style-daylight \.desk-top \.top-bell\.on \{/)
	assert.match(CSS, /\.top-pop \.icon-btn \{[^}]*color:\s*inherit;/)
})

test('workspace pill hover does not override active .on pill and Locked chip stays style-safe', () => {
	assert.match(CSS, /\.hypr-ws \.hypr-pill:not\(\.on\):hover \{/)
	assert.match(CSS, /\.style-daylight \.hypr-ws \.hypr-pill:not\(\.on\):hover \{/)
	const lock = CSS.match(/\n\.hypr-lock\.on \{[^}]*\}/)?.[0]
	assert.ok(lock && /color:\s*inherit;/.test(lock) && !/--accent-text/.test(lock))
})

test('title-bar tooltips are unified with --tip-* and keyboard focus, and ghost buttons keep 30px width with 12px total group gap', () => {
	assert.match(CSS, /\.win-btn\[data-tip\]::after \{[^}]*--tip-bg/)
	assert.match(CSS, /\.win-btn\[data-tip\]:hover::after,\n\.win-btn\[data-tip\]:focus-visible::after \{/)
	assert.match(CSS, /\.win-btn\.ghost \+ \.win-btn:not\(\.ghost\) \{[^}]*margin-left:\s*5px;/)
	assert.doesNotMatch(CSS, /\.win-btn\.ghost \+ \.win-btn:not\(\.ghost\)::before/)
})

test('context & system menus share concentric 8px (Graphite 4px) item radius, truncation, and disabled hover exclusion in all styles', () => {
	assert.match(CSS, /\.sys-pop button,\n\.ctx-menu button \{[^}]*border-radius:\s*8px;/)
	assert.match(CSS, /\.style-graphite \.sys-pop button,\n\.style-graphite \.ctx-menu button \{[^}]*border-radius:\s*4px;/)
	assert.match(CSS, /\.ctx-menu button:not\(:disabled\):hover/)
	assert.match(CSS, /\.style-daylight \.ctx-menu button:not\(:disabled\):hover/)
	assert.match(DESKTOP, /<span>\{it\.label\}<\/span>/)
})

test('offline banner sits above dock and below top bar, context menu sits above Hyprland overlays, and clock-pop stacks on narrow viewports', () => {
	const z = (sel) => Number(CSS.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{[^}]*?z-index: (\\d+)`))?.[1])
	assert.ok(z('.desk-offline-banner') > z('.desk-dock'), 'offline banner must clear the dock')
	assert.ok(z('.desk-top') > z('.desk-offline-banner'), 'top bar and its popovers must sit above the offline banner')
	assert.ok(z('.menu-scrim') > z('.hypr-onboard') && z('.ctx-menu') > z('.menu-scrim'), 'context menu must sit above Hyprland overlays')
	assert.match(CSS, /@media \(max-width: 600px\) \{\n\t\.clock-pop \{[^}]*grid-template-columns:\s*1fr;/)
})

test('desktop-mode body sheets centre with compact desktop confirm row, Cancel-first at narrow widths, legible danger fill, and toasts clear the top bar', () => {
	assert.match(CSS, /html\.desk-mode > body > \.sheet \{/)
	assert.match(CSS, /html\.desk-mode > body > \.sheet \.confirm-actions \{[^}]*flex-direction:\s*row-reverse;/)
	assert.match(CSS, /html\.desk-mode > body > \.sheet \.confirm-actions \.btn\.block \{[^}]*min-height:\s*40px;/)
	assert.match(CSS, /@media \(max-width: 420px\) \{\n\thtml\.desk-mode > body > \.sheet \.confirm-actions \{[^}]*flex-direction:\s*column-reverse;/)
	assert.match(CSS, /\.btn\.danger\.solid \{[^}]*color-mix\(in srgb, var\(--red\) 60%, #240004\)/)
	assert.match(CSS, /html\.desk-mode \.toast \{[^}]*top:\s*calc\(var\(--top-h, 34px\) \+ 12px\);/)
	assert.match(UI, /className="stack confirm-actions"/)
	assert.match(UI, /if \(document\.documentElement\.classList\.contains\('desk-mode'\)\) return/)
})

test('row hover targets actionable rows and preserves :active press state', () => {
	assert.match(CSS, /:is\(button, a\)\.row:not\(\.static\):not\(:disabled\):not\(:active\):hover \{/)
})

test('field textareas are styled and Clips buttons are spaced cleanly', () => {
	assert.match(CSS, /\.field input,\n\.field textarea \{/)
	assert.match(CLIP_BOOK, /btn block danger/)
})
