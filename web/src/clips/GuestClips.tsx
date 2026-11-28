// The same clip book, on a virtual machine. Send is offered only when its connector can take a file.
import {useUser} from '../data'
import {isOwner} from '../isOwner'
import {guestAgent} from '../swarm/guestLink'
import {useSwarm} from '../swarm/Swarm'
import {ClipBook} from './ClipBook'
import {guestHere} from './view'

export function GuestClips({machine}: {machine: {id: string; name: string}}) {
	const swarm = useSwarm()
	const user = useUser()
	const agent = guestAgent(swarm.data ?? [], machine.id)
	const here = guestHere(
		machine,
		agent
			? {id: agent.id, name: agent.name, online: agent.online, allowed: agent.allowed, on: agent.on}
			: null,
	)
	return <ClipBook here={here} readings={isOwner(user.data) && !!agent?.online} />
}
