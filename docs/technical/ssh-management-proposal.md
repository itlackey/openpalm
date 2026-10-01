# SSH instance management implementation guide

Status: proposal for consideration in OpenPalm 0.15. Not implemented or a release commitment.

This guide outlines how Admin could manage an OpenPalm installation on another
computer over SSH. The recommended first version manages existing instances
using system OpenSSH and the remote OpenPalm CLI. It adds no permanent service,
container, public management endpoint, or separate SSH credential store.

SSH management is distinct from Guardian MCP access and the experimental Codex
and Claude Code remote sessions. An SSH account manages the host and its stack;
a Guardian credential controls what an assistant client can do.

## First version scope

Support existing 0.14 homes on supported Linux hosts after installing a remote
CLI that implements the new management entry point. A currently released 0.14
CLI cannot provide that entry point. Require SSH access, a compatible remote
CLI, and an account already permitted to manage Docker without interactive sudo.

Include:

- Remembered remote instances alongside local instances on the welcome screen.
- Connection testing, instance validation, and understandable failure messages.
- Status, service logs, start, stop, and restart.
- Stack configuration, Guardian credentials, portal mappings, and portal tokens.
- Existing provider discovery and readiness checks, without promising remote
  browser sign-in support in the first version.
- An optional local tunnel for opening the remote OpenCode interface. Guardian
  MCP tunneling can follow the same mechanism, retaining normal authentication.

Defer automatic host provisioning, remote installation and updates, password
storage, remote directory browsing, backup transfers, browser-based provider
authentication, and interactive Codex or Claude setup until their individual
flows have been verified. Do not silently fall back to local execution for an
unsupported remote operation; show that limitation in Admin.

## User experience

1. The welcome screen offers **Open remote instance** beside the local folder
   picker. Ask for an SSH host or existing SSH alias, an optional username and
   port, and the remote OpenPalm directory. An advanced field can override the
   CLI executable path when detection fails.
2. **Test connection** checks authentication, CLI compatibility, the selected
   home, and Docker access before opening management screens. It does not start
   or stop containers or modify the selected home.
3. Remember the host and home as a recent instance, with an unmistakable remote
   label. Never store passwords, private keys, provider secrets, or MCP keys in
   instance preferences.
4. Reuse existing management screens. Keep the active host and home visible so
   users know where an action will run.
5. **Open OpenCode** establishes a loopback-only local tunnel and opens its
   local URL. The tunnel closes when the instance is closed or switched. Closing
   Admin must not stop the remote stack.

Keep the current manual window sizing behavior. Switching instances must clear
temporary secrets, authentication state, previews, and connection-specific URLs.
Block switching while a management mutation is in progress.

## Reuse the existing boundaries

The current implementation provides useful starting points, but not an SSH
backend:

- [Admin types](../../packages/electron/src/admin-types.ts) define a local-only
  `AdminInstance` and the existing renderer API.
- [Instance selection](../../packages/electron/src/admin-instances.ts) owns
  validation, recent instances, and operation isolation.
- [Admin handlers](../../packages/electron/src/admin-app.ts) currently execute
  local filesystem and Docker operations at the IPC boundary.
- [Admin domain functions](../../packages/electron/src/admin-domain.ts), the
  [shared library](../../packages/lib/src), and the
  [CLI](../../packages/cli/src/main.ts) contain the operations to reuse.

Extend the instance target to distinguish local and SSH destinations. Identify
a remote instance by its destination, effective connection options, and
canonical remote home, not by its home path alone. Resolve remote paths on the
remote host; never pass them through local directory validation.

Introduce a small host-operation boundary behind the existing renderer API.
Local operations call shared functions directly. SSH operations call those same
functions through a remote CLI process. Move reusable Electron-independent
operations into `@openpalm/lib` as needed; do not build a second implementation
of configuration, credential, or lifecycle logic. Clipboard, local dialogs,
browser opening, and preference storage remain local.

Preserve the selected home's saved Compose project identity. Do not derive a
replacement project name from an SSH alias or folder name.

## Remote CLI transport

Add an explicitly invoked, machine-readable CLI subcommand, provisionally
`openpalm manage --stdio`. Its final name and message format are implementation
decisions. Do not overload `openpalm remote`, which already manages optional
native coding workers, or invoke bare `openpalm`, which starts the normal
installation flow.

Run one CLI process over an SSH session while Admin is connected. It exits on
disconnect and is not a daemon. Use a small versioned JSON envelope with request
IDs, an explicit operation, arguments, and structured success or failure.
Reserve stdout for framed responses; send diagnostics to stderr. Bound message
sizes and operation timeouts. Only dispatch supported domain operations, not
arbitrary shell or Docker commands.

