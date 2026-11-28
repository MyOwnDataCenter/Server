import {Icon} from './icons'
import {applyPrefsUpdate, prefsChoosingYourPhoto} from './photoPrefs'
import {RADIO_SELECTOR, rovingKeyDown, rovingTabIndex} from './roving'
import {themeModeOf, withThemeChoice, withThemeMode, withThemePreference, DARK_THEME_IDS, LIGHT_THEME_IDS, PICTURE_THEME_IDS, type ThemeMode} from './theme/themeMode'
import {haptic, Segmented, THEMES, customBackgroundUrl, omarchyBackgroundUrl, useOmarchyThemes, type Prefs, type ThemeId} from './ui'

const byId = Object.fromEntries(THEMES.map((t) => [t.id, t])) as Record<ThemeId, (typeof THEMES)[number]>

export function ThemeChooser({
	prefs,
	setPrefs,
	wallpaperBrand,
	photo,
	uploading,
	onPickPhoto,
	onTheme,
	modeSwitch = false,
}: {
	prefs: Prefs
	setPrefs: (p: Prefs) => void
	wallpaperBrand?: string
	photo?: string | null
	uploading?: boolean
	onPickPhoto?: () => void
	onTheme?: (id: ThemeId) => void
	/** First-run setup only. The top bar owns this switch everywhere else. */
	modeSwitch?: boolean
}) {
	const desktop = useOmarchyThemes().data
	const wp = omarchyBackgroundUrl(prefs.omarchyBackground, desktop?.current)
	const picture = photo ?? customBackgroundUrl(prefs.backgroundVersion)
	const brand = wallpaperBrand ?? 'hsl(24 90% 50%)'
	const photoBrand = prefs.customBrandHsl ? `hsl(${prefs.customBrandHsl})` : brand
	const mode = themeModeOf(prefs.theme)

	const apply = (id: ThemeId) => {
		haptic(6)
		if (id === 'custom' && onPickPhoto && !picture) {
			onPickPhoto()
			return
		}
		applyPrefsUpdate(setPrefs, (latest) => {
			const base = id === 'custom' ? prefsChoosingYourPhoto(latest) : latest
			const next = withThemeChoice(base, id)
			return id === 'omarchy' ? {...next, solidColor: null} : next
		})
		onTheme?.(id)
	}
	const prefer = (id: ThemeId) => {
		haptic(6)
		applyPrefsUpdate(setPrefs, (latest) => withThemePreference(latest, id))
	}
	const setMode = (next: ThemeMode) => {
		const theme = next === 'sun' ? prefs.lightTheme : next === 'moon' ? prefs.darkTheme : prefs.pictureTheme
		applyPrefsUpdate(setPrefs, (latest) => withThemeMode(latest, next))
		onTheme?.(theme)
	}

	return (
		<div className="theme-chooser">
			{modeSwitch && (
				<Segmented
					label="Light, dark, or off"
					value={mode}
					onChange={setMode}
					options={[
						{id: 'sun', label: 'Sun'},
						{id: 'moon', label: 'Moon'},
						{id: 'off', label: 'Off'},
					]}
				/>
			)}
			<p className="footer-note theme-mode-note">Sun and Moon use the palette marked in each column. Off uses the last of Horizon, Your photo, and Omarchy.</p>
			<div className="theme-board">
				<div className="theme-picture">
					{PICTURE_THEME_IDS.map((id) => (
						<ThemeCard
							key={id}
							id={id}
							on={prefs.theme === id}
							onApply={() => apply(id)}
							background={pictureBackground(id, {wp, picture, brand, photoBrand, uploading, omarchyBg: desktop?.colors?.background, omarchyFg: desktop?.colors?.foreground})}
						/>
					))}
				</div>
				<div className="theme-rule" aria-hidden="true" />
				<div className="theme-columns">
					<div className="theme-col" role="radiogroup" aria-label="Dark palette" onKeyDown={(e) => rovingKeyDown(e, RADIO_SELECTOR)}>
						{DARK_THEME_IDS.map((id, i) => (
							<ThemeCard key={id} id={id} on={prefs.theme === id} preferred={prefs.darkTheme === id} tabIndex={rovingTabIndex(prefs.darkTheme === id, i, DARK_THEME_IDS.some((x) => x === prefs.darkTheme))} onApply={() => apply(id)} onPrefer={() => prefer(id)} preferLabel={`Use ${byId[id].name} for Moon`} />
						))}
					</div>
					<div className="theme-rule-v" aria-hidden="true" />
					<div className="theme-col" role="radiogroup" aria-label="Light palette" onKeyDown={(e) => rovingKeyDown(e, RADIO_SELECTOR)}>
						{LIGHT_THEME_IDS.map((id, i) => (
							<ThemeCard key={id} id={id} on={prefs.theme === id} preferred={prefs.lightTheme === id} tabIndex={rovingTabIndex(prefs.lightTheme === id, i, LIGHT_THEME_IDS.some((x) => x === prefs.lightTheme))} onApply={() => apply(id)} onPrefer={() => prefer(id)} preferLabel={`Use ${byId[id].name} for Sun`} />
						))}
					</div>
				</div>
			</div>
		</div>
	)
}

