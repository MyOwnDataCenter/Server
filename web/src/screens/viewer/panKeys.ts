// Arrow keys pan a zoomed photo (and only then): the picture moves the way the view does, so
// ArrowRight shows more of the right-hand side, which slides the picture left.
export const PAN_STEP = 80

export function panDeltaForKey(key: string, step = PAN_STEP): {x: number; y: number} | null {
	if (key === 'ArrowLeft') return {x: step, y: 0}
	if (key === 'ArrowRight') return {x: -step, y: 0}
	if (key === 'ArrowUp') return {x: 0, y: step}
	if (key === 'ArrowDown') return {x: 0, y: -step}
	return null
}
