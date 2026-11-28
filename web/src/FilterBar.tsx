// The list filter row. Machines, Terminals, and Clip book share it: a name field, then one track of chips.
// A chip can stay pressed while another is pressed. Tapping a chip is the caller's choice.
import {type ReactNode} from 'react'

import {Icon} from './icons'
import {rovingKeyDown} from './roving'
import {haptic} from './ui'

export function FilterBar<T extends string>({
	query,
	onQuery,
	queryLabel,
	placeholder,
	slots,
	onSlot,
	slotsLabel,
	children,
}: {
	query: string
	onQuery: (value: string) => void
	queryLabel: string
	placeholder: string
	slots: readonly {id: T; label: string; pressed: boolean}[]
	onSlot: (id: T) => void
	slotsLabel: string
	children?: ReactNode
}) {
	const tabAt = Math.max(0, slots.findIndex((slot) => slot.pressed))
	return (
		<div className="filter-bar">
			<label className="search glass filter-bar-search">
				<Icon name="search" size={16} />
				<input value={query} placeholder={placeholder} aria-label={queryLabel} onChange={(e) => onQuery(e.target.value)} />
				{query && (
					<button type="button" className="clear" aria-label="Clear search" onClick={() => onQuery('')}>
						<Icon name="close" size={12} />
					</button>
				)}
			</label>
			<div className="filter-bar-slots">
				<div className="segmented glass" role="group" aria-label={slotsLabel} onKeyDown={(e) => rovingKeyDown(e, 'button', 'horizontal')}>
					{slots.map((slot, index) => (
						<button
							key={slot.id}
							type="button"
							aria-pressed={slot.pressed}
							tabIndex={index === tabAt ? 0 : -1}
							onClick={() => {
								haptic(5)
								onSlot(slot.id)
							}}
						>
							{slot.label}
						</button>
					))}
				</div>
				{children}
			</div>
		</div>
	)
}
