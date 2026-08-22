# Manual and Headless Install

The supported non-interactive install path is:

```bash
openpalm install --file <setup-spec.yaml>
```

This uses the same setup implementation as the browser wizard and creates the
full runtime contract. Use `--no-start` when you intend to operate the generated
stack with raw Docker Compose.

## Install the CLI

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh \
  | bash -s -- --cli-only
```

Windows PowerShell — the plain `irm | iex` one-liner has no way to pass script
arguments (`$args` is empty inside a script run through `iex`), so use the
saved-file form when you need `--cli-only` or any other flag:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 -OutFile setup.ps1
Unblock-File .\setup.ps1
powershell -ExecutionPolicy Bypass -File .\setup.ps1 --cli-only
```

The default Windows execution policy (`Restricted`, or `RemoteSigned` for a
file downloaded from the internet) blocks running a saved, unsigned script
directly — `./setup.ps1 --cli-only` fails with a policy error on a stock
machine. `Unblock-File` clears the mark-of-the-web flag the download added;
`-ExecutionPolicy Bypass` overrides the policy for that one invocation only
and does not change your system-wide setting.

Then run the file install below.

### Environment Variables and Flags

Both installer scripts accept the same knobs. Under `irm | iex` on Windows,
only environment variables take effect — script arguments are silently
ignored in that form (see above), so pin a version or architecture with
`OP_VERSION`/`OP_ARCH` rather than `--version`/`--arch` when using the
one-liner.

| Variable | Equivalent flag (saved-file form only) | Purpose |
|---|---|---|
| `OP_VERSION` | `--version <tag>` | Install a specific release tag instead of resolving latest stable |
| `OP_ARCH` | `--arch <arch>` (Windows only) | Override detected architecture |
| `OP_INSTALL_DIR` | — | Install location. Default `~/.local/bin` on Linux/macOS, `%LOCALAPPDATA%\openpalm\bin` on Windows |
| `OP_NO_ALIAS` | — | Linux/macOS only. Set to `1` to skip writing the `op` shell alias |
| — | `--cli-only` | Install the CLI binary only; skip seeding `OP_HOME` and starting the stack |

Example — pin a release and skip the `op` alias, Linux/macOS:

```bash
OP_VERSION=0.13.0 OP_NO_ALIAS=1 \
  curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

## Minimal Setup Spec

A fresh installation requires a version 2 object, a `security` object with a UI
password, and a `connections` array. Provider/model selection is optional.

```yaml
version: 2
security:
  uiLoginPassword: change-me-please
connections: []
access:
  networkAccess: false
  assistantDirect: false
  guardianNetwork: false
  guardianOpenaiApi: false
```

`uiLoginPassword` must be at least eight characters. A setup rerun may omit it
to preserve an existing password, but a fresh install fails closed without one.

## Provider Example

```yaml
version: 2
security:
  uiLoginPassword: change-me-please
owner:
  name: Jane Operator
  email: jane@example.com
llm:
  provider: openai
  model: gpt-4o
  baseUrl: https://api.openai.com/v1
embedding:
  provider: openai
  model: text-embedding-3-small
  dims: 1536
  baseUrl: https://api.openai.com/v1
connections:
  - id: openai
    name: OpenAI
    provider: openai
    baseUrl: https://api.openai.com/v1
    apiKey: sk-...
addons:
  gateway: true
  voice: true
voiceProfile: addon.voice.cpu
access:
  networkAccess: false
  assistantDirect: false
  guardianNetwork: false
  guardianOpenaiApi: false
