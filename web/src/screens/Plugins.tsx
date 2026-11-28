// Omarchy plugins, inside the App Store: verified plugins from the Omarchy plugin registry
// (plugins.omarchy.org), installed at the exact version the registry checked (omarchyd/omarchy-plugins.mjs).
import {useMutation, useQueries, useQueryClient} from '@tanstack/react-query'
import {useState} from 'react'

import {mutate, query} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useUser} from '../data'
import {isOwner} from '../isOwner'
import {CategoryChips} from '../CategoryChips'
import {Icon} from '../icons'
import {haptic, useConfirm, useToast} from '../ui'

export type Plugin = {
	id: string
	name: string
	description: string
	author: string
	category: string
	tags: string[]
	kind: string
	version: string
	stars: number
	repo: string
	commit: string
	image: string | null
	page: string
	installed: boolean
	job: {state: 'installing' | 'removing' | 'error'; error?: string} | null
}
type Page = {total: number; categories: string[]; available: boolean; plugins: Plugin[]}

export function PluginBrowser({q}: {q: string}) {
	const qc = useQueryClient()
	const toast = useToast()
	const confirm = useConfirm()
	const owner = isOwner(useUser().data)
	const [category, setCategory] = useState('')
	const [sort, setSort] = useState<'stars' | 'new'>('stars')
	const filterKey = `${q}\0${category}\0${sort}`
	const [pageState, setPageState] = useState({filterKey, pages: 1})
	if (pageState.filterKey !== filterKey) setPageState({filterKey, pages: 1})
	const pages = pageState.pages
	const queries = useQueries({
		queries: Array.from({length: pages}, (_, i) => ({
			queryKey: ['omarchy.plugins', q, category, sort, i],
			queryFn: () => query<Page>('omarchy.plugins', {q, category, sort, limit: 30, offset: i * 30}),
			placeholderData: (prev: Page | undefined) => prev,
			// Watch installs and removals as they happen.
			refetchInterval: (qq: {state: {data?: Page}}) => (qq.state.data?.plugins.some((p) => p.job && p.job.state !== 'error') ? 2000 : false),
		})),
	})
	const page = queries[0]
	const plugins = queries.flatMap((qq) => qq.data?.plugins ?? [])
	const act = useMutation({
		mutationFn: (a: {path: string; id: string; done: string}) => mutate(a.path, {id: a.id}).then(() => a.done),
		onSuccess: (done) => (toast(done), qc.invalidateQueries({queryKey: ['omarchy.plugins']})),
		onError: (e) => toast((e as Error).message, true),
	})
	const install = async (p: Plugin) => {
		haptic(6)
		const ok = await confirm({
			title: `Install ${p.name}?`,
			body: `It runs inside your Omarchy desktop with your permissions, like any Omarchy plugin. My Own Data Center installs the exact version the Omarchy plugin registry verified (an automated check of its code, not a full security review), by ${p.author || 'its author'}.`,
			confirm: 'Install',
			icon: 'puzzle',
		})
		if (ok) act.mutate({path: 'omarchy.installPlugin', id: p.id, done: `Installing ${p.name}…`})
	}
	const remove = async (p: Plugin) => {
		if (await confirm({title: `Remove ${p.name}?`, body: 'It’s turned off and removed from your Omarchy desktop.', confirm: 'Remove', danger: true, icon: 'trash'}))
			act.mutate({path: 'omarchy.removePlugin', id: p.id, done: `Removing ${p.name}…`})
	}
	const data = page?.data
	const browserOnline = useBrowserOnline()
	const problem = page ? queryProblem(page, browserOnline) : null
	return (
		<section className="plugins">
			<div className="glass card" style={{borderRadius: 18, margin: '4px 0 14px', display: 'flex', gap: 12, alignItems: 'flex-start'}}>
				<span className="row-ico" style={{'--c': 'var(--accent)'} as React.CSSProperties}>
					<Icon name="puzzle" size={18} />
				</span>
				<span style={{fontSize: 14}}>
					<b style={{display: 'block'}}>Omarchy plugins</b>
					<span className="muted">
						Widgets, panels and tools for your Omarchy desktop, from the{' '}
						<a href="https://plugins.omarchy.org/" target="_blank" rel="noopener noreferrer">
							Omarchy plugin registry
						</a>
						. Only plugins it has verified are shown, and each is installed at the verified version.
					</span>
				</span>
			</div>
			{data && !data.available && (
				<div className="error" role="alert" style={{marginBottom: 12}}>
					<Icon name="alert" size={18} />
					This server’s Omarchy doesn’t support plugins yet. Update Omarchy, then come back.
				</div>
			)}
			<div className="plugin-chipbar">
				<CategoryChips label="Plugin categories">
					{['', ...(data?.categories ?? [])].map((c) => (
						<button key={c || 'all'} type="button" role="tab" aria-selected={category === c} tabIndex={category === c ? 0 : -1} className={`chip${category === c ? ' on' : ''}`} onClick={() => (haptic(5), setCategory(c))}>
							{c || 'All'}
						</button>
					))}
				</CategoryChips>
				<button type="button" className="chip" onClick={() => (haptic(5), setSort((s) => (s === 'stars' ? 'new' : 'stars')))}>
					<Icon name="sort" size={15} /> {sort === 'stars' ? 'Most starred' : 'Newest'}
				</button>
			</div>
			{problem && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{problem}
				</div>
			)}
			{page?.isLoading && Array.from({length: 4}, (_, i) => <div key={i} className="skeleton" style={{height: 96, margin: '10px 0', borderRadius: 18}} />)}
			<div className="plugin-grid">
				{plugins.map((p) => {
					const busy = p.job && p.job.state !== 'error'
					return (
						<article key={p.id} className="plugin-card glass">
							{p.image ? <img src={p.image} alt="" loading="lazy" decoding="async" /> : <div className="plugin-art"><Icon name="puzzle" size={30} /></div>}
							<div className="plugin-body">
								<div className="plugin-title">
									<b>{p.name}</b>
									<span className="plugin-verified" title="Verified by the Omarchy plugin registry for this exact version">
										<Icon name="shield" size={13} /> Verified
									</span>
								</div>
								<small className="muted">
									{p.author ? `by ${p.author}` : ''}
									{p.kind ? ` · ${p.kind}` : ''}
									{p.stars ? ` · ★ ${p.stars}` : ''}
								</small>
								<p>{p.description}</p>
								{p.job?.state === 'error' && <p className="plugin-error" role="alert">{p.job.error}</p>}
								<div className="plugin-actions">
									{busy ? (
										<button className="btn small" disabled aria-label={`${p.job!.state === 'installing' ? 'Installing' : 'Removing'} ${p.name}`}>
											<span className="spinner" /> {p.job!.state === 'installing' ? 'Installing…' : 'Removing…'}
										</button>
									) : p.installed ? (
										<button className="btn small" disabled={!owner || act.isPending} aria-label={`Installed · Remove ${p.name}`} onClick={() => remove(p)}>
											<Icon name="check" size={15} /> Installed · Remove
										</button>
									) : (
										<button className="btn small primary" disabled={!owner || !data?.available || act.isPending} aria-label={`Install ${p.name}`} onClick={() => install(p)} title={owner ? undefined : 'Only the server’s owner can install plugins'}>
											Install
										</button>
									)}
									<a className="btn small ghost" href={p.page} target="_blank" rel="noopener noreferrer" aria-label={`Details for ${p.name}`}>
										Details
									</a>
								</div>
							</div>
						</article>
					)
				})}
			</div>
			{data && plugins.length === 0 && !page?.isLoading && (
				<div className="glass empty">
					<span className="big">
						<Icon name="search" size={30} />
					</span>
					<b>No plugins found</b>
					<span>Try a different search or category.</span>
				</div>
			)}
			{data && data.total > plugins.length && (
				<button className="btn" style={{width: '100%', marginTop: 12}} disabled={queries.some((qq) => qq.isFetching)} onClick={() => setPageState({filterKey, pages: pages + 1})}>
					{queries.some((qq) => qq.isFetching) ? <span className="spinner" /> : null} Show more ({data.total - plugins.length} more)
				</button>
			)}
		</section>
	)
}
