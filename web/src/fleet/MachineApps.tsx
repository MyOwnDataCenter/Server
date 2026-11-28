// Apps installed on one machine, for the compact machine page.
// The header already has the App Store button, so an empty machine explains that instead of repeating it.
import type {UserApp} from '../api'
import {queryProblem, useBrowserOnline} from '../connection'
import {useApps} from '../data'
import {AppIcon, appStatus, haptic} from '../ui'

/** Absent or "server" is this server. A joined computer uses its agent id. */
export function appsOnMachine(apps: UserApp[], computerId: string): UserApp[] {
	return apps.filter((app) => (app.computerId || 'server') === computerId)
}

export function MachineApps({computerId, name, onOpenApp}: {computerId: string; name: string; onOpenApp?: (app: UserApp) => void}) {
	const apps = useApps()
	const browserOnline = useBrowserOnline()
	const problem = queryProblem(apps, browserOnline)
	if (!apps.data) {
		if (problem) return <p className="reason">{problem}</p>
		return <p className="quiet">Loading…</p>
	}
	const list = appsOnMachine(apps.data, computerId)
	if (list.length === 0) {
		return (
			<p className="prose machine-apps-empty">
				Apps are programs that run on this machine. Use the App Store button above to install them on {name}.
			</p>
		)
	}
	return (
		<div className="glance">
			{list.map((app) => {
				const label = app.name ?? app.id
				const key = `${app.computerId || 'server'}:${app.id}`
				const body = (
					<>
						<AppIcon src={app.icon} name={label} size={36} />
						<span style={{flex: 1, minWidth: 0}}>
							<b>{label}</b>
							<small>{appStatus(app.state).label}</small>
						</span>
					</>
				)
				// A remote install does not open through this server’s gateway.
				return onOpenApp && !app.remote ? (
					<button key={key} type="button" className="run-row" onClick={() => (haptic(6), onOpenApp(app))}>
						{body}
					</button>
				) : (
					<div key={key} className="run-row">
						{body}
					</div>
				)
			})}
		</div>
	)
}
