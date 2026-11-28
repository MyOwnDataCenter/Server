import {haptic} from './ui'

export function MachineStepper({label, value, unit, min, max, step = 1, next, onChange}: {label: string; value: number; unit: string; min: number; max: number; step?: number; next?: (value: number, direction: -1 | 1) => number; onChange: (v: number) => void}) {
	const set = (v: number) => {
		haptic(4)
		onChange(Math.min(max, Math.max(min, v)))
	}
	const go = (direction: -1 | 1) => set(next ? next(value, direction) : value + direction * step)
	return (
		<div className="stepper row static">
			<span className="k">{label}</span>
			<button className="step-btn" aria-label={`Less ${label}`} onClick={() => go(-1)} disabled={value <= min}>
				−
			</button>
			<span className="step-val num" role="status">
				<span className="sr-only">{label} </span>
				{value} <small>{unit}</small>
			</span>
			<button className="step-btn" aria-label={`More ${label}`} onClick={() => go(1)} disabled={value >= max}>
				+
			</button>
		</div>
	)
}
