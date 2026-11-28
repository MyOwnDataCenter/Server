// A time-series chart for the System dashboard: gridlines, area or line series, and a crosshair
// that shows the exact values under the pointer (or the keyboard: focus the chart, then ← →).
import {useEffect, useRef, useState, type KeyboardEvent} from 'react'

export type Series = {label: string; color: string; values: (number | null)[]; area?: boolean}

type Props = {
	times: number[]
	series: Series[]
	/** Fixed top of the scale (100 for percentages); otherwise the largest value, rounded up. */
	max?: number
	/** 1024 for byte rates, so the scale steps in round KB/s or MB/s. */
	base?: number
	format: (v: number) => string
	height?: number
	label: string
}

const PAD = {top: 8, right: 8, bottom: 20, left: 46}
const GRID_LINES = 4

/** A "nice" top for the scale: 1, 2 or 5 times a power of ten, at or above the largest value. */
export function niceMax(v: number, base = 1): number {
	if (!(v > 0)) return 1
	// For byte rates (base 1024) pick a round number of KB/s, MB/s… rather than of bytes.
	if (base > 1) {
		const unit = base ** Math.max(0, Math.floor(Math.log(v) / Math.log(base)))
		return niceMax(v / unit) * unit
	}
	const p = 10 ** Math.floor(Math.log10(v))
	return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p
}

const clock = (t: number, spanMs: number) =>
	new Date(t).toLocaleString(undefined, spanMs > 36 * 3600_000 ? {weekday: 'short', hour: 'numeric'} : spanMs < 15 * 60_000 ? {hour: 'numeric', minute: '2-digit', second: '2-digit'} : {hour: 'numeric', minute: '2-digit'})

export function TimeChart({times, series, max, base = 1, format, height: fixedHeight, label}: Props) {
	const box = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(600)
	const [hover, setHover] = useState<number | null>(null)
	useEffect(() => {
		const el = box.current
		if (!el) return
		const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.round(e.contentRect.width))))
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	// Taller as the card gets wider, so a wide window shows more detail, within reason.
	const height = fixedHeight ?? Math.round(Math.min(280, Math.max(150, width * 0.3)))
	const n = times.length
	const top = max ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))), base)
	const w = width - PAD.left - PAD.right
	const h = height - PAD.top - PAD.bottom
	const x = (i: number) => PAD.left + (n <= 1 ? w : (i / (n - 1)) * w)
	const y = (v: number) => PAD.top + h - (Math.min(v, top) / top) * h
	const span = n > 1 ? times[n - 1] - times[0] : 0

	const path = (values: (number | null)[]) => {
		let d = ''
		let open = false
		values.forEach((v, i) => {
			if (v == null) {
				open = false
				return
			}
			d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
			open = true
		})
		return d
	}
	const areaPath = (values: (number | null)[]) => {
		const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)] as const)).filter(Boolean) as (readonly [number, number])[]
		if (pts.length < 2) return ''
		const base = PAD.top + h
		return `M${pts[0][0]},${base}` + pts.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('') + `L${pts[pts.length - 1][0]},${base}Z`
	}

	const pick = (clientX: number) => {
		const r = box.current?.getBoundingClientRect()
		if (!r || n === 0) return
		const rel = (clientX - r.left - PAD.left) / w
		setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))))
	}
	const onKey = (e: KeyboardEvent) => {
		if (!n) return
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault()
			setHover((cur) => Math.max(0, Math.min(n - 1, (cur ?? n - 1) + (e.key === 'ArrowLeft' ? -1 : 1))))
		} else if (e.key === 'Escape') setHover(null)
	}

	const at = hover ?? null
	const tipLeft = at == null ? 0 : Math.min(Math.max(x(at) - 70, 0), width - 150)

	return (
		<div className="tchart" ref={box} tabIndex={0} role="img" aria-label={`${label}. ${series.map((s) => `${s.label} now ${s.values.length && s.values[s.values.length - 1] != null ? format(s.values[s.values.length - 1] as number) : 'no data'}`).join(', ')}`} onPointerMove={(e) => pick(e.clientX)} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
			{n < 2 ? (
				<div className="tchart-empty" style={{height}}>
					Collecting the first samples… graphs fill in over the next minute.
				</div>
			) : (
				<svg width={width} height={height} aria-hidden="true">
					{Array.from({length: GRID_LINES + 1}, (_, i) => {
						const v = (top / GRID_LINES) * i
						return (
							<g key={i}>
								<line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} className="tchart-grid" />
								<text x={PAD.left - 6} y={y(v) + 4} className="tchart-axis" textAnchor="end">
									{format(v)}
								</text>
							</g>
						)
					})}
					{[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
						<text key={i} x={x(i)} y={height - 4} className="tchart-axis" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
							{clock(times[i], span)}
						</text>
					))}
					{series.map((s) => s.area && <path key={`a-${s.label}`} d={areaPath(s.values)} fill={s.color} opacity={0.16} />)}
					{series.map((s) => (
						<path key={s.label} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={1.75} strokeLinejoin="round" />
					))}
					{at != null && (
						<g>
							<line x1={x(at)} x2={x(at)} y1={PAD.top} y2={PAD.top + h} className="tchart-cross" />
							{series.map((s) => s.values[at] != null && <circle key={s.label} cx={x(at)} cy={y(s.values[at] as number)} r={3.5} fill={s.color} stroke="var(--bg-solid)" strokeWidth={1.5} />)}
						</g>
					)}
				</svg>
			)}
			{at != null && n >= 2 && (
				<div className="tchart-tip" style={{left: tipLeft}} role="status">
					<b>{new Date(times[at]).toLocaleString(undefined, {weekday: 'short', hour: 'numeric', minute: '2-digit', second: span < 2 * 3600_000 ? '2-digit' : undefined})}</b>
					{series.map((s) => (
						<span key={s.label}>
							<i style={{background: s.color}} />
							{s.label} <em>{s.values[at] == null ? '–' : format(s.values[at] as number)}</em>
						</span>
					))}
				</div>
			)}
			<div className="tchart-legend">
				{series.map((s) => (
					<span key={s.label}>
						<i style={{background: s.color}} />
						{s.label}
					</span>
				))}
			</div>
		</div>
	)
}
