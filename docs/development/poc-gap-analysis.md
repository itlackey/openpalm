# Gap Analysis: POC Generators vs Current Stack-Spec / Generator

This report compares the **POC proof-of-concept generators** (`gen-stack.ts` and `gen-automations.ts` from `openpalm_poc_generators.md`) against the **current production implementation** in the OpenPalm codebase.

---

## 1. Stack-Spec Schema

### POC Schema (`StackSpec` / `ChannelSpec`)

| Field | Type | Notes |
|---|---|---|
| `projectName` | `string?` | Optional Docker Compose project name |
| `caddy.email` | `string?` | ACME email for Let's Encrypt |
| `channels[]` | `ChannelSpec[]` | **Array** of arbitrary channel objects |
| `channels[].name` | `string` | Free-form service name |
| `channels[].image` | `string` | Full Docker image reference |
| `channels[].exposure` | `host \| lan \| public` | Three-tier exposure model |
| `channels[].containerPort` | `number` | Required |
| `channels[].hostPort` | `number?` | Defaults to containerPort |
| `channels[].domains` | `string[]?` | Caddy virtual-host routing |
| `channels[].pathPrefixes` | `string[]?` | Caddy path-based routing |
| `channels[].internalTls` | `boolean?` | Default true for host/lan |
| `channels[].env` | `Record<string, scalar>?` | Environment variables |
| `channels[].config` | `Record<string, scalar>?` | Merged into env |
| `automations[]` | `AutomationSpec[]` | Cron job definitions |

### Current Schema (`packages/lib/admin/stack-spec.ts`)

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Schema version lock |
| `accessScope` | `host \| lan` | Global ingress scope (no `public`) |
| `channels` | `Record<StackChannelName, StackChannelConfig>` | **Fixed map** of 4 known channels |
| `channels[name].enabled` | `boolean` | Toggle channel on/off |
| `channels[name].exposure` | `host \| lan \| public` | Per-channel exposure |
| `channels[name].config` | `Record<string, string>` | Whitelisted config keys only |
| `automations[]` | `StackAutomation[]` | Cron job definitions |

### Gaps

| # | Gap | Severity | Detail |
|---|---|---|---|
| S1 | **No `projectName`** | Low | Current implementation hardcodes project naming via compose structure; no user-configurable project name in the spec. |
| S2 | **No `caddy.email`** | Medium | POC generates a global Caddy block with ACME email for Let's Encrypt. Current generator hardcodes `admin off` and has no ACME/email configuration. Public TLS certificates cannot be automatically obtained. |
| S3 | **Fixed channel set vs. dynamic array** | High | POC uses `channels[]` — an open-ended array where any service can be declared. Current uses a closed `Record<StackChannelName, ...>` restricted to exactly `chat`, `discord`, `voice`, `telegram`. Adding a new channel type requires code changes to `StackChannelName`, `ChannelConfigKeys`, the generator, and tests. The POC's approach is more extensible. |
| S4 | **No `image` field per channel** | Medium | POC lets each channel declare its own `image`. Current channels derive images from a global `${OPENPALM_IMAGE_NAMESPACE}` / `${OPENPALM_IMAGE_TAG}` convention. Third-party or custom channel images cannot be specified per-service. |
| S5 | **No `containerPort` / `hostPort` per channel** | Medium | POC allows arbitrary port configuration per channel. Current hardcodes ports in `ChannelPorts` map (`chat=8181`, `discord=8184`, etc.). No user control over port assignments. |
| S6 | **No `domains` / virtual-host routing per channel** | Medium | POC routes traffic via `domains[]` per channel (e.g., `admin.local`, `api.example.com`). Current uses a single `:80` catch-all site block with path-based routing (`/channels/chat*`). No support for domain-based virtual hosting. |
| S7 | **No `pathPrefixes` per channel** | Low | POC allows configurable `pathPrefixes[]` per channel. Current hardcodes paths in `ChannelRewritePaths`. |
| S8 | **No `internalTls` option** | Low | POC supports `tls internal` for non-public services (useful for mTLS between services). Current Caddy config operates on HTTP only (port 80) with no TLS configuration. |
| S9 | **No `public` in `accessScope`** | Medium | `accessScope` is limited to `host | lan`. The POC has a three-tier model where `public` is a first-class exposure level with full ACME TLS. Current supports `public` per-channel in the exposure field but the global access scope and Caddy configuration don't fully support public internet exposure with automatic certificates. |

---

## 2. Stack Generator (Compose + Caddy)

### POC Generator (`gen-stack.ts`)

