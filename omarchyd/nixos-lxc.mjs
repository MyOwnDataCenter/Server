// NixOS config apply/export helpers for Incus system containers.
// Rebuild runs inside the container via `incus exec` (not cloud-init).

export const NIXOS_CONFIG_PATH = '/etc/nixos/configuration.nix'
export const NIXOS_CONFIG_MAX = 512 * 1024

export const NIXOS_EXAMPLE = `{ config, pkgs, ... }:
{
  imports = [ <nixpkgs/nixos/modules/virtualisation/lxc-container.nix> ];

  networking.hostName = "nixos";
  system.stateVersion = "24.11";

  environment.systemPackages = with pkgs; [ vim curl ];
}
`

export function isNixosOs(os = '') {
	return /^nixos$/i.test(String(os).trim())
}

export function validateNixosConfig(text) {
	const config = String(text ?? '')
	if (!config.trim()) return {ok: true, config: ''}
	if (config.length > NIXOS_CONFIG_MAX) return {ok: false, error: 'That configuration is too large (512 KB max).'}
	if (config.includes('\0')) return {ok: false, error: 'The configuration can’t contain null bytes.'}
	if (!/\{\s*config\s*,\s*pkgs\s*,/.test(config) && !/flake\.nix|outputs\s*=/.test(config)) {
		// Soft check: classic configuration.nix usually takes config and pkgs.
		if (!config.includes('system.stateVersion') && !config.includes('environment.systemPackages')) {
			return {ok: false, error: 'That doesn’t look like a NixOS configuration.nix.'}
		}
	}
	return {ok: true, config}
}

/**
 * Write configuration.nix and run nixos-rebuild switch.
 * @param {{name: string, config: string, run: Function, substituter?: string, sleep?: Function}} o
 */
export async function applyNixosConfig({name, config, run, substituter = '', sleep = (ms) => new Promise((r) => setTimeout(r, ms))} = {}) {
	const n = String(name ?? '')
	const checked = validateNixosConfig(config)
	if (!checked.ok) throw new Error(checked.error)
	if (!checked.config.trim()) throw new Error('Paste a NixOS configuration first.')

	await run(['exec', n, '--', 'mkdir', '-p', '/etc/nixos'], {timeout: 30_000})
	await run(['file', 'push', '-', `${n}${NIXOS_CONFIG_PATH}`, '--uid', '0', '--gid', '0', '--mode', '0644'], {
		timeout: 60_000,
		input: checked.config.endsWith('\n') ? checked.config : `${checked.config}\n`,
	})

	const sub = String(substituter ?? '').trim()
	if (sub) {
		if (!/^https?:\/\/[A-Za-z0-9._:~%/?#@[\]!$&'()*+,;=-]+$/.test(sub)) throw new Error('The binary cache address has to be an http(s) URL.')
		const conf = `extra-substituters = ${sub}\nextra-trusted-public-keys = cache.modc.local:0000000000000000000000000000000000000000000=\n`
		await run(['exec', n, '--', 'mkdir', '-p', '/etc/nix'], {timeout: 15_000})
		await run(['file', 'push', '-', `${n}/etc/nix/nix.conf.d/99-modc-cache.conf`, '--uid', '0', '--gid', '0', '--mode', '0644'], {
			timeout: 30_000,
			input: conf,
		}).catch(async () => {
			// Older images may lack conf.d; append a drop-in note into nix.conf instead.
			await run(
				['exec', n, '--', 'bash', '-lc', `grep -q 'extra-substituters = ${sub}' /etc/nix/nix.conf 2>/dev/null || printf '\\nextra-substituters = %s\\n' ${JSON.stringify(sub)} >> /etc/nix/nix.conf`],
				{timeout: 30_000},
			)
		})
	}

	// Give the container a moment after write before rebuild.
	await sleep(500)
	await run(['exec', n, '--', 'nixos-rebuild', 'switch'], {timeout: 45 * 60_000})
	return {ok: true}
}

export async function readNixosConfig({name, run} = {}) {
	const n = String(name ?? '')
	try {
		const data = await run(['file', 'pull', `${n}${NIXOS_CONFIG_PATH}`, '-'], {timeout: 60_000, binary: true})
		const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
		return {path: NIXOS_CONFIG_PATH, config: text, present: true}
	} catch {
		return {path: NIXOS_CONFIG_PATH, config: '', present: false}
	}
}
