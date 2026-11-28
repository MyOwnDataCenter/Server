// Sun and Moon are named palettes. Off is the picture theme: Horizon, Your photo, or Omarchy.
export const DARK_THEME_IDS = ['mocha', 'tokyo', 'gruvbox'] as const
export const LIGHT_THEME_IDS = ['latte', 'linen', 'sky'] as const
export const PICTURE_THEME_IDS = ['horizon', 'custom', 'omarchy'] as const

export type DarkThemeId = (typeof DARK_THEME_IDS)[number]
export type LightThemeId = (typeof LIGHT_THEME_IDS)[number]
export type PictureThemeId = (typeof PICTURE_THEME_IDS)[number]
export type ThemeMode = 'sun' | 'moon' | 'off'

const darkIds: readonly string[] = DARK_THEME_IDS
const lightIds: readonly string[] = LIGHT_THEME_IDS
const pictureIds: readonly string[] = PICTURE_THEME_IDS

export const isDarkTheme = (id: string): id is DarkThemeId => darkIds.includes(id)
export const isLightTheme = (id: string): id is LightThemeId => lightIds.includes(id)
export const isPictureTheme = (id: string): id is PictureThemeId => pictureIds.includes(id)

export function themeModeOf(theme: string): ThemeMode {
	if (isLightTheme(theme)) return 'sun'
	if (isDarkTheme(theme)) return 'moon'
	return 'off'
}

export function cleanThemeSlots(
	theme: string,
	raw: {darkTheme?: string | null; lightTheme?: string | null; pictureTheme?: string | null} | null | undefined,
): {darkTheme: DarkThemeId; lightTheme: LightThemeId; pictureTheme: PictureThemeId} {
	const saved = raw ?? {}
	const darkTheme: DarkThemeId = isDarkTheme(saved.darkTheme ?? '') ? (saved.darkTheme as DarkThemeId) : isDarkTheme(theme) ? theme : 'mocha'
	const lightTheme: LightThemeId = isLightTheme(saved.lightTheme ?? '') ? (saved.lightTheme as LightThemeId) : isLightTheme(theme) ? theme : 'latte'
	const pictureTheme: PictureThemeId = isPictureTheme(saved.pictureTheme ?? '') ? (saved.pictureTheme as PictureThemeId) : isPictureTheme(theme) ? theme : 'omarchy'
	return {darkTheme, lightTheme, pictureTheme}
}

export type ThemeSlots = {
	theme: string
	darkTheme: DarkThemeId
	lightTheme: LightThemeId
	pictureTheme: PictureThemeId
}

export function withThemeChoice<T extends ThemeSlots>(prefs: T, id: string): T {
	if (isLightTheme(id)) return {...prefs, theme: id, lightTheme: id}
	if (isDarkTheme(id)) return {...prefs, theme: id, darkTheme: id}
	if (isPictureTheme(id)) return {...prefs, theme: id, pictureTheme: id}
	return prefs
}

export function withThemePreference<T extends ThemeSlots>(prefs: T, id: string): T {
	if (isLightTheme(id)) return {...prefs, lightTheme: id}
	if (isDarkTheme(id)) return {...prefs, darkTheme: id}
	return prefs
}

export function withThemeMode<T extends ThemeSlots>(prefs: T, mode: ThemeMode): T {
	if (mode === 'sun') return {...prefs, theme: prefs.lightTheme}
	if (mode === 'moon') return {...prefs, theme: prefs.darkTheme}
	return {...prefs, theme: prefs.pictureTheme}
}

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {sun: 'moon', moon: 'off', off: 'sun'}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
	return NEXT_MODE[mode]
}
