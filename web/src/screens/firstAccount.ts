// A server with no account yet (a new install that skipped it, or after a factory reset). The first account is made
// in a terminal on the server, not in the web app, so the sign-in page has to say so.
import type {Bootstrap} from '../api'

// The command on a standard install (install.sh puts the app and its data under ~/.local/share/omarchy-server).
export const CREATE_OWNER_COMMAND = 'node ~/.local/share/omarchy-server/app/omarchyd/cli.mjs create-owner --data ~/.local/share/omarchy-server/omarchyd'

export function needsFirstAccount(boot: Pick<Bootstrap, 'server'>): boolean {
	return boot.server?.onboarded === false
}
