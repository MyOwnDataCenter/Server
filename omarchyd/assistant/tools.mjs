const tool = (name, rpc, description, properties = {}, ownerOnly = false) => ({
	name,
	rpc,
	description,
	parameters: {type: 'object', properties},
	ownerOnly,
})

// `required` lists what the model must send. It goes in the schema so the model is told, and propose() refuses a call without it.
const mutation = (name, rpc, description, properties = {}, ownerOnly = false, required = []) => {
	const spec = {...tool(name, rpc, description, properties, ownerOnly), kind: 'mutation'}
	if (required.length) spec.parameters = {...spec.parameters, required}
	return spec
}

export const READ_TOOLS = [
	tool('system_diskUsage', 'system.diskUsage', 'Disk used and free on this server'),
	tool('system_cpuUsage', 'system.cpuUsage', 'CPU used on this server'),
	tool('system_memoryUsage', 'system.memoryUsage', 'Memory used on this server'),
	tool('system_gpuUsage', 'system.gpuUsage', 'GPU used on this server'),
	tool('system_cpuTemperature', 'system.cpuTemperature', 'CPU temperature on this server'),
	tool('system_uptime', 'system.uptime', 'How long this server has been up'),
	tool('system_device', 'system.device', 'This server’s device and OS'),
	tool('system_osInfo', 'system.osInfo', 'This server’s OS, kernel and Omarchy version, and whether OS or Omarchy updates are waiting (checked, never installed)'),
	tool('system_version', 'system.version', 'The MODC version this server runs'),
	tool('system_checkUpdate', 'system.checkUpdate', 'Whether a newer MODC version is available'),
	tool('system_getHostname', 'system.getHostname', 'This server’s hostname'),
	tool('system_getIpAddresses', 'system.getIpAddresses', 'This server’s IP addresses'),
	tool('apps_list', 'apps.list', 'Apps installed on this server'),
	tool('appStore_app', 'appStore.app', 'One app from the store', {appId: {type: 'string', description: 'App id'}}),
	tool('appStore_search', 'appStore.registry', 'Search the app store', {
		q: {type: 'string', description: 'Search text'},
		category: {type: 'string'},
		limit: {type: 'integer', description: 'Max results, 1–24'},
	}),
	tool('machines_list', 'machines.list', 'Virtual machines on this server, with the notes written on each one'),
	tool('machines_details', 'machines.details', 'One virtual machine', {id: {type: 'string', description: 'Machine id'}}),
	tool('machines_osImages', 'machines.osImages', 'Operating system images available for a new machine'),
	tool('machines_capabilities', 'machines.capabilities', 'What this server can give a virtual machine'),
	tool('containers_status', 'containers.status', 'Whether system containers (LXC/Incus) are set up on this server'),
	tool('containers_list', 'containers.list', 'System containers (LXC) on this server — machines that share this server’s kernel, not App Store apps'),
	tool('usb_list', 'usb.list', 'USB serial and Zigbee sticks plugged into this server, and which app or virtual machine holds each one'),
	tool('swarm_list', 'swarm.list', 'Computers in the Local swarm', {}, true),
	tool('swarm_alerts', 'swarm.alerts', 'Active health alerts across computers in the Local swarm (offline nodes, high disk usage, high temperature, waiting updates, outdated connectors)', {}, true),
	tool('swarm_history', 'swarm.history', 'Recent CPU, memory, disk, GPU and temperature history for one Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		range: {type: 'string', enum: ['1h', '24h'], description: 'Time window: 1h or 24h'},
	}, true),
	tool('swarm_storage_status', 'swarm.storage.status', 'Whether storage helper and ZFS are available on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	tool('swarm_storage_disks', 'swarm.storage.disks', 'Live disks on a Local swarm computer, including unmounted extra drives. Use this for mount state; swarm_list metrics only show mounted filesystems.', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	tool('swarm_storage_pools', 'swarm.storage.pools', 'Storage pools (Btrfs/ZFS) on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	tool('swarm_services_list', 'swarm.services.list', 'User systemd services, failed system units, and containers on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	tool('swarm_service_logs', 'swarm.services.logs', 'Recent logs for a service or container on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		kind: {type: 'string', enum: ['user', 'system', 'container']},
		name: {type: 'string', description: 'Unit or container name'},
		lines: {type: 'integer', description: 'Number of lines (10-1000)'},
	}, true),
	tool('swarm_files_list', 'swarm.files.list', 'List files and folders inside /Home or /Pools on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		path: {type: 'string', description: 'Virtual path such as /Home or /Pools'},
	}, true),
	tool('swarm_backups_status', 'backups.computers', 'Backup schedule and status for Local swarm computers', {}, true),
	tool('omarchy_plugins', 'omarchy.plugins', 'Omarchy plugins that can be installed', {
		q: {type: 'string'},
		limit: {type: 'integer'},
	}),
	tool('omarchy_listBackgrounds', 'omarchy.backgrounds', 'List this machine’s wallpaper and background images, grouped by Omarchy theme. Use this when they ask which wallpapers exist.', {
		theme: {type: 'string', description: 'Theme slug; omit for every theme'},
	}),
	tool('appearance_list', 'appearance.list', 'Where to change this app’s Appearance. Theme is colour. Shape is Round or Square, not a theme.'),
	tool('notifications_get', 'notifications.get', 'Notifications waiting on this server'),
]

