# Pre-release Machine Manager

Worktree: `/tmp/omarchy-server-manager`
Branch: `feat/machine-manager-prerelease` (from `origin/main` at `27ca50c`, pull request #909)
Do not commit onto `feat/theme-layout-shape` or `feat/data-center-shell`.
Do not bump the product version or `INSTALLER_REVISION`.
Pull request #904 stays separate.

## What this is

Settings has a switch, **Enable pre-release features**. It is stored on this browser only (`localStorage` key `omarchy-server:prerelease`). It does not follow the account. Other trials should read the same switch through `usePreRelease()`.

While the switch is on and the layout is the phone, Machines shows the new list. The desktop Machines window stays the current list. With the switch off, both layouts stay as they are.

## Phone list

- Title with the one add button on that same line. Under it, a smaller name search and the filter control share one row. Search is case-insensitive, and X clears it.
- The filter is one choice. The bar has four places: All, Physical, Unhealthy, and Offline. Search still applies on top of that choice.
- Pressing Physical, Unhealthy, or Offline selects that filter. Pressing the same place again switches it in place: Physical becomes Virtual, Unhealthy becomes Healthy, Offline becomes Online. Pressing it once more switches back. Choosing another place returns the previous one to its first word.
- The first visit shows a bubble under the bar. Dismissing it is remembered on this browser (`omarchy-server:mm-filter-tip`).
- All shows every row. Physical is this server and connected computers. Virtual is virtual machines. No section headings.
- Unhealthy is Warning or Danger only. Healthy is the Healthy pill only. Unknown is neither, including a machine that is offline or a virtual machine with no online connector.
- Offline is the Offline pill only. Online is the Online pill only. A paused, hibernated, or failed virtual machine is neither, and neither is one that is starting or stopping.
- Those four labels sit on the same row as the name search. The open row keeps a border on every side, including the bottom.
- When the search or the filter changes, a row that no longer matches fades into the page and collapses, and the rows that remain glide into the gap. A new match opens a gap and fades in from the page. The motion is about 280ms. Reduced motion swaps the list immediately. The opening paint does not play this. A change after that does, including search.
- The add button opens a flyout: Machine (the existing Add a computer sheet) and Virtual Machine (the existing create page). Owners see both. A member has no Add a computer, so the button opens create virtual machine directly.
- One flat list, online first, then name (the order `fleetList` already uses).
- One row open at a time. Search or filter changes collapse it.
- Collapsed rows are flat, separated by a hairline. The open row eases open and rises (shadow, surface) over the others.
- Collapsed row: type icon, name, reachability pill, health pill, disclosure triangle.
- Icons say what kind of machine it is. This server uses the server icon. A connected computer uses the computer icon. A virtual machine uses the virtual-machine icon. None of them use the installed operating system. A future fail-over is not built and has no row.
- Reachability uses the existing pill. Computers and this server are Online or Offline. A virtual machine uses Online, Offline, Paused, Hibernated, Error, or the busy word (Installing, Starting, Stopping, Restarting).
- Health uses the existing pill: Healthy, Warning, Danger, Unknown. A virtual machine with no online connector is Unknown. Offline or not reporting is Unknown. Warning and Danger come from swarm alerts and the gauge lines already used on Home (75% / 90%, battery 25% / 15%). Missing numbers stay a dash.
- Open row, first: the account's saved drawing of the readings. A tap cycles one line, three lines, and gauges. The choice is saved with the account and is the same on every machine. Home's aggregate gauges do not follow it. A guest with no connector can show the host sample for CPU and memory, and disk size only. Every reading appears in each drawing, including temperature and a size-only disk. A gauge with no percent shows the value and no arc.
- Next line, icon only, and only when they apply: Terminal, then Desktop (remote screen). Then the power buttons that apply. On the right, Up time when it is known for a running machine, otherwise Last seen in the relative form already used. Empty when we have never seen it.
- Terminal: this server when the page was given a terminal action (owners); a connected computer when it is online and terminal is granted; a virtual machine when it is running, its connector is online, and terminal is granted.
- Desktop: this server for an owner; a connected computer when it is online, desktop is granted, and the connector says the screen is available; a running virtual machine through the host console even with no connector.
- Power: this server has none. A connected computer that is online and allows manage shows Suspend, Restart, and Shut down. A virtual machine shows Start, or Resume when paused or hibernated; while running, Shut down, Reboot, and Pause; while paused, Resume and Stop. Hibernate, clone, and delete stay on Manage. Confirms are the ones already used.
- Last line: pin / pinned (same dashboard pin), and Manage, which opens the machine page already built.
- The machine page is a sheet. The drag handle stays at the top. The title stays under it while the rest of the page scrolls, so the bottom of the page can be reached. Pin sits on the same line as Terminal and Desktop, on this server, a connected computer, and a virtual machine.

## Checklist

- [x] Plan file (this file) kept current
- [x] `web/src/prerelease.ts` browser switch and `usePreRelease`
- [x] Settings row
- [x] `web/src/fleet/machineManagerLogic.ts` rules
- [x] `test/machine-manager.test.mjs`
- [x] `web/src/fleet/MachineManager.tsx` phone list
- [x] `Machines.tsx` shows it only for the phone while the switch is on
- [x] Styles for the flat list, raised row, and easing
- [x] `tsc --noEmit -p web` (passed again after the filter motion)
- [x] `node --test test/machine-manager.test.mjs` (7 passed after the filter motion)
- [x] Unhealthy and Offline on the same filter control
- [x] Rows fade into the page and collapse, and new matches fade in while the others glide

Not committed. Not pushed. The desktop list is untouched.

A hibernated virtual machine’s Resume calls `machines.start`, the same call the current virtual-machine card uses. Pause uses `machines.resume`.

## Where to look after a compaction

1. This file.
2. Worktree `/tmp/omarchy-server-manager`, branch `feat/machine-manager-prerelease`.
3. `node_modules` there is a symlink to `/tmp/omarchy-server-modc/node_modules` so typecheck can run. It is not part of the change.

## Verify

```
cd /tmp/omarchy-server-manager
./node_modules/.bin/tsc --noEmit -p web
node --test test/machine-manager.test.mjs
```

Do not run the full `npm test`. Do not run `test/machines.test.mjs`.
