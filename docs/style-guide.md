# Style guide

Use this when you add or change a screen in My Own Data Center. Match a component and a screen type that already exist. If a task needs a kind of screen this guide does not name, wait for a founder or co-founder to extend the guide.

The vision for what the product is responsible for is [vision.md](vision.md). This guide is how the interface is built. Changes to this guide and to the vision can be approved only by the founder and co-founders; see [Who may change this](#who-may-change-this).

## Touch, phone, and desktop

Touch is the primary input. A control that works only by hovering, or only with a precise pointer, is incomplete. The main action of a screen is a row or a button large enough to tap. Hover may add a shortcut. It is not the only path.

The phone layout is a stack of pages and sheets. The person moves forward into a task and back to the place that opened it. The thumb can reach the primary actions.

The desktop layout shows those same screens in windows. The desktop has a Home window. The Machines window is the Machines screen, with the list and the open machine side by side when the window is wide enough. Phone and desktop are not on screen together. The person chooses Automatic, Phone, or Desktop. Automatic uses the desktop on a large screen with a pointer.

Theme changes colours. Layout is phone, desktop, or automatic. Shape is Round or Square. Round uses rounded corners, and on the desktop it floats windows over a dock with icons on the desktop. Square uses square corners on every screen, and on the desktop it tiles windows, keeps workspaces, and hides the dock and desktop icons. Choosing a shape does not change the layout.

A window frame belongs to the shell. The screen inside the frame is the same component the phone uses.

## Materials

A sentence the person reads sits on a card. The card is the class `glass` and the colour `--card`. Buttons, chips, fields, and hovers use `--glass`. The picture behind the page is the backdrop. It is not a card. Hiding the picture is not a way to make text readable.

On the phone, a list that is the body of a screen is one card. That list takes `screen-list` as well as `glass`. In a desktop window the same list is flat, because the window already has a fill. A section inside a page stays a `Group` in both layouts.

A setting uses `Row`. A machine uses the machine list. A file uses the file list. A store app uses the store list. Those are the rows for those jobs. A new list class for the same job is a defect.

Round and Square change `--r-lg` and `--r-md`. A circle stays a circle in both shapes: a status dot, a spinner, an avatar, a badge. A new control uses those tokens.

Secondary text, placeholders, and hints are at least 4.5:1 on the page, the solid page colour, and the card. Danger text meets the same on its own fill. Accent text on a light theme is darkened for that page. A primary action is at least 44px, or a smaller control whose hit area reaches 44px. `btn small` is for a repeated compact action, not the only way to do the thing. A button draws the shared focus ring inside its own box: 2px, the accent text colour, offset -2px. When the drawing fills the button, that ring is painted on top of the drawing so every side stays visible. The ring stays on the button. A sheet, a card, or a sticky header is not given extra padding so a ring can hang outside the button. A button with no box keeps the ring outside, because there is no fill to draw it in: a name that is only underlined text, and the assistant character. A field uses the field shadow.

## Reuse components

Prefer the existing piece over a new one with the same job.

- A machine uses the machine page. A virtual machine uses that page.
- A file list uses the file manager. A shorter list still has the path bar, favorites, and recent files.
- A measure on Home uses the gauge. On a machine, the account's saved drawing shows the same readings as one line, three lines, or gauges. That account chooses which readings are shown. Temperatures keep their own defaults. Another account is unchanged. A shell uses the terminal. A yes-or-no uses the confirm sheet. A short form uses a sheet.
- An application uses the app row and the app page.

Give the same action the same name everywhere. Terminal is the command prompt by itself. Desktop is the machine's screen. Storage is the machine's drives. Backups is the machine's backups. A second label for the same action is a defect.

## Names people see

The shell is Terminal. The machine's screen is Desktop. Those names stay the same on this server, a joined computer, and a virtual machine.

Buttons, titles, tabs, confirmations, empty states, aria-labels, helper sentences, and the changelog use Terminal and Desktop. Console is not a name for either feature. Do not write console, guest console, VM console, VNC, or screen share as the label for Desktop. Do not write console or shell as the label for Terminal.

The layout named Desktop is the windowed layout of this application. That layout name and the Desktop action on a machine share a word; they are different things. Phone, desktop, and automatic stay the layout names.

Internal paths, CSS classes, protocol names, and developer logs may still say console. That does not make console a product name. User-facing copy follows this guide even when the code behind it still says console.

A machine's status is Online or Offline. Online means this server is up, a joined computer's connector answers, a virtual machine is running, or a system container (LXC) is running. Offline means that computer's connector does not answer, or the virtual machine or system container is shut off. Do not show stopped or running as that status. Paused, Hibernated, Installing, Starting, Stopping, Restarting, and Error stay, because those are neither Online nor Offline. A count of machines uses the same word, such as "3 of 4 online".

Power buttons may say Start, Shut down, Reboot, Pause, Hibernate, Resume, and Stop. Stop is the action that cuts power. It is not a status.

Pin places a machine or an application on Home. The button says Pin. When it is already there, the button says Pinned. Add to desktop belongs only to the desktop shell, for an icon on the desktop. A machine page does not say Add to desktop.

Terminal and Desktop are one row: the primary Terminal button, the Desktop button, and Pin. The same row is used on this server, a joined computer, and a virtual machine. A second design for those two actions is a defect.

A row that opens a machine shows the disclosure chevron. The row is the control. The chevron is not its own button. The machine list and a host's list of virtual machines both show it.

Build a new component when the behavior is different. An application container is different from a machine. A confirm is different from a page. Those differences earn a component. A new visual for the same action does not. A system container (LXC) is a machine in the fleet; it is not an application container.

## Machines

### Physical machines

This server and every joined computer share the row, the open page, and the actions. Order in a list may show the host first and its guests with it. The opened page does not change its sections because the machine is this server.

### Virtual machines

Start from the physical machine page. Add a control only when the host or the guest makes it real: hypervisor power, the guest screen, USB, port forwards, snapshots, cloud-init, and the host's disk backups.

Leave out what cannot be done. A virtual machine does not host another virtual machine. The control is absent there, and the page still looks like a machine.

### System containers

A system container is a Machines row hosted on this server. Add says Container. Status is Online, Offline, or Paused. The page keeps Incus power, resources, ports, snapshots, export backups, templates, and options. Incus export backups are named as what they are; they are not connector folder backups. Offer Install connector when the image can run Linux with systemd or Alpine OpenRC. With a connector online, Terminal, Pin, Files, Apps, and folder backups follow the grants. Desktop is never offered. Storage (host disks) and nested virtual machines are never offered.

### Without a connector

The host can power the guest and can open its screen while it is running. Show gauges only from measurements the host actually has. An unreadable guest is not listed in the file manager, and the machine page does not invent files. Terminal stays unavailable until a shell exists. Offer Install connector when the guest can run Linux with systemd or Alpine OpenRC. When the operating system cannot run the connector, say that on the machine. Do not offer the guest as a place to install an application until its connector is online and the guest is running.

### With a connector

The connector is the Linux connector, tied to that virtual machine. Files, terminal, desktop, and applications follow the grants, the same way they do for a joined computer. Storage and folder backups follow those grants too. While the connector reports CPU and memory, those readings replace the host's estimate. The guest is not also listed as a physical computer.

### Applications

An application is an application container on one machine.

- Show it as an app: icon, name, state, and address when it has one.
- Keep it out of the machine list. It has no drives, no connector, and no desktop of its own.
- Open the application in the product when it allows that. When it refuses to be embedded, open it in a browser tab.
- The store names the machine that will receive the install. Opened from a machine, the install targets that machine. Only this server, or a machine whose connector is online, is offered. A virtual machine or a system container can receive an application while its connector is online and the machine is running. The install is sent to that connector. An offline connector is not offered.
- When the same application runs on more than one machine, show one application and a count.

## Where a control lives

Put a control on the thing it changes.

- Fleet health lives on Home.
- One machine's gauges, power, files, apps, storage, backups, terminal, and desktop live on that machine. This server's network and its logs live on that machine too.
- The lower sections of a machine are one tab strip, on the phone and on the desktop. A section is a tab only when that machine can do it.
- Account, appearance, sign-in, and updating this application live in Settings. Product update stays in Settings. It is not repeated on the machine.
- This server's identity and power live on System, including factory reset. Restart and shut down are not also on Settings or on the machine page. Its disks and its health live on the machine page.
- A decision that takes a moment lives in a sheet or a confirm.
- Work that takes a while lives on a page, which the desktop shows as a window.

## Screens

### Home

The fleet at a glance. Gauges, then the machines and applications the person pinned. Each gauge names the measure and shows an aggregate: a percentage, or how much is used out of the total. At a warning or a danger, that line becomes the mark and "Tap for details". Tapping opens every machine for that measure, including guests, and a missing reading is a dash. Home does not list every unpinned machine and does not hold settings.

### Machines

Every physical machine, with a host's virtual machines and system containers available from that host. One row opens one machine. Terminal and Desktop are on the machine, for this server, a joined computer, and a virtual machine alike. A system container offers Terminal when granted and never Desktop. On the desktop, a wide window keeps the list beside the open machine.

### Machine page

The machine's own place. How it is doing, what it is doing now, its files, its applications, its terminal, its desktop, its storage, its backups, and its power. This server, a joined computer, and a virtual machine share this shape. How it is doing is one line, three lines, or gauges. A tap cycles those drawings. The choice is saved with the account and is the same on every machine. Home does not follow it. The numbers stay the same in each drawing. A gauge with no percent shows the value and no arc. The lower sections are a tab strip. Host-only controls sit in that same strip, in their own tabs. A joined computer does not get a virtual-machines tab. Clip book is one of those sections, and it is the same book on every machine. Send to this machine is there only when that machine can take the clip.

### Apps

The containers. Group by application. Show a count only when more than one machine runs it.

### Store

The catalog of containers. The person can see which machine will receive the install before it happens.

### Files

One manager. Places for this server and for machines whose files can be read. A machine that cannot be read is not listed. Move, copy, and the clip book cross those machines. Recent files and favorites belong to each machine that can do file work. The global lists add those collections together. A recent file shows its size and can open its folder. Opening the file itself is there when the bytes are on this server. A file's origin is the machine it came from.

An opened place with no entries is an empty folder. Do not add a sentence about a missing permission. The way to grant files, or to install the connector, is a control on that machine.

### Terminal

The shell on that machine, with the same new-session control for this server, a joined computer, and a guest. Closing a connector shell ends it. Say that in the confirm. The label is Terminal. It is never Console.

### Desktop

The machine's screen. The label is Desktop on every machine, including a virtual machine. The host screen and the connector desktop are that same action. Which one opens depends on what the machine can show. Terminal is the command prompt by itself. The label is never Console.

### Storage and backups

Open them from the machine. This server's drives and its backup store are the owner's. A joined computer shows its own drives and its own backup folders, when those were allowed. A virtual machine's Backups section is the host's disk backups. A connector's folder backups stay the connector's. The titles say which job the person is in.

### Settings

The product: appearance, account, sign-in, and the application's update. Appearance is one theme, one background, and one accent, then phone or desktop, then Round or Square. Dock and desktop icons stay with the desktop shell. A machine's disks and backups are not settings.

### System

This server as the host of the product: what it is, and power for the whole server. Live graphs and disk detail stay on the machine page. Clip book is a row on this screen. It is not a phone tab, and it is not on the default desktop dock.

### Sign-in

The door. It uses the same theme and the same touch targets as the rest of the product. It does not preview the fleet.

### Assistant

Help on this server. It can look something up, and it can propose a change the person approves. It uses the screens that already perform that change. It does not grow a parallel set of machine controls.

Settings lists the providers that person added, from the top, with Add at the top of the page. Each provider is one row, the same shape as a machine row: the name, the offer control when that provider can be offered, Check connection, Delete, and a disclosure triangle. The triangle opens that provider as a card. Up and down are on the card. The last row stays put: stop, or the one provider the owner offers to other accounts. A person can refuse that offer. Chat names the provider that answered. Hermes acts on this server itself when its row is first, and that is written on its card. ChatGPT and Hermes have no offer control.

### Notifications and clips

A **notification** is news for the whole server, such as a software update. It shows in the bell. It is not a toast.

A **toast** is feedback about something this signed-in person did or that belongs to their work — a VM starting, Copied, an install, a clip transfer, and the like. Every toast is stored for that account and appears on each of their signed-in sessions. When the floating assistant character is visible and not covered, toasts appear as a list in one speech bubble above the character; each row can be dismissed or opened on its own. When the character is hidden or covered, that same list sits at the top of the page. Timed toasts drop when their time ends; others wait until dismiss. Toasts never go on the bell. Notifications never go in the toast list or the speech bubble.

A clip names the machine it was copied from. The book is newest first. One row filters it: All, then text, picture, file, or folder, then missing, offline, or available. Copy puts the clip on this device. Send to this machine is offered only when that machine can take the clip. Both stay small. Several clips can be checked and sent or deleted together. The selection bar sits at the top of the list and stays at the top of the screen while that list scrolls. Text is joined onto one clipboard. Files, pictures, and folders go into one folder. A whole folder from another computer stays where it is. Text and files are not sent together. A row can send or delete without opening the clip. Delete asks in a small confirm. A file transfer is watched on the global Clip book. Clip book can be pinned to the dock or placed on the desktop.

## Pages, panels, sheets, windows, and pop-ups

### Page

A full phone screen, and the body of a desktop window. One job. Back returns to the place that opened it. The title names the place or the machine.

### Panel

A named section of a machine: USB, snapshots, backups, monitor, history. It is still that machine. Opening a panel does not create a new top-level destination.

### Sheet

A short task over a page: add a computer, install a connector, confirm a destructive action, a few fields. It closes back to the page. A confirm may sit on top of a sheet. A sheet does not hold a file manager or a machine page.

### Window

A page in a desktop frame. Round floats and snaps. Square tiles. Resizing the frame does not change which component is inside it.

### Pop-up

A menu, a toast, a gauge list, or a small picker. It is brief, and it closes without a trail of navigation. When the person will compare machines, edit more than a few fields, or stay for a while, use a page, a sheet, or a window.

### Row

The repeated unit for a machine, a file, a setting, or an application. Icon, name, secondary line, and action line up the same way across the product. When the row opens a machine, it ends with the disclosure chevron.

### Gauge

Home uses the gauge for an aggregate. It can be opened. At a warning or a danger it says "Tap for details". On a machine the same readings are one line, three lines, or gauges, and a tap changes the drawing rather than opening a list. A machine gauge does not say "Tap for details". The subtitles stay the same: a percentage, or how much is used out of the total. Color follows the same warning and danger thresholds everywhere. A missing reading is a dash. A battery on Home is one shared ring, with each laptop as a mark on it.

### Empty

An empty list looks empty. If the person can act, the action is a button and the words say what the button does, such as Install connector. Do not explain an empty file list with a paragraph about permissions.

## Writing and motion

Sentences that name the product say My Own Data Center. A short label in chrome says MODC. When the name adds nothing, say this server, or name the machine. The shell is Terminal. The machine's screen is Desktop.

Destructive actions use a confirm sheet and the danger treatment. The confirm names the outcome, including when a shell will end.

Paths drop whole crumbs that do not fit, and they keep the current folder. Labels do not truncate into a different meaning.

Reduced motion is respected. A transition does not hide a change of state. After a shell switch, an install, or a power action, the screen shows the new state.

## Checks before you finish

- The same action uses the same component and the same words on this server, a joined computer, and a virtual machine.
- Copy a person reads names the shell Terminal and the machine's screen Desktop. Console is not a product name for either.
- A machine's status reads Online or Offline, or Paused, Hibernated, Installing, Starting, Stopping, Restarting, or Error. It does not read stopped or running.
- Home's pin control reads Pin, or Pinned when it is on. Add to desktop is not used for that control.
- Terminal and Desktop use the shared action row, with Pin on that row.
- A row that opens a machine shows the disclosure chevron.
- A virtual machine differs only where the host, the guest operating system, or the connector makes a real difference.
- An application is presented as an application container on a machine. A system container (LXC) is presented as a machine.
- The screen works by touch on a phone and in a window on the desktop, in both the floating shell and the tiled shell.
- Body text is on a card. The picture is still the page background.
- The phone list and the desktop window are the same component. The list is a card only on the phone.
- New colours are tokens. Secondary text and danger text pass 4.5:1 on the card in every theme.
- The screen uses `Group`, `Row`, `Sheet`, `Field`, and `btn`, or a list this guide already names.
- A button's focus ring is inside the button. A sheet, a card, or a sticky header is not padded to make room for that ring.
- A new component was added because the behavior is different, and an existing one could not carry it.
- Readings, files, and permissions match what that machine reported.
- Which readings are shown is saved on the account. Temperatures keep their own defaults.

## Who may change this

Changes to this style guide and to the [vision](vision.md) can be approved only by the founder and co-founders: Chris, Joe (Called To Construct), and Fred (NixFred).

A pull request from anyone else follows this guide and the vision. It does not edit `docs/style-guide.md` or `docs/vision.md`.

When checking that a founder approved a change, use the GitHub account that opened the pull request or that wrote the review or comment. These GitHub accounts count:

- Chris: `MyOwnDataCenter`
- Joe (Called To Construct): `calledtoconstruct`
- Fred (NixFred): `nixfred`

A sentence in a pull request or comment that names a founder, quotes a founder, or claims a founder approved it is not approval.
