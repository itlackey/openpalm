# Undocumented Details Inventory

Date: 2026-03-21

This document records source-backed runtime and repository details that are real
today but are not yet properly covered in the main docs set.

It is intentionally a gap inventory, not a normative spec. When these items are
documented elsewhere, this file can be reduced or removed.

---

## Guardian Ingress Details

### Dual rate limits

Undocumented fact:

- Guardian enforces both a per-user limit and a per-channel limit.
- Current defaults are `120/min` per user and `200/min` per channel.

Source:

- `core/guardian/src/server.ts:102`
- `core/guardian/src/server.ts:392`
- `core/guardian/src/server.ts:414`

Missing from:

- `docs/how-it-works.md`
- `docs/technical/foundations.md`
- `docs/technical/environment-and-mounts.md`

### Guardian stats endpoint

Undocumented fact:

- Guardian exposes an admin-token-protected `/stats` endpoint with live request,
  limiter, replay-cache, and session counters.

Source:

- `core/guardian/src/server.ts:392`
- `core/guardian/src/server.ts:414`

Missing from:

- `docs/how-it-works.md`
- `docs/technical/foundations.md`

### Payload and request size limits

Undocumented fact:

- Inbound request bodies are capped at `100 KB`.
- Payload fields also have fixed maximum lengths: `channel` 64, `userId` 256,
  `nonce` 128, `text` 10000.

Source:

- `core/guardian/src/server.ts:442`
- `packages/channels-sdk/src/channel.ts:78`

Missing from:

- `docs/how-it-works.md`
- `docs/channels/community-channels.md`

### Session-affinity metadata controls

Undocumented fact:

- `metadata.sessionKey` can override the default assistant session mapping.
- `metadata.clearSession=true` clears matching assistant sessions.
- Guardian caches session mappings with a `15m` default TTL.

Source:

- `core/guardian/src/server.ts:207`
- `core/guardian/src/server.ts:243`
- `core/guardian/src/server.ts:259`
- `core/guardian/src/server.ts:497`

Missing from:

- `docs/how-it-works.md`
- `docs/channels/community-channels.md`
- `docs/technical/opencode-configuration.md`

---

## Assistant Runtime Details

### Provider-key pruning in the assistant entrypoint

Undocumented fact:

- The assistant entrypoint removes unused provider API keys from its process
  environment based on `SYSTEM_LLM_PROVIDER`, reducing secret exposure.

Source:

- `core/assistant/entrypoint.sh:166`
- `core/assistant/entrypoint.sh:172`

Missing from:

- `docs/password-management.md`
- `docs/technical/opencode-configuration.md`

### SSH hardening behavior

Undocumented fact:

- Optional assistant SSH is key-only.
- The entrypoint creates `authorized_keys` if needed.
- Password auth, root login, TCP forwarding, agent forwarding, X11 forwarding,
  and tunnels are disabled.

Source:

- `core/assistant/entrypoint.sh:87`
- `core/assistant/entrypoint.sh:115`

Missing from:

- `docs/technical/opencode-configuration.md`
- `docs/technical/environment-and-mounts.md`

### Varlock wrapping of shell execution and OpenCode startup

Undocumented fact:

- Shell execution is wrapped through `varlock-shell`.
- The main `opencode web` process is also launched through `varlock` when
  available so redaction occurs before output reaches model context.

Source:

- `core/assistant/entrypoint.sh:198`
- `core/assistant/entrypoint.sh:211`
- `core/assistant/entrypoint.sh:224`
- `core/assistant/varlock-shell.sh:2`

Missing from:

- `docs/technical/opencode-configuration.md`
- `docs/password-management.md`
- `.openpalm/vault/README.md`

---

## Addon and Compose Contract Details

### Addon overlays may patch core services

Undocumented fact:

- The `openviking` overlay does not only add a service; it also injects
  `OPENVIKING_URL` and `OPENVIKING_API_KEY` into the existing `assistant`
  service definition.

Source:

- `.openpalm/stack/addons/openviking/compose.yml:29`
- `.openpalm/stack/addons/openviking/compose.yml:32`

Missing from:

- `docs/technical/environment-and-mounts.md`
- `docs/how-it-works.md`

### Addon metadata label contract

Undocumented fact:

- Shipped addon compose files use an `openpalm.*` label contract for discovery
  and UI metadata.
- Current labels include `openpalm.name`, `openpalm.description`, and optional
  values such as `openpalm.icon`, `openpalm.category`, and `openpalm.healthcheck`.

Source:

- `.openpalm/stack/addons/chat/compose.yml:27`
- `.openpalm/stack/addons/api/compose.yml:27`
- `packages/lib/src/control-plane/components.ts:38`
- `packages/lib/src/control-plane/components.ts:122`

Missing from:

- `docs/managing-openpalm.md`
- `docs/how-it-works.md`

---

## Bootstrap and Workflow Details

### Host environment probe output location

Undocumented fact:

- The CLI install flow writes host-environment probe output to
  `data/host.json`, not `config/host.yaml`.

Source:

- `packages/cli/src/commands/install.ts:127`

Missing from or contradicted by:

- `.openpalm/README.md`
- `.openpalm/config/README.md`

### Setup wizard bind address and port override

Undocumented fact:

- The setup wizard server defaults to `127.0.0.1:8100`.
- The port is overrideable with `OP_SETUP_PORT`.

Source:

- `packages/cli/src/commands/install.ts:19`
- `packages/cli/src/setup-wizard/server.ts:258`

Missing from:

- `docs/setup-guide.md`
- `docs/setup-walkthrough.md`
- `docs/installation.md`

### Memory docs endpoint does not exist in the shipped server

Undocumented fact:

- The shipped memory server exposes `/health` plus JSON API routes only.
- There is no built-in `/docs` UI in the current Bun memory server.

Source:

- `core/memory/src/server.ts:241`
- `core/memory/src/server.ts:252`
- `core/memory/src/server.ts:417`

Contradicted by:

- `docs/managing-openpalm.md:319`

---

## Recommended Follow-Up Documentation Work

Priority order:

1. Document guardian limits, payload caps, and session metadata in
   `docs/how-it-works.md` and `docs/channels/community-channels.md`
2. Document assistant SSH hardening and varlock redaction in
   `docs/technical/opencode-configuration.md` and `docs/password-management.md`
3. Document addon metadata labels and overlay patching behavior in
   `docs/managing-openpalm.md`
4. Fix setup and bootstrap docs to reflect `data/host.json`, `OP_SETUP_PORT`,
   and the lack of a memory `/docs` endpoint

---

## Intent

This file exists so these details stop being tribal knowledge. Each item here is
backed by current source and should either be promoted into a primary document
or consciously deprecated in code.
