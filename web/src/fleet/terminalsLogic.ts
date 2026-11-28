// Who belongs on the Terminals list, and the For-Each pass over that list.
// A grant is enough. Being offline is a separate fact, so the reach filter still applies.

import type {ManagerKind} from './machineManagerLogic.ts'

export function supportsDirectTerminal(input: {kind: ManagerKind; granted: boolean; serverShell: boolean}): boolean {
	if (input.kind === 'server') return input.serverShell
	return input.granted
}

/** The machines in this pass, in the order they had when For-Each started. */
export type ForEachPass = {ids: readonly string[]; done: readonly string[]}

export function startForEach(ids: readonly string[]): ForEachPass {
	return {ids: [...ids], done: []}
}

/** Checking a machine counts it once. A machine that was not in the pass stays out. */
export function completeMachine(pass: ForEachPass, id: string): ForEachPass {
	if (!pass.ids.includes(id) || pass.done.includes(id)) return pass
	return {ids: pass.ids, done: [...pass.done, id]}
}

export function forEachCounts(pass: ForEachPass): {done: number; total: number} {
	const done = new Set(pass.done)
	return {done: pass.ids.filter((id) => done.has(id)).length, total: pass.ids.length}
}

/** An empty pass is not finished. There is nothing to check off. */
export function forEachFinished(pass: ForEachPass): boolean {
	const {done, total} = forEachCounts(pass)
	return total > 0 && done === total
}

/** Snapshot order, skipping machines already checked and machines that have left the fleet. */
export function forEachShown(pass: ForEachPass, present: readonly string[]): string[] {
	const have = new Set(present)
	const done = new Set(pass.done)
	return pass.ids.filter((id) => have.has(id) && !done.has(id))
}
