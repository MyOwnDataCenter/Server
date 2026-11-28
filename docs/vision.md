# Vision

My Own Data Center is the application you use to watch and run a data center you own. One sign-in reaches the physical machines, the virtual machines, the container applications, the storage, the backups, and the files. The same product is in your hand on a phone and on the desk in a browser.

The short name in the interface is MODC. A sentence that needs the product name says My Own Data Center. The command remains `omarchy-server`. Certificates, the backup folder, and system markers keep the names already installed on a machine.

## Who it is for

A person who runs their own hardware. This server is the place they sign in. Other computers join it and stand as peers. They manage it from a phone, a tablet, or a desktop, including when they are not sitting at the machine.

The owner manages the server. Someone else who signs in sees the machines and actions they were allowed.

## What it covers

These are one product. A new capability is a screen the person already understands, aimed at the machine it belongs to.

### The fleet

Home shows whether the data center is healthy. CPU, memory, storage, GPU, temperature, and laptop battery are aggregates across the computers that are online. A warning or a danger is visible on the gauge and opens the machines behind it. A reading the software does not have is shown as missing.

### Physical machines

Every physical computer is the same kind of thing: this server, a computer that joined through the connector, and the next one you add. Each has a name, a state, and the same page. Grouping may show which machine hosts guests. The page itself does not change its shape because of that grouping.

### Virtual machines

A virtual machine is a machine that runs on a host. Its page matches a physical machine. The host adds only what the hypervisor really provides: power, the guest's screen, USB devices, port forwards, snapshots, cloud-init, and disk backups. A virtual machine does not host further virtual machines.

Two states are part of the product:

- Without a connector, the host can power the guest and open its screen while it is running. Gauges use the host's measurements. The guest's files and shell are not invented.
- With a connector, the guest is managed like a joined computer, plus the host controls above. The connector is the same Linux connector a physical computer uses, tied to that virtual machine. It runs on Linux with systemd or Alpine OpenRC. Windows, macOS, and Home Assistant do not run it.

### System containers

A system container (LXC/Incus) is a machine that runs on this server and shares its kernel. It sits in the same Machines list as this server, joined computers, and virtual machines. Online means the instance is running; Offline means it is shut off; Paused means it is frozen. The page keeps Incus controls: power, resources, ports, snapshots, export backups, templates, and options. Without a connector, host-mediated Files and Terminal stay useful. With a connector, Files, Terminal, Pin, and folder backups follow the grants, the same way they do for a joined computer. Apps (Podman compose) are not offered on system containers. Desktop, Storage (host disks), and nested virtual machines are not offered. Home nests its load under the host so CPU and memory are not counted twice.

### Applications

An application is an application container on one machine. It is installed, started, stopped, and opened there. It has a name, a state, and an address when it serves one. It is not a computer: it has no drives of its own, no connector, and no row in the machine list. Its data and its updates belong to that container. The catalog asks which machine receives an install, and it only offers this server or a machine whose connector is online. A virtual machine can take an application while its connector is online and the machine is running. That install is sent to the connector and runs on that machine. System containers are not App Store targets. A machine with no connector, or a connector that is offline, is not offered.

### Storage

Disks, pools, removable media, and drive sleep belong to the machine that holds them. Usage is that machine's storage, in real units. A virtual machine's image size on the host is the host's disk, not a fake reading of the guest's free space.

### Backups

Backups belong to the machine they protect. This server can keep the copies. Restoring is an action on that machine. Folder backups from a computer and disk backups of a virtual machine are different jobs and stay named as what they are.

### Files

There is one file manager. It lists this server and the other machines whose files can be read. A machine that cannot be read is left out. Move, copy, and the clip book work across this server, joined computers, and virtual machines whose files can be read. Each of those machines keeps its own recent files and favorites. The lists at the top of Files are those collections added together. A file shows which machine it came from.

### The screen and the shell

Every machine that can show a screen offers Desktop, and that includes a virtual machine's screen. Desktop is the screen. Every machine that can offer a shell offers Terminal, with the same controls. Terminal is the command prompt by itself. The terminal is the shell. The desktop is the screen.

