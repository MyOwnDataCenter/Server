// The global clip book. A machine section uses ClipBook directly, with that machine already chosen.
import {ClipBook} from '../clips/ClipBook'

export function Clips({onBack}: {onBack?: () => void}) {
	return <ClipBook onBack={onBack} />
}

export {ClipBook} from '../clips/ClipBook'