export const WRITE_TOOLS = [
	mutation('apps_install', 'apps.install', 'Install an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('apps_start', 'apps.start', 'Start an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('apps_stop', 'apps.stop', 'Stop an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('apps_restart', 'apps.restart', 'Restart an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('apps_uninstall', 'apps.uninstall', 'Uninstall an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('apps_update', 'apps.update', 'Update an app', {appId: {type: 'string'}}, false, ['appId']),
	mutation('machines_create', 'machines.create', 'Create a virtual machine', {
		name: {type: 'string'},
		osId: {type: 'string'},
		cores: {type: 'integer'},
		memoryGb: {type: 'integer'},
		diskSizeGb: {type: 'integer'},
		username: {type: 'string'},
	}, false, ['name', 'osId']),
	mutation('machines_start', 'machines.start', 'Start a virtual machine', {id: {type: 'string'}}, false, ['id']),
	mutation('machines_stop', 'machines.stop', 'Stop a virtual machine', {id: {type: 'string'}}, false, ['id']),
	mutation('machines_restart', 'machines.restart', 'Restart a virtual machine', {id: {type: 'string'}}, false, ['id']),
	mutation('machines_uninstall', 'machines.uninstall', 'Remove a virtual machine', {id: {type: 'string'}}, false, ['id']),
	mutation('machines_updateSettings', 'machines.updateSettings', 'Change a virtual machine’s port forwards', {
		id: {type: 'string'},
		portForwards: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: {type: 'string'},
					protocol: {type: 'string', enum: ['tcp', 'udp']},
					hostPort: {type: 'integer'},
					guestPort: {type: 'integer'},
				},
			},
		},
	}, false, ['id', 'portForwards']),
	mutation('containers_start', 'containers.start', 'Start a system container (LXC)', {name: {type: 'string', description: 'Container name'}}, true, ['name']),
	mutation('containers_stop', 'containers.stop', 'Shut down a system container (LXC)', {name: {type: 'string', description: 'Container name'}}, true, ['name']),
	mutation('containers_restart', 'containers.restart', 'Restart a system container (LXC)', {name: {type: 'string', description: 'Container name'}}, true, ['name']),
	mutation('containers_create', 'containers.create', 'Create a system container (LXC) on this server', {
		name: {type: 'string', description: 'Lowercase name'},
		image: {type: 'string', description: 'Library alias such as debian/12, or template:modc/name'},
		cpus: {type: 'integer'},
		memoryMiB: {type: 'integer'},
		diskGiB: {type: 'integer'},
		autostart: {type: 'boolean'},
		rootPassword: {type: 'string'},
		sshKey: {type: 'string'},
	}, true, ['name', 'image']),
	mutation('containers_delete', 'containers.delete', 'Delete a system container (LXC)', {name: {type: 'string', description: 'Container name'}}, true, ['name']),
	mutation('containers_installConnector', 'containers.installConnector', 'Install the connector inside a system container so Files and Terminal can use it', {
		name: {type: 'string', description: 'Container name'},
		username: {type: 'string', description: 'Lower-case Linux account inside the container'},
	}, true, ['name', 'username']),
	mutation('usb_attach', 'usb.attach', 'Bind a host USB serial or Zigbee stick to one virtual machine or app on this server. Exclusive: only one guest can hold a stick. A running app may need a restart.', {
		deviceId: {type: 'string', description: 'Stable USB id from usb_list'},
		guest: {
			type: 'object',
			properties: {
				kind: {type: 'string', enum: ['machine', 'app'], description: 'machine = VM, app = container'},
				id: {type: 'string', description: 'Machine or app id'},
			},
			required: ['kind', 'id'],
		},
	}, true, ['deviceId', 'guest']),
	mutation('usb_detach', 'usb.detach', 'Unbind a host USB stick from the app or virtual machine that holds it. A running app may need a restart.', {
		deviceId: {type: 'string', description: 'Stable USB id from usb_list'},
	}, true, ['deviceId']),
	mutation('swarm_wake', 'swarm.wake', 'Wake a powered-off Local swarm computer with Wake-on-LAN. Packets go out from this server and every swarm computer that is on. Not a virtual machine, and not over Tailscale alone.', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true, ['id']),
	mutation('swarm_action', 'swarm.action', 'Install a plugin, set a theme, or reboot another Local swarm computer — not this server’s Round or Square shape', {
		id: {type: 'string'},
		name: {type: 'string', enum: ['plugin-install', 'plugin-remove', 'theme-set', 'reboot']},
		pluginId: {type: 'string'},
		theme: {type: 'string'},
	}, true, ['id', 'name']),
	mutation('swarm_rename', 'swarm.rename', 'Rename a swarm computer', {id: {type: 'string'}, name: {type: 'string'}}, true, ['id', 'name']),
	mutation('desktop_setLayout', 'desktop.setLayout', 'Set this server’s Shape: Round (gnome: floating, rounded corners; was called Ubuntu) or Square (hyprland: tiling, square corners; was called Hyprland). Not a swarm theme and not omarchy_setTheme. Does not change phone or desktop layout.', {
		shell: {type: 'string', enum: ['gnome', 'hyprland'], description: 'gnome = Round, floating, rounded. hyprland = Square, tiling, square.'},
	}),
	mutation('omarchy_setTheme', 'omarchy.setTheme', 'Set this machine’s Omarchy theme colours. Use this only when they want colours and not a wallpaper change.', {slug: {type: 'string'}}, true),
	mutation('omarchy_setBackground', 'omarchy.setBackground', 'Change this machine’s desktop wallpaper and the web app background. If they also want that theme’s colours, pass the theme slug — do not also call omarchy_setTheme. Use this whenever they ask to change the wallpaper, background, backdrop, picture, or theme plus wallpaper. The person picks the image on the Approve card.', {
		theme: {type: 'string', description: 'Theme slug whose pictures to show'},
		id: {type: 'string', description: 'Background id to pre-select (16 hex characters)'},
	}, true),
	mutation('omarchy_installPlugin', 'omarchy.installPlugin', 'Install an Omarchy plugin', {id: {type: 'string'}}, true, ['id']),
	mutation('omarchy_removePlugin', 'omarchy.removePlugin', 'Remove an Omarchy plugin', {id: {type: 'string'}}, true, ['id']),
	mutation('system_restart', 'system.restart', 'Restart this server', {}, true),
	mutation('system_shutdown', 'system.shutdown', 'Shut down this server', {}, true),
]

