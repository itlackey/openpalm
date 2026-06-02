# Setup Guide

OpenPalm has three setup paths, in order of recommendation:

1. **Desktop app** (most users) — download, double-click, follow the wizard. Recommended.
2. **CLI install script** — for servers and headless environments. Same wizard, in your browser.
3. **Manual compose** — copy `.openpalm/` by hand and run `docker compose` yourself.

All three install the same stack from the same compose files. Pick whichever fits.

---

## Prerequisites

You need Docker with Compose V2.

| Your computer | What to install | Link |
|---|---|---|
| **Mac** | Docker Desktop or OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com | sh` |

The wizard's first screen verifies Docker is installed and running before any configuration happens, so don't worry about getting Docker right ahead of time — you'll be told if anything is missing.

---

## 1. Desktop app (recommended)

Download the latest installer for your platform from the [releases page](https://github.com/itlackey/openpalm/releases/latest):

| Platform | Artifact |
|---|---|
| Mac (Apple Silicon) | `OpenPalm-<version>-arm64.dmg` |
| Mac (Intel) | `OpenPalm-<version>.dmg` |
| Windows | `OpenPalm-Setup-<version>.exe` |
| Linux | `OpenPalm-<version>.AppImage` |

Open the app. The setup wizard will:

1. **System Check** — verify Docker and Compose are available; offer install links if not.
2. **Welcome** — pick an admin token, name, email.
3. **Providers** — choose your AI provider (OpenAI, Anthropic, Ollama, LM Studio, etc.).
4. **Models** — pick chat, embedding, and (optional) small model.
5. **Voice** — TTS/STT settings.
6. **Options** — channels (Discord, Slack), addons, image tag.
7. **Review & Install** — confirm and deploy.

When the install completes, the same window navigates to the chat page. That's it.

> **First launch on macOS/Windows**: the installers aren't yet code-signed. On macOS, right-click the app and choose **Open**; on Windows, click **More info → Run anyway** on the SmartScreen prompt. Subsequent launches are unrestricted.

---

## 2. Headless install (CLI)

For servers or anyone who prefers a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

This downloads the CLI binary, seeds `~/.openpalm/`, opens the wizard in your default browser at `http://localhost:3880/setup`, and starts the stack on completion. The wizard is identical to the desktop version.

To re-run the wizard later (e.g. to add a channel or change providers), run `openpalm` and click **Update Settings** in the admin overview, or open `http://localhost:3880/setup?rerun=1`.

---

## 3. Manual compose (power users)

For full control without any harness:

```bash
git clone https://github.com/itlackey/openpalm.git
cp -R openpalm/.openpalm "$HOME/.openpalm"
$EDITOR "$HOME/.openpalm/knowledge/env/stack.env"
$EDITOR "$HOME/.openpalm/knowledge/env/user.env"
```

Then start the stack using the compose commands in the [Manual Compose Runbook](operations/manual-compose-runbook.md).

The running deployment is always the exact compose file list you pass to Docker Compose — there's no hidden orchestration layer.

---

## Deployment truth

- `~/.openpalm/config/stack/` is the only deployment foundation.
- Base services come from `~/.openpalm/config/stack/core.compose.yml`.
- First-party addons are defined in `services.compose.yml` and `channels.compose.yml`, then enabled by name in `~/.openpalm/config/stack/stack.yml`.
- Custom services and overlays live in `~/.openpalm/config/stack/custom.compose.yml`.
- OpenPalm resolves enabled addon names to Compose profiles; the fixed compose files remain deployment truth.

This keeps the live system understandable: if a compose file is not in the command, it is not part of the stack.

---

## Convenience options

The primary workflow is always raw `docker compose` as shown above. The options
below are typing shortcuts only.

### `op` helper function

The [Manual Compose Runbook](operations/manual-compose-runbook.md) documents the
generated `run.sh` and an optional `op` shell helper for custom compose work.
After adding it to your shell profile:

```bash
op up -d        # start the stack
op ps           # list containers
op logs -f      # follow all logs
```

### Setup scripts

Repo setup scripts can still help bootstrap files on a fresh machine, but they should be understood as convenience tooling that prepares the same `~/.openpalm/` layout. They do not replace the compose-first model.

If you use helper tooling that reads `config/stack/stack.yml`, treat that file as OpenPalm addon state - not as a Compose file.

---

## Common tasks

For all common compose operations (start, stop, status, pull, logs, restart), see the [Manual Compose Runbook](operations/manual-compose-runbook.md).

**Change model keys**

Edit `~/.openpalm/knowledge/env/stack.env`, then recreate services that need the new values.

---

## After setup

The copied bundle gives you a predictable host layout:

| Path | Purpose |
|---|---|
| `~/.openpalm/config/stack/` | Compose files |
| `~/.openpalm/knowledge/env/stack.env` | Stack-level env values |
| `~/.openpalm/knowledge/env/user.env` | Optional user extensions |
| `~/.openpalm/config/` | User-managed config |
| `~/.openpalm/data/` | Persistent container data |
| `~/.openpalm/data/logs/` | Logs |

If you include the `admin` addon, the UI is available on its configured host port from `stack.env`.

---

## Troubleshooting

### Docker not found

Verify Docker is installed and running:

```bash
docker info
```

### Wrong services started

Re-check the exact compose file list in your command. Docker Compose only deploys the files you pass.

### `config/stack/stack.yml` had no effect

That file is OpenPalm addon state. Regenerate or rerun the OpenPalm compose command so the selected addon names become `--profile` arguments.

### An addon fails to start

Inspect `~/.openpalm/config/stack/services.compose.yml`, `channels.compose.yml`, and logs (see [Manual Compose Runbook](operations/manual-compose-runbook.md) for log commands).

### Start over

Stop the stack, remove `~/.openpalm/` if you truly want a clean reset, then copy the bundle again and rerun your compose command.

---

## Next steps

| Guide | What's inside |
|---|---|
| [operations/manual-compose-runbook.md](operations/manual-compose-runbook.md) | Fully explicit compose workflow |
| [managing-openpalm.md](managing-openpalm.md) | Day-to-day operations |
| [how-it-works.md](how-it-works.md) | Architecture overview |
| [technical/foundations.md](technical/foundations.md) | Host paths, mounts, and runtime contract |
| [technical/core-principles.md](technical/core-principles.md) | Security and architecture rules |
