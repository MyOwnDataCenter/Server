/** Phone chrome Settings gear: reset to main when already in Settings; otherwise open Settings. */
export function phoneSettingsGearAction(tab: string): 'reset-main' | 'open-settings' {
	return tab === 'settings' ? 'reset-main' : 'open-settings'
}
