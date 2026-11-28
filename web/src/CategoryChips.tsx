import {useCallback, useLayoutEffect, useRef, useState, type ReactNode} from 'react'

import {chipEdgeFade, chipScrollEnds, chipScrollTarget} from './categoryChips'
import {Icon} from './icons'
import {rovingKeyDown, TAB_SELECTOR} from './roving'
import {haptic} from './ui'

// One line of category chips. An arrow at each end moves the line, and goes
// quiet when that direction has nothing left to show. A chip cut by the edge
// fades out, so the arrow does not sit against a hard slice.
export function CategoryChips({label, children}: {label: string; children: ReactNode}) {
	const scroller = useRef<HTMLDivElement>(null)
	const track = useRef<HTMLDivElement>(null)
	const [ends, setEnds] = useState({back: false, more: false, fadeStart: false, fadeEnd: false})

	const measure = useCallback(() => {
		const el = scroller.current
		const row = track.current
		if (!el || !row) return
		const origin = el.getBoundingClientRect().left
		const chips = [...row.children].flatMap((node) => {
			if (!(node instanceof HTMLElement)) return []
			const rect = node.getBoundingClientRect()
			return [{left: rect.left - origin, right: rect.right - origin}]
		})
		setEnds({
			...chipScrollEnds(el.scrollLeft, el.scrollWidth, el.clientWidth),
			...chipEdgeFade(el.clientWidth, chips),
		})
	}, [])

	useLayoutEffect(() => {
		const el = scroller.current
		const row = track.current
		if (!el || !row) return
		measure()
		const watch = new ResizeObserver(measure)
		watch.observe(el)
		watch.observe(row)
		el.addEventListener('scroll', measure, {passive: true})
		return () => {
			watch.disconnect()
			el.removeEventListener('scroll', measure)
		}
	}, [measure])

	const move = (direction: -1 | 1) => {
		const el = scroller.current
		if (!el) return
		haptic(5)
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		el.scrollTo({
			left: chipScrollTarget(el.scrollLeft, el.scrollWidth, el.clientWidth, direction),
			behavior: reduce ? 'auto' : 'smooth',
		})
	}

	return (
		<div className="category-chips">
			<button type="button" className="category-chips-arrow" aria-label="Previous categories" disabled={!ends.back} onClick={() => move(-1)}>
				<Icon name="back" size={16} />
			</button>
			<div className={`category-chips-scroller${ends.fadeStart ? ' fade-start' : ''}${ends.fadeEnd ? ' fade-end' : ''}`} ref={scroller}>
				<div className="category-chips-track" role="tablist" aria-label={label} ref={track} onKeyDown={(e) => rovingKeyDown(e, TAB_SELECTOR, 'horizontal')}>
					{children}
				</div>
			</div>
			<button type="button" className="category-chips-arrow" aria-label="Next categories" disabled={!ends.more} onClick={() => move(1)}>
				<Icon name="chevron" size={16} />
			</button>
		</div>
	)
}