```

Portal bot credentials can be supplied through `portalCredentials`; setup
writes sensitive values to `private/secrets/` and non-secret portal settings to
`state/stack.env`.

The access object contains independent booleans. There is no nested network
object, preset, operator-supplied OpenCode password, or SSH option.

> The `access` object requires OpenPalm `0.13.0` or newer. On a resolved
> release older than `0.13.0`,
> validation does not know about `access` at all — the object is silently
> accepted and dropped, so none of these booleans take effect and no error is
> raised. Pin `--version`/`OP_VERSION` to a `0.13.0`-or-later release if you
> need `access` to actually apply.

## Run the Install

```bash
openpalm install --file ./setup-spec.yaml
```

To create files without starting Docker:

```bash
openpalm install --file ./setup-spec.yaml --no-start
```

The normal install records `OP_SETUP_COMPLETE=true` only after a successful
deploy. A `--no-start` install leaves setup incomplete until an OpenPalm deploy
succeeds. Prefer `openpalm start` once before switching entirely to raw Compose
if the host UI should treat setup as complete.

## Isolated Runtime Overrides

The file-install path persists these non-secret shell overrides into
`state/stack.env`:

- `OP_PROJECT_NAME`
- `OP_ASSISTANT_PORT`
- `OP_UI_PORT`
- `OP_HOST_UI_PORT`

```bash
OP_HOME="$PWD/.tmp/openpalm/home" \
OP_PROJECT_NAME=openpalm-test \
OP_ASSISTANT_PORT=4810 \
OP_UI_PORT=4800 \
OP_HOST_UI_PORT=4880 \
openpalm install --file ./setup-spec.yaml --no-start
```

## What the Installer Generates

`packages/skeleton/` is only a release asset bundle. A complete runtime also
needs generated directories and files, including:

```text
config/{assistant,guardian,akm,stack}/
system/{assistant,guardian,stack}/
state/
private/secrets/
knowledge/{env,secrets,tasks}/
data/{assistant,guardian,akm,logs,ui,backups,rollback}/
cache/{assistant,guardian}/
workspace/
```

The managed Compose files are placed in `system/stack/`; only
`config/stack/custom.compose.yml` is user-owned. `state/stack.env` is the sole
Compose env file.

Baseline generated secret material includes:

```text
knowledge/secrets/auth.json
private/secrets/op_ui_login_password
private/secrets/op_opencode_password
private/secrets/op_guardian_admin_token
private/secrets/op_guardian_mcp_token
private/secrets/op_api_key
private/secrets/portal_api_secret
private/secrets/portal_discord_secret
private/secrets/portal_slack_secret
```

Enabling Discord additionally requires `private/secrets/discord_bot_token`.
Enabling Slack requires `private/secrets/slack_bot_token` and
`private/secrets/slack_app_token`. Secret directories use mode `0700`; files
use `0600`.

Raw copying omits generated state and can leave required secrets or bind-source
directories absent. This guide intentionally does not provide a partial
copy-and-fill recipe.

## Remote Access Providers (Headless)

The `remote` addon is one capability with mutually-exclusive provider
variants (Tailscale today), selected by `OP_REMOTE_PROFILE` — see
`docs/technical/remote-provider-contract.md` for the model. Headlessly it is
ordinary files, no spec object required:

```bash
# state/stack.env
OP_ENABLED_ADDONS=remote          # deploys the default (Tailscale) variant
# OP_REMOTE_PROFILE=addon.remote.tailscale   # explicit selection, optional
# OP_REMOTE_TARGET=assistant      # assistant | guardian | both
```

With nothing else set, the tunnel starts in interactive-login mode: the
sign-in link appears on the addon's status card in the UI, or in the
container logs (`openpalm logs tunnel`). For fully unattended installs,
pre-authorize the node by writing a reusable Tailscale auth key to
`private/secrets/ts_authkey` (mode `0600`; the file is seeded empty by
install, and blank deliberately means interactive login). Know what a
reusable auth key exposes before scripting one.

Two keys have no UI control by design. `OP_REMOTE_PUBLIC=true` turns the
private tailnet link into a public Funnel link with **no sign-in page in
front of it** — a hand edit reserved for operators who have read the
warning in the addon's env schema. `OP_UI_ADDRESS_HEADER` /
`OP_UI_XFF_DEPTH` are maintained by the addon's own apply (they keep the
login throttle per-client behind the tunnel) and should not be set by hand.

## Raw Compose After Generation

After a generated install, use the managed files, the user overlay, the
sole env file, and explicit active profiles. The three core managed files are
always present; a voice overlay joins them when voice LAN access is on. See the
[Manual Compose Runbook](manual-compose-runbook.md) for the exact file list.
`OP_ENABLED_ADDONS` is translated only by OpenPalm control-plane commands.

Continue with the [Manual Compose Runbook](manual-compose-runbook.md).
