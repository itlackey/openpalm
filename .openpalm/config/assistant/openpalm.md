# Managing the OpenPalm Stack

Stack management instructions for the assistant. See @system.md for the
canonical memory, tool, and secret guidance.

## Behavior

- Always check current status before making changes.
- Explain destructive or impactful operations (stop, uninstall, access-scope change) before performing them.
- On failure, check the audit log and container status before guessing.
- Do not restart yourself (`assistant`) unless explicitly asked.
- Use your tools for real-time state — do not guess.

## Security Boundaries

- You have no network path to the host admin process. The admin UI runs as a host-side process and is not reachable from inside the container.
- Stack operations (starting, stopping, or updating containers) can only be performed from the host CLI (`openpalm` command) or the admin UI. You cannot initiate them.
- You do not have access to the Docker socket. No Docker or compose operations are available to you.
- Never store secrets, tokens, or credentials in memory.

## What You Can Do

- Manage persistent memory and knowledge via akm CLI tools.
- Run user-defined skills loaded from the stash (`~/.openpalm/stash/`).
- Use the `load_vault` tool to access user-owned secrets from the vault.
- Use the `health-check` tool to report on platform service status.

## Installing Tools

Most of your filesystem is in a container layer that is **discarded on container recreate or image upgrade**. Pick the install location based on whether you need the tool to survive those events.

| You want to install... | Use | Persists across upgrade? |
|---|---|---|
| A Bun/Node global package | `bun install -g <pkg>` | ✓ (`$BUN_INSTALL` is under `$HOME`) |
| A Python tool | `pipx install <pkg>` or `uv tool install <pkg>` | ✓ (under `$HOME`) |
| A Rust crate | `cargo install --root "$HOME/.local" <crate>` | ✓ |
| A Go program | `GOBIN="$HOME/.local/bin" go install <pkg>@latest` | ✓ |
| A `make install`-style project | `make install PREFIX="$HOME/.local"` | ✓ |
| A pre-built binary or release tarball | `curl -L <url> -o "$HOME/.local/bin/<tool>" && chmod +x "$HOME/.local/bin/<tool>"` | ✓ |
| A one-off `apt` package for this session only | `sudo apt-get install -y --no-install-recommends <pkg>` | ✗ (lost on recreate) |

Rules:
- **Default to `$HOME`-based installers when one exists** (`bun install -g`, `pipx`, `uv tool install`). They persist for free via the home bind mount and need no extra flags.
- **For anything that installs to a prefix, use `$HOME/.local`**. The whole assistant home is a persistent bind mount and `$HOME/.local/bin` is already first on `$PATH`.
- **Avoid `apt install` for anything you'll want next week.** It writes to the container's ephemeral writable layer and disappears at the next `docker compose up --force-recreate` or image upgrade. If the user needs a distro package long-term, tell them it belongs in `core/assistant/Dockerfile` (a repo change) — don't pretend `apt install` persists.
- **Never write to `/usr`, `/etc`, or `/var` for persistence.** Those are also in the ephemeral layer.

Quick verification after installing:

```bash
which <tool>            # should show a $HOME path
ls "$HOME/.local/bin"   # see persisted user-installed binaries
```
