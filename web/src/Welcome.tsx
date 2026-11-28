// The first time anyone signs in on a device: a short setup. A welcome, the layout (the biggest
// choice, so it comes first), a theme, and a quick look at where things are. Every step can be
// skipped, and everything here can be changed later in Settings › Appearance.
// Shown under the same condition the old layout question used, so a device that already set up
// never sees it again.
import {useRef, useState} from 'react'
import {createPortal} from 'react-dom'

import {openSettingsPage} from './desktop/settingsPage'
import {useUser} from './data'
import {useDialogFocus} from './focus'
import {isOwner} from './isOwner'
import {Icon, type IconName} from './icons'
import {ScreenLayoutCards} from './LayoutPicker'
import {ThemeChooser} from './ThemeChooser'
import {detectDesktop, haptic, setLayoutPref, type LayoutPref, type Prefs} from './ui'

type Step = 'hello' | 'layout' | 'theme' | 'assistant' | 'tour'
const STEPS: Step[] = ['hello', 'layout', 'theme', 'assistant', 'tour']

const TOUR: {icon: IconName; title: string; body: string; owner?: boolean}[] = [
	{icon: 'store', title: 'Apps', body: 'Install apps from the App Store and open them from Home or the dock.'},
	{icon: 'folder', title: 'Files', body: 'Your files and shared folders, with uploads, previews and Trash.'},
	{icon: 'machine', title: 'Machines', body: 'Virtual machines and the other computers in your swarm.', owner: true},
	{icon: 'sparkle', title: 'Assistant', body: 'Ask about your server, or have it do things for you. You choose the providers and their order. Hermes can act on this server when its row is first.'},
	{icon: 'settings', title: 'Settings', body: 'Appearance, storage, backups, your account and signed-in devices.'},
]

export function Welcome({name, owner, prefs, setPrefs, onDone}: {name?: string; owner: boolean; prefs: Prefs; setPrefs: (p: Prefs) => void; onDone: () => void}) {
	const [step, setStep] = useState<Step>('hello')
	// Focus moves into the setup, Tab stays inside it, and focus goes back to where it was when it closes.
	const dialogRef = useRef<HTMLDivElement>(null)
	useDialogFocus(true, dialogRef)
	const [detected] = useState(() => detectDesktop())
	const [layout, setLayout] = useState<LayoutPref | null>(null)
	const index = STEPS.indexOf(step)
	const next = () => {
		haptic(6)
		if (step === 'layout' && layout === null) chooseLayout('auto')
		if (index === STEPS.length - 1) return finish()
		setStep(STEPS[index + 1])
	}
	const back = () => index > 0 && setStep(STEPS[index - 1])
	// The layout is saved as soon as it's picked, so the screen behind changes while you watch.
	const chooseLayout = (p: LayoutPref) => {
		setLayout(p)
		setLayoutPref(p)
	}
	const finish = () => {
		// Skipping still counts as set up: the layout stays Automatic.
		if (layout === null) setLayoutPref('auto')
		onDone()
	}
	// Set up the assistant now: setup ends here and Settings opens at Assistant.
	const assistantNow = () => {
		haptic(6)
		finish()
		openSettingsPage('assistant')
	}
	const first = name?.trim().split(/\s+/)[0]

	return createPortal(
		<div ref={dialogRef} className="layout-chooser welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabIndex={-1}>
			<div className="layout-card glass welcome-card">
				<div className="welcome-top">
					<span className="welcome-dots" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
						{STEPS.map((s, i) => (
							<i key={s} className={i <= index ? 'on' : ''} />
						))}
					</span>
					<button type="button" className="welcome-skip" onClick={finish}>
						Skip setup
					</button>
				</div>

				{step === 'hello' && (
					<>
						<h2 id="welcome-title">Welcome{first ? `, ${first}` : ''}</h2>
						<p>My Own Data Center runs your apps, files, machines and backups from one place. A few quick choices and you’re set. You can change all of it later in Settings › Appearance.</p>
					</>
				)}

				{step === 'layout' && (
					<>
						<h2 id="welcome-title">Pick a layout</h2>
						<p>How My Own Data Center looks on this device. Saved on this device only.</p>
						<ScreenLayoutCards value={layout} detected={detected} onPick={chooseLayout} />
					</>
				)}

				{step === 'theme' && (
					<>
						<h2 id="welcome-title">Choose a theme</h2>
						<p>Colours for My Own Data Center. You can also use your own photo later.</p>
						<ThemeChooser prefs={prefs} setPrefs={setPrefs} modeSwitch />
					</>
				)}

				{step === 'assistant' && (
					<>
						<h2 id="welcome-title">Set up the assistant</h2>
						<p>The assistant answers questions about your server and can do things for you. Add the providers you want, in the order chat should try them.{owner ? ' Hermes is there too, and it answers when its row is first.' : ''} Change that any time in Settings › Assistant.</p>
						<div className="welcome-choices">
							<button type="button" className="welcome-choice" onClick={assistantNow}>
								<span className="welcome-ico">
									<Icon name="sparkle" size={20} />
								</span>
								<span>
									<b>Set up providers</b>
									<span>ChatGPT, Grok, OpenAI, Anthropic, or a model on this server.</span>
								</span>
							</button>
							<button type="button" className="welcome-choice" onClick={next}>
								<span className="welcome-ico">
									<Icon name="clock" size={20} />
								</span>
								<span>
									<b>Later, myself</b>
									<span>Whenever you’re ready, in Settings › Assistant.</span>
								</span>
							</button>
						</div>
					</>
				)}

				{step === 'tour' && (
					<>
						<h2 id="welcome-title">Where things are</h2>
						<ul className="welcome-tour">
							{TOUR.filter((t) => owner || !t.owner).map((t) => (
								<li key={t.title}>
									<span className="welcome-ico">
										<Icon name={t.icon} size={20} />
									</span>
									<span>
										<b>{t.title}</b>
										<span>{t.body}</span>
									</span>
								</li>
							))}
						</ul>
					</>
				)}

				<div className="welcome-actions">
					{index > 0 ? (
						<button type="button" className="btn" onClick={back}>
							Back
						</button>
					) : (
						<span />
					)}
					<button type="button" className="btn primary" data-autofocus onClick={next}>
						{index === 0 ? 'Get started' : index === STEPS.length - 1 ? 'Done' : 'Next'}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	)
}

/** The welcome setup for whoever is signed in (inside the signed-in app, where the account is known). */
export function WelcomeForUser(props: {prefs: Prefs; setPrefs: (p: Prefs) => void; onDone: () => void}) {
	const user = useUser()
	return <Welcome name={user.data?.name} owner={isOwner(user.data)} {...props} />
}
