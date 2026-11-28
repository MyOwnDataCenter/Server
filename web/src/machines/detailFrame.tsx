// The compact machine page: header, section list, and the open section.
// A virtual machine, this server, and a joined computer share this frame.
import {useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode} from 'react'

import {Icon, type IconName} from '../icons'
import {haptic} from '../ui'

function NameFacts({label, facts}: {label: string; facts: {label: string; value: string}[]}) {
	const tipId = `name-facts-${useId().replace(/:/g, '')}`
	const btnRef = useRef<HTMLButtonElement>(null)
	const tipRef = useRef<HTMLDivElement>(null)
	const hideTimer = useRef(0)
	const [open, setOpen] = useState(false)
	useEffect(() => {
		const btn = btnRef.current
		const tip = tipRef.current
		if (!btn || !tip) return
		if ('interestForElement' in HTMLButtonElement.prototype) btn.setAttribute('interestfor', tipId)
		const probe = document.createElement('div')
		probe.popover = 'hint'
		const hintWorks = probe.popover === 'hint'
		const place = () => {
			if (!tip.matches(':popover-open') || CSS.supports('position-area: block-end')) return
			const r = btn.getBoundingClientRect()
			tip.style.position = 'fixed'
			tip.style.margin = '0'
			tip.style.inset = 'auto'
			const left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8))
			let top = r.bottom + 6
			if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 6)
			tip.style.left = `${left}px`
			tip.style.top = `${top}px`
		}
		const onBefore = (event: Event) => {
			if (hintWorks || (event as ToggleEvent).newState !== 'open') return
			if (tip.getAttribute('popover') === 'hint') tip.popover = 'auto'
		}
		const onToggle = () => {
			setOpen(tip.matches(':popover-open'))
			place()
		}
		tip.addEventListener('beforetoggle', onBefore)
		tip.addEventListener('toggle', onToggle)
		window.addEventListener('resize', place)
		return () => {
			tip.removeEventListener('beforetoggle', onBefore)
			tip.removeEventListener('toggle', onToggle)
			window.removeEventListener('resize', place)
			window.clearTimeout(hideTimer.current)
		}
	}, [tipId, facts.length])
	if (facts.length === 0) return <b>{label}</b>
	const nativeInterest = 'interestForElement' in HTMLButtonElement.prototype
	const show = () => {
		const tip = tipRef.current
		if (!tip || tip.matches(':popover-open')) return
		window.clearTimeout(hideTimer.current)
		tip.showPopover()
	}
	const scheduleHide = () => {
		window.clearTimeout(hideTimer.current)
		hideTimer.current = window.setTimeout(() => {
			const tip = tipRef.current
			if (tip?.matches(':popover-open')) tip.hidePopover()
		}, 150)
	}
	const cancelHide = () => window.clearTimeout(hideTimer.current)
	return (
		<>
			<button
				type="button"
				ref={btnRef}
				className="pve-name"
				{...({popoverTarget: tipId, popoverTargetAction: 'show'} as ButtonHTMLAttributes<HTMLButtonElement>)}
				aria-expanded={open}
				onPointerEnter={nativeInterest ? undefined : show}
				onPointerLeave={nativeInterest ? undefined : scheduleHide}
				onFocus={nativeInterest ? undefined : show}
				onBlur={nativeInterest ? undefined : scheduleHide}
			>
				{label}
			</button>
			<div ref={tipRef} id={tipId} role="tooltip" className="pve-facts" onPointerEnter={cancelHide} onPointerLeave={nativeInterest ? undefined : scheduleHide} {...({popover: 'hint'} as HTMLAttributes<HTMLDivElement>)}>
				<dl>
					{facts.map((fact) => (
						<div key={fact.label}>
							<dt>{fact.label}</dt>
							<dd>{fact.value}</dd>
						</div>
					))}
				</dl>
			</div>
		</>
	)
}

export type DetailSection = {id: string; label: string; icon: IconName}

export function DetailFrame({
	name,
	facts,
	icon,
	iconBg,
	status,
	extra,
	store,
	toolbar,
	onBack,
	backLabel,
	navLabel,
	sections,
	section,
	onSection,
	children,
}: {
	name: string
	facts: {label: string; value: string}[]
	icon: IconName
	iconBg: string
	status?: ReactNode
	extra?: ReactNode
	store?: ReactNode
	toolbar?: ReactNode
	onBack?: () => void
	backLabel?: string
	navLabel: string
	sections: DetailSection[]
	section: string
	onSection: (id: string) => void
	children: ReactNode
}) {
	const listRef = useRef<HTMLElement>(null)
	const current = sections.some((item) => item.id === section) ? section : sections[0]?.id
	const move = (key: string) => {
		const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
		if (index < 0) return
		const next = key === 'ArrowDown' ? (index + 1) % buttons.length : key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : -1
		if (next < 0) return
		buttons[next]?.focus()
	}
	return (
		<div className="pve-vm">
			<div className="pve-head">
				<div className="pve-title">
					{onBack && (
						<button type="button" className="round-btn pve-back" aria-label={backLabel ?? 'Back'} onClick={() => (haptic(6), onBack())}>
							<Icon name="back" size={18} />
						</button>
					)}
					<span className="pve-os" style={{background: iconBg}}>
						<Icon name={icon} size={15} />
					</span>
					<NameFacts label={name} facts={facts} />
					{status}
					{extra}
					<span className="pve-spacer" />
					{store}
				</div>
				{toolbar}
			</div>
			<div className="pve-body">
				<nav
					ref={listRef}
					className="pve-nav"
					aria-label={navLabel}
					onKeyDown={(e) => {
						if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
						e.preventDefault()
						move(e.key)
					}}
				>
					{sections.map((item) => {
						const on = item.id === current
						return (
							<button type="button" key={item.id} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={() => onSection(item.id)}>
								<Icon name={item.icon} size={15} />
								{item.label}
							</button>
						)
					})}
				</nav>
				<div className="pve-panel">{children}</div>
			</div>
		</div>
	)
}
