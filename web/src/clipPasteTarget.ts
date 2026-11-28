// The clip book's "Paste as text" goes to one place: the terminal or desktop screen the person used
// last. Every open one hears the event, so each asks here whether it is the one.
const used: object[] = []

// This screen was just opened, clicked, or typed in: it is now the one a clip pastes into.
export function markClipTarget(me: object): void {
	const at = used.indexOf(me)
	if (at >= 0) used.splice(at, 1)
	used.push(me)
}

// This screen closed: the one used before it takes over.
export function unmarkClipTarget(me: object): void {
	const at = used.indexOf(me)
	if (at >= 0) used.splice(at, 1)
}

export function isClipTarget(me: object): boolean {
	return used.at(-1) === me
}
