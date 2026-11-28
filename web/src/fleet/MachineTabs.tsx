import {useEffect, useRef, type ReactNode} from 'react'

import {Sheet} from '../ui'

/** Phone uses a sheet. The desktop Machines window embeds the same page beside the list. */
export function MachineShell({bare, label, onClose, children}: {bare?: boolean; label: string; onClose: () => void; children: ReactNode}) {
	if (bare) return <div className="machine-page">{children}</div>
	return (
		<Sheet open onClose={onClose} label={label} tall>
			{children}
		</Sheet>
	)
}

export type MachineTab = {id: string; label: string; body: ReactNode}

/**
 * Lower sections of a machine. Selection is by click or Enter, not by moving focus:
 * opening a section fetches it, so arrowing through the row must not load every one.
 * The panel is not a tab stop. Tab moves from the selected tab to the first control inside.
 */
export function MachineTabs({label, tabs, tab, onTab}: {label: string; tabs: MachineTab[]; tab: string; onTab: (id: string) => void}) {
	const listRef = useRef<HTMLDivElement>(null)
	const selected = tabs.some((item) => item.id === tab) ? tab : tabs[0]?.id
	const current = tabs.find((item) => item.id === selected)
	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
		el?.scrollIntoView({block: 'nearest', inline: 'nearest', container: 'nearest'} as ScrollIntoViewOptions)
	}, [selected])
	if (!current) return null
	const move = (key: string) => {
		const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
		if (index < 0) return
		const next = key === 'ArrowRight' ? (index + 1) % buttons.length : key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length : key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : -1
		if (next < 0) return
		buttons[next]?.focus()
	}
	return (
		<div className="machine-tabs">
			<div
				ref={listRef}
				className="machine-tabs-list"
				role="tablist"
				aria-label={label}
				onKeyDown={(e) => {
					if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
					e.preventDefault()
					move(e.key)
				}}
			>
				{tabs.map((item) => {
					const on = item.id === selected
					return (
						<button key={item.id} type="button" role="tab" id={`mtab-${item.id}`} aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => onTab(item.id)}>
							{item.label}
						</button>
					)
				})}
			</div>
			<div role="tabpanel" aria-labelledby={`mtab-${current.id}`} tabIndex={-1} className="machine-tab-panel">
				<div className="machine-tab-body">{current.body}</div>
			</div>
		</div>
	)
}
