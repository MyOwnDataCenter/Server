// Notes the account has dismissed. One id is one note, on every screen that shows it.
export const TUTORIAL_IDS = ['machines-filters'] as const
export type TutorialId = (typeof TUTORIAL_IDS)[number]
export const MACHINES_FILTER_TIP: TutorialId = 'machines-filters'

export function cleanTutorials(raw: unknown): TutorialId[] {
	if (!Array.isArray(raw)) return []
	const ids = new Set<string>()
	for (const id of raw) if (typeof id === 'string' && (TUTORIAL_IDS as readonly string[]).includes(id)) ids.add(id)
	return TUTORIAL_IDS.filter((id) => ids.has(id))
}

export function dismissTutorial(current: readonly string[] | null | undefined, id: TutorialId): TutorialId[] {
	const kept = cleanTutorials(current)
	if (kept.includes(id)) return kept
	return [...kept, id]
}
