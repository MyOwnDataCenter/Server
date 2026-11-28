// Up time, or when the machine is offline the last time it was seen.
// It sits under the stats. Disk and temperature stay in the stats.
import {Row, duration} from '../ui'

export function MachineSeen({online, offline = !online, uptime, lastSeen}: {online: boolean; offline?: boolean; uptime?: number | null; lastSeen?: number | null}) {
	if (online) {
		if (uptime == null || !Number.isFinite(uptime)) return null
		return (
			<div className="machine-seen">
				<Row icon="clock" color="#8e8e93" label="Up for" trailing={<b>{duration(uptime)}</b>} />
			</div>
		)
	}
	if (!offline || lastSeen == null || !Number.isFinite(lastSeen) || lastSeen <= 0) return null
	return (
		<div className="machine-seen">
			<Row icon="clock" color="#8e8e93" label="Last seen" trailing={<b>{new Date(lastSeen).toLocaleString()}</b>} />
		</div>
	)
}
