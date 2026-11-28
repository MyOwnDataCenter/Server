# Remote guest connector install

Date: 2026-11-24
Status: ready for implementation
Repo: omarchy-server. Implement on `feat/remote-guest-connector-install`, stacked on Series B `feat/swarm-vm-hosting` (`3d52baf`). Do not open a PR from this spec. Do not bump `package.json`, `OMARCHYD_VERSION`, `web/src/changelog.ts`, or `INSTALLER_REVISION`.

This is Series C of `docs/plans/guest-connector-auto-install.md`: subsystem 1 for a guest whose `hostId` is a joined Linux computer. Series A installed the connector on this server. Series B hosted the guest and left the seams below. This spec does not re-implement hosting.

## 1. Goal

The Install connector button and create-time auto-install work for a guest whose `hostId` is a joined Linux computer. They use the same `guest-install.mjs` commands and the same `createQemuAgent({run, domain})`. Transport is that computer’s `vm-ga-ping`, `vm-ga-exec`, and `vm-ga-status` calls. There is no second installer.

## 2. What Series B left

- `omarchyd/qemu-agent.mjs` is unchanged. `run('virsh', ['-c', 'qemu:///session', 'qemu-agent-command', domain, json])` is the only transport it knows.
- Remote create sets `options.agent: true`, writes a seed with no qemu-guest-agent and no installer, and does not call `waitForGuestConnector`.
- `installConnector` throws `PRECONDITION_FAILED` `Install the connector from the computer that hosts this virtual machine once that is available.` when `hostOf(m) !== 'server'`, before `liveState` and before any guest-exec.
- The host helper already implements `ga-ping`, `ga-exec`, and `ga-status`. The agent exposes them as `vm-ga-ping`, `vm-ga-exec`, and `vm-ga-status` when ability `vms` is on. Series B does not call them from install or create.
- `ga-exec` accepts only an absolute path (`GA_PATH`). Series A’s commands are basenames: `loginctl`, `bash`, `runuser`, and `powershell.exe`.

## 3. Non-goals

- Editing `omarchyd/qemu-agent.mjs`, `omarchyd/guest-install.mjs`, `helper/helper.mjs`, root `install.sh`, or `connector/agent.py`.
- Adding `vms` to `LINUX_CONNECTOR_ALLOW` or `WINDOWS_CONNECTOR_ALLOW`. The guest connector is not a hypervisor.
- A host shell, a new `vm-*` verb, or calling `vm-ga-*` through `sh`.
- Rewriting Series B create, power, console, options, or the refused procedures in Series B section 10.10 other than `installConnector`.
- SPA changes. `GuestLive` already calls `machines.installConnector`, opens the password sheet on `needs-password`, and opens the copy-paste sheet on `needs-agent`.
- Embedding a pairing token, `install.sh`, or `install.ps1` in a remote seed or Windows answer file.
- macOS, Alpine OpenRC, Android, or HAOS enroll. `connectorKind` stays the gate.
- Bumping versions. Opening a PR. Mixing the isolation overlay into the diff.

## 4. Transport

Add `omarchyd/remote-guest-agent.mjs`. It does not import machines or the connector.

```
remoteGuestAgentRun({call, guestId}) → run(cmd, args)
```

`call(name, args)` is `remoteCall(hostId, name, args)` bound by `machines.mjs`. `guestId` is the 8-hex machine id. The expected domain is `omarchy-${guestId}`.

`createQemuAgent` calls `run` with exactly:

```
virsh, ['-c', 'qemu:///session', 'qemu-agent-command', domain, json]
```

Any other command, a different connect URI, a different domain, a missing JSON argument, or an `execute` other than the three below throws `Error('remote guest agent only accepts qemu-agent-command')` and does not call `call`.

| `execute` in the JSON | `call` | What `run` returns |
|---|---|---|
| `guest-ping` | `vm-ga-ping`, `{guestId}` | The helper stdout unchanged when it is a string. An object is `JSON.stringify`’d. This is raw virsh JSON, usually `{"return":{}}`. |
| `guest-exec` | `vm-ga-exec`, body below | `JSON.stringify({return: {pid}})` so `createQemuAgent` can read `reply.return.pid`. |
| `guest-exec-status` | `vm-ga-status`, `{guestId, pid: String(pid)}` | Virsh-shaped JSON: `{return: {exited, exitcode, 'out-data', 'err-data'}}`. |

`guest-exec` body, built from the payload `arguments` that `createQemuAgent` already sends:

- `guestId`
- `path` from `arguments.path` (unchanged; do not rewrite to `/usr/bin/…`)
- `args` from `arguments.arg` when that key is present (virsh `arg` becomes helper `args`)
- `capture: false` only when `arguments['capture-output'] === false`. Otherwise omit `capture` (the helper defaults to true).
- `input` only when `arguments['input-data']` is a string: UTF-8 decode of that base64. This is how the helper’s stdin field is defined. Do not log it.

