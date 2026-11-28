import type {ReactNode} from 'react'

import type {ThermalSensor} from '../api'
import {useBattery, useCpu, useDisk, useGpus, useMemory, useTemp, useUptime} from '../data'
import {BatteryRing} from './BatteryRing'
import type {FleetRings, GaugeKind} from './aggregate'
import {Icon, type IconName} from '../icons'
import {swarmGaugeItems, type SwarmMetrics} from '../swarm/gauges'
import {Ring, levelColor} from '../ui'
import {LiveStats} from './StatRegion'
import {gaugeButtonLabel} from './gaugeLabel'

export type GaugeModel = {
	k: string
	key?: string
	icon: IconName
	p: number
	sub: string
	ready: boolean
	color?: string
	battery?: FleetRings['battery']
	/** A reading that is not a percent. The ring stays empty and this text sits in the center. */
	reading?: {text: string}
}

/** High use is a warning at 75% and danger at 90%. A low battery flips that: 25% and 15%. */
function gaugeLevel(name: string, p: number, ready: boolean): 'ok' | 'warning' | 'danger' {
	if (!ready) return 'ok'
	if (name === 'Battery') return p <= 15 ? 'danger' : p <= 25 ? 'warning' : 'ok'
	return p >= 90 ? 'danger' : p >= 75 ? 'warning' : 'ok'
}

function gaugeKind(name: string): GaugeKind {
	if (name === 'Memory' || name === 'Storage' || name === 'Battery') return name
	if (name.startsWith('GPU')) return 'GPU'
	return 'CPU'
}

export function useServerGaugeMetrics(): {metrics: SwarmMetrics; temp: number | null; sensors: ThermalSensor[] | null; uptime: number | undefined} {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const gpus = useGpus()
	const battery = useBattery()
	const temp = useTemp()
	const uptime = useUptime()
	return {
		metrics: {
			cpu: cpu.data ? cpu.data.totalUsed : null,
			cores: cpu.data?.threads,
			mem: mem.data ? {total: mem.data.size, used: mem.data.totalUsed} : null,
			swap: mem.data?.swap && mem.data.swap.total > 0 ? mem.data.swap : null,
			disks: disk.data ? [{mount: '/', total: disk.data.totalUsed + disk.data.available, used: disk.data.totalUsed}] : [],
			gpus: (gpus.data?.gpus ?? []).map((g) => ({id: g.id, index: g.index, name: g.name, used: g.used, temp: g.temperature})),
			batteries: battery.data?.batteries ?? [],
		},
		temp: temp.data?.temperature ?? null,
		sensors: temp.data?.sensors ?? null,
		uptime: uptime.data,
	}
}

/** This server's readings on its card. The account's stat view decides the drawing. */
export function ServerSpecs() {
	const {metrics, temp, sensors} = useServerGaugeMetrics()
	return <LiveStats metrics={metrics} temp={temp} sensors={sensors} />
}

function gaugeFace(g: GaugeModel): ReactNode {
	if (g.battery) return <BatteryRing groups={g.battery.groups} lowest={g.battery.lowest} color={g.color} />
	if (g.reading) {
		return (
			<Ring value={0} empty color="var(--muted)" label={`${g.k}, ${g.reading.text}`}>
				<span className="plain">{g.reading.text}</span>
			</Ring>
		)
	}
	return (
		<Ring value={g.p} color={g.color ?? levelColor(g.p)} label={`${g.k} ${Math.round(g.p)}%`}>
			<span className="pct">
				{g.ready ? Math.round(g.p) : '–'}
				<small>%</small>
			</span>
		</Ring>
	)
}

/**
 * Home's aggregate gauges. Each gauge opens its detail.
 * A machine's own readings use StatRegion instead, so this row is not part of the stat-view cycle.
 */
export function GaugeCluster({
	metrics,
	items,
	interactive = false,
	onOpen,
}: {
	metrics?: SwarmMetrics | null
	items?: readonly GaugeModel[]
	interactive?: boolean
	onOpen?: (gauge: {title: string; kind: GaugeKind; gpuId?: string}) => void
}) {
	const rows: GaugeModel[] = items
		? [...items]
		: swarmGaugeItems(metrics).map((g) => ({
				k: g.k,
				icon: g.icon,
				p: g.p,
				sub: g.sub,
				ready: g.ready,
				key: 'key' in g ? g.key : undefined,
				color: 'color' in g ? g.color : undefined,
			}))
	if (!rows.length) return null
	return (
		<div className="glass gauges" data-n={rows.length} role="group" aria-label="System usage" style={items ? undefined : {marginTop: 16}}>
			{rows.map((g) => {
				const level = gaugeLevel(g.k, g.p, g.ready)
				const face = (
					<>
						{gaugeFace(g)}
						<span className="k">{g.k}</span>
						{interactive && level !== 'ok' ? (
							<span className={`sub gauge-alert${level === 'danger' ? ' danger' : ''}`}>
								<Icon name={level === 'danger' ? 'exclaim' : 'alert'} size={13} />
								Tap for details
							</span>
						) : (
							<span className="sub">{g.sub}</span>
						)}
					</>
				)
				const key = g.key ?? g.k
				if (!interactive) {
					return (
						<div className="gauge" key={key}>
							{face}
						</div>
					)
				}
				return (
					<button
						type="button"
						className="gauge press"
						key={key}
						aria-label={gaugeButtonLabel(g.k, g.reading?.text ?? g.sub, level)}
						onClick={() => onOpen?.({title: g.k, kind: gaugeKind(g.k), gpuId: g.key})}
					>
						{face}
					</button>
				)
			})}
		</div>
	)
}

export function ServerRings({name}: {name?: string} = {}) {
	const {metrics, temp, sensors} = useServerGaugeMetrics()
	return <LiveStats metrics={metrics} temp={temp} sensors={sensors} machineName={name} />
}
