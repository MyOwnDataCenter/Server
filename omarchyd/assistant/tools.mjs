const tool = (name, rpc, description, properties = {}, ownerOnly = false) => ({
	name,
	rpc,
	description,
	parameters: {type: 'object', properties},
	ownerOnly,
})

const mutation = (name, rpc, description, properties = {}, ownerOnly = false) => ({...tool(name, rpc, description, properties, ownerOnly), kind: 'mutation'})

export const READ_TOOLS = [
	tool('system_diskUsage', 'system.diskUsage', 'Disk used and free on this server'),
	tool('system_cpuUsage', 'system.cpuUsage', 'CPU used on this server'),
	tool('system_memoryUsage', 'system.memoryUsage', 'Memory used on this server'),
	tool('system_gpuUsage', 'system.gpuUsage', 'GPU used on this server'),
	tool('system_cpuTemperature', 'system.cpuTemperature', 'CPU temperature on this server'),
	tool('system_uptime', 'system.uptime', 'How long this server has been up'),
	tool('system_device', 'system.device', 'This server’s device and OS'),
	tool('system_getHostname', 'system.getHostname', 'This server’s hostname'),
	tool('system_getIpAddresses', 'system.getIpAddresses', 'This server’s IP addresses'),
	tool('apps_list', 'apps.list', 'Apps installed on this server'),
	tool('appStore_app', 'appStore.app', 'One app from the store', {appId: {type: 'string', description: 'App id'}}),
	tool('appStore_search', 'appStore.registry', 'Search the app store', {
		q: {type: 'string', description: 'Search text'},
		category: {type: 'string'},
		limit: {type: 'integer', description: 'Max results, 1–24'},
	}),
	tool('machines_list', 'machines.list', 'Virtual machines on this server'),
	tool('machines_details', 'machines.details', 'One virtual machine', {id: {type: 'string', description: 'Machine id'}}),
	tool('machines_osImages', 'machines.osImages', 'Operating system images available for a new machine'),
	tool('machines_capabilities', 'machines.capabilities', 'What this server can give a virtual machine'),
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
	tool('swarm_apps_list', 'swarm.apps.list', 'Apps hosted on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	tool('swarm_backups_status', 'backups.computers', 'Backup schedule and status for Local swarm computers', {}, true),
	tool('omarchy_plugins', 'omarchy.plugins', 'Omarchy plugins that can be installed', {
		q: {type: 'string'},
		limit: {type: 'integer'},
	}),
	tool('omarchy_listBackgrounds', 'omarchy.backgrounds', 'List this machine’s wallpaper and background images, grouped by Omarchy theme. Use this when they ask which wallpapers exist.', {
		theme: {type: 'string', description: 'Theme slug; omit for every theme'},
	}),
	tool('appearance_list', 'appearance.list', 'Where to change this app’s Appearance themes and panel styles (glass vs solid). Not Ubuntu vs Hyprland layout.'),
	tool('notifications_get', 'notifications.get', 'Notifications waiting on this server'),
]

export const WRITE_TOOLS = [
	mutation('apps_install', 'apps.install', 'Install an app', {appId: {type: 'string'}}),
	mutation('apps_start', 'apps.start', 'Start an app', {appId: {type: 'string'}}),
	mutation('apps_stop', 'apps.stop', 'Stop an app', {appId: {type: 'string'}}),
	mutation('apps_restart', 'apps.restart', 'Restart an app', {appId: {type: 'string'}}),
	mutation('apps_uninstall', 'apps.uninstall', 'Uninstall an app', {appId: {type: 'string'}}),
	mutation('apps_update', 'apps.update', 'Update an app', {appId: {type: 'string'}}),
	mutation('machines_create', 'machines.create', 'Create a virtual machine', {
		name: {type: 'string'},
		osId: {type: 'string'},
		cores: {type: 'integer'},
		memoryGb: {type: 'integer'},
		diskSizeGb: {type: 'integer'},
		username: {type: 'string'},
	}),
	mutation('machines_start', 'machines.start', 'Start a virtual machine', {id: {type: 'string'}}),
	mutation('machines_stop', 'machines.stop', 'Stop a virtual machine', {id: {type: 'string'}}),
	mutation('machines_restart', 'machines.restart', 'Restart a virtual machine', {id: {type: 'string'}}),
	mutation('machines_uninstall', 'machines.uninstall', 'Remove a virtual machine', {id: {type: 'string'}}),
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
	}),
	mutation('usb_attach', 'usb.attach', 'Bind a host USB serial or Zigbee stick to one virtual machine or app on this server. Exclusive: only one guest can hold a stick. A running app may need a restart.', {
		deviceId: {type: 'string', description: 'Stable USB id from usb_list'},
		guest: {
			type: 'object',
			properties: {
				kind: {type: 'string', enum: ['machine', 'app'], description: 'machine = VM, app = container'},
				id: {type: 'string', description: 'Machine or app id'},
			},
		},
	}, true),
	mutation('usb_detach', 'usb.detach', 'Unbind a host USB stick from the app or virtual machine that holds it. A running app may need a restart.', {
		deviceId: {type: 'string', description: 'Stable USB id from usb_list'},
	}, true),
	mutation('swarm_action', 'swarm.action', 'Install a plugin, set a theme, or restart/suspend/shut down another Local swarm computer — not this server’s Ubuntu vs Hyprland layout', {
		id: {type: 'string'},
		name: {type: 'string', enum: ['plugin-install', 'plugin-remove', 'theme-set', 'reboot', 'shutdown', 'suspend']},
		pluginId: {type: 'string'},
		theme: {type: 'string'},
	}, true),
	mutation('swarm_power', 'swarm.action', 'Restart, suspend, or shut down a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		name: {type: 'string', enum: ['reboot', 'suspend', 'shutdown']},
	}, true),
	mutation('swarm_wake', 'swarm.wake', 'Send a Wake-on-LAN packet to wake an offline Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		mac: {type: 'string', description: 'Optional MAC address override'},
	}, true),
	mutation('swarm_update_connector', 'swarm.updateConnector', 'Update the connector on one Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	mutation('swarm_update_all_connectors', 'swarm.updateAllConnectors', 'Update outdated connectors across all online manageable Local swarm computers', {}, true),
	mutation('swarm_storage_mount', 'swarm.storage.mount', 'Mount an extra drive on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		device: {type: 'string', description: 'Device path such as /dev/sdb1'},
	}, true),
	mutation('swarm_storage_unmount', 'swarm.storage.unmount', 'Unmount an extra drive on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		device: {type: 'string', description: 'Device path such as /dev/sdb1'},
	}, true),
	mutation('swarm_storage_scrub', 'swarm.storage.scrub', 'Run a health scrub on a storage pool on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		name: {type: 'string', description: 'Pool name'},
		kind: {type: 'string', enum: ['btrfs', 'zfs']},
	}, true),
	mutation('swarm_storage_setSleep', 'swarm.storage.setSleep', 'Set idle spin-down timer (minutes) for a drive on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		device: {type: 'string', description: 'Device path'},
		minutes: {type: 'integer', description: 'Idle minutes (0 disables sleep)'},
	}, true),
	mutation('swarm_service_control', 'swarm.services.control', 'Start, stop, or restart a user systemd service or container on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		kind: {type: 'string', enum: ['user', 'container']},
		name: {type: 'string', description: 'Unit or container name'},
		action: {type: 'string', enum: ['start', 'stop', 'restart']},
	}, true),
	mutation('swarm_app_control', 'swarm.apps.control', 'Start, stop, or restart a remote app hosted on a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
		appId: {type: 'string', description: 'App id from swarm_apps_list'},
		action: {type: 'string', enum: ['start', 'stop', 'restart']},
	}, true),
	mutation('swarm_backup_run', 'backups.runComputer', 'Start a manual backup for a Local swarm computer', {
		id: {type: 'string', description: 'Computer id from swarm_list'},
	}, true),
	mutation('swarm_fleet_action', 'swarm.fleetAction', 'Apply a theme, plugin change, or connector update across multiple Local swarm computers at once', {
		ids: {type: 'array', items: {type: 'string'}, description: 'Computer ids from swarm_list; omit for all eligible computers'},
		name: {type: 'string', enum: ['theme-set', 'plugin-install', 'plugin-remove', 'update-connector']},
		theme: {type: 'string'},
		pluginId: {type: 'string'},
	}, true),
	mutation('swarm_rename', 'swarm.rename', 'Rename a swarm computer', {id: {type: 'string'}, name: {type: 'string'}}, true),
	mutation('desktop_setLayout', 'desktop.setLayout', 'Set this Omarchy Server’s desktop layout on this machine: Ubuntu (gnome: floating, rounded corners) or Hyprland (hyprland: tiling, square corners). Not a swarm theme and not omarchy_setTheme.', {
		shell: {type: 'string', enum: ['gnome', 'hyprland'], description: 'gnome = Ubuntu, floating, rounded. hyprland = Hyprland, tiling, square.'},
	}),
	mutation('omarchy_setTheme', 'omarchy.setTheme', 'Set this machine’s Omarchy theme colours. Use this only when they want colours and not a wallpaper change.', {slug: {type: 'string'}}, true),
	mutation('omarchy_setBackground', 'omarchy.setBackground', 'Change this machine’s desktop wallpaper and the web app background. If they also want that theme’s colours, pass the theme slug — do not also call omarchy_setTheme. Use this whenever they ask to change the wallpaper, background, backdrop, picture, or theme plus wallpaper. The person picks the image on the Approve card.', {
		theme: {type: 'string', description: 'Theme slug whose pictures to show'},
		id: {type: 'string', description: 'Background id to pre-select (16 hex characters)'},
	}, true),
	mutation('omarchy_installPlugin', 'omarchy.installPlugin', 'Install an Omarchy plugin', {id: {type: 'string'}}, true),
	mutation('omarchy_removePlugin', 'omarchy.removePlugin', 'Remove an Omarchy plugin', {id: {type: 'string'}}, true),
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
			note: 'This is the app look: rounding and glass vs square solid panels. Picking a wallpaper here can switch the theme to Omarchy unless you were already on Horizon.',
		},
		themes: [
			{id: 'horizon', name: 'Horizon', look: 'Rounded glass over the wallpaper'},
			{id: 'custom', name: 'Your photo', look: 'Rounded glass over your photo'},
			{id: 'mocha', name: 'Midnight', look: 'Rounded glass, dark palette'},
			{id: 'tokyo', name: 'Neon', look: 'Rounded glass, dark palette'},
			{id: 'gruvbox', name: 'Ember', look: 'Rounded glass, warm palette'},
			{id: 'latte', name: 'Daylight', look: 'Rounded glass, light palette'},
			{id: 'omarchy', name: 'Omarchy', look: 'Square corners, solid panels, no blur'},
		],
		panelStyle: {
			where: 'Personalize → Panel style',
			note: 'Desktop chrome only (top bar, dock, windows).',
			styles: [
				{id: 'yaru', name: 'Yaru', note: 'Ubuntu’s look: solid dark panels'},
				{id: 'glass', name: 'Glass', note: 'Frosted, see-through panels'},
				{id: 'graphite', name: 'Graphite', note: 'Flat and crisp, no blur'},
				{id: 'daylight', name: 'Daylight', note: 'Light top bar, dock and menus'},
			],
		},
		layout: {
			where: 'Personalize → Layout',
			note: 'Ubuntu is floating with rounded windows. Hyprland tiles with square corners. App chrome rounding is Settings → Appearance.',
			options: [
				{id: 'gnome', name: 'Ubuntu'},
				{id: 'hyprland', name: 'Hyprland'},
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
