import {useEffect, useId, useMemo, useRef, useState, type ReactNode} from 'react'

import {
	focusedLauncherIndex,
	launcherRowMatches,
	scrollSelectedRow,
	shouldLauncherCaptureEnter,
	shouldYieldLauncherKey,
	stepLauncherSelection,
} from './launcherScroll'

export type LaunchItem = {key: string; label: string; icon: (size: number) => ReactNode}

export function Launcher({
	onClose,
	onOpen,
	onMenu,
	items,
}: {
	onClose: () => void
	onOpen: (key: string) => void
	onMenu?: (key: string, x: number, y: number, opener?: HTMLElement | null) => void
	items: LaunchItem[]
}) {
	const [q, setQ] = useState('')
	const [sel, setSel] = useState(0)
	const listId = useId()
	const input = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLUListElement>(null)
	const ignoreHover = useRef(false)
	const lastPtr = useRef<{x: number; y: number} | null>(null)
	const rows = useMemo(() => items.filter((r) => launcherRowMatches(r.label, q)), [items, q])
	const pick = (key: string) => {
		onOpen(key)
		onClose()
	}
	useEffect(() => {
		input.current?.focus()
	}, [])
	useEffect(() => {
		scrollSelectedRow(list.current, sel, rows.length)
	}, [sel, rows.length])
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// An input-method composition (candidate list, confirm, cancel) owns its keys.
			if (e.isComposing) return
			if (shouldYieldLauncherKey(document, e.target)) return
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
			}
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault()
				ignoreHover.current = true
				const focusedIdx = focusedLauncherIndex(list.current, document.activeElement)
				const base = focusedIdx >= 0 ? focusedIdx : sel
				const next = stepLauncherSelection(base, e.key, rows.length)
				setSel(next)
				if (focusedIdx >= 0) {
					list.current?.children[next]?.querySelector<HTMLElement>('button')?.focus()
				}
			}
			if (e.key === 'Enter' && rows[sel] && shouldLauncherCaptureEnter(input.current, document.activeElement, e.target)) {
				e.preventDefault()
				pick(rows[sel].key)
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	})
	return (
		<div className="hypr-overlay" onClick={onClose}>
			<div className="hypr-launcher" role="dialog" aria-label="Launcher" onClick={(e) => e.stopPropagation()}>
				<input
					ref={input}
					value={q}
					onChange={(e) => (setQ(e.target.value), setSel(0))}
					placeholder="Open…"
					aria-label="Filter"
					role="combobox"
					aria-expanded="true"
					aria-autocomplete="list"
					aria-controls={listId}
					aria-activedescendant={rows[sel] ? `${listId}-${sel}` : undefined}
				/>
				<ul ref={list} id={listId} role="listbox" aria-label="Open">
					{rows.map((r, i) => (
						<li key={r.key} role="presentation">
							<button
								id={`${listId}-${i}`}
								role="option"
								aria-selected={i === sel}
								className={i === sel ? 'on' : ''}
								onClick={() => pick(r.key)}
								onMouseEnter={() => {
									if (!ignoreHover.current) setSel(i)
								}}
								onMouseMove={(e) => {
									const prev = lastPtr.current
									if (prev && prev.x === e.clientX && prev.y === e.clientY) return
									lastPtr.current = {x: e.clientX, y: e.clientY}
									ignoreHover.current = false
									setSel(i)
								}}
								onFocus={() => setSel(i)}
								onContextMenu={(e) => {
									if (!onMenu) return
									e.preventDefault()
									e.stopPropagation()
									onMenu(r.key, e.clientX, e.clientY, e.currentTarget)
								}}
							>
								<span className="hypr-launch-ico">{r.icon(22)}</span>
								{r.label}
							</button>
						</li>
					))}
					{!rows.length && (
						<li className="muted" role="presentation">
							Nothing matches
						</li>
					)}
				</ul>
			</div>
		</div>
	)
}
