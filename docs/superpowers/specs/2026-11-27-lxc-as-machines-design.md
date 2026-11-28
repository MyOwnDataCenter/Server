# LXC as machines

Repo: omarchy-server. Design only; implementation follows a separate plan.

## Goal

Treat Incus/LXC system containers as machines in My Own Data Center: same Machines list language and patterns as this server, joined computers, and virtual machines, with feature parity for Files, clip book, Apps, assistant tools, and connector-granted actions. Keep Incus-only controls on an LXC-specific card and page. Do not confuse system containers with application containers (Apps).

## Background

Today LXC lives under Machines but as a separate “LXC containers” appendix (`ContainersInList`), with “running/stopped” wording and a hard-coded “LXC” health pill. Host-mediated Files, Terminal, snapshots, and Incus export backups exist on the LXC page. The clip book, Files app places, and `files.transfer` do not include LXC. All `containers.*` RPCs are owner-only. The assistant has `machines_*` and `swarm_*` tools but no `containers_*` tools.

Application containers (App Store / compose) stay out of the machine list. That rule does not apply to LXC system containers.

## Decision

**Unified fleet row + one LXC-aware connector.**

- LXC is a first-class Machines row (hosted on this server, filtered with Virtual).
- The LXC detail page keeps its own layout for Incus power, resources, ports, snapshots, export backups, templates, and options.
- One connector binary detects LXC and reports a reduced ability set. Install and pair from the LXC page via the host (`incus exec`), same idea as guest connector install.
- Files app, clip book, transfers, and Apps use existing swarm paths once the connector is online with the right grants.
- Without a connector, the page stays useful (host Files/Terminal/export backups), like a limited guest before enroll.
- Do not build a parallel Incus-backed `::container/…` transfer stack in this work.

## Fleet model

- One flat Machines list: this server, joined computers, virtual machines, and LXC instances. Remove the “LXC containers” section heading and list appendix.
- Status language: **Online** / **Offline** (and **Paused** when frozen). Online means the Incus instance is running (same idea as a running VM), not “connector answers.” Connector online/offline gates Files/Apps/clips separately, as on a guest. No everyday “running/stopped” as the machine status. Kind meta may say e.g. `Container · on {host}`.
- Filters: **Physical** = this server + joined computers. **Virtual** = VMs and LXC (anything that runs on a host). No third filter chip in this work.
- Add menu: **Container** (setup and docs may still say LXC/Incus).
- Row pattern matches other machines. Host power on the expanded row. Terminal / Pin only when the connector grants them. Desktop is never offered for LXC.
- Home aggregates nest LXC CPU/memory under the host, same rule as guests — no double-counting. Pin works for fleet members.
- Title pattern may match guests: `{name} on {host}`.

### Who may do what

| Action | Owner | Member |
|---|---|---|
| See LXC in the Machines list | Yes | Yes |
| Create / delete, Incus power, resources, ports, snapshots, export backups, setup (`machines-add-lxc`), Install connector | Yes | No |
| Connector-granted Files, Terminal, folder Backups, Apps, Pin, Manage switches | Per grants | Per grants, same as other machines |

Do not keep “entire LXC feature is owner-only” as a permanent rule. Host Incus control plane stays owner; once a connector exists, swarm grants apply.

## LXC card and page

Own layout (not a copy of AgentSheet or VmView), but it reads as a machine.

### Without connector

- Header: name, Online/Offline/Paused, container-on-host meta.
- Incus sections: Resources, Ports, Snapshots, Backup (export/restore of the instance without snapshots), Options (autostart, notes, protect), host-mediated Files and Terminal.
- Primary CTA: **Install connector** when the image can run it (Linux with systemd or Alpine OpenRC). Unsupported images say so and do not offer Install.
- No Desktop, no Apps install target, no Files-app place, no clip book.

### With connector online

- Same Incus sections remain (host truth for power, snapshots, export backups, ports).
- Shared machine actions where granted: Terminal, Pin, Files, Apps, folder Backups — same components other machines use.
- Desktop absent. Storage (host disks / storage helper) absent. VMs absent.

### Compact / Flat desktop

