// The spoken name of a dock button: the app or machine, how many windows it has open, and a machine's state.
// The dots and the green dot on the icon are only visual, so this is the one place a screen reader learns them.
export function dockLabel(label: string, count: number, status?: 'running' | 'stopped' | 'busy', machine = false): string {
	const parts = [label]
	if (count > 0) parts.push(count === 1 ? '1 window open' : `${count} windows open`)
	if (status === 'stopped') parts.push('stopped')
	else if (status === 'busy') parts.push('busy')
	else if (status === 'running' && machine) parts.push('running')
	return parts.join(', ')
}
