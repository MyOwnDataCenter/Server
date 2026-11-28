// Devices tab: bind a host USB serial/Zigbee stick to one machine or one app.
import {useQuery} from '@tanstack/react-query'

import {query, type UsbList} from './api'
import {useAction, useUser} from './data'
import {Icon} from './icons'
import {isOwner} from './isOwner'
import {errorText} from './queryNotice'
import {haptic, useToast} from './ui'
import {showUnplugged} from './usbPresent'

export function DevicesPanel({guest}: {guest: {kind: 'machine' | 'app'; id: string; name: string}}) {
	const action = useAction()
	const toast = useToast()
	const owner = isOwner(useUser().data)
	const list = useQuery({queryKey: ['usb.list'], queryFn: () => query<UsbList>('usb.list'), refetchInterval: 5000})
	const installer = useQuery({queryKey: ['system.installerStatus'], queryFn: () => query<{needed: boolean}>('system.installerStatus'), staleTime: 60_000, retry: false})
	const devices = list.data?.devices ?? []
	const noun = guest.kind === 'machine' ? 'machine' : 'app'
	const done = (r: unknown, fallback: string) => {
		const message = r && typeof r === 'object' && 'message' in r && typeof r.message === 'string' && r.message ? r.message : fallback
		toast(message)
	}
	const attach = (deviceId: string) => {
		haptic(8)
		action.mutate({path: 'usb.attach', input: {deviceId, guest: {kind: guest.kind, id: guest.id}}}, {onSuccess: (r) => done(r, `${guest.name} can use this stick`)})
	}
	const detach = (deviceId: string) => {
		haptic(8)
		action.mutate({path: 'usb.detach', input: {deviceId}}, {onSuccess: (r) => done(r, 'Removed')})
	}
	return (
		<section className="pf">
			<h4 className="list-head">
				<Icon name="usb" size={16} /> Devices
			</h4>
			{installer.data?.needed && <p className="muted pf-note">The server helper needs an update to hand this stick to apps.</p>}
			{list.error && !devices.length && (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					{errorText(list.error)}
				</div>
			)}
			{list.isSuccess && !devices.length && <p className="muted pf-note">Plug a serial adapter or Zigbee stick into this server.</p>}
			{devices.length > 0 && (
				<div className="glass group">
					{devices.map((d) => {
						const here = d.bound?.kind === guest.kind && d.bound.id === guest.id
						return (
							<div key={d.id} className="row static">
								<span className="main">
									<b>{d.name}</b>
									<span className="mono">
										{d.vendorId}:{d.productId}
										{d.path ? ` · ${d.path}` : ''}
									</span>
									{here && showUnplugged(d) && <span className="muted">Unplugged</span>}
									{d.bound && !here && <span className="muted">Used by {d.bound.name}</span>}
									{here && d.needsRestart && <span className="muted">Restart {guest.name} to apply</span>}
								</span>
								{owner && here && (
									<button className="btn small" disabled={action.isPending} onClick={() => detach(d.id)}>
										Remove
									</button>
								)}
								{owner && !d.bound && (
									<button className="btn small" disabled={action.isPending} onClick={() => attach(d.id)}>
										Use with this {noun}
									</button>
								)}
							</div>
						)
					})}
				</div>
			)}
		</section>
	)
}
