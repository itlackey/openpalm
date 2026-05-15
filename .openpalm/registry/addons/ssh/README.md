# SSH Addon

Overlay-only addon that publishes the assistant container's SSH port on
the host and enables sshd inside the container.

## What it does

- Patches the existing `assistant` service to publish port `22` from the
  container as `2222` on the host (`127.0.0.1` by default).
- Sets `OPENCODE_ENABLE_SSH=1` so the assistant entrypoint launches
  `sshd` at startup.

When this addon is **not** enabled, no SSH port is reserved on the host
and sshd does not run inside the container.

## Enabling

```bash
openpalm addon enable ssh
```

Disable with `openpalm addon disable ssh`.

## Configuration

| Variable                          | Default       | Purpose                                  |
|-----------------------------------|---------------|------------------------------------------|
| `OP_ASSISTANT_SSH_BIND_ADDRESS`   | `127.0.0.1`   | Host interface to bind. Use `0.0.0.0` for LAN access. |
| `OP_ASSISTANT_SSH_PORT`           | `2222`        | Host port to publish.                    |

Set these in `vault/stack/stack.env` if you need to override the
defaults.

## Security implications

Read these before enabling on a non-loopback interface:

- The `opencode` user inside the container has **passwordless sudo**.
  Anyone who logs in via SSH can become root in the container.
- sshd is configured for **public-key authentication only** — password
  logins are disabled. You must place an authorized key for the
  `opencode` user inside the container's `~/.ssh/authorized_keys`
  before connecting.
- Default bind is loopback (`127.0.0.1`). Exposing on `0.0.0.0` makes
  the assistant SSH port reachable from the LAN; treat the addon as
  a privileged ingress when you do.
