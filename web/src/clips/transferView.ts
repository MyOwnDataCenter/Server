// Rules for a file transfer. The screen and the runner both follow omarchyd/transferRules.mjs.

export type {FailReason, TransferItem, TransferItemState} from '../../../omarchyd/transferRules.mjs'

export {
	TRANSIENT_TRIES,
	TOAST_LIFE_MS,
	FOLDER_TO_COMPUTER,
	FOLDER_FROM_COMPUTER,
	MISSING_FILE,
	transferProgress,
	afterFailure,
	resumeIds,
	canResume,
	jobToast,
} from '../../../omarchyd/transferRules.mjs'
