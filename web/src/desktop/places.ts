// The things a person can pin to the dock or place on the desktop. The default dock is a shorter list.
import {SYSTEM_DOCK} from './config.ts'

export function placeableKeys(appList: {id: string; name?: string}[], machineList: {id: string}[], owner: boolean, folders = false): string[] {
	return [
		...(folders ? ['folder:/Home', 'folder:/Trash'] : []),
		...SYSTEM_DOCK.filter((key) => key !== 'terminal' || owner),
		'assistant',
		'personalize',
		'clips',
		...[...appList].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((app) => `app:${app.id}`),
		...(owner ? ['machine:desktop'] : []),
		...machineList.map((machine) => `machine:${machine.id}`),
	]
}
