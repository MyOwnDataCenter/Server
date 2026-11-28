# NixOS system containers (LXC)

Repo: omarchy-server. Design for declarative NixOS LXC on Incus.

## Goal

Let the owner create an Incus system container from a NixOS image, supply NixOS configuration at create time, apply it on first start, edit and re-apply later, export the config, and optionally use a binary cache on this server so rebuilds are faster and shared across containers.

Apps (Podman compose) stay off system containers. Software on NixOS LXC is Nix modules and packages, not the App Store.

## Background

- Incus already publishes `images:nixos/…` container images.
- Cloud-init is a poor fit for NixOS; apply config with `nixos-rebuild` via `incus exec` (same idea as other Incus NixOS tooling).
- Nested Podman is not the product path for LXC.

## Decision

**Config-in → rebuild-in-place → export-out**, with an optional host binary cache.

1. Create from a NixOS library image (stable/unstable as Incus lists them).
2. Optional `configuration.nix` (and later a small flake) at create time.
3. After the instance is up, a background job writes config and runs `nixos-rebuild switch`.
4. A Config section on the container page: view, edit, Apply, Export.
5. Optional MODC binary cache on this server; containers can use it as a substituter.

## Create

- Library already includes NixOS when Incus lists it; no separate “NixOS only” product unless the library is empty.
- When the chosen image’s OS is NixOS, Create shows a **Configuration** field (textarea) with a short starter example and “Use example”.
- Empty config = stock image only (no rebuild job).
- Limits (CPU, memory, disk, autostart, root password/SSH) stay as today.
- Nesting: set `security.nesting=true` for NixOS containers (needed for many builds); document why.

## First apply

- Job name visible on the list (e.g. `applying NixOS config`), same pattern as creating / installing connector.
- Steps: write `/etc/nixos/configuration.nix` (and `hardware-configuration.nix` only if we generate a minimal one), then `nixos-rebuild switch`.
- Failures stay on the container row/error like other jobs.
- Timeout is generous (rebuilds can take many minutes without a cache).

## Config on the page

Owner-only (same as other Incus mutations):

| Action | Behavior |
|---|---|
| View / edit | Text of current config (read via `incus file` / exec) |
| Apply | Write + `nixos-rebuild switch` as a job |
| Export | Download `configuration.nix` (and flake files when present) as a zip or single file |

Members see the machine; they do not edit or apply config.

## Optional binary cache

- Setting on this server: enable a local Nix binary cache (v1: nix-serve or equivalent behind localhost / LAN only).
- When enabled, Apply injects or merges substituter settings into the container’s Nix config (or a drop-in) so rebuilds prefer this server.
- Off by default. No requirement to run a public cache.
- Signing keys: generate once on enable; keep private key on this server only.

Out of scope for v1: shared `/nix/store` mounts across containers, attic multi-user UI, Hydra.

## Connector

Unchanged: Files, Terminal, Pin, folder backups when granted. No Apps. No Desktop.

## Assistant

Optional later: `containers_setNixosConfig` / apply tools. Not required for the first UI cut.

## Errors

- Non-NixOS image + config supplied → refuse at create.
- Rebuild fails → show last lines of the log on the job error.
- Cache enable fails → leave setting off; plain words.

## Out of scope

- App Store on LXC.
- Building custom squashfs images on MODC as the only create path (rebuild-in-place is enough for v1).
- Full flake editor IDE.
- Members editing NixOS config.

## Verification

- Create NixOS LXC with example config → job completes → services from config are present.
- Edit + Apply updates the system.
- Export downloads the current config.
- With cache on, a second container rebuild hits the local substituter (observable in rebuild log).
- Non-NixOS create path unchanged.
- `tsc --noEmit -p web` and focused container tests.

## Implementation note

Execute on `feat/nixos-lxc` as its own PR, separate from “no Apps on LXC”.