function pictureBackground(
	id: ThemeId,
	src: {wp: string; picture?: string | null; brand: string; photoBrand: string; uploading?: boolean; omarchyBg?: string | null; omarchyFg?: string | null},
): {background: string; color: string; dots: readonly string[]; uploading?: boolean} {
	const theme = byId[id]
	if (id === 'horizon') {
		return {background: `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${src.wp}) center/cover`, color: theme.fg, dots: [src.brand, '#ffffff']}
	}
	if (id === 'custom') {
		return src.picture
			? {background: `linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45)), url(${src.picture}) center/cover`, color: theme.fg, dots: [src.photoBrand, '#ffffff']}
			: {background: 'linear-gradient(140deg, #2a2a33, #15151a)', color: theme.fg, dots: [], uploading: src.uploading}
	}
	return {background: src.omarchyBg || theme.bg, color: src.omarchyFg || theme.fg, dots: theme.dots}
}

function ThemeCard({
	id,
	on,
	preferred,
	tabIndex,
	onApply,
	onPrefer,
	preferLabel,
	background,
}: {
	id: ThemeId
	on: boolean
	preferred?: boolean
	tabIndex?: 0 | -1
	onApply: () => void
	onPrefer?: () => void
	preferLabel?: string
	background?: {background: string; color: string; dots: readonly string[]; uploading?: boolean}
}) {
	const theme = byId[id]
	const face = background ?? {background: theme.bg, color: theme.fg, dots: [...theme.dots]}
	return (
		<div className={`theme-card-wrap${onPrefer ? ' has-prefer' : ''}`} style={{color: face.color}}>
			<button type="button" className={`theme-card${on ? ' on' : ''}`} aria-pressed={on} style={{background: face.background, color: face.color}} onClick={onApply}>
				<span className="label">{theme.name}</span>
				<span className="dots">
					{id === 'custom' && !face.dots.length ? (
						<span style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, opacity: 0.85}}>
							{face.uploading ? <span className="spinner" style={{width: 14, height: 14}} /> : <Icon name="photo-up" size={16} />}
							{face.uploading ? 'Uploading…' : 'Upload'}
						</span>
					) : (
						face.dots.map((d) => <i key={d} style={{background: d}} />)
					)}
				</span>
				{on && (
					<span className="tick">
						<Icon name="check" size={14} stroke={3} />
					</span>
				)}
			</button>
			{onPrefer && (
				<button type="button" className="theme-prefer" role="radio" aria-checked={preferred} aria-label={preferLabel} tabIndex={tabIndex} onClick={onPrefer}>
					<i />
				</button>
			)}
		</div>
	)
}
