import type {Machine} from '../api'

export function hostedVms<T extends Pick<Machine, 'id' | 'hostId'>>(list: readonly T[], hostId: string) {
	return list.filter((m) => (m.hostId || 'server') === hostId)
}
