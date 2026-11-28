import assert from 'node:assert/strict'
import {test} from 'node:test'

import {cleanThemeSlots, nextThemeMode, themeModeOf, withThemeChoice, withThemeMode, withThemePreference} from '../web/src/theme/themeMode.ts'

const base = {theme: 'omarchy', darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'omarchy'}

test('a saved palette fills the empty slot it belongs to', () => {
	assert.deepEqual(cleanThemeSlots('latte', {}), {darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'omarchy'})
	assert.deepEqual(cleanThemeSlots('gruvbox', {}), {darkTheme: 'gruvbox', lightTheme: 'latte', pictureTheme: 'omarchy'})
	assert.deepEqual(cleanThemeSlots('horizon', {}), {darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'horizon'})
	assert.deepEqual(cleanThemeSlots('custom', {}), {darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'custom'})
	assert.deepEqual(cleanThemeSlots('sky', {lightTheme: 'linen', darkTheme: 'tokyo', pictureTheme: 'custom'}), {darkTheme: 'tokyo', lightTheme: 'linen', pictureTheme: 'custom'})
})

test('a slot that is the wrong kind of theme falls back', () => {
	assert.deepEqual(cleanThemeSlots('omarchy', {lightTheme: 'mocha', darkTheme: 'latte', pictureTheme: 'sky'}), {darkTheme: 'mocha', lightTheme: 'latte', pictureTheme: 'omarchy'})
})

test('the mode follows the theme that is on screen', () => {
	assert.equal(themeModeOf('latte'), 'sun')
	assert.equal(themeModeOf('linen'), 'sun')
	assert.equal(themeModeOf('sky'), 'sun')
	assert.equal(themeModeOf('mocha'), 'moon')
	assert.equal(themeModeOf('tokyo'), 'moon')
	assert.equal(themeModeOf('gruvbox'), 'moon')
	assert.equal(themeModeOf('horizon'), 'off')
	assert.equal(themeModeOf('custom'), 'off')
	assert.equal(themeModeOf('omarchy'), 'off')
})

test('choosing a card applies it and remembers it for that column', () => {
	assert.deepEqual(withThemeChoice(base, 'sky'), {...base, theme: 'sky', lightTheme: 'sky'})
	assert.deepEqual(withThemeChoice(base, 'tokyo'), {...base, theme: 'tokyo', darkTheme: 'tokyo'})
	assert.deepEqual(withThemeChoice(base, 'horizon'), {...base, theme: 'horizon', pictureTheme: 'horizon'})
	assert.deepEqual(withThemeChoice(base, 'custom'), {...base, theme: 'custom', pictureTheme: 'custom'})
	assert.deepEqual(withThemeChoice(base, 'omarchy'), base)
})

test('the radio remembers a palette and leaves the screen alone', () => {
	const onSky = {...base, theme: 'sky', lightTheme: 'sky'}
	assert.deepEqual(withThemePreference(onSky, 'linen'), {...onSky, lightTheme: 'linen'})
	assert.deepEqual(withThemePreference(onSky, 'gruvbox'), {...onSky, darkTheme: 'gruvbox'})
	assert.equal(withThemePreference(onSky, 'horizon').theme, 'sky')
})

test('the top-bar icon steps sun, moon, then off', () => {
	assert.equal(nextThemeMode('sun'), 'moon')
	assert.equal(nextThemeMode('moon'), 'off')
	assert.equal(nextThemeMode('off'), 'sun')
})

test('sun, moon, and off apply the remembered palette', () => {
	const prefs = {...base, lightTheme: 'linen', darkTheme: 'gruvbox', pictureTheme: 'custom', theme: 'tokyo'}
	assert.equal(withThemeMode(prefs, 'sun').theme, 'linen')
	assert.equal(withThemeMode(prefs, 'moon').theme, 'gruvbox')
	assert.equal(withThemeMode(prefs, 'off').theme, 'custom')
})