- Standalone Bun script, reads JSON, writes `docker-compose.yml` + `Caddyfile`
- Generates per-channel compose services from the array
- Exposure model controls port binding: `127.0.0.1:HP:CP` for host, `HP:CP` for lan/public
- Always includes a Caddy service with ports 80/443, data volumes, shared `edge` network
- Caddy routing: per-domain site blocks, path-based handle rules, `tls internal` for non-public
- Global Caddy email block for ACME
- Uses a custom YAML serializer (POC-quality)

### Current Generator (`packages/lib/admin/stack-generator.ts`)

- Library function (`generateStackArtifacts`) embedded in the admin package
- Generates: compose file, Caddyfile, Caddy route snippets, env files (gateway, channels, postgres, qdrant, openmemory, opencode)
- Compose file is a **template string** with hardcoded core services (caddy, postgres, qdrant, openmemory, openmemory-ui, opencode-core, gateway, admin) + dynamic channel services
- Exposure model: correctly implements `127.0.0.1` binding for host exposure
- Caddy: single `:80` site block, `@lan`/`@not_lan`/`@host`/`@not_host` matchers, snippet imports
- Per-channel Caddy routes emitted as separate `.caddy` snippet files
- Supports secret references (`${SECRET_NAME}`) resolved from a secrets env file
- Integrated with `StackManager` for atomic spec writes and artifact rendering
- Has `StackApplyEngine` for diff-based impact analysis and targeted restarts/reloads

### Gaps

| # | Gap | Severity | Detail |
|---|---|---|---|
| G1 | **No domain-based Caddy routing** | Medium | POC generates separate `site { }` blocks per domain with `reverse_proxy` directives. Current uses a single `:80` block with path matchers and Caddy snippet imports. Cannot route by virtual host. |
| G2 | **No HTTPS/TLS support** | Medium | POC generates `tls internal` for host/lan and relies on Caddy's automatic HTTPS with ACME email for public. Current listens on `:80` only with `admin off`. No TLS termination. |
| G3 | **Compose file is a template string, not structured** | Low | POC builds a structured JS object and serializes it to YAML. Current builds compose output via string concatenation/template literals. This makes the compose generation harder to test, extend, and validate programmatically. |
| G4 | **No user-configurable network name** | Low | POC uses a configurable `edge` network. Current hardcodes `assistant_net`. Not user-facing but affects composability. |
| G5 | **No standalone CLI entrypoint for generation** | Low | POC is a standalone `bun run gen-stack.ts ./spec.json --out ./out` script. Current generation is embedded in the admin server/library, invoked through the `StackManager` class. There's no CLI tool to regenerate artifacts from a spec file independently. |
| G6 | **Core services not spec-driven** | Medium | POC treats all services uniformly — they're all defined in the spec. Current hardcodes 8 core services (caddy, postgres, qdrant, openmemory, openmemory-ui, opencode-core, gateway, admin) in the template. Adding or removing a core service requires modifying the generator code. |
| G7 | **No `volumes` / `labels` / `depends_on` per channel in spec** | Low | POC notes these as future enhancements. Current hardcodes `depends_on: [gateway]` and `networks: [assistant_net]` for all channels. No per-channel volume or label configuration. |

---

## 3. Automations Generator

### POC Generator (`gen-automations.ts`)

- Standalone Bun script, reads JSON, writes `cron.d.enabled/`, `cron.d.disabled/`, `cron.schedule`
- Each automation becomes its own file with a numbered prefix: `NN-slug`
- Inline cron lines with `sh -lc 'script'` wrapping
- 5-field cron validation
- Deterministic alphabetical ordering
- Clean output directory on each generation

### Current Generator (`admin/src/automations.ts`)

- `syncAutomations()` function called by the admin server
- Writes individual script files to `scripts/ID.sh`
- Generates `cron.d.enabled/NN-id` and `cron.d.disabled/NN-id` with numbered prefixes
- Generates `cron.schedule` combined file (enabled only)
- Uses a `run-automation` runner script with:
  - `flock`-based concurrency locking
  - JSONL structured logging (`log/ID.jsonl`)
  - Exit code tracking, duration measurement, output preview
- `crontab` reload after sync
- `triggerAutomation()` for manual ad-hoc execution
- `readHistory()` / `getLatestRun()` for reading execution logs
- Stale script cleanup (removes scripts no longer in spec)

### Gaps

| # | Gap | Severity | Detail |
|---|---|---|---|
| A1 | **No cron schedule validation** | Low | POC validates 5-field cron expressions (`isValidCron5`). Current `parseStackSpec` validates that `schedule` is a non-empty string but does not check cron format. Invalid cron expressions (e.g., `"not a cron"`) would be accepted by the spec parser and only fail at `crontab` reload time. |
| A2 | **No `sh -lc` wrapping** | Neutral | POC wraps scripts in `sh -lc '...'` for profile/PATH consistency. Current writes the raw script content to a `.sh` file and executes it via a runner bash script. This is arguably a better approach (the runner loads the environment). |

