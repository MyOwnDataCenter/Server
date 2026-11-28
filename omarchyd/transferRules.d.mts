export const TRANSIENT_TRIES: number
export const TOAST_LIFE_MS: number
export const FOLDER_TO_COMPUTER: string
export const FOLDER_FROM_COMPUTER: string
export const MISSING_FILE: RegExp

export type FailReason = 'transient' | 'gone' | 'changed' | 'refused'
export type TransferItemState = 'waiting' | 'sending' | 'done' | 'failed'
export type TransferItem = {
	clipId: string
	name: string
	state: TransferItemState
	reason: FailReason | null
	tries: number
	error: string | null
}

export function transferProgress(items: readonly TransferItem[]): {done: number; total: number; current: string | null}
export function afterFailure(item: TransferItem, reason: FailReason, error: string, max?: number): {item: TransferItem; pause: boolean}
export function resumeIds(items: readonly TransferItem[]): string[]
export function canResume(state: string, items: readonly TransferItem[]): boolean
export function jobToast(kind: 'started' | 'finished' | 'problem', name: string): {text: string; level: 'note' | 'problem'; untilDismiss: boolean; href: string}