`vm-ga-exec` and `vm-ga-status` results are the helper’s stdout, not raw virsh JSON. `vm-ga-exec` is `{"pid": number}`. `vm-ga-status` is `{"exited": bool, "exitcode": number|null, "out": string, "err": string}` with output already decoded. Accept either that JSON string or an already-parsed object. Re-encode `out` and `err` with base64 into `out-data` and `err-data`. `exitcode` null stays null. `exited` is true only when the helper says true.

Use `remoteCall`, not `hostCall`, so a transport failure becomes the existing `BAD_GATEWAY` clip and these calls do not paint download progress onto the guest. Do not raise the agent’s 2-minute `ga-exec` timeout: `guest-exec` returns a pid and does not wait for the installer.

`installConnector` and `waitForGuestConnector` both go through one helper inside `createMachines`:

```
qemuAgentFor(m)
  hostOf server → qemuAgent({run, domain: domain(m.id)})
  otherwise     → qemuAgent({run: remoteGuestAgentRun({call, guestId: m.id}), domain: domain(m.id)})
```

The local `run` is never used for a remote guest’s qemu-agent command.

## 5. Host gate

`installConnector` stays owner-only where it is today: `server.mjs` wraps it with `ownerOnly(auth, 'install a guest connector')` and then calls `p.run(input)` without a ctx. Do not change that wrapper. Do not call `requireRemote` or `assertOwner` from `installConnector` or from the create wait. The wait has no ctx. A test `isOwner` that requires `ctx.auth.role === 'owner'` would then fail a background enroll, and the real server predicate treats a missing user as not a member.

When `hostOf(m) !== 'server'`, after the unsupported-OS return and before `liveState`, require the host the same way `requireRemote` does after its owner check:

1. `hostAgent(m)`. Missing computer → `NOT_FOUND` `That computer isn’t in your swarm`.
2. Offline → `PRECONDITION_FAILED` `${hostName} is offline right now`.
3. `allowed.vms` or `on.vms` not both true → `FORBIDDEN` `Pair ${hostName} again with Virtual machines switched on.`

No `vm-ga-*` and no `vm-state` on those failures. `liveState` comes next, so a shut-off guest on an online host is still `Start the machine first.` An offline host wins over that sentence.

## 6. Button

`machines.installConnector`, same input and output as Series A.

1. `find`. Unknown id stays `NOT_FOUND` `That machine doesn’t exist`.
2. `connectorKind` `unsupported` → `{status: 'unsupported', os: 'other', message}` with no list and no `call`. Remove the Series B remote refuse. This check stays first so an Alpine guest of a missing computer does not 404.
3. Remote host gate from section 5.
4. `liveState !== 'running'` → `PRECONDITION_FAILED` `Start the machine first.`
5. `qemuAgentFor(m).ping()`. Any throw, including a dead agent or a bad gateway, → `{status: 'needs-agent', os}` and no exec. The SPA copy-paste sheet stays.
6. The rest is the Series A function, unchanged: Linux username or `Give the guest account to install as.`; `guestConnectorPrep` then `guestConnectorExec`; `connector.pair({machineId, …abilities})`; `guestReachableUrl`; poll `guestOf`; task type `connector`.

`sudoPassword` is still accepted and discarded. qemu-ga is root inside the guest, on this server and on the joined computer. Do not put it in `vm-ga-exec` `input`, task messages, logs, or `machines.json`. Do not return `needs-password` from this path. The SPA sheet stays for that status and is not redesigned.

`--server` / `-Server` is whatever `guestReachableUrl` already returns from the pairing addresses: a LAN address, else a Tailscale address, never `127.0.0.1`, `::1`, or `localhost`. That address is this MODC, which the guest reaches through the host’s passt network. It is never the hypervisor’s loopback. No new picker.

A nonzero prep or enroll exit keeps the Series A `PRECONDITION_FAILED` sentences. Do not append guest stdout or stderr to those errors.

## 7. Create-time

`machines.create` still returns `{id}` before the background work finishes.

On the remote success path, in the same place as local create (after the async `finally`, still inside the background function):

```
if (!m.state && connectorKind(osId) !== 'unsupported') waitForGuestConnector(id, username)
```

`waitForGuestConnector` uses `qemuAgentFor`. A ping throw keeps waiting until `connectorAgentWaitMs`, with the existing unref’d sleep. It does not run when create set `state: 'error'`. It does not run for Alpine, HAOS, or macOS. It does run for remote Linux cloud, Omarchy ISO, and Windows, same as local.

