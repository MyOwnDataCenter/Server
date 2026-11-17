import {createContext, useContext, useEffect, useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {
	mutate,
	query,
	type Bootstrap,
	type CpuUsage,
	type DiskUsage,
	type Temperature,
	type InstallReview,
	type Machine,
	type MemoryUsage,
	type Registry,
	type User,
	type UserApp,
} from './api'
import {isAppBusy, useToast} from './ui'

export const BootstrapContext = createContext<Bootstrap | null>(null)
export const useBootstrap = () => useContext(BootstrapContext)!

export function usePageVisible() {
	const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
	useEffect(() => {
		const onChange = () => setVisible(document.visibilityState === 'visible')
		document.addEventListener('visibilitychange', onChange)
		return () => document.removeEventListener('visibilitychange', onChange)
	}, [])
	return visible
}

export const visibleInterval = (ms: number | false, visible: boolean) => (visible ? ms : false)

export function useApps() {
	const visible = usePageVisible()
	return useQuery({
		queryKey: ['apps.list'],
		queryFn: () => query<UserApp[]>('apps.list'),
		// Poll fast while anything is installing/starting/stopping so progress feels live.
		refetchInterval: visible ? (q) => ((q.state.data ?? []).some((a) => isAppBusy(a.state)) ? 1500 : 6000) : false,
	})
}
export const useUpdates = () => {
	const visible = usePageVisible()
	return useQuery({queryKey: ['apps.updates'], queryFn: () => query<{id: string; version: string}[]>('apps.updates'), refetchInterval: visibleInterval(5 * 60_000, visible)})
}
export const useUser = () => useQuery({queryKey: ['user.get'], queryFn: () => query<User>('user.get'), staleTime: 5 * 60_000})
export const useRecent = () =>
	useQuery({queryKey: ['apps.recentlyOpened'], queryFn: () => query<string[]>('apps.recentlyOpened'), staleTime: 30_000, retry: false})

function useLive<T>(key: string, ms = 3000) {
	const visible = usePageVisible()
	return useQuery({queryKey: [key], queryFn: () => query<T>(key), refetchInterval: visibleInterval(ms, visible)})
}
export const useCpu = () => useLive<CpuUsage>('system.cpuUsage')
export const useMemory = () => useLive<MemoryUsage>('system.memoryUsage')
export const useDisk = () => useLive<DiskUsage>('system.diskUsage', 30_000)
export const useTemp = () => useLive<Temperature>('system.cpuTemperature', 10_000)
export const useUptime = () => useLive<number>('system.uptime', 60_000)
export const useNotifications = () => {
	const visible = usePageVisible()
	return useQuery({queryKey: ['notifications.get'], queryFn: () => query<string[]>('notifications.get'), refetchInterval: visibleInterval(30_000, visible), staleTime: 15_000})
}
export const useMachines = () => {
	const visible = usePageVisible()
	return useQuery({
		queryKey: ['machines.list'],
		queryFn: () => query<Machine[]>('machines.list'),
		refetchInterval: visible ? (q) => ((q.state.data ?? []).some((m) => !['running', 'stopped', 'error', 'suspended', 'hibernated'].includes(m.state)) ? 2000 : 8000) : false,
	})
}
export const useRegistry = (enabled = true) =>
	useQuery({queryKey: ['appStore.registry'], queryFn: () => query<Registry>('appStore.registry'), staleTime: 10 * 60_000, enabled})
export const useInstallReview = (appId: string | null) =>
	useQuery({
		queryKey: ['apps.installReview', appId],
		queryFn: () => query<InstallReview>('apps.installReview', {appId}),
		enabled: !!appId,
		retry: false,
		// Waiting for a one-time setup you run in a terminal: notice as soon as it's done.
		refetchInterval: (q) => (q.state.data?.setup?.length ? 3000 : false),
	})

// Run an omarchyd mutation with optimistic state, a toast, and a refresh.
export function useAction() {
	const qc = useQueryClient()
	const toast = useToast()
	return useMutation({
		mutationFn: async (a: {path: string; input?: unknown; optimistic?: {appId: string; state: UserApp['state']}; adding?: Pick<UserApp, 'id' | 'name' | 'icon'>[]; done?: string}) =>
			mutate(a.path, a.input),
		onMutate: (a) => {
			if (a.optimistic) {
				qc.setQueryData<UserApp[]>(['apps.list'], (apps) =>
					apps?.map((app) => (app.id === a.optimistic!.appId ? {...app, state: a.optimistic!.state} : app)),
				)
			}
		},
		onSuccess: (_, a) => {
			// A new install shows (installing) right away, everywhere the app list is shown, even
			// before the list is fetched again.
			if (a.adding?.length)
				qc.setQueryData<UserApp[]>(['apps.list'], (apps = []) => [
					...apps,
					...a.adding!.filter((n) => !apps.some((x) => x.id === n.id)).map((n) => ({path: '', ...n, state: 'installing', progress: 0}) as UserApp),
				])
			if (a.done) toast(a.done)
		},
		onError: (error: Error) => toast(error.message, true),
		onSettled: (_, __, a) => {
			const domain = a.path.split('.')[0]
			if (domain === 'apps') {
				qc.invalidateQueries({queryKey: ['apps.list']})
				qc.invalidateQueries({queryKey: ['apps.updates']})
			}
			if (domain === 'machines') qc.invalidateQueries({queryKey: ['machines.list']})
			if (domain === 'notifications') qc.invalidateQueries({queryKey: ['notifications.get']})
		},
	})
}

export {appUrl} from './appUrl'