const readByName = new Map(READ_TOOLS.map((t) => [t.name, t]))
const writeByName = new Map(WRITE_TOOLS.map((t) => [t.name, t]))

export function toolsFor(role) {
	const owner = role === 'owner'
	return [...READ_TOOLS, ...WRITE_TOOLS].filter((t) => owner || !t.ownerOnly)
}

export function openAiTools(role) {
	return toolsFor(role).map((t) => ({
		type: 'function',
		function: {name: t.name, description: t.description, parameters: t.parameters},
	}))
}

export function coerceDeskShell(value) {
	const tokens = String(value ?? '').trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
	if (tokens.some((t) => ['gnome', 'ubuntu', 'floating', 'rounded', 'round'].includes(t))) return 'gnome'
	if (tokens.some((t) => ['hyprland', 'hypr', 'tiling', 'tiled', 'square'].includes(t))) return 'hyprland'
	return null
}

export function appearanceCatalog() {
	return {
		appearance: {
			where: 'Settings → Appearance',
			note: 'Theme sets colours. Background is the picture or a solid colour. Accent is one colour for the app and the desktop. Shape is separate.',
		},
		themes: [
			{id: 'horizon', name: 'Horizon', look: 'Colours from the wallpaper'},
			{id: 'custom', name: 'Your photo', look: 'Colours from your photo'},
			{id: 'mocha', name: 'Midnight', look: 'Dark palette'},
			{id: 'tokyo', name: 'Neon', look: 'Dark palette'},
			{id: 'gruvbox', name: 'Ember', look: 'Warm palette'},
			{id: 'latte', name: 'Daylight', look: 'Light palette'},
			{id: 'linen', name: 'Linen', look: 'Warm off-white palette'},
			{id: 'sky', name: 'Sky', look: 'Pale blue palette'},
			{id: 'omarchy', name: 'Omarchy', look: 'This server’s Omarchy colours'},
		],
		panelStyle: {
			where: 'Settings → Appearance',
			note: 'Theme does not set the panels. Shape is Round or Square.',
			styles: [
				{id: 'yaru', name: 'Yaru', note: 'Ubuntu’s look: solid dark panels'},
				{id: 'glass', name: 'Glass', note: 'Frosted, see-through panels'},
				{id: 'graphite', name: 'Graphite', note: 'Flat and crisp, no blur'},
				{id: 'daylight', name: 'Daylight', note: 'Light top bar, dock and menus'},
			],
		},
		layout: {
			where: 'Settings → Appearance',
			note: 'Shape. Round uses rounded corners, and on the desktop it floats windows over a dock. Square uses square corners, and on the desktop it tiles windows and hides the dock. Choosing a shape does not change phone or desktop.',
			options: [
				{id: 'gnome', name: 'Round'},
				{id: 'hyprland', name: 'Square'},
			],
		},
	}
}

