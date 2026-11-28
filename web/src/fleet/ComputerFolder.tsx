import {useQuery} from '@tanstack/react-query'

import {query} from '../api'
import {NuEntries, type NuItem} from './NuEntries'
import {Icon} from '../icons'
import {bytes, haptic} from '../ui'

type Entry = {name: string; size: number; mtime: number | null; dir: boolean}

function modifiedLabel(mtime: number | null): string {
	if (!mtime) return ''
	return new Date(mtime).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})
}

// A joined computer's home folder. Listing uses the connector. This is not the server file browser.
export function ComputerFolder({id, rel, grid, onOpen, favoriteOf, onToggleFavorite, onMove, onCopy}: {id: string; rel: string; grid: boolean; onOpen: (rel: string) => void; favoriteOf?: (rel: string) => boolean; onToggleFavorite?: (rel: string) => void; onMove?: (rel: string) => void; onCopy?: (rel: string) => void}) {
	const listing = useQuery({
		queryKey: ['swarm.files.list', id, rel],
		queryFn: () => query<{path: string; entries: Entry[]; truncated?: boolean}>('swarm.files.list', {id, path: rel}),
	})
	const entries = listing.data?.entries ?? []
	if (listing.isLoading) return <div className="skeleton" style={{height: 160, borderRadius: 20}} />
	if (listing.error) {
		return (
			<div className="error" role="alert">
				<Icon name="alert" size={18} />
				{(listing.error as Error).message}
			</div>
		)
	}
	const items: NuItem[] = entries.map((entry) => {
		const next = rel ? `${rel}/${entry.name}` : entry.name
		return {
			key: entry.name,
			name: entry.name,
			size: entry.dir ? '—' : bytes(entry.size),
			modified: modifiedLabel(entry.mtime),
			icon: entry.dir ? 'folder' : 'logfile',
			onOpen: entry.dir ? () => (haptic(5), onOpen(next)) : undefined,
			favorite: favoriteOf?.(next) ?? false,
			onFavorite: onToggleFavorite ? () => onToggleFavorite(next) : undefined,
			actions: [
				...(onMove ? [{id: 'move', label: 'Move', onClick: () => onMove(next)}] : []),
				...(onCopy ? [{id: 'copy', label: 'Copy', onClick: () => onCopy(next)}] : []),
			],
		}
	})
	return (
		<>
			{items.length === 0 ? (
				<div className="glass empty">
					<b>Empty folder</b>
				</div>
			) : (
				<NuEntries items={items} grid={grid} />
			)}
			{listing.data?.truncated && <p className="reason">This list is the first part of the folder.</p>}
			<div className="nu-status">
				{entries.length} item{entries.length === 1 ? '' : 's'}
			</div>
		</>
	)
}
