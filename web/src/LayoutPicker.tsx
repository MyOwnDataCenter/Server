// Layout choices as large cards with a small drawing of each, used in the welcome setup,
// Settings › Appearance and the desktop's Appearance window. Layouts change the whole screen,
// so they're shown bigger than themes.
import type {ReactNode} from 'react'

import type {LayoutPref} from './ui'
import {haptic} from './ui'

function ArtDesktop({stayRound = false}: {stayRound?: boolean} = {}) {
	return (
		<span className={`lp-art lp-art-desktop${stayRound ? ' lp-art-round' : ''}`} aria-hidden="true">
			<i className="lp-win" />
			<i className="lp-win lp-win-2" />
			<i className="lp-dock" />
		</span>
	)
}
function ArtPhone() {
	return (
		<span className="lp-art lp-art-phone" aria-hidden="true">
			<i className="lp-phone">
				<i className="lp-tiles" />
				<i className="lp-tabbar" />
			</i>
		</span>
	)
}
function ArtAuto() {
	return (
		<span className="lp-art lp-art-auto" aria-hidden="true">
			<i className="lp-mini-desk" />
			<i className="lp-mini-phone" />
		</span>
	)
}
function ArtHyprland() {
	return (
		<span className="lp-art lp-art-tiles" aria-hidden="true">
			<i className="lp-bar" />
			<i className="lp-tile lp-tile-a" />
			<i className="lp-tile lp-tile-b" />
			<i className="lp-tile lp-tile-c" />
		</span>
	)
}

function Card({on, suits, art, title, body, onClick, readme}: {on: boolean; suits?: boolean; art: ReactNode; title: string; body: string; onClick: () => void; readme?: () => void}) {
	const picture = (
		<>
			{art}
			<span className="lp-text">
				<b>
					{title}
					{suits && <em className="lp-badge">Suits this screen</em>}
				</b>
				<span>{body}</span>
			</span>
		</>
	)
	if (!readme) {
		return (
			<button type="button" role="radio" aria-checked={on} className={`lp-card${on ? ' on' : ''}`} onClick={onClick}>
				{picture}
			</button>
		)
	}
	// The README control sits on the card, beside the choice, so it is not a second press of the radio.
	return (
		<div className={`lp-card has-readme${on ? ' on' : ''}`}>
			<button type="button" role="radio" aria-checked={on} className="lp-card-hit" onClick={onClick}>
				{picture}
			</button>
			<button
				type="button"
				className="btn small lp-readme"
				onClick={() => {
					haptic(6)
					readme()
				}}
			>
				README
			</button>
		</div>
	)
}

/** How this device shows My Own Data Center: Automatic, Desktop, or Phone & tablet. */
export function ScreenLayoutCards({
	value,
	detected,
	onPick,
	label = 'Screen layout',
	compact,
}: {
	value: LayoutPref | null
	detected: boolean
	onPick: (p: LayoutPref) => void
	label?: string
	compact?: boolean
}) {
	const pick = (p: LayoutPref) => {
		haptic(6)
		onPick(p)
	}
	return (
		<div className={`lp-cards${compact ? ' lp-compact' : ''}`} role="radiogroup" aria-label={label}>
			<Card
				on={value === 'desktop'}
				suits={detected}
				art={<ArtDesktop />}
				title="Desktop"
				body={compact ? 'Windows and a dock.' : 'Windows, a dock and Activities, like a computer. Best with a mouse or trackpad.'}
				onClick={() => pick('desktop')}
			/>
			<Card
				on={value === 'phone'}
				suits={!detected}
				art={<ArtPhone />}
				title="Phone & tablet"
				body={compact ? 'Pages made for touch.' : 'Big touch targets and a bar along the bottom. Best for touch.'}
				onClick={() => pick('phone')}
			/>
			<Card
				on={value === 'auto'}
				art={<ArtAuto />}
				title="Automatic"
				body={
					compact
						? `Follows this screen. Now: ${detected ? 'Desktop' : 'Phone'}.`
						: `Desktop on a big screen with a mouse, Phone otherwise. Here: ${detected ? 'Desktop' : 'Phone & tablet'}.`
				}
				onClick={() => pick('auto')}
			/>
		</div>
	)
}

/** Shape is corners and, on the desktop, how windows are arranged. Round floats. Square tiles. */
export function DesktopStyleCards<T extends string>({
	value,
	onPick,
	floating,
	tiling,
	onSquareReadme,
	compact,
}: {
	value: T
	onPick: (v: T) => void
	floating: T
	tiling: T
	onSquareReadme?: () => void
	compact?: boolean
}) {
	const pick = (v: T) => {
		haptic(6)
		onPick(v)
	}
	return (
		<div className={`lp-cards lp-cards-2${compact ? ' lp-compact' : ''}`} role="radiogroup" aria-label="Shape">
			<Card
				on={value === floating}
				art={<ArtDesktop stayRound />}
				title="Round"
				body={compact ? 'Rounded. Windows float.' : 'Rounded corners. Floating windows, a dock, and Activities.'}
				onClick={() => pick(floating)}
			/>
			<Card
				on={value === tiling}
				art={<ArtHyprland />}
				title="Square"
				body={compact ? 'Square. Windows tile.' : 'Square corners. Tiled windows over a dock, and workspaces 1–9.'}
				onClick={() => pick(tiling)}
				readme={onSquareReadme}
			/>
		</div>
	)
}
