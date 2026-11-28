import {Icon, type IconName} from '../icons'
import {applyPrefsUpdate} from '../photoPrefs'
import {haptic, type Prefs} from '../ui'
import {nextThemeMode, themeModeOf, withThemeMode, type ThemeMode} from './themeMode'

const ICON: Record<ThemeMode, IconName> = {sun: 'sun', moon: 'moon', off: 'sun-off'}
const NAME: Record<ThemeMode, string> = {sun: 'Sun', moon: 'Moon', off: 'Off'}

export function ThemeModeButton({prefs, setPrefs, className, size}: {prefs: Prefs; setPrefs: (p: Prefs) => void; className: string; size: number}) {
	const mode = themeModeOf(prefs.theme)
	const next = nextThemeMode(mode)
	const label = `${NAME[mode]}. Switch to ${NAME[next]}`
	return (
		<button
			type="button"
			className={className}
			aria-label={label}
			title={label}
			onClick={() => {
				haptic(6)
				applyPrefsUpdate(setPrefs, (latest) => withThemeMode(latest, nextThemeMode(themeModeOf(latest.theme))))
			}}
		>
			<Icon name={ICON[mode]} size={size} />
		</button>
	)
}
