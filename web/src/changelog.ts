// What's new, newest first. Shown once after an update (everything since the version this device last saw),
// and any time from Settings → Software update. Keep each line short and about what the person can now do.
export type Release = {version: string; date: string; title: string; added?: string[]; fixed?: string[]}

export const CHANGELOG: Release[] = [
	{
		version: '0.9.108',
		date: '2026-11-28',
		title: 'The Home icon opens Home, and a system container is a machine',
		added: [
			'A system container is a machine. Machines lists it with your computers and virtual machines. It is Online while running, Offline when shut off, and Paused when frozen. On a wide desktop its page sits beside the list. An app from the store stays an app.',
			'Open the container for Files and Terminal. When its connector is online, Apps and Pin work there too. The owner can install that connector from the container page while the container is running.',
		],
		fixed: [
			'On the desktop, the Home icon opens the Home page. A Home folder shortcut you add after that still opens the folder in Files.',
		],
	},
	{
		version: '0.9.107',
		date: '2026-11-27',
		title: 'An encrypted server can start by itself after a power cut',
		added: [
			'The installer asks whether to turn on unattended boot when the system disk is encrypted. Why: until now, after a restart or power cut the computer waited at the disk password screen, so this server stayed off until someone typed it at the keyboard.',
			'With it on, the disk unlocks itself and the server starts on its own. The screen asks for your Linux password instead of signing in automatically. Your disk password still works.',
			'Trade-off: anyone who takes the computer or its drive could read the data. It is off unless you say yes, and it is never turned on by an in-app update.',
			'Restart from the app is no longer blocked by the disk password warning once unattended boot is on.',
		],
	},
	{
		version: '0.9.106',
		date: '2026-11-27',
		title: 'Toasts follow you, and chat tries your providers in order',
		added: [
			'Copied, a VM starting, an install, and other feedback for you show in one list. When the floating assistant is on screen, that list sits in its speech bubble. When the assistant is hidden, the same list sits at the top of the page. The bell stays for news for the whole server, such as a software update.',
			'Settings → Assistant lists the providers you added, from the top. Chat tries them in that order and names the one that answered. A new provider is added at the bottom. Open a provider to move it up or down.',
			'The owner can offer one provider to other accounts. Those accounts can refuse it. A provider someone else added stays off your list, apart from that offer. When someone else uses the one you offered, chat names the service, not the private name you gave it.',
			'Hermes answers only when its row is first. It is not a backup for the providers under it.',
		],
	},
	{
		version: '0.9.105',
		date: '2026-11-27',
		title: 'The store names the machine before you install',
		added: [
			'Before Get, the store shows Install on. It offers this server, a computer that is online, or a virtual machine that is running with its connector online. An offline machine is left out. Why: an app should go only where it can actually be installed.',
			'Sharing sign-in with an app asks first, and it starts off. Why: accounts on this server, including two-factor, should not be shared unless you say so.',
			'Discarding edits in a file asks first.',
			'System keeps this device apart from server power. Clip book, Terminals, Settings, and sign out sit with this device. Restart and shut down sit with server power. The page shows one version of My Own Data Center.',
			'Terminals is no longer a phone tab. Open it from System. A container’s login is labeled Container login.',
			'When no apps are installed, Apps offers Find apps.',
		],
		fixed: [
			'The Settings gear returns to the main Settings page. On the desktop, Appearance stays open.',
			'Owner controls stay hidden until the signed-in account is the owner.',
		],
	},
	{
		version: '0.9.104',
		date: '2026-11-27',
		title: 'Lists that match, and clips you can clear together',
		added: [
			'Terminals uses the same list as Machines. On the phone the list is one card. More sits on the title line. Why: a shell you can open should look like the other lists.',
			'Machines, Terminals, and Clip book share one filter row: a name field, then the chips.',
			'When several clips are checked, Clear, Delete, and Send stay at the top of the list while it scrolls. Delete asks first. The files you copied stay where they are.',
		],
	},
	{
		version: '0.9.103',
		date: '2026-11-27',
		title: 'Terminals, a clip book, and a way back in',
		added: [
			'Terminals lists every shell the owner can open: this server, and a joined computer or a virtual machine whose connector granted a terminal, including one that is offline. Open a row and that terminal sits in the list. Why: the shells you can use should be in one place.',
			'Clip book keeps what you copied. It is a section on the machine page and a row on System. Copy puts the clip on this device. A send keeps going after the browser closes, and a toast tells you when it finishes or when it needs you. Why: a copy should still be there when you come back, and closing the page should not drop a send.',
			'Sun, Moon, and Off are in the top bar again. Which readings a machine shows is saved on the account, and another account keeps its own choice.',
			'The assistant can read a machine’s notes, and it can say what system this server is running and whether Omarchy updates are waiting. Asking does not install anything.',
		],
		fixed: [
			'A forgotten sign-in password can be set again from this server’s own terminal with omarchy-server reset-password. Every account is signed out of every device and browser. Two-factor stays on. Why: the person at the machine should be able to get back in without the old password.',
			'Virtio disks on a virtual machine share an I/O thread, so disk work is less likely to stall the machine. It applies the next time the machine is fully started.',
			'A damaged list of apps on a joined computer is left as it is, and the problem is written once, instead of the list being replaced.',
		],
	},
	{
		version: '0.9.102',
		date: '2026-11-27',
		title: 'An LXC container’s console is the container’s',
		fixed: [
			'An LXC container’s console opened the server’s own shell. Why: the web server passes only the settings it knows on to the terminal, and it didn’t know the container’s name, so the request arrived as an ordinary terminal. It now passes the container and its console along (and refuses a name that isn’t one), and a test checks it.',
		],
	},
	{
		version: '0.9.101',
		date: '2026-11-27',
		title: 'LXC containers work like virtual machines',
		added: [
			'An LXC container opens like a virtual machine: in Machines, open its row for a summary and power, then Manage opens its page with its console in it, like Proxmox, and its sections (Summary, Network, Snapshots, Backup, Files, Options) under it. Why: an LXC container is a guest like a VM, so it should look and work the same.',
		],
		fixed: [
			'Sun, Moon, and Off are gone from the top bar again; Appearance in Settings is where you choose them. Horizon, Your photo, and Omarchy go back to their earlier sizes.',
			'The Root shell button is gone from LXC containers: the console is the way in, as in Proxmox.',
			'A container made from a template file gets its own name as its host name.',
		],
	},
	{
		version: '0.9.100',
		date: '2026-11-27',
		title: 'LXC containers, with their console in the page',
		added: [
			'An LXC container’s console sits in its page, the way a virtual machine’s screen does, with Full screen and Root shell under it. Why: an LXC container is a guest like a VM, so its screen belongs with it rather than over everything.',
		],
		fixed: ['Containers are called LXC containers everywhere: on the server’s page, in Machines → Add, and in their own pages.'],
	},
	{
		version: '0.9.99',
		date: '2026-11-27',
		title: 'Sun, Moon, and Off in the top bar',
		added: [
			'Sun, Moon, and Off sit in the desktop top bar and next to Settings on the phone. Sun and Moon use the palettes marked in Appearance. Off returns to Horizon, Your photo, and Omarchy.',
		],
		fixed: [
			'Horizon, Your photo, and Omarchy are the same size.',
		],
	},
	{
		version: '0.9.98',
		date: '2026-11-26',
		title: 'Container console, and your own ISOs and templates',
		added: [
			'Containers have a Console: the container’s own screen with its login prompt, like Proxmox’s console. Root shell still opens straight into it. Set root’s password from the container’s page to sign in at the console. Why: a container is a small system of its own, and its console is where it shows itself.',
			'Add an ISO for virtual machines from a link or from this device, right in New virtual machine. It’s saved in Downloads and shows under Your own ISO when it’s complete.',
			'Add container templates: download one from a link, upload one, or import any template file already on the server (a Proxmox CT template or an Incus image). Imported templates appear under Your templates. New container can also show Incus’s whole library, not only the main systems.',
		],
	},
	{
		version: '0.9.97',
		date: '2026-11-26',
		title: 'A container’s terminal opens',
		fixed: [
			'A container’s Terminal opened behind its page, so you saw an empty panel. Why: container pages are sheets, which sit above the layer terminals open on. It now opens above the sheet.',
			'A new container no longer offers Start while it’s still being created. Why: Incus lists it (stopped) a moment before it starts it, and pressing Start then failed. It shows as creating until it’s running.',
		],
	},
	{
		version: '0.9.96',
		date: '2026-11-26',
		title: 'New containers finish being created',
		fixed: [
			'A new container stayed at “creating” for good. Why: Incus reads a container’s settings from its input whenever it isn’t typing at a screen, and My Own Data Center left that input open and empty, so Incus waited for it forever before even downloading. Incus now gets a closed input unless there’s something to send. While a container is being made you see Incus’s own progress (downloading, unpacking) and how long it’s been.',
			'Container pages fit a phone screen. Fields beside a button, the power buttons and long lines no longer push the page past the right edge.',
		],
	},
	{
		version: '0.9.95',
		date: '2026-11-26',
		title: 'The container library fills in',
		fixed: [
			'New container showed no systems to pick. Why: the image server names an image’s architecture two ways (x86_64, and amd64 in its details), and My Own Data Center only looked for x86_64 in the details, so every image was skipped. It now reads both. If the library ever does come back empty, it says so and what to check.',
		],
	},
	{
		version: '0.9.94',
		date: '2026-11-26',
		title: 'Updates see lettered versions',
		fixed: [
			'0.9.93B was never offered as an update to 0.9.93A. Why: updates compared only the numbers in a version, so 0.9.93A and 0.9.93B looked the same. Letters now count (0.9.93 < 0.9.93A < 0.9.93B < 0.9.94). This release carries 0.9.93B’s container fix: containers no longer stop at “unknown flag: --format” after setting up, and clearing a container’s CPU cap works.',
		],
	},
	{
		version: '0.9.93B',
		date: '2026-11-26',
		title: 'Containers past the setup card',
		fixed: [
			'Containers stopped at “unknown flag: --format” after setting up. Why: My Own Data Center asked Incus for its details in a form Incus doesn’t offer. It now asks the way Incus does. Every other Incus command it uses was checked against the real Incus client.',
			'Clearing a container’s CPU cap no longer says “Use a CPU share of 5 to 100%”.',
		],
	},
	{
		version: '0.9.93A',
		date: '2026-11-26',
		title: 'Add a container from Machines',
		added: [
			'Machines → Add (+) offers Container beside Machine and Virtual Machine. It shows the setup if containers aren’t set up yet, then the library.',
		],
		fixed: [
			'machines-add-lxc no longer hangs after installing Incus. It starts Incus without waiting on systemd, then gives it two minutes; if Incus doesn’t come up, it prints why (its status and recent log) and stops, instead of sitting there. Every step now says what it’s doing.',
			'The container setup card checks again every few seconds, so it moves on by itself once machines-add-lxc finishes.',
			'Containers said “Incus isn’t installed” right after setting it up. Why: to work without a restart, My Own Data Center went through a command (sg) that Arch doesn’t have. machines-add-lxc now gives your account its own permission on Incus’s per-user door, which is exactly what Incus’s group grants, so it works straight away. Run machines-add-lxc again on a server that set up containers before.',
		],
	},
	{
		version: '0.9.92',
		date: '2026-11-26',
		title: 'Containers set up with one command',
		fixed: [
			'Setting up containers is one command: machines-add-lxc. It installs Incus, starts it now and at every boot, makes storage, adds your account to Incus’s per-user group, and opens Omarchy’s firewall for the containers’ own network. It’s safe to run again. Why: the long command it replaces stopped partway on Arch, which has no incus-startup service, and left containers half set up.',
			'No restart after setting up containers. Until the server picks up your new group at the next sign-in, it reaches Incus through that group directly.',
		],
	},
	{
		version: '0.9.91',
		date: '2026-11-26',
		title: 'Containers catch up with Proxmox',
		added: [
			'Containers can start with the server, in the order you choose and with a delay between them. Why: a server with no screen should bring its containers back after a power cut without anyone signing in. New containers start with the server unless you switch it off. (Run the setup command again on a server that set up containers before, so Incus’s startup service is on.)',
			'Change a container’s CPUs, CPU cap, CPU priority, memory and swap while it runs, and grow its disk.',
			'A new container can get a root password and an SSH key. They’re handed straight to the container and not kept by My Own Data Center.',
			'Back up a container to a single file on this server and restore it under a new name; clone it; or save it as a template, which then appears under Your templates when you make a new one.',
			'Protect a container from deleting, and give it notes and tags. The Machines search finds the tags.',
			'Live CPU and network graphs, and a file browser: download, upload, or copy a file into the server’s Downloads.',
			'Containers appear in the Machines list too, each opening in its own sheet. The library adds CentOS Stream, Devuan and Gentoo.',
		],
	},
	{
		version: '0.9.90',
		date: '2026-11-26',
		title: 'Containers, Linen and Sky, and a restart that says when it will wait',
		added: [
			'This server’s Machines page can run a container: a Linux system that shares the server’s kernel. Choose Debian, Ubuntu, Alpine, Arch Linux, Fedora, Rocky Linux, AlmaLinux, or openSUSE. Start it, shut it down, open its terminal, open a port, or take a snapshot. It stays on this server’s page.',
			'Appearance adds Linen and Sky. Sun and Moon use the light or dark palette you marked. Off returns to Horizon, Your photo, or Omarchy.',
			'The Machines list says how many are shown when a filter or a search is hiding some, beside how many are online. Dismissing the filter note keeps it dismissed on this account, on every device.',
		],
		fixed: [
			'Restart warns first when this computer’s disk is encrypted (Omarchy’s default) and doesn’t unlock by itself. Why: an encrypted disk asks for its password before anything on it runs, so after a restart the computer waits at that screen, and this server and remote access can’t start until someone types it at the computer. “Starts after a restart” only covers what happens once the disk is open. Settings now says so too, with how to have the disk unlock by itself.',
		],
	},
	{
		version: '0.9.89',
		date: '2026-11-26',
		title: 'Safer restarts, and a terminal that behaves like the one on your computer',
		added: [
			'Terminal on a computer: Ctrl+V (and Ctrl+Shift+V) pastes, Ctrl+Shift+C copies, and Ctrl+C copies when text is selected (otherwise it stops the running program, as always). Right-click pastes straight away over https://; over http:// browsers don’t let a page read the clipboard, so the browser’s own menu opens with Paste.',
			'Change permissions on a computer that already has the connector runs the update for you: when its connector is online and allows the terminal, Update now opens a terminal there and runs the command, so there’s nothing to copy and paste. Why: it’s the same command you’d paste, run in a shell you already have as that user, so it reaches no further than you could by typing. Without the terminal ability, or with the computer offline, you still get the command to run yourself.',
		],
		fixed: [
			'Restart and Shut down first make sure this server will start again by itself, with nobody signed in at it. If it can’t switch that on, it tells you before going ahead, instead of leaving a server with no screen down until someone signs in at it.',
			'Opening a terminal again no longer types stray characters into it (like 1;2c0;276;0c2026;0$y). They were the terminal’s own answers to questions in the screen it was showing again.',
			'Remote desktop on a phone fits the picture again when the remote screen changes size, instead of keeping the old fit.',
			'A virtual machine’s screen no longer connects and disconnects over and over right after you sign in to it. Signing in sends the whole new picture at once, and on Wi-Fi or a phone that burst was more than the server let wait for the browser, so it cut the viewer off; reconnecting asked for the whole picture again, and the loop went on. Now the server slows the screen down until the browser catches up, and only lets go of a viewer that has read nothing for 30 seconds.',
			'The terminal no longer seems to freeze: Ctrl+S doesn’t pause it any more, and a stuck resize can’t hold back what you type.',
		],
	},
	{
		version: '0.9.88',
		date: '2026-11-26',
		title: 'Use Hermes Agent as your assistant',
		added: [
			'Settings › Assistant: choose who answers in chat, the built-in assistant or Hermes Agent. If you already run Hermes on this server, Connect Hermes imports it: Hermes keeps its own model, memory and skills, and nothing needs setting up twice.',
			'Hermes can look after this server from anywhere it runs (here, Telegram, Discord or its own CLI): apps, files, machines, storage and backups. Choose Full control, or Read only to let it look without changing anything.',
			'Connecting changes Hermes’ own files the way Hermes documents them, keeps a copy of each first, and turns its API server on for this machine only. Disconnect Hermes undoes it.',
			'Hermes can run somewhere else too: on another computer or in the cloud. Connect it by its address and key, and Settings shows the two lines to add on that machine so it can use this server (with a token you can replace any time).',
			'The setup wizard now asks which assistant you want.',
		],
	},
	{
		version: '0.9.87',
		date: '2026-11-25',
		title: 'Steadier remote desktop, and servers that start after a restart',
		fixed: [
			'Viewing a desktop no longer drops and reconnects over and over when nothing on it is moving (an empty desktop, an idle window). The desktop only redraws when something changes, and a still screen was mistaken for a lost one; now the last picture is kept and resent.',
			'An app opened from desktop mode (Google Chrome, say) now shows up in its window even when it opens on the computer’s own screen, for example because it was already running. It’s brought over instead of the launch giving up after 15 seconds.',
			'Remote desktop no longer leaves part of the picture black after the remote screen changes size, or when you come back to the app: the whole screen is asked for again, instead of waiting for something on it to change.',
			'The sign-in and setup screens show the My Own Data Center logo instead of the old umbrella, and phones and browsers fetch the new icons instead of keeping a cached umbrella.',
			'A server with no screen now comes back by itself after a restart or a power cut. It used to stay off until someone signed in on it when the installer couldn’t switch on start at boot. It now switches that on by itself where it can, Settings › Software update shows whether it’s on (with a Turn on button), and the services keep retrying at boot instead of giving up.',
		],
	},
	{
		version: '0.9.86',
		date: '2026-11-25',
		title: 'QR code file transfers, and a steadier phone remote desktop',
		added: [
			'Files (desktop layout): right-click a file and choose Share via QR code. A phone that scans it gets a small download page in your app’s colours and background, without signing in. Handy for passing a file to someone in the house.',
			'Right-click a folder, or empty space inside one, to upload from a phone: scan the code and pick photos or files to send straight into that folder.',
			'Each code lasts 10 minutes and covers only that one file or folder. Stop sharing ends it at once, and so does signing out. Uploads never replace a file that’s already there.',
		],
		fixed: [
			'Remote desktop on a phone: the keyboard you open with the keyboard button now stays up while you tap and drag on the screen, until you put it away with that button. Every tap used to close it.',
			'Apps you open from this server’s desktop view now open on the screen you’re looking at. After using desktop mode, they could open on its hidden display instead, so they seemed to disappear.',
		],
	},
	{
		version: '0.9.85',
		date: '2026-11-25',
		title: 'Paste in the terminal, and a tidier Appearance page',
		added: [
			'Terminal: right-click pastes on a computer, even over http://, where the browser blocks reading the clipboard directly; the paste box opens instead. Right-click with text selected still copies.',
			'Terminal: press and hold on a phone shows a Paste button, because a long press in the terminal did nothing useful before.',
		],
		fixed: [
			'Removed the twelve older photo backgrounds (Yosemite Valley through Tower). They were outdated and crowded the picker; Omarchy backgrounds, the server wallpaper, your own photo and solid colours remain. If one of them was your desktop background, it switches to the Omarchy background.',
			'Dock and desktop icon settings now appear only in the desktop layout. On a phone they controlled things you can’t see there, which was confusing.',
			'A Mac that joins uses a Python that can verify this server’s certificate.',
			'When a list cannot be loaded, including backups, plugins, and a new machine, the page says so instead of looking empty.',
			'Keyboard focus, screen readers, and the phone’s page title follow the screen you are on.',
			'Daylight and the Omarchy theme keep secondary text and accent text readable.',
			'The App Store window follows the computer you just picked.',
		],
	},
	{
		version: '0.9.84',
		date: '2026-11-25',
		title: 'Wake a computer from any machine that is on',
		added: [
			'Wake up uses every network card that computer has shown. The packet goes out from this server and from every computer that is on.',
		],
	},
	{
		version: '0.9.83',
		date: '2026-11-25',
		title: 'Apps can sign in with My Own Data Center',
		added: [
			'An app can sign in with My Own Data Center. The app has to prove it started that sign-in, and a matching email does not take over an existing account.',
		],
	},
	{
		version: '0.9.82',
		date: '2026-11-25',
		title: 'Encrypted Drive backups, and sturdier guest enroll',
		added: [
			'Backups can keep an encrypted copy in a Google Drive folder that this server creates. The connection can see only that folder.',
		],
		fixed: [
			'An Alpine guest installs curl and runuser, and the connector starts only after enroll succeeds. Fedora sets the guest-agent permission with the real setsebool path.',
		],
	},
	{
		version: '0.9.81',
		date: '2026-11-24',
		title: 'More Linux guests, and readings from the machine',
		added: [
			'Swap shows on a machine that has it, in the same drawings as the other readings. Home keeps its aggregate gauges.',
			'The catalog adds CachyOS, Linux Mint, openSUSE Leap, Rocky Linux, Debian 12, and Ubuntu 22.04. Omarchy is 4.5.0. CachyOS and Linux Mint boot their own installers.',
			'A joined computer shows when a restart is needed, how many security updates are waiting, failed services, and listening ports.',
		],
		fixed: [
			'Create waits until a Debian, Fedora, or Omarchy guest can enroll. A failed connector install stays an error.',
		],
	},
	{
		version: '0.9.80',
		date: '2026-11-24',
		title: 'Alpine guests, and Machines on every screen',
		added: [
			'An Alpine guest can install the connector. It runs as an OpenRC service. Windows, macOS, and Home Assistant still do not.',
			'A guest on passt reaches this server through an address it can use.',
			'Machines uses the same list on the phone and on the desktop. A joined computer can create a virtual machine from its own page.',
		],
		fixed: [
			'Restarting this server stops only its own process, so virtual machines keep running. The installer asks to run once so that takes effect.',
		],
	},
	{
		version: '0.9.79',
		date: '2026-11-24',
		title: 'One drawing for a machine’s readings',
		added: [
			'A tap on a machine’s readings cycles one line, three lines, and gauges. That choice is saved with the account and is the same on every machine. Home keeps its aggregate gauges.',
		],
	},
	{
		version: '0.9.78',
		date: '2026-11-24',
		title: 'Linux guests, Square panes, and a steadier stream',
		added: [
			'A Linux guest can install the connector, on this server or on a joined computer. It runs on Linux with systemd. Windows, macOS, and Home Assistant do not run it.',
			'Square panes resize when you drag the gap between them.',
		],
		fixed: [
			'The guest installer checks this server’s certificate.',
			'A machine’s usage rate is taken when the reading starts, so a slow reading does not shrink the percentage.',
			'On a slow connection, the desktop stream gives audio a little more room, and the stats line shows the jitter. A local network keeps the short cushion.',
		],
	},
	{
		version: '0.9.77',
		date: '2026-11-24',
		title: 'Hyprland 0.57, and stream profiles',
		fixed: [
			'Opening an app on this server’s screen, and moving it between workspaces, works on Hyprland 0.57.',
		],
		added: [
			'The screen can try each hardware codec and remember the one that plays smoothly on this device. Only the owner can do that.',
		],
	},
	{
		version: '0.9.76',
		date: '2026-11-24',
		title: 'This server’s screen, and readings from an older server',
		added: [
			'This server’s screen can be drawn from the Hyprland session you are signed in to. Only the owner can open it.',
			'An installed desktop app can open on that screen. A launch that cannot be shown there is refused. The clipboard on that screen is the desktop’s clipboard.',
		],
		fixed: [
			'A connector newer than its server keeps sending readings until that server asks it to watch. After that, it sends only while a screen is open.',
			'Store and plugin categories stay on one line. The arrows move what does not fit, and a chip cut by the edge fades out.',
		],
	},
	{
		version: '0.9.75',
		date: '2026-11-24',
		title: 'Macs, ARM servers, and a desktop you can open',
		added: [
			'Add a computer only asks what this server may do. The same command works on any Linux (it finds the distribution and its package manager itself) and now on a Mac; Windows gets its PowerShell command. Each computer keeps what it can do there.',
			'Macs can join: terminal, files (with uploads), power, and their CPU, memory, disks and battery. No sudo; it runs while you’re signed in.',
			'Windows computers can take uploads in Files.',
			'My Own Data Center installs on ARM (Omarchy on an Apple Silicon Mac, or another 64-bit ARM computer). Machines there run ARM images: Ubuntu 24.04 and 26.04, Debian 13.',
			'A connected computer’s card has a Desktop button that opens its screen straight away.',
		],
		fixed: [
			'Opening a connected computer’s desktop finds the session you’re actually signed in to, even when an old Hyprland or Wayland session left files behind. When it can’t open, it says why and offers the fix: allow the desktop, or install screen sharing in one tap.',
			'Updating a Windows computer’s permissions gives you a PowerShell command.',
		],
	},
	{
		version: '0.9.74',
		date: '2026-11-23',
		title: 'Machines, sessions, and the desktop',
		fixed: [
			'A Windows ISO you install by hand gets a SATA disk and an e1000e network card, so Setup can see them. An IDE drive is refused on a q35 machine before it is saved.',
			'Cloning a machine keeps the source’s history until the copy finishes. A rollback shows the disk size the image actually has, and a live backup’s progress follows the units virsh prints.',
			'The Machine Summary page loads that machine’s chart only. The running count is this server’s machines.',
			'Using My Own Data Center keeps the sign-in behind Files, Terminal, and Desktop alive. A renewal the server refuses is tried again.',
			'A new chat stays the same chat when the first reply fails. A reply that never finishes is cut off, and you can stop it.',
			'Files and Settings still open when the browser blocks storage. A new password asks for 8 characters, and a refused update says why.',
			'An open clock or system menu closes when you click outside it. Accent text stays readable on light and dark themes.',
		],
	},
	{
		version: '0.9.73',
		date: '2026-11-23',
		title: 'Big uploads through a tunnel',
		fixed: [
			'Uploading a big file in Files no longer stalls when you reach your server through a Cloudflare Tunnel (or another proxy that limits one request; Cloudflare allows 100 MB). Files over 8 MB go up in 8 MB pieces, and a piece that drops is sent again and carries on where it stopped. The file only appears once all of it has arrived.',
		],
	},
	{
		version: '0.9.72',
		date: '2026-11-23',
		title: 'My Own Data Center on GitHub',
		added: [
			'The project now lives at github.com/MyOwnDataCenter/server, and its app stores under MyOwnDataCenter (same names). Your server moves its update source and saved stores to the new addresses by itself, so updates keep coming once GitHub’s redirect from the old name ends. The install command is now: curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash',
			'The installers, messages and docs say My Own Data Center.',
		],
	},
	{
		version: '0.9.71',
		date: '2026-11-23',
		title: 'Machines on the desktop, and one store at a time',
		added: [
			'The App Store lists your stores above the search: pick one to see only its apps (with its own search), or All stores. Stores › View apps does the same.',
			'On the desktop layout, Machines looks like a desktop app: a toolbar with Add a computer and New virtual machine, labelled sections, and one line per virtual machine with its controls. Double-click a machine to open it. The phone layout is unchanged.',
		],
		fixed: ['A running virtual machine with changes waiting for a reboot showed “Working…” instead of its controls. It now offers Reboot to apply.'],
	},
	{
		version: '0.9.70',
		date: '2026-11-22',
		title: 'Seeing a connected computer’s desktop',
		fixed: [
			'A connected computer running Omarchy shows its desktop. Its screen sharing (wayvnc) wouldn’t start while MODC’s own, or any other, was already running on that desktop; each now has its own control socket. Let the computer update its connector, and this server update, for it to take effect.',
			'When a desktop can’t be shown, the viewer says why and offers Try again, instead of “Reconnecting…” forever. A desktop that was working and drops still reconnects by itself.',
		],
	},
	{
		version: '0.9.69',
		date: '2026-11-22',
		title: 'One desktop viewer, and drives you can browse',
		added: [
			'Files › Drives shows the drives you mount in Storage: open, upload, download, copy, move and trash inside them like Home. The free space in Files and on Home counts them, and pools, as well as the main drive.',
		],
		fixed: [
			'A connected computer’s desktop opens in the same viewer as a virtual machine’s: a window of its own on the desktop layout, full screen on a phone.',
		],
	},
	{
		version: '0.9.68',
		date: '2026-11-22',
		title: 'Storage in Settings, and remote desktops that show up',
		added: ['Settings › Storage is back: drives, pools, drive health and sleep for the host server, as well as under Machines.'],
		fixed: [
			'A connected computer’s Desktop works soon after you sign in to it. The connector usually starts before anyone signs in, and the server kept that answer for up to five minutes; now a sign-in is reported within about ten seconds.',
		],
	},
	{
		version: '0.9.67',
		date: '2026-11-22',
		title: 'Windows computers',
		added: [
			'Add a Windows computer (Windows 10 or later, with Python 3.8+) from Machines › Add a computer › Windows: paste one PowerShell command, no Administrator needed. It brings its terminal (PowerShell, kept running between visits), its files (open, download, move, delete) and power (restart, shut down, sleep), with CPU, memory and disks. Sharing the screen, uploads, disks, backups and services still need Linux. Based on kdegeek’s Windows connector.',
		],
	},
	{
		version: '0.9.66',
		date: '2026-11-22',
		title: 'Virtual machine controls are back',
		fixed: [
			'Each virtual machine in Machines has its controls on its row again: Start or Resume when it’s off, and Desktop, Shut down, Reboot and Pause when it’s running. Opening a machine that isn’t running goes straight to Power.',
			'In Files, the machine you’re browsing from is called Host server.',
		],
	},
	{
		version: '0.9.65',
		date: '2026-11-22',
		title: 'Machines in sections, folders as trees',
		added: [
			'Machines is in sections: this server, its virtual machines, and connected computers, each with its own count. Virtual machines are listed again instead of only inside the server’s card.',
			'First-run setup asks whether to set up your assistant now or later. Now opens Settings › Assistant.',
			'In Files, folders open in place as a tree, like Favorites and Recent. The arrow on a folder goes into it. Connected computers and the virtual machines running on this server are trees too, in place of the Computers list.',
		],
	},
	{
		version: '0.9.64',
		date: '2026-11-22',
		title: 'Terminals that stay put, and the new icon',
		added: [
			'Your terminal keeps running through restarts and updates, on this server and on every connected computer and virtual machine. Leave, switch devices, come back: it’s the same shell. New session still starts a clean one. This uses tmux, which is installed for you (with no tmux, the terminal works as before).',
			'The new MODC logo is the app icon and favicon.',
		],
		fixed: [
			'On iPhone, the app added to the Home Screen fills the screen again, with no band under the dock. Remove it from the Home Screen and add it again once for this to take effect.',
		],
	},
	{
		version: '0.9.63',
		date: '2026-11-22',
		title: 'Sign-out, the terminal, and the phone',
		fixed: [
			'Signing out returns to the signed-out page, and only after sign-out succeeds.',
			'Opening Terminal again focuses the shell you already have.',
			'Pasting into the terminal inserts at the cursor. Option keys type the character. On a phone, Back closes a full-screen Terminal or Desktop.',
			'The phone layout scrolls across the width of the screen. A confirmation sits above the terminal. Files search waits until two characters are typed.',
			'A request with no body is answered, instead of failing as an internal error. When this computer has no address, that address is left out. A pool on another computer is described as ~/Pools on that computer.',
		],
	},
	{
		version: '0.9.62',
		date: '2026-11-22',
		title: 'Try an app before it’s approved',
		added: ['Stores › Add by link also takes a GitHub pull request or branch link, such as a Modc App Store submission, to try an app exactly as submitted. It’s listed with its pull request or branch, so it’s easy to remove afterwards.'],
	},
	{
		version: '0.9.61',
		date: '2026-11-22',
		title: 'Submit an app',
		added: [
			'Anyone can submit an app to the new Modc App Store, with a short form or a pull request. Submit an app is at the bottom of the App Store, in Stores, and in an empty search.',
			'Modc is listed under App Store › Stores › Suggested, for owners who want community-submitted apps.',
		],
	},
	{
		version: '0.9.60',
		date: '2026-11-22',
		title: 'Files on every computer, and the iPhone bar',
		added: ['Files lists the computers in your swarm. Open one to browse its home folder, upload, download, or copy a file to this server. A computer needs Files switched on in Machines.'],
		fixed: ['On an iPhone home-screen app, Omarchy Server no longer adjusts the page after the keyboard closes. That adjustment could leave a dark strip under the bottom bar until the app was reinstalled.'],
	},
	{
		version: '0.9.59',
		date: '2026-11-22',
		title: 'A welcome, and one place for how things look',
		added: ['The first time you sign in on a device, a short setup walks you through picking a layout and a theme and shows where things are. Skip it any time.'],
		fixed: [
			'Layouts and themes live together in Appearance. Layout comes first, with pictures of each choice. On the desktop, right-click the background and choose Appearance….',
			'On an iPhone home-screen app, the strip under the bottom bar is gone, and the bar is no longer cut off.',
		],
	},
	{
		version: '0.9.58',
		date: '2026-11-22',
		title: 'A stronger swarm',
		added: [
			'Swarm computers can update their connector from this server, one at a time or all at once, and you can change what a computer allows without removing it.',
			'Terminals on swarm computers keep running when you close them, and pick up where you left off. New session starts fresh.',
			'Each computer shows an hour or a day of CPU, memory, disk and network history, GPU memory and temperature, and fleet alerts for full disks, heat and waiting updates.',
			'Swarm computers can be suspended, shut down, and woken with Wake-on-LAN.',
			'New, off by default: Services, to see and start, stop or restart a computer’s user services and containers, and Files, to browse its home folder and copy files to and from this server. Keys, keyrings and browser profiles stay private.',
		],
		fixed: ['Connectors on Python 3.13 and newer connect to this server again.'],
	},
	{
		version: '0.9.57',
		date: '2026-11-22',
		title: 'The store, files, and the desktop tell the truth',
		fixed: [
			'A private app port stays off another app’s public port. A serial device whose name contains a colon still reaches the app. A named volume is not turned into an empty folder.',
			'Hardening an app is not treated as reaching into the server. An option that turns confinement off still is. A comment or an optional value is not reported as a missing setting.',
			'The store shows an install size, tries again when a store fails to load, and search ignores extra spaces and missing fields. A plugged-in device is not labeled unplugged.',
			'Favorites survive a rename. A full disk says so. Keep both names the copy in the right place. Trash times are local. Search stays in the folder you opened, and each Files window remembers its own folder.',
			'A name that starts with a dot is refused instead of vanishing. A large folder does not draw every row at once. Photo zoom stays on the photo, and a spreadsheet can be edited from the keyboard.',
			'The dock closes after a brush of the edge. Maximize fills a half-snapped window. Enter on a focused icon opens it. Signing out clears Later, so it can return next time.',
			'An unfinished disk check is not reported as clean. Unused space leaves out the other partitions. A new machine stays inside the sizes and names the server accepts. A theme keeps its name, and Show more continues past the first page.',
		],
	},
	{
		version: '0.9.56',
		date: '2026-11-21',
		title: 'Clip books, published apps, and a desktop that stays put',
		added: [
			'Each signed-in person has a private clip book. A file on this server or another computer stays a reference until you paste it. A file on a virtual machine stays on that computer. Factory reset clears every clip book.',
			'A studio on this server can publish a local app. Other apps call it with a token, and the web page stays behind sign-in.',
		],
		fixed: [
			'A published app does not start unless its own port stays on localhost.',
			'Copying a folder into a shortcut inside it is refused. Restoring from Trash keeps characters such as & in the name. Saving a text file keeps its line endings and a byte-order mark. A file that is not valid text can be viewed but not edited.',
			'Home folders can be shared on the network. A folder that failed to load does not also say it is empty, and an upload you cannot write shows that error once.',
			'An app whose page is down is shown as stopped. Uninstall waits until an install of that app finishes. Updating a stopped app leaves it stopped. An app that depends on itself is marked unsupported.',
			'A low port set by the app is not opened unless you allow system ports. The server uses a 172.16 address on the local network. A store that cannot be checked says which store failed.',
			'The wallpaper you chose shows after sign-in. Icons from a larger screen stay on screen. Clicking a stopped machine once does not start it twice. The assistant does not open again when the desktop is rebuilt.',
		],
	},
	{
		version: '0.9.55',
		date: '2026-11-21',
		title: 'Files, the desktop, and machines stay accurate',
		fixed: [
			'A swarm computer whose Storage is switched off says so. A computer that stops answering shows offline. It introduces itself once every five minutes.',
			'A thumbnail that failed is not kept for an hour. A missing file answers 404. Signing in too many times tells you when you can try again.',
			'Markdown and Word links stay in the document or open safely. Excel dates, times, and numbers match the workbook. Zip listings keep folders apart when they differ only by case, say when the list is cut off, and read older file names. Slide and PDF arrow keys leave a Rename box alone.',
			'Removing a local app store brings the usual store back. One bad listing leaves the other apps visible. A failed start, stop, or restart shows the container’s message. A folder path has to stay inside your home, and the review stays open when that path is refused.',
			'In Files, folders stay before files when you sort by size or date. Favorites show the file’s name and details. Search treats the same name as the same name. An upload refreshes Recents and keeps empty folders. Trash does not follow a link that points outside it.',
			'Super+Escape closes the system menu, and the launcher keeps the selected row in view. A window moved onto its own workspace leaves the tiles alone. A slow wallpaper does not replace a newer one. Windows stay on screen, a dragged title bar stays above a bottom dock, and the clock updates on the minute. Removing a theme clears its spinner.',
			'A port forward on a running machine waits for the next start, and a port another machine already uses leaves the form open. Name and start-order edits stay put when a switch is flipped. A task still running at restart is marked failed. Start rewrites the machine definition. Ejecting a disc reports a refusal. A live backup asks for room for two copies. Protection, start at boot, order, and notes do not ask for a restart.',
		],
	},
	{
		version: '0.9.54',
		date: '2026-11-21',
		title: 'Swarm computers, backups, and the desktop stay honest',
		added: ['The assistant can sign in with ChatGPT.'],
		fixed: [
			'A stuck network disk or a terminal that is not reading no longer freezes a swarm computer. A missing tool or a command that runs too long names that command, and removing a pool leaves /etc/fstab with its trailing newline.',
			'Storage no longer says to reinstall when a computer only reconnected. A computer that left the swarm stays in Backups, so you can restore it here or delete it. Skipped folders and unreadable files show as a warning, and older backups stay in the list.',
			'A key check that finishes after you edit the key, model, or address is ignored. A provider that cannot be reached names the address, and a tool result that is too long is cut so the next message still works.',
			'Desktop shortcuts act only while the desktop is in front. A screen that fails to load shows a message and a button. Uploading a photo keeps a theme change made during the upload and clears a solid colour. A hibernated computer can be started from its icon.',
			'Move from Unraid keeps names it cannot copy on the list, keeps hard links when copying folders, and a stopped move says how many items came over.',
			'An unplugged USB stick stays tied to its app and is left out until it is plugged back in.',
			'Replacing or downloading a file no longer removes a parent folder or hides a file that is not a regular file. A wallpaper change that fails says why.',
			'Machine snapshots and clones stay with the right disk. A machine name the hypervisor cannot hold is refused, and two machines cannot take the same name.',
		],
	},
	{
		version: '0.9.53',
		date: '2026-11-20',
		title: 'Fixes for the server, app windows and swarm computers',
		fixed: [
			'The server no longer stops when a swarm computer sends data for a closed terminal, when an update can’t read its own version, or when settings and backups are saved at the same moment.',
			'Closing an app window or download stops it on the app’s side too, and an app that drops mid-download no longer leaves the page waiting.',
			'Apps keep opening after signing another device out, and on devices that stay signed in for more than 30 days.',
			'A wrong password counts once and the form stays open. Settings › Devices shows when each device was really last used, and a shell or desktop that can’t open says why instead of “only the owner”.',
			'Switching Terminal or Desktop off for a computer closes what’s already open, and a computer that reconnects ends its old sessions.',
			'The CPU gauge counts virtual machine time once and stays steady when several pages are open.',
			'Swarm computers: closed terminals are cleaned up, storage works on older Linux versions, drive sleep survives a restart on Debian and Ubuntu, linked folders no longer break backups, and a failed restore leaves no empty folder.',
			'Opening the server by an IPv6 address works for app windows.',
		],
	},
	{
		version: '0.9.52',
		date: '2026-11-20',
		title: 'Lighter live gauges, and updates from a local copy',
		added: ['A server can update itself and its app store from a local copy of the source instead of GitHub (see the README).'],
		fixed: ['Live gauges for this server, its machines, apps and swarm computers come in one request, and the server only measures while someone is looking, so idle servers and computers stay quiet.'],
	},
	{
		version: '0.9.51',
		date: '2026-11-20',
		title: 'Sturdier when files are damaged, and assistant installs that finish',
		added: ['Approving an assistant install opens the same “Before you install” review as the App Store, so apps that need permissions, folders or a GPU install in one go.'],
		fixed: [
			'A damaged settings, backup, machine or certificate file no longer stops the server from starting, and nothing is overwritten. Damaged certificate notes keep the current certificate in use.',
			'Deleting a machine is refused when its state can’t be read, so a running machine never loses its disk.',
			'Apps that run as their own user, such as Jellyfin, can write to their own data folder.',
			'Only the owner can add or remove an app store.',
			'A computer leaves the swarm only when the server actually rejects its key, not after a local error.',
			'A long computer name in another language can’t crash the server, and a failed settings save shows an error instead of stopping the web server.',
		],
	},
	{
		version: '0.9.50',
		date: '2026-11-19',
		title: 'Remote desktop on your phone, and steadier apps',
		added: ['A remote desktop on your phone has a Fill the screen button, and one finger pans around the picture when it’s zoomed in or doesn’t fill the screen.'],
		fixed: [
			'The remote desktop keeps your phone’s keyboard open while you tap and type, and fits the screen again after the keyboard closes.',
			'Opening an app in its own tab works behind a reverse proxy, and tells you when app addresses need setting up instead of opening a broken page.',
			'Apps start again by themselves after the server restarts.',
			'Restarting or updating the server is quick instead of waiting up to 90 seconds.',
			'If Podman’s storage still belongs to another user, Apps says so and how to fix it.',
			'Installing over SSH without a terminal stops with a clear message instead of failing in the system update.',
		],
	},
	{
		version: '0.9.49',
		date: '2026-11-19',
		title: 'Format, unmount and mount extra disks',
		added: [
			'Settings › Storage: format an extra disk (blank, ext4 or exFAT), unmount it, and mount it again. Drives that hold the system, are in a pool, or are in use by encryption, LVM or RAID are never touched.',
			'The same for computers in your swarm, from their Storage page, plus pools and drive sleep there. Add a computer with Storage switched on (it’s off by default, as it can format disks).',
			'The assistant can see a swarm computer’s drives, including ones that are unmounted.',
		],
		fixed: ['A computer you add shows up as soon as it joins, and the theme menu on a swarm computer stays open while its numbers update.'],
	},
	{
		version: '0.9.48',
		date: '2026-11-19',
		title: 'Security fixes',
		fixed: [
			'The path computers use to upload backups can’t be used to reach anything else on the server.',
			'Move from Unraid leaves behind a container folder that would lead outside its share or app folder, and says so.',
			'Only the owner can update the server, change its update channel, or create, change or check storage pools.',
			'Intel graphics on computers in your swarm show how busy they are, including older chips.',
		],
	},
	{
		version: '0.9.47',
		date: '2026-11-19',
		title: 'Move from Unraid',
		added: [
			'Settings › Move from Unraid: connect to your Unraid server, tick what to bring over, and watch it come across. Unraid keeps running and isn’t changed.',
			'Shares are copied into Home (or a storage pool) and shared on your network again with the same names. Copies pick up where they left off if anything stops them.',
			'Docker containers become apps, with the same image, settings, ports and files from appdata. Folders they used from your shares point at the copied shares.',
			'VMs come over with their disks and settings (shut them down on Unraid first).',
		],
		fixed: ['The installer now makes sure rsync and ssh are on the server (needed to move from Unraid). Run it once more when it asks.'],
	},
	{
		version: '0.9.46',
		date: '2026-11-19',
		title: 'Backups to your NAS',
		added: [
			'Settings › Backups: back up your apps and server settings to a shared folder on your NAS. Pick the NAS, sign in, choose a share, and it’s on.',
			'Backups run every night (or weekly, at the time you choose). Only what changed is sent, and the last 7 days, 4 weeks and 6 months are kept.',
			'Everything is encrypted with a recovery key that only you have. Save it somewhere safe, away from the server.',
			'Restore any app to how it was in an earlier backup, or open your NAS backups on a new server with the recovery key.',
			'Back up your other computers too: add them in Machines › Local swarm with Backups on, then in Settings › Backups tick the folders to save and when. A computer that’s off at backup time catches up when it’s back, and it can add backups but never delete them.',
			'Restore a computer’s folders into a new Restored folder on it, without touching what’s there now.',
		],
	},
	{
		version: '0.9.45',
		date: '2026-11-18',
		title: 'USB sticks for apps and VMs',
		added: [
			'Give a USB serial or Zigbee stick plugged into this server to one virtual machine or app, from its Devices tab or by asking the assistant. Home Assistant and similar apps then see it. Owner only.',
			'Approve cards say what will happen in plain words, with the names of the things involved, like “Give the SkyConnect stick to Home Assistant”.',
		],
		fixed: ['Approve cards from apps always show the app, the real tool and every value it will use, so a step can’t hide behind its own description.'],
	},
	{
		version: '0.9.44',
		date: '2026-11-18',
		title: 'Installer fix',
		fixed: ['On a fresh install, the installer could stop right after installing packages with “cannot touch …/.widget-offered”, skipping the download and build. It now runs every step.'],
	},
	{
		version: '0.9.43',
		date: '2026-11-18',
		title: 'A smarter assistant, more providers',
		added: [
			'Anthropic (Claude) joins Grok and OpenAI in Settings → Assistant → Add.',
			'Keys are checked with the provider before you save them, and the Model field lists the models it actually serves. Each key has Check connection.',
			'Edit a saved provider: its name, key, model, API and address, without deleting and re-sharing it.',
			'Choose how hard each key’s model thinks: Default, Low, Medium or High.',
			'Long chats are summarized instead of forgetting how they started.',
			'Ask the assistant to switch this server between the Ubuntu and Hyprland layouts.',
			'Creating a VM from the assistant asks you for its password on the Approve card.',
		],
		fixed: [
			'Closing the assistant no longer stops its reply. It finishes and is there when you come back.',
			'Closing the assistant on a phone no longer leaves the screen zoomed in.',
			'A busy or briefly unreachable provider is retried instead of ending the reply.',
			'Models that can’t take tool calls (like Gemma on Ollama) work with the assistant.',
			'Custom endpoints are owner-only, since they let the server reach any address.',
			'Switching an installed server to another branch fetches that branch properly.',
		],
	},
	{
		version: '0.9.42',
		date: '2026-11-18',
		title: 'Desktop or phone, your choice',
		added: ['The first time you sign in on a device, choose Desktop or Phone & tablet (the one that suits the screen is marked), or let it decide automatically. Change it any time in Settings → Layout.'],
		fixed: [
			'Automatic now picks the desktop on a touchscreen PC or touch laptop with a mouse or trackpad, and always the phone layout on a phone.',
			'Automatic no longer flips between desktop and phone when a window is snapped to half the screen or resized a little.',
			'The desktop’s “Right-click the desktop” tip can be closed, and stays gone once you’ve closed it, opened a window or used the desktop menu.',
		],
	},
	{
		version: '0.9.41',
		date: '2026-11-18',
		title: 'Put your assistant anywhere',
		added: [
			'Drag the floating character anywhere on the screen. It follows your finger or mouse, leans as it moves, settles where you drop it, and stays there on every device (phone and desktop each keep their own spot). Arrow keys move it too.',
			'The characters have no background now, just the character, with smoother motion: gentle breathing, springy hops, and frames that blend into each other.',
		],
	},
	{
		version: '0.9.40',
		date: '2026-11-18',
		title: 'Meet Oma',
		added: [
			'The assistant has a face: Oma, the Omarchy mascot, floats above the page and opens the assistant. It listens, thinks, talks, works, celebrates a step that finished, and naps when things are quiet.',
			'Settings → Assistant → Choose Your AI Assistant: Oma, Patch, Pixel, Stack, Pulse or Orbit. Give it a name, and set its size and how lively it is (or keep it still). Saved to your account, so it follows you to every device.',
		],
		fixed: ['On a phone, scrolling in the assistant scrolls the chat, not the page behind it.'],
	},
	{
		version: '0.9.39',
		date: '2026-11-18',
		title: 'Assistant',
		added: [
			'Assistant: ask about this server and your swarm, and have it install, start or update apps, manage machines and change the look. Lookups run straight away; anything that changes something waits for you to tap Approve. Add a SpaceXAI (Grok) or OpenAI-compatible API key in Settings → Assistant.',
			'Pick a wallpaper and theme together from one card.',
		],
		fixed: ['On a phone, a machine’s Hibernate, Stop and Clone buttons stay visible when its Summary or Hardware panel is tall.'],
	},
	{
		version: '0.9.38',
		date: '2026-11-17',
		title: 'Finish updates that need the installer',
		added: [
			'When an update needs the installer run again (new system packages or a changed storage helper), Omarchy Server asks at your next sign-in. Run the installer opens it in the terminal, where sudo asks for your password on the server.',
		],
		fixed: ['Running the installer from Omarchy Server’s own terminal no longer stops partway when it restarts the server.'],
	},
	{
		version: '0.9.37',
		date: '2026-11-17',
		title: 'Battery and GPU at a glance',
		added: [
			'On a laptop, Home shows a Battery ring with charging state or time left, and System shows each battery pack with a short history.',
			'Home shows a ring for each graphics card.',
			'Opening a computer in your swarm shows the same rings as Home, including its graphics cards and battery.',
			'The version you’re running is shown in the desktop menu, on the sign-in screen, in System and in Settings.',
		],
		fixed: [
			'A laptop’s NVIDIA graphics card is no longer woken just to read how busy it is while it’s asleep, which saves battery.',
			'The small facts under the rings line up evenly.',
		],
	},
	{
		version: '0.9.36',
		date: '2026-11-17',
		title: 'A terminal that fits and scrolls',
		added: [
			'The terminal fills its window: make the window bigger (or rotate your phone) and the shell gets more columns and rows, at the same text size, instead of zooming in.',
			'Scroll back through everything that happened: with the mouse wheel and a scrollbar on a computer, or by dragging on a phone, which keeps gliding when you let go. Changing the window’s size no longer jumps you back to the bottom.',
			'In full-screen programs such as less, man and vim, swiping moves through them.',
			'On a phone, the keyboard no longer covers the prompt: the terminal shrinks to the space above it.',
		],
		fixed: [
			'The arrow, Home and End buttons on the phone’s key row now work in programs like less and vim.',
			'Typing straight after reopening the terminal could be lost.',
		],
	},
	{
		version: '0.9.35',
		date: '2026-11-17',
		title: 'Hyprland layout: minimize and restore',
		added: ['In the Hyprland layout, Super+M minimizes the window and Super+Shift+M brings back the last one you minimized, to the same place in the tiles.'],
	},
	{
		version: '0.9.34',
		date: '2026-11-17',
		title: 'A Hyprland layout for the desktop',
		added: [
			'Desktop & Dock → Layout → Hyprland: windows tile side by side, with workspaces 1–9 on the top bar and Omarchy’s Super shortcuts (Super+Return for a terminal, Super+1–9, Super+arrows, Super+Q and more; Super+K lists them). Ubuntu stays the default, and switching back keeps your dock and icons.',
			'Using it from an Omarchy computer: copy the snippet from Desktop & Dock → Layout into your Hyprland key config, then press Scroll Lock (or Super+F12) to keep Super in the browser, and again to give it back. On https:// in Chrome, Edge or Brave, the lock chip on the bar can take Super in full screen instead.',
			'With a machine’s screen focused, Super shortcuts go to that machine.',
		],
	},
	{
		version: '0.9.33',
		date: '2026-11-17',
		title: 'Your GPUs, live',
		added: ['System shows a live card for each graphics card (NVIDIA and AMD): how busy it is, its memory and temperature, with a graph of the last two minutes. Servers without one look the same as before.'],
	},
	{
		version: '0.9.32',
		date: '2026-11-17',
		title: 'Safer sharing, faster loading',
		added: [
			'Omarchy Server opens faster: Files, the App Store, Terminal and machine screens load the first time you open them, the App Store list is about a third smaller, and the desktop wallpapers are lighter.',
			'Hover the Omarchy Server version in Settings to see how long it has been running and its exact build.',
		],
		fixed: [
			'Only the server’s owner can open its shell, an app’s shell, this server’s own desktop, or a Local swarm computer. Members keep their apps and virtual machine screens.',
			'Network shares: only the owner can set them up, hidden folders can’t be shared, files saved to a no-password share are no longer saved as you, and shares are open on your home network only (not over Tailscale).',
			'An app’s listing can no longer reach your private folders (such as SSH keys) through tricks in its folder paths.',
		],
	},
	{
		version: '0.9.31',
		date: '2026-11-16',
		title: 'Local swarm: your other Linux computers',
		added: [
			'Machines → Local swarm: join your other Linux computers (Omarchy, Ubuntu, Debian, Fedora, Arch, openSUSE and their relatives) with one command, and see them here with their CPU, memory, disks, temperature and updates waiting.',
			'Open a terminal on any of them, or see and use its desktop (Hyprland, Sway and other X11 or wlroots desktops), right from Omarchy Server.',
			'Manage them: install verified Omarchy plugins at the exact version the registry checked, change the Omarchy theme, run updates in a terminal you can watch, or restart.',
			'Add a computer walks you through it: choose what it may do, copy the command, paste it on that computer. It checks it’s talking to your server before it sends anything, the code works once, and the computer opens no ports.',
			'Each computer only allows what you chose when it joined. You can switch things off later, rename it, or remove it, and a removed computer’s connector forgets your server and stops.',
			'Omarchy Server now updates from the repository it was installed from, so a server installed from the development copy (omarchy-server-dev) gets development updates, and one installed from here gets these.',
		],
	},
	{
		version: '0.9.30',
		date: '2026-11-16',
		title: 'Your terminal keeps running',
		added: [
			'Closing the terminal no longer ends your shell. Open it again, on this device or another, and you’re right where you left off, with what was on screen and anything you left running still going. App shells work the same way, one per app. (A Local swarm computer’s terminal still ends when you close it.)',
			'If the connection drops, Reconnect picks up the same shell. Open it on two devices at once and both show the same session.',
			'New session (the circular arrow at the top) ends the running shell and starts a fresh one. Typing exit ends it too.',
			'Restarting the server, or installing an Omarchy Server update, still ends running shells.',
		],
		fixed: ['Closing the terminal used to leave its shell running out of sight on the server, with no way back to it. Shells now stop when you exit them or start a new session.'],
	},
	{
		version: '0.9.27',
		date: '2026-11-15',
		title: 'Bell back to size; sharing on a fresh Samba',
		fixed: [
			'The notification bell no longer grows huge while an update is waiting.',
			'Sharing a folder failed with “Can’t load /etc/samba/smb.conf” on a server where Samba had never been set up (Arch doesn’t create that file). Omarchy Server now writes it before setting the share password.',
		],
	},
	{
		version: '0.9.26',
		date: '2026-11-15',
		title: 'Omarchy look by default, and solid colours',
		added: [
			'Solid colours: choose a plain colour instead of a picture, for the phone’s background (Appearance → Solid colour) and the desktop’s wallpaper (Personalize → Background → Solid colour). Pick one of the swatches or any colour you like.',
			'New installs start on the Omarchy theme, with the Omarchy desktop’s own colours and background. If you already chose a theme, nothing changes.',
		],
	},
	{
		version: '0.9.25',
		date: '2026-11-15',
		title: 'System updates the Omarchy way',
		fixed: [
			'The fix for a half-updated Samba now uses omarchy update, which Omarchy requires (it stops a direct pacman -Syu, because its own update also takes a snapshot and runs migrations and hooks). The installer updates the system the same way before adding anything.',
		],
	},
	{
		version: '0.9.24',
		date: '2026-11-15',
		title: 'Network shares fix themselves up',
		fixed: [
			'If Samba is half-updated (Samba and its libraries at different versions, which stopped sharing from working), the share screen now says so and gives one command to fix it, with an Open Terminal button, and carries on by itself once it’s done.',
			'The installer now installs what it needs together with the system’s waiting updates, the way Arch and Omarchy update, so this can’t happen on new installs. Running it again also repairs a Samba that’s already out of step.',
		],
	},
	{
		version: '0.9.23',
		date: '2026-11-15',
		title: 'New icon, and a bell that rings for updates',
		added: [
			'Omarchy Server has a new icon, in the browser tab and when added to a home screen.',
			'When an Omarchy Server update is ready, the bell rings and shows a badge: on the desktop’s top bar (new) and in the phone layout. Tap the update to see what’s new and install it. Updates are now checked every 30 minutes instead of every 6 hours.',
		],
	},
	{
		version: '0.9.22',
		date: '2026-11-15',
		title: 'No more half-updated system packages',
		fixed: [
			'Sharing a folder could fail with a long “version … not found” error from Samba. That happens when Samba was installed without updating the rest of the system, so its parts didn’t match. Omarchy Server now explains it and how to fix it (update the whole system once), and its installer no longer installs packages on top of waiting updates. Tailscale is set up the same careful way.',
		],
	},
	{
		version: '0.9.21',
		date: '2026-11-15',
		title: 'Omarchy plugins, network shares, and the Omarchy Desktop on your desktop',
		added: [
			'Omarchy plugins in the App Store: browse widgets, panels and tools from the Omarchy plugin registry and install them in one tap. Only plugins the registry has verified are shown, and each is installed at exactly the version it verified.',
			'Share a folder on your network from Files: right-click it (or open a folder and tap the share button on a phone), choose whether a password is needed and whether others can change files, and mount it from any computer. You can also pick your own share password.',
			'The Omarchy Desktop can be an icon on your desktop or in the dock (Machines → Add to desktop, or Personalize → Desktop icons).',
		],
		fixed: ['The “Check for new apps” button now works (the server wasn’t letting its request through).'],
	},
	{
		version: '0.9.20',
		date: '2026-11-15',
		title: 'Installs show up right away, one theme everywhere, apps open inside',
		fixed: [
			'A new app shows up as installing straight away, in the App Store and with your installed apps, instead of only after reloading the page. The app list also stays quick while a big app downloads.',
			'Your theme, accent and desktop look are saved on the server and followed by every device: change them on one, and the others switch when you go back to them, without being put back by an older copy.',
		],
		added: ['Opening an app on a phone or tablet shows it inside Omarchy Server, full screen with a back button, instead of leaving Omarchy Server. Apps that need https still open on their own when you’re on plain http.'],
	},
	{
		version: '0.9.19',
		date: '2026-11-15',
		title: 'Check for new apps',
		added: ['A refresh button at the top of the App Store checks your stores for new apps right away, instead of waiting for the hourly check.'],
	},
	{
		version: '0.9.18',
		date: '2026-11-15',
		title: 'You choose where an app keeps your files',
		added: [
			'Apps can ask where to keep your files when you install them: inside the app, or in a folder in your home that you can also open from Files and the desktop. A folder of yours stays when you uninstall the app. Hidden folders and anything outside your home are refused.',
			'Dev-Space is coming to the App Store: your projects, GitHub and AI coding agents with live previews. It asks where your projects should live.',
		],
		fixed: [
			'Apps that leave sign-in to Omarchy Server can now tell that a request really came through its sign-in, so nothing else that reaches them gets in.',
		],
	},
	{
		version: '0.9.17',
		date: '2026-11-15',
		title: 'Tailscale',
		added: [
			'Tailscale is in the App Store, first in the list. It installs Omarchy’s own Tailscale on the server (the same way the Omarchy menu does), and Open shows Tailscale’s page behind your Omarchy Server sign-in. Press Log In there to join your tailnet, then reach Omarchy Server from your phone or laptop anywhere at its Tailscale address.',
			'Stop and Start disconnect and reconnect the server from your tailnet without logging in again. Uninstall logs out and removes Tailscale, unless it was already installed before.',
			'Your tailnet devices can reach what the server shares on its network, like the server’s own Wi-Fi or wired neighbours can. Everything kept private on the server itself (Omarchy Server’s internals and each app’s inner port) stays private, and apps still ask you to sign in.',
			'No need to run the installer again. If Tailscale is already set up (for example from the Omarchy menu), it’s used as it is. Otherwise, on servers installed before this version, the App Store shows one command to run once, with an Open Terminal button, and carries on by itself when it’s done.',
		],
	},
	{
		version: '0.9.16',
		date: '2026-11-15',
		title: 'Apps open when they should',
		fixed: [
			'An app could say Running while Open said “still starting” for three minutes. Open now waits only while an app really is starting up. If an app is running but its web page doesn’t answer, it says so at once, with Try again and Open anyway.',
			'The app’s page shows “Web page: Ready / Starting up / Not answering” next to Running, so you can tell the two apart.',
			'AdGuard Home no longer disappears after its setup (it was moving its page to another port). Update AdGuard Home from the App Store to get the fix.',
			'Brave and Chrome (the streamed ones) now open their video ports in the server’s firewall. Update them from the App Store.',
			'Apps that use their own port, like Home Assistant, now open correctly when you use Omarchy Server over https://.',
		],
	},
	{
		version: '0.9.15',
		date: '2026-11-15',
		title: 'A clean way out',
		added: [
			'“omarchy-server uninstall” in a terminal removes Omarchy Server and keeps your account, apps, machines and their data, so installing again picks up where you left off. Add --purge to delete those too: it asks you to type “delete”, and refuses while any app or machine still exists. Your files, ~/Pools and installed packages are never touched (thanks, nixfred).',
		],
	},
	{
		version: '0.9.14',
		date: '2026-11-15',
		title: 'App updates that work',
		fixed: [
			'Updating some apps failed with “Internal error”: the update couldn’t write into the app’s data folders, which belong to the app’s container. Updates now get past that, and never overwrite settings an app keeps in its data folders.',
			'If an update does fail, it says why (for example, the new version couldn’t be downloaded), and the app keeps running and stays reachable on its old version. Before, it could be left unreachable.',
			'The old version keeps running while the new one downloads, so an app is only down for the moment it restarts.',
			'An update no longer moves the app to a different internal port, and new data folders from an update are set up for the app’s container.',
		],
	},
	{
		version: '0.9.13',
		date: '2026-11-14',
		title: 'One certificate for everything',
		fixed: [
			'Apps opened over https:// used a different certificate from the one you trust on your devices, so they could show a warning. Apps and the web app now share one certificate, and the Security settings (always use the secure address, replace the certificate) apply to both. If you accepted a warning for an app before, you may see it once more.',
			'Pasting your password (with its Enter) into the installer’s account step works now instead of waiting forever.',
			'A machine name of 64 characters no longer gives the machine an invalid name on its network (thanks, nixfred).',
		],
	},
	{
		version: '0.9.12',
		date: '2026-11-14',
		title: 'Steadier under the hood',
		fixed: [
			'Two changes saved at the same moment (installing an app while another finished, say) could lose one of them. Saves now happen one at a time and always land.',
			'Restoring from the Trash only ever puts things back inside your home folder, even if the Trash’s notes say otherwise.',
			'Switching and installing Omarchy themes now run one after another instead of at the same time.',
			'The installer stops with a clear message on computers that aren’t x86-64.',
		],
	},
	{
		version: '0.9.11',
		date: '2026-11-14',
		title: 'Use a bigger drive in one tap',
		added: [
			'Made the system drive bigger? System → Storage → “Use the extra space” grows the partition, its encryption (asks for the disk password) and the filesystem while the server runs. It only ever grows, only the last partition, and nothing is erased. Run the installer again once to add it.',
		],
		fixed: ['The suggested growpart command needed a package Omarchy doesn’t include; Omarchy Server now does the growing itself with tools every system has.'],
	},
	{
		version: '0.9.10',
		date: '2026-11-13',
		title: 'Ready to share',
		fixed: ['Settings no longer links to an installer ISO. Omarchy Server installs with one command on an Omarchy machine.'],
	},
	{
		version: '0.9.9',
		date: '2026-11-13',
		title: 'Accurate system stats',
		added: [
			'Made a drive or virtual disk bigger? System usage now shows how much of it isn’t in use yet, and the exact commands to grow the partition, encryption and filesystem into it.',
			'Storage pools appear in System usage with their own space, drives, layout and any errors.',
			'“What’s using it” now shows real CPU and memory for each app and machine, and storage is split into apps, machines, your files and the system (measured in the background).',
		],
		fixed: [
			'Temperature showed 0 °C when there’s no sensor. It now says “Not available in a virtual machine” (virtual machines have no sensors) or “No sensor found”, and more kinds of CPU sensors are read on real hardware.',
			'Storage percentages now match what df reports (space kept back for the system isn’t counted as free).',
		],
	},
	{
		version: '0.9.8',
		date: '2026-11-13',
		title: 'Your desktop follows you',
		fixed: [
			'The desktop’s wallpaper, look, accent, dock and desktop icons were kept only in the browser you set them in. They’re now saved on the server for your account, so every browser you sign in on shows the same desktop. The newest change wins, and a browser picks up changes made elsewhere when you switch back to it.',
		],
	},
	{
		version: '0.9.7',
		date: '2026-11-13',
		title: 'Right-click and paste',
		added: [
			'Terminal: right-click pastes, and with text selected it copies it, like most terminals. (On http:// the browser’s own menu opens instead, with Paste in it.)',
			'Omarchy desktop: Ctrl+V, Ctrl+Shift+V and ⌘V paste what you copied on this computer into the desktop’s apps, on http:// and https://.',
			'On the secure (https://) address, your clipboard is also handed to the desktop before you right-click, so an app’s own Paste menu pastes it, and anything copied on the desktop lands on this computer’s clipboard.',
		],
	},
	{
		version: '0.9.6',
		date: '2026-11-13',
		title: 'Dock your way',
		added: [
			'Desktop & Dock → Dock: put the dock on the left, bottom, right or top, and set the icon size anywhere from 28 to 80 px with a slider.',
			'Dock animations: icons lift or magnify (macOS-style, with adjustable magnification) under the pointer, and apps bounce while they open. Each can be turned off, and they turn down by themselves when your computer asks for reduced motion.',
		],
		fixed: [
			'Full screen now says why the Windows / Super key isn’t reaching the desktop: browsers only hand it over on the secure (https://) address, in Chrome, Edge or Brave. On a Linux computer, Right Alt now works as Super by default.',
		],
	},
	{
		version: '0.9.5',
		date: '2026-11-13',
		title: 'The Super key reaches your desktop',
		added: [
			'Your Windows / ⌘ / Super key now always reaches the Omarchy desktop and your machines as Super, from any browser that receives it.',
			'Computers that keep Super for themselves (an Omarchy or Windows desktop): in Desktop’s Keys menu, choose Right Alt or Right Ctrl to work as Super instead. Your choice is remembered on that browser.',
			'A Super button in the Desktop toolbar holds Super down until you click it again, so Super + Enter, Super + Space and the rest work from any keyboard.',
			'Keys menu shortcuts for the Omarchy desktop: app launcher, Omarchy menu, terminal, close window and all shortcuts.',
			'On a phone or tablet, the super key works like ctrl and alt: tap it, then the next key. Double tap it for Super on its own.',
		],
	},
	{
		version: '0.9.4',
		date: '2026-11-13',
		title: 'More security, nothing taken away',
		added: [
			'Settings → Security. “Always use the secure address” (off until you turn it on) sends browsers opening a page over http:// to https://, here and in your apps. App clients and phone apps aren’t redirected.',
			'“Lock after viewing remotely” (on): after you sign in to the server’s screen from here, it locks again a minute after the last viewer leaves, so it isn’t left signed in at the machine. A reload or reconnect within that minute keeps it open.',
			'New servers get a certificate that browsers only accept for your home network (local names and private addresses), never for a real website. Existing servers keep theirs, so your devices keep working; Settings → Security → Replace switches when you’re ready.',
		],
		fixed: [
			'Storage pools never run setuid programs or use device files stored on them. New and imported pools are set up that way, and existing pools are updated automatically once the installer has been run again.',
			'An app’s exports.sh no longer receives the server’s key for app secrets; it gets the same values as before, and apps installed from now on only get their own.',
			'The machine Monitor tab accepts commands that look at or act on the machine (info, sendkey, stop, cont, system_reset…), but not ones that read or write files on the server or start programs.',
			'Only the owner can change which server this web app connects to.',
			'The “Use network ports below 1024” permission now says plainly that it applies to the whole server.',
		],
	},
	{
		version: '0.9.3',
		date: '2026-11-13',
		title: 'Security fixes',
		fixed: [
			'Apps no longer receive your Omarchy Server sign-in. Browsers send a server’s cookies to every port on it; each app’s gateway now removes all of Omarchy Server’s own cookies before a request reaches the app, and stops apps from setting them.',
			'The desktop’s screen is now shared on a private socket only you can open, instead of a local port that other programs and host-network containers could reach. Existing servers are moved over automatically.',
			'Guessing passwords is slowed down everywhere (wrong tries queue up and wait longer each time), without ever locking you out. A 2FA code now works only once.',
			'Installing an app now also asks before giving it the server’s own network, folders on the server, or system access (D-Bus, other programs). Your whole home folder, its hidden folders and system folders are never given to an app. Apps you already installed keep working and updating as before.',
		],
	},
	{
		version: '0.9.2',
		date: '2026-11-13',
		title: 'Brave and other streamed apps open securely',
		fixed: [
			'Apps installed before their listing was marked as needing a secure page (Brave (HTTPS) and others) kept opening over http:// and showed “This application requires a secure connection”. Installed apps now follow their listing without reinstalling.',
			'Chromium, Firefox, Calibre, digiKam, Kdenlive, FileZilla, LibreOffice and Obsidian open over https:// too.',
		],
	},
	{
		version: '0.9.1',
		date: '2026-11-13',
		title: 'Icons that follow your theme',
		added: [
			'The Omarchy theme now takes every colour from the theme your Omarchy desktop is using (backgrounds, text and its full colour palette), so changing the desktop’s theme changes Omarchy Server too.',
			'Dock, desktop and home screen icons follow the theme: flat, Omarchy-style tiles in the Omarchy theme, tinted from the palette in Midnight, Neon, Ember and Daylight, and the colourful originals in Horizon.',
			'The tab bar on phones is tinted the same way.',
		],
	},
	{
		version: '0.9.0',
		date: '2026-11-13',
		title: 'Machines, the Proxmox way',
		added: [
			'On the desktop, Machines looks like Proxmox: a server and machine tree, a toolbar (Start, Shutdown, Reboot, Stop, Pause, Hibernate, Desktop, Clone, Remove), settings panels and a task log.',
			'Summary with live CPU, memory, network and disk graphs, plus notes for each machine.',
			'Hardware: memory in MiB, sockets and cores, CPU type, BIOS (SeaBIOS or UEFI), display, chipset, network model, MAC address and disconnect; add, grow, tune and remove disks; add CD/DVD drives and insert or eject ISOs from your Home folder.',
			'Options: rename, start at boot with order and delay, boot order (disks, CD/DVD, network), boot menu, protection against deletion, QEMU Guest Agent, tablet pointer, ACPI and KVM.',
			'Cloud-Init: change the user, hostname, SSH public keys and password (only a hash is kept); applied at the next start.',
			'Snapshots (take, roll back, delete), Backups to Home → Backups → Machines (live for running machines) with restore as a new machine, full clones, the QEMU monitor and a task history.',
			'On phones and tablets, the machine sheet has every one of these settings in tabs.',
		],
		fixed: ['The https:// certificate is only made once an app needs it.'],
	},
	{
		version: '0.8.13',
		date: '2026-11-13',
		title: 'Secure connections (https://)',
		added: [
			'Omarchy Server and every app now also answer https:// on the same address and port, with your server’s own certificate.',
			'Apps that need a secure page (Brave (HTTPS), Vaultwarden, Actual) open over https:// automatically, and work inside windows when you use the secure address.',
			'Settings → Secure connection: switch to the secure address, and download the certificate to trust this server on your devices so browsers stop warning.',
		],
	},
	{
		version: '0.8.12',
		date: '2026-11-13',
		title: 'The App Store shows every app',
		fixed: [
			'The App Store kept showing the apps from when the store was first downloaded; it now picks up new apps within the hour, and all 586 appear right after this update.',
		],
	},
	{
		version: '0.8.11',
		date: '2026-11-13',
		title: 'Updates that fit in less memory',
		fixed: [
			'Updating no longer reinstalls every package each time, only when they change, so it needs far less memory and finishes sooner.',
			'On a computer with little free memory, the installer borrows temporary swap for the build and removes it afterwards.',
		],
	},
	{
		version: '0.8.10',
		date: '2026-11-13',
		title: 'About 580 apps',
		added: [
			'The TouchWorkStation store now lists about 580 apps, built from the public self-hosting catalogs and the projects’ own compose files.',
			'Apps that need a 32-character key (BookStack, Firefly III, Invoice Ninja and others) get one generated for your server.',
		],
		fixed: ['Apps that use ports below 1024, such as Pi-hole on port 53, now have those ports opened in the firewall.'],
	},
	{
		version: '0.8.9',
		date: '2026-11-13',
		title: 'Apps that need extra access',
		added: [
			'Container managers (Portainer, Dockge, Dozzle), DNS blockers (Pi-hole, AdGuard Home), VPNs (WireGuard) and reverse proxies can now be installed. The store lists exactly what extra access each one needs and installs only after you tick “Allow”.',
			'Apps that manage containers get your own rootless container engine, never the system one.',
			'Apps can now use ports below 1024 (DNS on 53, web on 80 and 443) and UDP ports, when you allow it.',
		],
		fixed: ['An update that would need new access is refused with a clear message instead of quietly gaining it.'],
	},
	{
		version: '0.8.8',
		date: '2026-11-13',
		title: 'Only the TouchWorkStation store',
		added: ['The TouchWorkStation store now has 150 apps, each packaged from its project’s own official image, with descriptions written for it.'],
		fixed: [
			'The Umbrel store is removed from your server. Apps you already installed from it keep running; to move one to the TouchWorkStation version, uninstall it and install it again from the store.',
		],
	},
	{
		version: '0.8.7',
		date: '2026-11-13',
		title: 'The TouchWorkStation app catalog',
		added: [
			'44 apps in the TouchWorkStation store, each packaged from the project’s own official Docker image with a description written for it: Jellyfin, Plex, Immich, Nextcloud, Home Assistant, Paperless-ngx, Open WebUI, the Sonarr/Radarr family, Gitea and more.',
			'Apps can use your Videos, Music, Pictures, Documents and Downloads folders, and open the extra ports they need (sync, torrents, SSH).',
			'New servers start with the TouchWorkStation store only. Other stores can still be added under App Store → Stores, and an installed app always stays with the store it came from.',
		],
		fixed: ['Folder paths written as ${NAME:-default} in a compose file are now understood.'],
	},
	{
		version: '0.8.6',
		date: '2026-11-13',
		title: 'Every Settings button works',
		fixed: [
			'Home Assistant (and other apps on the server’s own network) spun forever when opened: its port was never let through Omarchy’s firewall. It is now.',
			'Restart server and Shut down server now do what they say.',
			'System logs, Device name, Wi-Fi, Two-factor authentication and Signed-in devices (Sign out, Sign out all other devices) now work. Signing a device out also ends its access to your apps.',
			'Factory reset now resets Omarchy Server: its apps, machines and accounts go, and it starts first-time setup. Your own files, storage pools and the Omarchy desktop are left alone.',
		],
	},
	{
		version: '0.8.5',
		date: '2026-11-13',
		title: 'Sign in the desktop from anywhere',
		added: [
			'When the Omarchy desktop is at its sign-in screen, Desktop in Machines now offers “Sign in to the desktop”. Confirm your Omarchy Server password and the desktop signs you in once, the same way Omarchy’s own first boot does. It also clears a lockout after too many wrong passwords.',
			'Open waits for an app that’s still starting (Home Assistant often takes a minute), then goes to it, instead of landing on a page that doesn’t load.',
		],
	},
	{
		version: '0.8.4',
		date: '2026-11-13',
		title: 'Open goes to the app’s own link',
		added: [
			'Open now takes this tab straight to the app’s own address and port, like clicking a container’s link in Docker. Nothing is wrapped around the app, so nothing can stop it showing. Your browser’s back button returns to Omarchy Server.',
			'The Address on an app’s page is a link you can tap.',
		],
		fixed: ['In the desktop layout, a window that hasn’t shown its app after 8 seconds offers Open in a tab.'],
	},
	{
		version: '0.8.3',
		date: '2026-11-12',
		title: 'Apps open straight away',
		added: [
			'Open goes straight to the app’s page in its window. No more checks first.',
			'The Omarchy Server icon now sits in Omarchy’s own top bar (current Omarchy has no Waybar). It’s added once by itself; omarchy-server widget off removes it.',
			'The bell lights up when an update is waiting. Omarchy Server checks GitHub on its own every few hours; tap the note to update.',
		],
		fixed: [
			'Apps loaded but stayed hidden behind the spinner. That was a bug in the loading cover, and it’s fixed.',
			'The Omarchy desktop in Machines starts its screen sharing when it isn’t running, or says exactly why it can’t.',
		],
	},
	{
		version: '0.8.2',
		date: '2026-11-12',
		title: 'Omarchy themes',
		added: [
			'Settings → Appearance → Omarchy → Themes: every Omarchy theme with its preview and colours. Tap one to switch your whole desktop, like Takeout.',
			'Get more themes: the community themes from the Omarchy manual, ready to download in one tap. Themes you added can be removed again.',
			'When an app is slow to show, Omarchy Server now checks it and says why: still starting, not listening, or not allowed inside a window.',
		],
		fixed: [
			'The page sometimes stopped scrolling until you reloaded (after closing two sheets in a row). Fixed for good.',
			'Backgrounds and colours now work with current Omarchy, which keeps its theme in ~/.local/state, and follow the desktop when it changes theme.',
		],
	},
	{
		version: '0.8.1',
		date: '2026-11-12',
		title: 'Apps load, wallpapers in Appearance',
		added: ['Wallpaper now lives in Settings → Appearance, with the backgrounds from your Omarchy themes. Picking one sets it right away.'],
		fixed: [
			'Apps that run on their own port (Home Assistant, Plex, Pi-hole, AdGuard and others) spun forever inside Omarchy Server. They now open through a viewer port that lets them show, without proxy headers they reject.',
			'Apps whose web port comes from their settings (like Mempool) now get their web page connected.',
			'An app that takes a long time to show now says so after 15 seconds, with Try again and Open in a tab, instead of spinning forever.',
			'Removed the old wallpaper picker from the main Settings list.',
		],
	},
	{
		version: '0.8.0',
		date: '2026-11-12',
		title: 'One sign-in, every app, Omarchy backgrounds',
		added: [
			'Signing in to Omarchy Server now signs you in to every app too. No app asks for an Omarchy Server sign-in of its own.',
			'Every app in the store can be installed. Apps that need others (like Mempool needing Bitcoin Node and Electrs) list them and install them first, all in one go.',
			'Apps that talk to each other share a network, and apps that use Tor get a shared Tor connection.',
			'The Omarchy theme uses your Omarchy desktop’s backgrounds and colours. Pick any background from any Omarchy theme, or follow whatever the desktop shows.',
			'For apps that have a login of their own inside, the app screen shows its username and password, ready to copy.',
		],
		fixed: [
			'Apps that look up their own parts by name (like Immich’s database) can find them now.',
			'An app that other apps need can’t be uninstalled out from under them.',
		],
	},
	{
		version: '0.7.3',
		date: '2026-11-12',
		title: 'App windows load',
		fixed: [
			'Apps like Home Assistant showed “Couldn’t reach” in their window: they went through extra ports the firewall blocks. They now load straight from their own port, which is already open.',
			'Removed leftover wording from another project in app window messages.',
		],
	},
	{
		version: '0.7.2',
		date: '2026-11-12',
		title: 'Apps open right here',
		added: [
			'Open shows the app full screen inside Omarchy Server, in the same tab, like an app on your phone. Back (on screen or your phone’s own back gesture) returns to where you were.',
			'The app screen has Reload, and a button to open it in its own browser tab if you ever want that.',
		],
		fixed: [
			'Open in the App Store and on an app’s page no longer starts a new browser tab.',
			'Desktop windows sign the browser in to apps by themselves instead of opening a sign-in tab.',
		],
	},
	{
		version: '0.7.1',
		date: '2026-11-12',
		title: 'App installs fixed',
		fixed: [
			'Store apps failed to install and showed “Unknown”: their own files were handed to the container user, so Omarchy Server couldn’t read them anymore. Only their data folders are handed over now.',
			'A failed install shows what went wrong on the app’s page, with a Try again button.',
			'Apps that name their web container differently (like SearXNG) now install.',
		],
	},
	{
		version: '0.7.0',
		date: '2026-11-12',
		title: 'Software update',
		added: [
			'Check for updates now checks GitHub for a newer Omarchy Server and shows what’s new in it.',
			'Update installs it from the web app: download, build and restart, and it rolls back if anything fails.',
			'When an update also needs the installer (new packages or storage changes), Settings says so and shows the command.',
		],
		fixed: ['Removed the Beta channel switch, since there are only stable updates for now.'],
	},
	{
		version: '0.6.1',
		date: '2026-11-12',
		title: 'Fixes',
		fixed: [
			'Machines failed to start with “does not support video model virtio”. They now use the standard display, and Start finishes a machine that failed that way.',
			'Apps like Gitea that need their own settings (from the app’s exports.sh) now install: about 300 apps install, up from about 200.',
		],
	},
	{
		version: '0.6.0',
		date: '2026-11-12',
		title: 'Terminal, desktop and 400 apps',
		added: [
			'Terminal: a real shell on the server from the web app, and a shell inside any installed app.',
			'Omarchy desktop: see and use this server’s own Omarchy desktop from Machines, behind your sign-in.',
			'App Store: about 400 apps, in your TouchWorkStation store and Popular apps, added automatically. Apps that need something Omarchy Server can’t provide yet say why instead of failing.',
			'Top-bar icon, launcher entries and an omarchy-server command to open, check and restart the server.',
		],
	},
	{
		version: '0.5.0',
		date: '2026-11-12',
		title: 'ZFS',
		added: [
			'ZFS pools: choose Btrfs or ZFS for a new pool, with Combined, Mirrored, RAID-Z1 and RAID-Z2 layouts.',
			'Import existing ZFS pools, including ones from another computer, without changing anything on them. They show up in Files under Home → Pools.',
			'ZFS pools show their health, drive errors and last error check, and can be checked or removed from here.',
			'ZFS is optional: add it by running the installer with --zfs.',
		],
		fixed: ['A ZFS pool’s last error check is shown instead of “Never checked”.'],
	},
	{
		version: '0.4.0',
		date: '2026-11-12',
		title: 'One-tap machines',
		added: [
			'Desktops: Ubuntu Desktop, Debian Desktop and Fedora Desktop install with one tap and start into their desktop.',
			'More systems: Ubuntu 26.04, Fedora Server and Alpine Linux.',
			'Omarchy as a machine: it downloads the official ISO and installs itself with your username and password.',
			'Your own ISO: any .iso in Files shows up under New machine. Windows 10 and 11 install by themselves with your account; other ISOs boot their installer on the Desktop.',
		],
	},
	{
		version: '0.3.0',
		date: '2026-11-12',
		title: 'Apps, NAS and an installer',
		added: [
			'App Store: add an app store by its address, then install, open, stop, update and remove apps. Apps run in rootless Podman as your own user.',
			'Every app is behind your Omarchy Server sign-in. Sign in once and every app on the server opens.',
			'Storage: see every drive’s health, temperature and age, and set hard drives to sleep when idle.',
			'Pools: combine blank drives into a pool (mirrored if you like), import existing Btrfs drives, add drives later, and check for errors. Pools show up in Files under Home → Pools.',
			'Share any folder on your network (SMB) from Files.',
			'Installer ISO: one download sets up a new Omarchy Server (Settings → Installer ISO).',
		],
		fixed: ['Settings no longer shows options that don’t apply to Omarchy Server.'],
	},
	{
		version: '0.2.0',
		date: '2026-11-12',
		title: 'Virtual machines',
		added: [
			'Machines: create Ubuntu, Debian or Arch Linux virtual machines from the web app. Each download is checked against its publisher’s checksum before use.',
			'Your machine’s account is set up on first boot. Only a hashed copy of its password is ever written.',
			'Open a machine’s screen in the browser, with the touch keyboard and paste key.',
			'Port forwarding: reach SSH, web or remote desktop inside a machine from your other devices.',
		],
		fixed: ['Omarchy Server now uses its own name everywhere.'],
	},
	{
		version: '0.1.0',
		date: '2026-11-11',
		title: 'First light',
		added: ['Sign in, system stats, and your real home folder as Files: browse, preview, upload, download, organise, trash and restore.', 'One-line installer that runs everything as your own user.'],
	},
]

// A number with an optional letter after it: 0.9.93 < 0.9.93A < 0.9.93B < 0.9.94.
const parse = (v: string) =>
	v.split('.').map((part) => {
		const m = /^(\d*)([A-Za-z]*)/.exec(part) ?? []
		return [parseInt(m[1] ?? '', 10) || 0, (m[2] ?? '').toUpperCase()] as const
	})
export function newer(a: string, b: string) {
	const x = parse(a)
	const y = parse(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const [na, la] = x[i] ?? [0, '']
		const [nb, lb] = y[i] ?? [0, '']
		if (na !== nb) return na > nb
		if (la !== lb) return la.length !== lb.length ? la.length > lb.length : la > lb
	}
	return false
}
// Releases a device hasn't seen yet. With no record (first run of this feature), just the newest one.
export function unseen(current: string, lastSeen: string | null): Release[] {
	const upTo = CHANGELOG.filter((r) => !newer(r.version, current))
	if (!lastSeen) return upTo.slice(0, 1)
	return upTo.filter((r) => newer(r.version, lastSeen))
}