### Current Exceeds POC

| # | Advantage | Detail |
|---|---|---|
| A+ 1 | **Runner script with flock concurrency control** | POC has no concurrency protection. Current generates a runner that uses `flock -n` to prevent overlapping runs — exactly what the POC lists as a "future enhancement" (`concurrencyPolicy: wrap with flock`). |
| A+ 2 | **Structured JSONL execution logging** | POC has no logging. Current logs every run with timestamp, status, exit code, duration, and output preview in JSONL format. |
| A+ 3 | **Manual trigger support** | POC is generation-only. Current has `triggerAutomation()` for on-demand execution via the admin API. |
| A+ 4 | **Execution history API** | `readHistory()` and `getLatestRun()` provide access to past automation runs — not present in POC. |
| A+ 5 | **Crontab reload** | Current automatically calls `crontab` to install the schedule. POC only writes files. |
| A+ 6 | **Stale script cleanup** | Current removes `.sh` files for automations no longer in the spec. POC recreates directories from scratch (effective but blunt). |

---

## 4. Summary Matrix

| Area | POC Feature | Current Status | Gap? |
|---|---|---|---|
| **Schema: dynamic channels** | Array of arbitrary services | Fixed 4-channel map | **Yes — High** |
| **Schema: per-channel image** | `image` field per channel | Global image namespace | **Yes — Medium** |
| **Schema: per-channel ports** | `containerPort` / `hostPort` | Hardcoded port map | **Yes — Medium** |
| **Schema: domain routing** | `domains[]` per channel | Path-based only | **Yes — Medium** |
| **Schema: ACME/TLS email** | `caddy.email` | Not present | **Yes — Medium** |
| **Schema: project name** | `projectName` | Not configurable | **Yes — Low** |
| **Schema: path prefixes** | `pathPrefixes[]` | Hardcoded | **Yes — Low** |
| **Schema: internal TLS** | `internalTls` | Not present | **Yes — Low** |
| **Generator: domain site blocks** | Per-domain Caddy blocks | Single `:80` block | **Yes — Medium** |
| **Generator: HTTPS/TLS** | `tls internal` + ACME | HTTP only | **Yes — Medium** |
| **Generator: structured compose** | JS object → YAML | Template string | **Yes — Low** |
| **Generator: standalone CLI** | `bun run gen-stack.ts` | Embedded in admin | **Yes — Low** |
| **Generator: spec-driven core** | All services from spec | Core services hardcoded | **Yes — Medium** |
| **Automations: cron validation** | 5-field format check | String non-empty check | **Yes — Low** |
| **Automations: concurrency** | Not present (future) | flock-based locking | **Current exceeds POC** |
| **Automations: logging** | Not present | JSONL structured logs | **Current exceeds POC** |
| **Automations: manual trigger** | Not present | `triggerAutomation()` | **Current exceeds POC** |
| **Automations: history API** | Not present | `readHistory()` | **Current exceeds POC** |
| **Automations: crontab reload** | Not present | Automatic reload | **Current exceeds POC** |
| **Infra: secret references** | Not present | `${SECRET}` resolution | **Current exceeds POC** |
| **Infra: impact-based restarts** | Not present | Diff-based reload/restart | **Current exceeds POC** |
| **Infra: atomic spec writes** | Not present | Temp-file + rename | **Current exceeds POC** |

---

## 5. Recommendations

### High Priority

1. **Extensible channel model**: Migrate from `Record<StackChannelName, ...>` to a dynamic channel array (or at minimum, `Record<string, ChannelConfig>`) to support arbitrary channel types without code changes. This is the single largest architectural gap.

2. **Per-channel image and port configuration**: Allow each channel to declare its own Docker image and port mapping. This enables third-party channels and custom deployments.

### Medium Priority

3. **Domain-based Caddy routing**: Add optional `domains[]` support to the stack spec and generate per-domain Caddy site blocks. This is important for production deployments that need virtual hosting.

4. **HTTPS/TLS support**: Add `caddy.email` to the spec and generate proper TLS configuration. Public-facing services need automatic certificate management.

5. **Spec-driven core services**: Consider moving core service definitions into the spec (or a layered spec) so the compose generator isn't a hardcoded template.

### Low Priority

6. **Cron schedule validation**: Add a 5-field cron format validator to `parseAutomations()`.

7. **Standalone generation CLI**: Provide a `bun run gen-stack` CLI entrypoint for offline artifact generation and CI/CD pipelines.

8. **Structured compose generation**: Replace the template-string approach with an object model + YAML serializer for better testability and extensibility.