Authenticate through OpenSSH, then validate CLI compatibility and the remote
home before enabling writes. Bind the session to that home; switching targets
opens a new session. Pass credentials, paths, and configuration through stdin,
not command-line arguments or shell-interpolated environment assignments.

Use argument arrays to launch the local SSH process. SSH remote execution still
involves a remote shell, so argument arrays alone do not make the remote command
safe. Keep the remote bootstrap command fixed, correctly quote any configurable
executable path, and keep operation data out of it. Non-interactive SSH may not
include the user's normal CLI installation directory in PATH; detect a known
installation location or request an explicit path rather than sourcing shell
startup files.

Report interrupted mutations as an unknown outcome when appropriate. Do not
automatically replay credential rotation, configuration writes, or lifecycle
actions after reconnecting. Refresh state and let the user decide what to do.
Retain existing locks and safe filesystem writes on the remote host.

## Authentication and tunnels

Use the installed `ssh` executable, existing SSH configuration, and local key
agent. Check that SSH is available and report how to install it when missing.
Do not upload private keys, enable agent forwarding, bypass host-key checks, or
auto-accept changed host keys. The first version should support established
key-based authentication and provide a clear native SSH verification step when
trust or an unlocked key is needed. `BatchMode` can prevent background requests
from hanging on password or host-trust prompts. These behaviors belong to
[OpenSSH configuration](https://man.openbsd.org/ssh_config.5).

For browser access, bind a local forwarding socket explicitly to `127.0.0.1`
and connect it to the configured Assistant endpoint as seen from the remote
host. Do not assume the Assistant is always bound to remote loopback: an
operator may have explicitly configured a LAN address. Handle wildcard bind
addresses as listening configuration, selecting a usable destination instead.
Use an available local port, check forwarding setup, then verify the actual
endpoint; an established SSH connection alone is not service readiness.
[OpenSSH local forwarding](https://man.openbsd.org/ssh.1) carries traffic over
the encrypted connection without requiring public Assistant exposure.

Native OpenCode access through a tunnel still bypasses Guardian and retains
OpenCode authentication. Guardian MCP through a tunnel retains Guardian policy
and credentials. SSH management access is host administration, not an additional
Guardian policy. Avoid a Docker SSH context as the main transport: it does not
cover the remote home, configuration files, or provider state.

## Implementation sequence

1. Extract the minimum shared host operations and test unchanged local behavior.
   Add the CLI stdio entry point, structured errors, compatibility check, and
   session-bound home validation.
2. Add the system-SSH transport, destination validation, executable detection,
   connection deadlines, disconnect handling, and process cleanup.
3. Extend welcome, preferences, target isolation, and management screens. Show
   supported operations explicitly and keep unsupported flows unavailable.
4. Add OpenCode tunneling and endpoint checks, then integration tests against a
   disposable SSH host with two independent homes.
5. Assess full Admin parity separately. Browser callbacks need a deliberate
   local-versus-remote routing design; backup/import need explicit file transfer
   and path semantics. Experimental native worker setup must preserve native
   trust, sandbox, sign-in, and hook approval rather than bypassing them.

Update active architecture and core principles only when the feature is approved
and implemented. This proposal does not change the current 0.14 contract.

## Verification and acceptance criteria

- Unit-test target parsing, preference compatibility, framing, unsupported
  operations, executable paths with spaces or shell metacharacters, and remote
  homes that differ from local paths.
- Test missing SSH, missing CLI, incompatible versions, authentication failure,
  unknown or changed host keys, unavailable Docker, invalid homes, and noisy
  remote startup output. Errors must not trigger local execution or setup.
- Verify status, logs, lifecycle, configuration, credentials, and portal changes
  affect only the selected remote home. Confirm the other home remains intact.
- Disconnect during a mutation; verify locks recover and reconnect does not
  replay the operation or claim an unconfirmed success.
- Verify tunnels are loopback-only, work with configured loopback and LAN binds,
  detect unavailable services and occupied ports, and close on switch or exit.
- Verify instance switching clears secrets and stale authentication responses.
  No secrets appear in process arguments, preferences, diagnostics, or reports.
- Run the normal check, test, lint, build, and Compose verification gates, then
  manually test the supported Admin desktop platforms against a Linux host.
- Record screenshots and a repeatable SSH integration runbook. Keep window
  dimensions unchanged unless the tester explicitly resizes the window.

## Effort and release decision

These are rough engineering estimates, not delivery commitments:

| Scope | Estimate |
|---|---|
| Existing-instance management and an OpenCode tunnel | 3–5 days |
| Polished onboarding, failure handling, and integration verification | Another 3–5 days |
| Full remote setup, file transfers, and authentication parity | Several additional days, depending on authentication flows |

Consider the first version for 0.15 only after the local Admin experience remains
stable and the SSH acceptance criteria pass. Keep server provisioning and broader
fleet-management features outside this proposal; one selected host and home
should remain the unit of management.