Do not wait for enroll before returning `{id}`.

Remote Windows `windowsAnswerFile(...)` stays without `windowsCommand`. There is no catalog Windows image. Create-time Windows enroll is the qemu-ga wait, not a token in `autounattend.xml`. If the agent never answers, the wait ends quietly and the button returns `needs-agent`.

## 8. Cloud seed

Remote cloud `vm-seed` user-data uses the same `connectorCloudInit` call as local `seed()`:

```
connectorCloudInit({...img, username, cloudInit: {adminGroup: img.adminGroup, ...img.cloudInit}})
```

That adds `qemu-guest-agent`, `python3` (or `python` on Arch), `systemctl enable --now qemu-guest-agent`, and `loginctl enable-linger` for the username. It does not add a pairing token, `install.sh`, or the account password. Omarchy and Windows seeds stay as Series B wrote them. Every remote cloud image gets this prep, including Alpine; Alpine still skips the wait because `connectorKind` is unsupported.

This is the one Series B seed rule this series reverses. Series B forbade the package so create would not look like an install. The package is what makes `guest-ping` succeed after first boot. The installer command stays out of the seed.

## 9. Helper path

Series A commands are not absolute paths. In `connector/vm-helper.py` only, widen `GA_PATH` so a path is either the current absolute form or a single basename:

```
^(?:/(?:[A-Za-z0-9._+-]+/)*[A-Za-z0-9._+-]+|[A-Za-z][A-Za-z0-9._+-]*)$
```

The 200-character cap, the args limits (32 strings, 4096 each, no NUL), and the input cap stay. Accepted: `loginctl`, `bash`, `runuser`, `powershell.exe`, `/usr/bin/sudo`. Rejected with `Invalid path`: empty, `..`, `.`, `../bin/sh`, `bash -c`, `/tmp/foo bar`, `C:\Windows\System32\powershell.exe`.

Do not tighten absolute paths that Series B already accepted. Do not run `path` on the host. A basename is not a new capability: `/bin/bash` already matched, and qemu-ga resolves `bash` inside the guest. `powershell.exe` is the Windows guest-exec name Series A already sends; an absolute Unix rewrite cannot express it.

The existing sudo test still requires plaintext only inside `input-data` base64, not in the rest of the virsh argv.

## 10. Security

- Owner-only, same HTTP gate as today. Members do not install.
- Ability `vms` is the hypervisor’s ability. It is checked before any guest-exec. It is not granted to the guest.
- Argv is still the generated installer from `guest-install.mjs`, not an owner shell.
- The swarm call carries `input` only when the virsh JSON already had `input-data`. This series never sets that for `sudoPassword`.
- Guest URL is `https://` plus the CA fingerprint already placed by `guestConnectorExec`.

## 11. Testing

TDD. Fake `connector.call`. No real remote VM and no real libvirt. `node --test --test-concurrency=1` on the files a task touches. `python3 connector/test_vm_helper.py` for the helper. Do not edit the SPA, so `tsc` is not required. Known host failures (`storage.test.mjs` noPassword, `connector.test.mjs` theme-set) are not this work’s bugs.

`test/swarm-vms.test.mjs` `readyHarness` returns `'ok'` for unknown calls. Leave that. `'ok'` is not guest-ping JSON, so the new create wait fails the ping and its sleep is unref’d. A successful ping in that harness would start `installConnector` and hold the test for `connectorEnrollTimeoutMs`.

Cover:

- Helper accepts the four basenames and `/usr/bin/sudo`, and rejects the paths in section 9.
- `remoteGuestAgentRun` plus the real `createQemuAgent` maps ping, exec, and status, including base64 `input-data` in and base64 `out-data` out. `sh` and a mismatched domain do not call.
- Remote `installConnector` sends `vm-ga-ping` then prep and `runuser` / `powershell.exe`. `--server` / `-Server` is `https://192.168.84.81:7780` when that LAN address is paired, and is not loopback. `sudoPassword` is absent from call args, the task, and `machines.json`.
- Offline, `vms` off, and an unknown host use the sentences in section 5 and do not call `vm-ga-*`. Stopped, after the host gate, is `Start the machine first.` Unsupported does not call. Ping failure is `needs-agent` with no exec.
- The Series B test that expected the old refuse no longer expects it. Power, snapshot, and uninstall behavior in that test stays.
- Remote cloud create’s `vm-seed` contains `qemu-guest-agent`, python, and linger, and does not contain `install.sh`, `--token`, or the account password. After a successful start, `vm-ga-ping` happens only once `machines.create` has already resolved. A failed `vm-start` does not ping. Alpine create does not ping.
- Local `test/guest-connector-install.test.mjs` still passes with an injected `qemuAgent`.
