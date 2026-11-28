import {useEffect, useState} from 'react'

import {Icon} from '../icons'
import {haptic} from '../ui'
import {hasPin, loadPins, PINS_KEY, togglePin, type DashboardPin} from './pins'

const EVENT = 'omarchy-pins'

function readPins() {
	try {
		return loadPins(localStorage.getItem(PINS_KEY))
	} catch {
		return []
	}
}

export function usePins() {
	const [pins, setPins] = useState(readPins)
	useEffect(() => {
		const refresh = () => setPins(readPins())
		window.addEventListener(EVENT, refresh)
		window.addEventListener('storage', refresh)
		return () => {
			window.removeEventListener(EVENT, refresh)
			window.removeEventListener('storage', refresh)
		}
	}, [])
	const toggle = (pin: DashboardPin) => {
		const next = togglePin(pins, pin)
		try {
			localStorage.setItem(PINS_KEY, JSON.stringify(next))
		} catch {
			/* private mode */
		}
		setPins(next)
		window.dispatchEvent(new Event(EVENT))
	}
	return {pins, toggle, has: (pin: DashboardPin) => hasPin(pins, pin)}
}

export function PinButton({pin, name}: {pin: DashboardPin; name: string; mini?: boolean}) {
	const {has, toggle} = usePins()
	const on = has(pin)
	return (
		<button
			type="button"
			className="btn small"
			aria-pressed={on}
			aria-label={on ? `Unpin ${name} from the dashboard` : `Pin ${name} to dashboard`}
			onClick={(e) => {
				e.stopPropagation()
				haptic(6)
				toggle(pin)
			}}
		>
			<Icon name="pin" size={16} />
			{on ? 'Pinned' : 'Pin'}
		</button>
	)
}