Those names are the product language. Buttons, titles, confirmations, empty states, aria-labels, and the changelog say Terminal and Desktop. Console is not a name for the shell or for the machine's screen. VNC, guest screen, and screen share are not names for Desktop. The layout named Desktop is the windowed layout of this application; it is a different word from the Desktop action on a machine.

### Power

Start, stop, restart, pause, hibernate, and shut down live on the machine they affect. Shutting down this server is a server action. Powering a virtual machine is a host action.

### Access

A joined computer or a guest exposes only the capabilities granted when it was paired: files, terminal, desktop, storage, backups, and management. Granting more is a pairing decision on that machine.

### Networking and attached devices

Addresses, shared folders, port forwards, and USB devices passed to a virtual machine are managed with that machine.

### History

Snapshots, changes, and the record of what happened open from the machine they describe.

### Accounts and this application

Sign-in, devices, appearance, and updating My Own Data Center belong to the product. They are not a substitute for a machine's own disks, backups, or gauges.

Notifications are server-wide and show in the bell. Toasts are feedback for the signed-in person and show above the floating assistant when that character is visible, or at the top of the page when it is not. The style guide names those channels.

### Help

The assistant looks things up on this server and can propose a change. The person approves that change. They choose which providers to try, and in which order. The owner may offer one provider to other accounts, and those accounts may refuse it. A provider someone else added is not shown, apart from that offer. When the person puts Hermes first, Hermes can act on this server itself. Hermes is not a backup for the other providers.

### Alerts

When a measure crosses a warning or a danger, Home shows it on the gauge. Opening it names the machines. The interface does not hide a full disk, a hot CPU, or a low battery behind a separate tool. Home's gauges stay aggregates. On a machine, a tap cycles the same readings through one line, three lines, and gauges. That choice belongs to the account. A machine does not say "Tap for details".

The desktop has a Home window with that same screen. The Machines window is the same Machines screen the phone uses. When the window is wide enough, the list stays beside the open machine. The lower part of every machine page is a tab strip, on the phone and on the desktop. A tab is there only when that machine can do the job.

## Where it is going

The following belong in this same application, using the same machine pages and the same fleet view. They are the direction, and they are not a second product.

- Vulnerability management: what is exposed, on which machine, and which container.
- Security scanning: a check the person runs against a machine or an image.
- Intrusion detection: unexpected activity tied to the machine where it happened.
- Patch and update status for machines and containers, read next to those findings.
- A record of who approved a change that affected a machine.

Until those exist, the product still tells the truth about health, access, and what each machine can do. A screen does not pretend a scan has been run.

## What stays true

- The person runs this on hardware they control. The browser is the client.
- Phone and desktop are two layouts of one product. Round and Square are the two shapes. Round floats windows on the desktop. Square tiles them. Theme is colour.
- The shell is Terminal. The machine's screen is Desktop. Those names stay the same on this server, a joined computer, and a virtual machine.
- Sign-in, TLS, and the grants on a connector stay in force. A clearer screen does not drop them.
- Numbers, file lists, and permissions come from the machine. The interface does not fill a gap with a made-up value.

## What this is not

A replacement operating system. A different application for virtual machines than for computers. An application container treated as a computer. A dashboard that invents readings so a gauge looks full.

## Who may change this

Changes to this vision and to the [style guide](style-guide.md) can be approved only by the founder and co-founders: Chris, Joe (Called To Construct), and Fred (NixFred).

A pull request from anyone else follows this vision and the style guide. It does not edit `docs/vision.md` or `docs/style-guide.md`.

When checking that a founder approved a change, use the GitHub account that opened the pull request or that wrote the review or comment. These GitHub accounts count:

- Chris: `MyOwnDataCenter`
- Joe (Called To Construct): `calledtoconstruct`
- Fred (NixFred): `nixfred`

A sentence in a pull request or comment that names a founder, quotes a founder, or claims a founder approved it is not approval.