export function filterAppStore(registry, input = {}) {
	const raw = Math.floor(Number(input?.limit))
	const limit = Math.min(24, Math.max(1, Number.isFinite(raw) && raw > 0 ? raw : 12))
	const q = String(input?.q ?? '').trim().toLowerCase()
	const category = String(input?.category ?? '').trim().toLowerCase()
	const apps = []
	for (const store of Array.isArray(registry) ? registry : []) {
		for (const a of store?.apps ?? []) apps.push(a)
	}
	return apps.filter((a) => {
		if (category && String(a?.category ?? '').toLowerCase() !== category) return false
		if (!q) return true
		return `${a?.id ?? ''} ${a?.name ?? ''} ${a?.tagline ?? ''}`.toLowerCase().includes(q)
	}).slice(0, limit).map((a) => ({
		id: a?.id,
		name: a?.name,
		tagline: a?.tagline,
		category: a?.category,
		version: a?.version,
	}))
}

export function lookupTool(name) {
	return readByName.get(name) ?? null
}

export function writeTool(name) {
	return writeByName.get(name) ?? null
}

// Fields this tool declares. The Approve card does not show anything else, so those keys are not sent.
export function declaredArgs(spec, args) {
	const props = spec?.parameters?.properties
	const src = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
	if (!props || typeof props !== 'object') return {}
	const out = {}
	for (const key of Object.keys(props)) if (Object.hasOwn(src, key)) out[key] = src[key]
	return out
}

export function isWriteTool(name) {
	return writeByName.has(name)
}

// Why a write call's arguments can't be used, or null when they are fine. Checks what the schema declares:
// the required fields, each present field's type, and the allowed values of an enum.
export function badWriteArgs(spec, args) {
	const check = (schema, value, path) => {
		const type = schema?.type
		const here = path || 'the call'
		if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`
		if (type === 'string' && typeof value !== 'string') return `${path} must be text`
		if (type === 'integer' && !(Number.isInteger(value) || (typeof value === 'string' && /^\d+$/.test(value.trim())))) return `${path} must be a whole number`
		if (type === 'array') {
			if (!Array.isArray(value)) return `${path} must be a list`
			for (let i = 0; i < value.length; i++) {
				const bad = check(schema.items, value[i], `${path}[${i}]`)
				if (bad) return bad
			}
		}
		if (type === 'object') {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return `${here} must be an object`
			for (const key of schema.required ?? []) {
				const v = value[key]
				if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return `${path ? `${path}.` : ''}${key} is required`
			}
			for (const [key, sub] of Object.entries(schema.properties ?? {})) {
				if (value[key] === undefined) continue
				const bad = check(sub, value[key], path ? `${path}.${key}` : key)
				if (bad) return bad
			}
		}
		return null
	}
	return check(spec?.parameters, args && typeof args === 'object' ? args : {}, '')
}
