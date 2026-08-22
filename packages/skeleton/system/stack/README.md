# system/stack/

This directory contains OpenPalm's managed Compose assembly. Lifecycle
reconcile may replace these files. User services and overrides belong only in
`$OP_HOME/config/stack/custom.compose.yml`.

## Files

| File | Purpose |
|---|---|
| `core.compose.yml` | Always-on assistant service and shared networks |
| `services.compose.yml` | Profile-gated services such as Voice and Ollama |
| `portals.compose.yml` | Profile-gated Guardian, compatible API, Discord, and Slack |
| `voice.compose.cdi.yml` | Managed Voice CUDA fallback for hosts using NVIDIA CDI |
| `voice.compose.rootless.yml` | Managed Voice user override for rootless Docker |

The complete normal file list also includes the user overlay:

```text
$OP_HOME/config/stack/custom.compose.yml
```

## Core and Addons

The assistant is the only always-on container. It runs OpenCode, the image-baked
OpenPalm UI, and BusyBox cron for AKM tasks.

Guardian is not core. It is deployed by a Guardian-ingress addon profile
(`addon.api`, `addon.discord`, `addon.slack`, `addon.gateway`) or by the bare
`guardian` profile, which the control plane activates whenever the guardian is
required without an addon (the guardian access toggles, or a remote tunnel
targeting it).

| Runtime | Activation | Default host publication |
|---|---|---|
| `assistant` OpenCode | Always | `127.0.0.1:3810 -> 4096` |
| Assistant UI | Always | `127.0.0.1:3800 -> 3000` |
| Guardian direct ingress | Guardian profile | `127.0.0.1:3830 -> 3830` |
| Guardian principal admin | Guardian profile | `127.0.0.1:3831 -> 3831` |
| Compatible API | `guardian.compose.api.yml` overlay (guardianOpenaiApi toggle or `api` addon) | `127.0.0.1:3821 -> 8182`; no host port otherwise |
| Discord / Slack | Matching profile | No host port; outbound bot connections |
| Voice | `addon.voice.*` | `127.0.0.1:8880 -> 8880` |
| Ollama | `addon.ollama.*` | Internal model service |

There is one Guardian-hosted compatible API listener on a single host port.

Voice is defined in `services.compose.yml`, joins `addon_net`, and defaults its
host port to loopback. Default TTS/STT models are baked into the Voice image.
Hardware variants use managed profiles. OpenPalm may select its managed CDI or
rootless fallback file during bring-up; operators do not maintain a generic GPU
overlay.

## Networks

| Network | Purpose |
|---|---|
| `assistant_net` | Assistant and explicitly trusted dependencies, including Guardian |
| `portal_net` | Portal adapters to Guardian |
| `addon_net` | Optional services that do not need assistant reachability, including Voice |

## Env and Secrets

Compose receives one env file:

```text
$OP_HOME/state/stack.env
```

It contains non-secret values and `OP_ENABLED_ADDONS`. OpenPalm control-plane
commands translate enabled IDs to profiles. Raw Docker Compose requires active
`--profile` arguments or an explicit `COMPOSE_PROFILES` value.

Delegated UI, Guardian, API, portal, bot, and OpenCode-server credentials come
from `$OP_HOME/state/secrets/`. Provider auth remains at
`$OP_HOME/knowledge/secrets/auth.json` because the assistant's OpenCode runtime
must read it.

Do not add another `--env-file` or broad service-level `env_file` grant.

## Raw Start

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile guardian \
  up -d
```

See the
[Manual Compose Runbook](../../../../docs/operations/manual-compose-runbook.md)
for profile handling, validation, and operations.