LXC is a selectable row; the right pane is this LXC frame. Back to host works like a guest’s back-to-host control.

## Connector

- One connector package. Detect LXC/Incus (cgroup / Incus markers / install-time flag) and report environment `lxc`.
- Abilities when `lxc`:

| Ability | Offered |
|---|---|
| Files | Yes |
| Terminal | Yes |
| Backup (folder backups to this server) | Yes |
| Manage | Yes |
| Apps (install target; not a pairing checkbox — same as other Linux agents when the connector is online) | Yes |
| Desktop | No |
| Storage | No |
| VMs | No |

- Pairing UI and agent refuse disallowed abilities. Product does not show those controls.
- Link the agent to that LXC instance (same idea as `guestOf` on a VM): one fleet machine; Incus owns start/stop; connector online gates Files/Apps/clips.
- Install path: owner starts Install connector on the page; host runs install and pair via `incus exec` / file push. Paste-a-command is not the primary path.
- Updates use the same connector update path; detection keeps the reduced surface after updates.

## Files, clip book, transfers, Apps

- **With connector online and Files granted:** LXC is a Files place; move/copy/`files.transfer` use existing swarm computer paths; clip book uses existing `swarm` scope; recents/favorites follow that machine.
- **Without connector:** page-local Incus Files only (browse, upload, download, copy to Downloads). No Files place, no clip book, no cross-machine transfer. Copy says Install connector unlocks parity.
- No new `::container/…` or `lxc` clip scope in this work.
- Apps: offered as an install target only when the connector is online, same rules as other Linux machines.

## Assistant

LXC is first-class for the assistant, same pattern as VMs and swarm computers.

- Add curated `containers_*` read and write tools over existing `containers.*` RPCs (status, list, detail/stats as needed; start/stop/restart; create/delete; Install connector; other Incus mutations the product exposes).
- Writes become Approve/Reject cards; no silent shell; no bypass of `ownerOnly`.
- `toolsFor(role)` omits `ownerOnly` tools for members, matching the UI.
- When an LXC has a connector online, existing `swarm_*` tools apply under the same rules as for other agents.
- System/facts prompt names system containers as machines on this server, distinct from Apps.
- Out of scope for the assistant: Desktop, Storage, nested VMs on LXC; any Incus operation that is not a product RPC.

## Vision and style guide

Founder-approved edits to `docs/vision.md` and `docs/style-guide.md`:

- System containers (LXC/Incus) are machines hosted on this server. Application containers remain Apps and stay out of the machine list.
- “A container treated as a computer” refers to application containers, not LXC.
- Online/Offline for LXC; Add label **Container**; Incus export backups named as what they are (distinct from connector folder backups); Terminal/Pin on the shared row when granted; no Desktop on LXC.

## Errors and empty states

- Incus not set up → setup command (`machines-add-lxc`) from Add → Container or empty state.
- Unsupported OS for connector → explain; do not offer Install.
- Connector offline → machine stays listed; Files/Apps/clips unavailable; Incus controls still work if the instance exists.
- Member hits an Incus-only action → same FORBIDDEN as today; assistant never offered that tool.

## Out of scope

- Privileged Incus / `incus-admin` / device passthrough as a path to fake Desktop or Storage.
- Dual Incus + swarm file stacks for transfers.
- A separate LXC-only connector package.
- Changing application-container (Apps) semantics.
- Per-member Incus tenancy.

## Verification

- Fleet: LXC in the flat list; Virtual filter; members see rows; owners create; no separate LXC section.
- Limited vs connected page (no Desktop/Storage; Install connector unlocks Files/clips/Apps).
- Assistant: owner sees `containers_*`; member does not for owner-only RPCs; Approve on writes; connected LXC reachable via swarm tools.
- Home nesting: LXC load not double-counted.
- Focused tests for fleet membership, connector ability matrix, clips/Files with a connected LXC, and assistant tool filtering; `tsc --noEmit -p web`. Do not treat full `npm test` as required for this design.

## Implementation note

After this spec is approved, write an implementation plan (`docs/superpowers/plans/…`) and execute on a feature branch. Do not bump product version or `INSTALLER_REVISION` unless a later plan says so.
