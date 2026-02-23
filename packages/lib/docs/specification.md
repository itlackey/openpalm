# Stack Generation Specification

This document is the authoritative technical reference for the OpenPalm stack generation pipeline implemented in `packages/lib/admin/`. It describes every input, transformation step, default value, validation rule, output artifact, and error code produced by the generator.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Inputs](#2-inputs)
   - 2.1 [StackSpec Schema](#21-stackspec-schema)
     - 2.1.1 [Top-level Fields](#211-top-level-fields)
     - 2.1.2 [accessScope](#212-accessscope)
     - 2.1.3 [caddy](#213-caddy)
     - 2.1.4 [channels](#214-channels)
     - 2.1.5 [automations](#215-automations)
   - 2.2 [secrets.env](#22-secretsenv)
   - 2.3 [Secret Reference Syntax](#23-secret-reference-syntax)
3. [Transformation Pipeline](#3-transformation-pipeline)
   - 3.1 [Step 1 — Parse and Validate StackSpec](#31-step-1--parse-and-validate-stackspec)
   - 3.2 [Step 2 — Read and Parse secrets.env](#32-step-2--read-and-parse-secretsenv)
   - 3.3 [Step 3 — Resolve Channel Identifiers](#33-step-3--resolve-channel-identifiers)
   - 3.4 [Step 4 — Generate Docker Compose File](#34-step-4--generate-docker-compose-file)
   - 3.5 [Step 5 — Generate Caddyfile](#35-step-5--generate-caddyfile)
   - 3.6 [Step 6 — Generate Channel Route Snippets](#36-step-6--generate-channel-route-snippets)
   - 3.7 [Step 7 — Resolve Channel Config Secrets](#37-step-7--resolve-channel-config-secrets)
   - 3.8 [Step 8 — Generate Per-Service Env Files](#38-step-8--generate-per-service-env-files)
   - 3.9 [Step 9 — Generate System Env](#39-step-9--generate-system-env)
   - 3.10 [Step 10 — Assemble Output Bundle](#310-step-10--assemble-output-bundle)
4. [Output Artifacts](#4-output-artifacts)
   - 4.1 [caddyJson](#41-caddyjson)
   - 4.2 [composeFile](#42-composefile)
   - 4.3 [systemEnv](#43-systemenv)
   - 4.4 [gatewayEnv](#44-gatewayenv)
   - 4.5 [openmemoryEnv](#45-openmemoryenv)
   - 4.6 [postgresEnv](#46-postgresenv)
   - 4.7 [qdrantEnv](#47-qdrantenv)
   - 4.8 [assistantEnv](#48-assistantenv)
   - 4.9 [channelEnvs](#49-channelenvsrecord)
   - 4.10 [serviceEnvs](#410-serviceenvsrecord)
   - 4.11 [renderReport](#411-renderreport)
5. [Defaults](#5-defaults)
   - 5.1 [Built-in Channel Ports](#51-built-in-channel-ports)
   - 5.2 [Built-in Channel Images](#52-built-in-channel-images)
   - 5.3 [Built-in Channel Config Keys](#53-built-in-channel-config-keys)
   - 5.4 [Built-in Channel Rewrite Paths](#54-built-in-channel-rewrite-paths)
   - 5.5 [Built-in Channel Shared Secret Env Keys](#55-built-in-channel-shared-secret-env-keys)
   - 5.6 [Access Scope LAN Matchers](#56-access-scope-lan-matchers)
   - 5.7 [Default StackSpec](#57-default-stackspec)
6. [Validation Rules and Error Codes](#6-validation-rules-and-error-codes)
   - 6.1 [Top-level Spec Validation](#61-top-level-spec-validation)
   - 6.2 [Channel Name Validation](#62-channel-name-validation)
   - 6.3 [Channel Field Validation](#63-channel-field-validation)
   - 6.4 [Custom Channel Requirements](#64-custom-channel-requirements)
   - 6.5 [Config Key Validation](#65-config-key-validation)
   - 6.6 [Caddy Config Validation](#66-caddy-config-validation)
   - 6.7 [Automation Validation](#67-automation-validation)
   - 6.8 [Secret Resolution Errors](#68-secret-resolution-errors)
7. [Impact Engine](#7-impact-engine)
   - 7.1 [Change Detection](#71-change-detection)
   - 7.2 [Impact Categories](#72-impact-categories)
   - 7.3 [Compose Service Operations](#73-compose-service-operations)
8. [File System Layout](#8-file-system-layout)
9. [Atomic Write Behaviour](#9-atomic-write-behaviour)
10. [Key Source Files](#10-key-source-files)

---

## 1. Overview

The **stack generator** converts a declarative user intent document (the _StackSpec_) plus a flat secrets store (`secrets.env`) into a complete set of deployment artifacts that Docker Compose, Caddy, and each containerised service can consume directly.

```
StackSpec (YAML) ──┐
                   ├──► generateStackArtifacts() ──► GeneratedStackArtifacts
secrets.env ───────┘
```

The generator is a **pure function** (`generateStackArtifacts` in `stack-generator.ts`). It takes a validated `StackSpec` and a `Record<string, string>` of secrets as inputs and returns a `GeneratedStackArtifacts` object. It does **not** write files, make network calls, or produce side effects. File I/O and service lifecycle operations are handled by the `StackManager` and `StackApplyEngine` layers above it.

Callers of the generator:

| Caller | Purpose |
|---|---|
| `StackManager.renderPreview()` | Preview artifacts without writing them to disk |
| `StackManager.renderArtifacts()` | Generate and persist all artifacts to the state directory |
| `applyStack()` in `stack-apply-engine.ts` | Generate, diff against existing artifacts, then apply compose operations |

---

## 2. Inputs

### 2.1 StackSpec Schema

The `StackSpec` is a YAML document stored at `$OPENPALM_CONFIG_HOME/openpalm.yaml` (v3). It captures the user's intent for the stack: which channels to run, how to expose them, what secrets they need, what services to add, and what automations to schedule. It is **not** a runtime state file — it contains no ephemeral values.

#### 2.1.1 Top-level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | `1 | 2 | 3` | Yes | Schema version. Versions 1 and 2 are read and silently upgraded to version 3 at parse time. |
| `accessScope` | `"host" | "lan" | "public"` | Yes | Default network exposure for the whole stack. Controls LAN IP matchers in Caddy. |
| `caddy` | `CaddyConfig` | No | Optional Caddy-specific configuration. |
| `channels` | `Record<string, StackChannelConfig>` | Yes | Map of channel name → channel configuration. Must include all four built-in channels. |
| `services` | `Record<string, StackServiceConfig>` | No | Map of service name → service configuration. Internal-only containers (no Caddy routing). Defaults to `{}`. |
| `automations` | `StackAutomation[]` | No | List of scheduled automation definitions. Defaults to `[]`. |

Unknown top-level keys are rejected with error `unknown_stack_spec_field_<key>`.

> **Note:** The `services` section was added in v3. Services are internal-only containers — they have no `exposure`, `domains`, or `pathPrefixes` fields, and no Caddy routing is generated for them. They always require `image` and `containerPort`.

#### 2.1.2 `accessScope`

Controls which IP ranges Caddy considers "LAN" for the `@lan` and `@not_lan` matchers.

| Value | Effect |
|---|---|
| `"host"` | LAN matcher is `127.0.0.0/8 ::1` (loopback only). Compose bind address defaults to `127.0.0.1`. |
| `"lan"` | LAN matcher covers `127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8`. |
| `"public"` | Same broad CIDR list as `"lan"`. No IP guard is applied to public-exposure channels. |

#### 2.1.3 `caddy`

Optional object with the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | `string` | No | ACME registration email for automatic TLS certificates. Emitted into the Caddyfile global block as `email <value>`. |

If `caddy` is omitted entirely, the global block contains only `admin off`.

#### 2.1.4 `channels`

Each entry maps a _channel name_ to a `StackChannelConfig`:

```typescript
type StackChannelConfig = {
  enabled:        boolean;
  exposure:       "host" | "lan" | "public";
  name?:          string;           // Friendly display name
  description?:   string;           // What this channel does
  image?:         string;           // Docker image (required for custom channels)
  containerPort?: number;           // Port the container listens on (required for custom channels)
  hostPort?:      number;           // Port published on the host (defaults to containerPort)
  domains?:       string[];         // If set, a dedicated Caddy site block is emitted per domain
  pathPrefixes?:  string[];         // Path prefixes routed into the domain block (default: ["/"])
  volumes?:       string[];         // Persistent data mounts
  config:         Record<string, string>;  // Channel env config; values may be secret references
};
```

**Built-in channels** (`chat`, `discord`, `voice`, `telegram`) are always required to be present. They have pre-configured defaults for `image`, `containerPort`, and `config` keys. They do not require `image` or `containerPort` to be set, but these can be overridden.

**Custom channels** are any additional keys beyond the four built-ins. They require both `image` and `containerPort` to be explicitly specified.

##### Channel name constraints

- Must match the pattern `/^[a-z][a-z0-9-]*$/` (lowercase letters, digits, and hyphens; starts with a letter).
- Maximum length: 63 characters (DNS label limit).
- The four built-in names (`chat`, `discord`, `voice`, `telegram`) are always reserved.

##### `exposure` field

| Value | Caddy behaviour | Port binding |
|---|---|---|
| `"host"` | Route guarded by `abort @not_host` (loopback only) | Published as `127.0.0.1:<hostPort>:<containerPort>` |
| `"lan"` | Route guarded by `abort @not_lan` (LAN CIDR) | Published as `<hostPort>:<containerPort>` (all interfaces) |
| `"public"` | No IP guard | Published as `<hostPort>:<containerPort>` (all interfaces) |

##### `config` values and secret references

Config values may be either:

- **Literal strings** — used as-is in the generated `.env` file.
- **Secret references** — a string of the form `${SECRET_NAME}`. These are resolved against `secrets.env` at generation time. Unresolved references cause the generation to fail.

#### 2.1.5 `automations`

Each automation is a `StackAutomation`:

```typescript
type StackAutomation = {
  id:           string;   // Unique identifier; must match /^[a-zA-Z0-9_-]+$/
  name:         string;   // Human-readable label
  description?: string;   // What this automation does
  schedule:     string;   // Standard Unix cron expression (e.g. "0 9 * * *")
  script:       string;   // Shell script body executed on each run
  enabled:      boolean;  // Whether the cron job is active
  core?:        boolean;  // System automations cannot be deleted
};
```

Automations are stored inside the spec but synced separately to cron files by `syncAutomations()` in `automations.ts`. The generator itself does not process automations — they are passed through untouched.

---

### 2.2 `secrets.env`

`secrets.env` is a flat key=value file stored at `$OPENPALM_CONFIG_HOME/secrets.env`. It follows standard `.env` syntax:

```
# Comments are allowed
OPENAI_API_KEY=sk-...
DISCORD_BOT_TOKEN=MT...
CHANNEL_CHAT_SECRET=some-long-shared-secret
```

Parsing rules (implemented in `parseRuntimeEnvContent`):

- Lines starting with `#` are ignored.
- Empty lines are ignored.
- Lines without `=` are ignored.
- The key is everything before the first `=`; the value is everything after (joined if multiple `=` are present).
- Leading/trailing whitespace on both key and value is stripped.

The generator receives the parsed secrets as a plain `Record<string, string>`.

---

### 2.3 Secret Reference Syntax

A config value that exactly matches the pattern `${SECRET_NAME}` is a _secret reference_. The generator resolves it by looking up `SECRET_NAME` in the secrets map.

- `SECRET_NAME` must match `/^[A-Z][A-Z0-9_]*$/` (enforced by `parseSecretReference`).
- The entire config value must be the reference — partial interpolation is not supported (e.g. `prefix_${SECRET}` is treated as a literal string, not a reference).
- If a referenced secret key is absent or empty in the secrets map, generation fails immediately with `unresolved_secret_reference_<channel>_<configKey>_<secretName>`.

---

## 3. Transformation Pipeline

The pipeline is implemented in `generateStackArtifacts(spec, secrets)` in `stack-generator.ts`. The steps below describe the logical order of operations.

### 3.1 Step 1 — Parse and Validate StackSpec

Before `generateStackArtifacts` is called, the spec must have already passed through `parseStackSpec`. The generator receives a fully-validated `StackSpec` object.

`parseStackSpec` performs the following validations in order:

1. Asserts the root value is a non-null object.
2. Rejects any key not in the allowed set `{version, accessScope, caddy, channels, services, automations}`.
3. Validates `version` is `1`, `2`, or `3`.
4. Validates `accessScope` is one of `"host"`, `"lan"`, `"public"`.
5. Parses the optional `caddy` sub-object.
6. Asserts `channels` is a non-null object.
7. Asserts all four built-in channel names are present.
8. Validates and parses each channel entry (see [Section 6](#6-validation-rules-and-error-codes)).
9. Parses the optional `automations` array.

Version 1 and 2 specs are accepted and the output spec is upgraded to `version: 3` with `services: {}` added if missing.

### 3.2 Step 2 — Read and Parse secrets.env

The `StackManager` layer reads `secrets.env` using `parseRuntimeEnvContent` and passes the resulting flat map to `generateStackArtifacts`. If the file does not exist, an empty map `{}` is used. The generator itself does not read files.

### 3.3 Step 3 — Resolve Channel Identifiers

For each channel in `spec.channels`, the generator resolves three identifiers:

**Container port** (`resolveChannelPort`):

1. If `config.containerPort` is set, use it.
2. If the channel is a built-in, use the default port from `BuiltInChannelPorts`.
3. Otherwise, throw `missing_container_port_for_channel_<name>`.

**Host port** (`resolveChannelHostPort`):

1. If `config.hostPort` is set, use it.
2. Otherwise, fall back to the container port (same value for both).

**Docker image** (`resolveChannelImage`):

1. If `config.image` is set, use it.
2. If the channel is a built-in, generate the default image reference: `${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-<name>:${OPENPALM_IMAGE_TAG:-latest}`.
3. Otherwise, throw `missing_image_for_channel_<name>`.

**Compose service name** (`composeServiceName`):

The Docker Compose service name is derived from the channel name as: `channel-<name>` where `<name>` is lowercased and all characters outside `[a-z0-9-_]` are replaced with `-`.

### 3.4 Step 4 — Generate Docker Compose File

The compose file is built as a multi-line string from a static template for core services plus dynamically generated blocks for each enabled channel.

**Core services** (always present, in this order):

| Service | Image | Key mounts / env |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Mounts rendered Caddyfile and snippets from state; data dir from data |
| `postgres` | `postgres:16-alpine` | Mounts data dir; env_file from state; POSTGRES_* env vars |
| `qdrant` | `qdrant/qdrant:latest` | Mounts storage dir from data; env_file from state |
| `openmemory` | `mem0/openmemory-mcp:latest` | Port 8765; mounts data dir; env_file from state |
| `openmemory-ui` | `mem0/openmemory-ui:latest` | Port 3000; NEXT_PUBLIC_API_URL and NEXT_PUBLIC_USER_ID env vars |
| `assistant` | `openpalm/assistant:latest` | Port 4096 + SSH port 22; mounts data home and workspace; healthcheck |
| `gateway` | `openpalm/gateway:latest` | Port 8080; env_file from state; env OPENCODE_CORE_BASE_URL; healthcheck |
| `admin` | `openpalm/admin:latest` | Port 8100; mounts data, config, state, workspace, and Docker socket; healthcheck |

All services attach to the `assistant_net` Docker network defined at the bottom of the compose file.

**Channel services** (one block per enabled channel, appended after core services):

Each enabled channel gets a compose service named `channel-<name>` with:

```yaml
  channel-<name>:
    image: <resolved image>
    restart: unless-stopped
    env_file:
      - ${OPENPALM_STATE_HOME}/channel-<name>/.env
    environment:
      - PORT=<containerPort>
      - GATEWAY_URL=http://gateway:8080
    ports:
      - "<portBinding>"
    networks: [assistant_net]
    depends_on: [gateway]
```

The port binding (`<portBinding>`) is:

- `127.0.0.1:<hostPort>:<containerPort>` for `exposure: "host"`
- `<hostPort>:<containerPort>` for `exposure: "lan"` or `"public"`

Disabled channels are **excluded entirely** from the compose file.

### 3.5 Step 5 — Generate Caddy Configuration

> **Note:** As of v3, the generator produces Caddy JSON API configuration directly (not a Caddyfile). The Caddyfile examples below describe the logical routing rules; the actual output is JSON.

The Caddy config is assembled from:

#### Part 1 — Global block

```
{
    admin off
    [email <caddy.email>]
}
```

`admin off` is always included. `email` is only present when `spec.caddy.email` is set.

#### Part 2 — Domain site blocks (optional)

For every enabled channel that has a `domains` array with at least one entry, a dedicated Caddy site block is generated and **prepended** before the main `:80` site. Domain blocks are never generated for channels with an empty or absent `domains` list.

Domain block structure:

```caddy
<domain1>[, <domain2>, ...] {
    [tls internal]           # present if exposure != "public"

    [@not_lan not remote_ip <lanMatcher>]  # present if exposure == "lan"
    [abort @not_lan]

    [@not_host not remote_ip 127.0.0.0/8 ::1]  # present if exposure == "host"
    [abort @not_host]

    # For each path prefix p in pathPrefixes (or "/" if absent):
    [handle_path <p>* {
        reverse_proxy channel-<name>:<containerPort>
    }]
    # If prefix is "/" or "/*":
    [reverse_proxy channel-<name>:<containerPort>]
}
```

- `tls internal` is included for `"lan"` and `"host"` exposure (not `"public"`), enabling self-signed TLS for internal names.
- Path prefixes are processed in declaration order. A prefix of `/` or `/*` produces a bare `reverse_proxy` directive without `handle_path`.
- Channels routed via domain blocks do **not** generate a path-based snippet in `caddyRoutes` — the two routing strategies are mutually exclusive.

#### Part 3 — Main `:80` site block

```caddy
:80 {
    @lan remote_ip <lanMatcher>
    @not_lan not remote_ip <lanMatcher>
    @host remote_ip 127.0.0.0/8 ::1
    @not_host not remote_ip 127.0.0.0/8 ::1

    import /etc/caddy/snippets/admin.caddy
    import /etc/caddy/snippets/channels/*.caddy
    import /etc/caddy/snippets/extra-user-overrides.caddy
}
```

The `<lanMatcher>` is determined by `spec.accessScope`:

- `"host"`: `127.0.0.0/8 ::1`
- `"lan"` or `"public"`: `127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8`

The site block delegates all routing to imported snippets. Per-channel snippets are loaded from `channels/*.caddy` inside the snippets directory. An `extra-user-overrides.caddy` file allows users to add custom directives that are never overwritten by the generator.

### 3.6 Step 6 — Generate Channel Routes

> **Note:** As of v3, channel routes are part of the single `caddy.json` output, not separate snippet files.

For each enabled channel that does **not** have a `domains` array, a route is generated in the Caddy JSON config.

**Built-in channels** use `handle` + `rewrite`:

```caddy
handle /channels/<name>* {
    [abort @not_lan | abort @not_host]
    rewrite * <rewritePath>
    reverse_proxy channel-<name>:<containerPort>
}
```

The rewrite paths for built-in channels are fixed:

| Channel | Rewrite path |
|---|---|
| `chat` | `/chat` |
| `discord` | `/discord/webhook` |
| `voice` | `/voice/transcription` |
| `telegram` | `/telegram/webhook` |

**Custom channels** use `handle_path` (which strips the matched prefix before forwarding):

```caddy
handle_path /channels/<name>* {
    [abort @not_lan | abort @not_host]
    reverse_proxy channel-<name>:<containerPort>
}
```

No `rewrite` directive is needed because `handle_path` automatically strips the prefix.

The access guard directive included depends on `exposure`:

| `exposure` | Guard directive |
|---|---|
| `"host"` | `abort @not_host` |
| `"lan"` | `abort @not_lan` |
| `"public"` | _(none)_ |

### 3.7 Step 7 — Resolve Channel Config Secrets

For each enabled channel, every config value is passed through `resolveScalar`:

1. `parseSecretReference(value)` checks if the value matches `${SECRET_NAME}`.
2. If not a reference, return the literal value.
3. If a reference, look up `SECRET_NAME` in the secrets map.
4. If the key is missing or the value is an empty string, throw `unresolved_secret_reference_<channel>_<configKey>_<secretName>`.
5. Otherwise, return the resolved secret value.

This resolution happens independently for each channel config entry. A failure in any single entry aborts the entire generation.

### 3.8 Step 8 — Generate Per-Service Env Files

Each generated env file is a newline-delimited list of `KEY=value` lines preceded by a comment header:

```
# Generated <service> env
KEY1=value1
KEY2=value2
```

**Gateway env** (`gatewayEnv`):

Assembled from two sources:

1. All secrets whose keys start with any of: `OPENPALM_GATEWAY_`, `GATEWAY_`, `OPENPALM_SMALL_MODEL_API_KEY`, `ANTHROPIC_API_KEY` — picked by prefix from the full secrets map.
2. The shared secret env var for each built-in channel: `CHANNEL_CHAT_SECRET`, `CHANNEL_DISCORD_SECRET`, `CHANNEL_VOICE_SECRET`, `CHANNEL_TELEGRAM_SECRET`. These are resolved from the built-in channel configs using the same secret resolution logic as step 7.

**OpenMemory env** (`openmemoryEnv`):

Keys `OPENAI_BASE_URL` and `OPENAI_API_KEY` picked by exact key from the secrets map. Missing keys produce empty values.

**Postgres env** (`postgresEnv`):

Keys `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` picked by exact key. Missing keys produce empty values.

**Qdrant env** (`qdrantEnv`):

Empty — no secrets are currently injected into Qdrant.

**Assistant env** (`assistantEnv`):

Keys starting with `OPENPALM_SMALL_MODEL_API_KEY` or `ANTHROPIC_API_KEY` picked by prefix from the secrets map.

**Channel envs** (`channelEnvs`):

One entry per enabled channel, keyed by the compose service name (`channel-<name>`). The content is the resolved config map for that channel (after step 7), serialised as `KEY=value` lines.

### 3.9 Step 9 — Generate System Env

`systemEnv` is the generated flat env file that exposes system-derived state values to containers. It is written to `$OPENPALM_STATE_HOME/system.env` and loaded by the `admin` and `gateway` services via their `env_file` declarations.

Unlike `secrets.env` (user-managed) or the per-service `.env` files (derived from secrets), `system.env` is always regenerated on every `renderArtifacts()` call. Users **must not hand-edit** it — any changes will be overwritten.

**Generated content:**

```
# Generated system env — do not edit; regenerated on every stack apply
OPENPALM_ACCESS_SCOPE=<spec.accessScope>
OPENPALM_ENABLED_CHANNELS=<comma-separated enabled channel service names>
```

`OPENPALM_ENABLED_CHANNELS` is the comma-separated list of Docker service names for all enabled channels (e.g. `channel-chat,channel-discord,channel-telegram`). Disabled channels are excluded. If no channels are enabled the value is an empty string.

During initial installation, `install.sh` and `dev-setup.sh` seed an empty placeholder at `$OPENPALM_STATE_HOME/system.env` so Docker Compose can start before the first `renderArtifacts()` call.

### 3.10 Step 10 — Assemble Output Bundle

All generated strings are collected into a `GeneratedStackArtifacts` object and returned to the caller. See [Section 4](#4-output-artifacts) for the full description of each field.

The `caddyJson` field is a JSON serialisation of `{ caddyfile, caddyRoutes }` — a convenience bundle used by the admin service when writing state.

---

## 4. Output Artifacts

`generateStackArtifacts` returns a `GeneratedStackArtifacts` object:

```typescript
type GeneratedStackArtifacts = {
  caddyJson:     string;
  composeFile:   string;
  systemEnv:     string;
  gatewayEnv:    string;
  openmemoryEnv: string;
  postgresEnv:   string;
  qdrantEnv:     string;
  assistantEnv:  string;
  channelEnvs:   Record<string, string>;
  serviceEnvs:   Record<string, string>;
  renderReport:  string;
};
```

### 4.1 `caddyJson`

**Type**: `string` (JSON-encoded)
**Written to**: `$OPENPALM_STATE_HOME/rendered/caddy/caddy.json`

A Caddy JSON API configuration document. The generator produces a native Caddy JSON config (not a Caddyfile) with servers, routes, handlers, and matchers. This is loaded directly by Caddy using its native JSON config format.

The JSON includes routes for:
- Admin UI subroute (`/` catch-all path)
- Channel path-based routes (`/channels/{name}*`)
- Channel domain-based routes (when domains are specified)
- Hostname routes for core services (assistant, admin, openmemory)
- Default catch-all to assistant

> **Note:** Prior to v3, the generator produced a Caddyfile with route snippets. The v3 generator produces Caddy JSON API format directly. The `caddyfile` and `caddyRoutes` artifacts no longer exist.

### 4.4 `composeFile`

**Type**: `string` (YAML)
**Written to**: `$OPENPALM_STATE_HOME/rendered/docker-compose.yml`

The complete Docker Compose file. Contains all core services and all enabled channel services. The `networks:` section always defines `assistant_net`. Never hand-edit this file — it is regenerated on every `renderArtifacts()` call.

### 4.5 `systemEnv`

**Type**: `string`
**Written to**: `$OPENPALM_STATE_HOME/system.env`

The generated system env file. Exposes system-derived state values to the `admin` and `gateway` containers via their `env_file` declarations. Always regenerated on every `renderArtifacts()` call — do not hand-edit.

| Variable | Value |
|---|---|
| `OPENPALM_ACCESS_SCOPE` | The `accessScope` field from the spec (`host`, `lan`, or `public`) |
| `OPENPALM_ENABLED_CHANNELS` | Comma-separated Docker service names for all enabled channels (e.g. `channel-chat,channel-discord`). Empty string if no channels are enabled. |

An empty placeholder is seeded by `install.sh` and `dev-setup.sh` so Docker Compose can start before the first `renderArtifacts()` call.

### 4.6 `gatewayEnv`

**Type**: `string`  
**Written to**: `$OPENPALM_STATE_HOME/gateway/.env`

Env file for the `gateway` container. Contains all secrets with keys prefixed by `OPENPALM_GATEWAY_`, `GATEWAY_`, `OPENPALM_SMALL_MODEL_API_KEY`, or `ANTHROPIC_API_KEY`, plus the four built-in channel shared secrets.

### 4.7 `openmemoryEnv`

**Type**: `string`  
**Written to**: `$OPENPALM_STATE_HOME/openmemory/.env`

Env file for the `openmemory` container. Contains `OPENAI_BASE_URL` and `OPENAI_API_KEY` (empty string if not configured).

### 4.8 `postgresEnv`

**Type**: `string`  
**Written to**: `$OPENPALM_STATE_HOME/postgres/.env`

Env file for the `postgres` container. Contains `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (empty string if not configured in secrets).

### 4.9 `qdrantEnv`

**Type**: `string`  
**Written to**: `$OPENPALM_STATE_HOME/qdrant/.env`

Env file for the `qdrant` container. Currently always empty (only the comment header is present) — no secrets are injected into Qdrant.

### 4.10 `assistantEnv`

**Type**: `string`  
**Written to**: `$OPENPALM_STATE_HOME/assistant/.env`

Env file for the `assistant` container. Contains all secrets with keys prefixed by `OPENPALM_SMALL_MODEL_API_KEY` or `ANTHROPIC_API_KEY`.

### 4.11 `channelEnvs` (Record)

**Type**: `Record<string, string>`  
**Written to**: `$OPENPALM_STATE_HOME/<serviceName>/.env` for each entry

One entry per enabled channel, keyed by compose service name (e.g. `channel-chat`). Each value is the fully-resolved env file content for that channel, containing all config key=value pairs after secret resolution.

### 4.12 `serviceEnvs` (Record)

**Type**: `Record<string, string>`
**Written to**: `$OPENPALM_STATE_HOME/<serviceName>/.env` for each entry

One entry per enabled service, keyed by compose service name (e.g. `service-n8n`). Each value is the fully-resolved env file content for that service.

### 4.13 `renderReport`

**Type**: `object`

Contains metadata about the generation run: `applySafe` (boolean), `warnings` (array), `missingSecretReferences` (array), and `changedArtifacts` (array). Used by the apply engine to communicate issues back to the caller.

---

## 5. Defaults

### 5.1 Built-in Channel Ports

| Channel | Container port |
|---|---|
| `chat` | `8181` |
| `telegram` | `8182` |
| `voice` | `8183` |
| `discord` | `8184` |

The host port defaults to the container port unless `hostPort` is explicitly set in the channel config.

### 5.2 Built-in Channel Images

Built-in channel images use shell variable expansion syntax so the Compose runtime can override namespace and tag at startup:

```
${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-<name>:${OPENPALM_IMAGE_TAG:-latest}
```

| Channel | Default image expression |
|---|---|
| `chat` | `${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-chat:${OPENPALM_IMAGE_TAG:-latest}` |
| `discord` | `${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-discord:${OPENPALM_IMAGE_TAG:-latest}` |
| `voice` | `${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-voice:${OPENPALM_IMAGE_TAG:-latest}` |
| `telegram` | `${OPENPALM_IMAGE_NAMESPACE:-openpalm}/channel-telegram:${OPENPALM_IMAGE_TAG:-latest}` |

### 5.3 Built-in Channel Config Keys

Each built-in channel has a fixed set of config keys. These keys are always present in the channel config (defaulting to `""` if not set by the user).

| Channel | Config keys |
|---|---|
| `chat` | `CHAT_INBOUND_TOKEN`, `CHANNEL_CHAT_SECRET` |
| `discord` | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `CHANNEL_DISCORD_SECRET` |
| `voice` | `CHANNEL_VOICE_SECRET` |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CHANNEL_TELEGRAM_SECRET` |

For built-in channels, only the keys listed above are accepted. Extra keys in the parsed config are silently ignored. For custom channels, all keys present in `config` are accepted (subject to the key naming pattern).

### 5.4 Built-in Channel Rewrite Paths

Built-in channels use Caddy's `rewrite` directive to remap the public path to the channel's native endpoint:

| Channel | Public path | Rewritten to |
|---|---|---|
| `chat` | `/channels/chat*` | `/chat` |
| `discord` | `/channels/discord*` | `/discord/webhook` |
| `voice` | `/channels/voice*` | `/voice/transcription` |
| `telegram` | `/channels/telegram*` | `/telegram/webhook` |

Custom channels use `handle_path` instead of `handle` + `rewrite`, which strips the matched prefix and forwards the remainder of the path.

### 5.5 Built-in Channel Shared Secret Env Keys

The gateway receives a shared HMAC secret for each built-in channel to verify inbound requests. The env key names are:

| Channel | Gateway env key |
|---|---|
| `chat` | `CHANNEL_CHAT_SECRET` |
| `discord` | `CHANNEL_DISCORD_SECRET` |
| `voice` | `CHANNEL_VOICE_SECRET` |
| `telegram` | `CHANNEL_TELEGRAM_SECRET` |

These values are extracted from each built-in channel's resolved config and written into `gatewayEnv`.

### 5.6 Access Scope LAN Matchers

| `accessScope` | Caddy `remote_ip` matcher |
|---|---|
| `"host"` | `127.0.0.0/8 ::1` |
| `"lan"` | `127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8` |
| `"public"` | `127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8` |

Note: `"public"` and `"lan"` use the same CIDR list for the matcher. The distinction is that `"public"` channels have no `abort @not_lan` guard in their route snippets.

### 5.7 Default StackSpec

`createDefaultStackSpec()` produces:

```yaml
version: 3
accessScope: lan
channels:
  chat:
    enabled: true
    exposure: lan
    config:
      CHAT_INBOUND_TOKEN: ""
      CHANNEL_CHAT_SECRET: ""
  discord:
    enabled: true
    exposure: lan
    config:
      DISCORD_BOT_TOKEN: ""
      DISCORD_PUBLIC_KEY: ""
      CHANNEL_DISCORD_SECRET: ""
  voice:
    enabled: true
    exposure: lan
    config:
      CHANNEL_VOICE_SECRET: ""
  telegram:
    enabled: true
    exposure: lan
    config:
      TELEGRAM_BOT_TOKEN: ""
      TELEGRAM_WEBHOOK_SECRET: ""
      CHANNEL_TELEGRAM_SECRET: ""
services: {}
automations: []
```

All four built-in channels are enabled with `"lan"` exposure and empty config values. No `caddy` key is present in the default spec. The `services` section is empty by default.

---

## 6. Validation Rules and Error Codes

All validation happens in `parseStackSpec` and `parseChannel`. Error messages use snake_case codes that encode the context so they are machine-parseable.

### 6.1 Top-level Spec Validation

| Condition | Error code |
|---|---|
| Root value is not a non-null object | `invalid_stack_spec` |
| Unknown top-level key present | `unknown_stack_spec_field_<key>` |
| `version` is not `1`, `2`, or `3` | `invalid_stack_spec_version` |
| `accessScope` not one of host/lan/public | `invalid_access_scope` |
| `channels` is missing or not an object | `missing_channels` |
| Built-in channel `chat` missing | `missing_built_in_channel_chat` |
| Built-in channel `discord` missing | `missing_built_in_channel_discord` |
| Built-in channel `voice` missing | `missing_built_in_channel_voice` |
| Built-in channel `telegram` missing | `missing_built_in_channel_telegram` |

### 6.2 Channel Name Validation

| Condition | Error code |
|---|---|
| Name fails `/^[a-z][a-z0-9-]*$/` or length > 63 | `invalid_channel_name_<name>` |

### 6.3 Channel Field Validation

| Field | Condition | Error code |
|---|---|---|
| `enabled` | Not a boolean | `invalid_channel_enabled_<name>` |
| `exposure` | Not host/lan/public | `invalid_channel_exposure_<name>` |
| `image` | Present but not a non-empty string | `invalid_channel_image_<name>` |
| `image` | Fails image pattern | `invalid_channel_image_format_<name>` |
| `containerPort` | Not an integer in 1–65535 | `invalid_channel_container_port_<name>` |
| `hostPort` | Not an integer in 1–65535 | `invalid_channel_host_port_<name>` |
| `domains` | Not an array | `invalid_channel_domains_<name>` |
| `domains` entry | Not a non-empty string | `invalid_channel_domain_entry_<name>` |
| `domains` entry | Fails domain pattern | `invalid_channel_domain_format_<name>` |
| `domains` entry | Length > 253 | `invalid_channel_domain_length_<name>` |
| `pathPrefixes` | Not an array | `invalid_channel_path_prefixes_<name>` |
| `pathPrefixes` entry | Not a non-empty string | `invalid_channel_path_prefix_entry_<name>` |
| `pathPrefixes` entry | Fails path prefix pattern | `invalid_channel_path_prefix_format_<name>` |
| Channel config | Not an object | `invalid_channel_config_<name>` |
| Config value | Not a string | `invalid_channel_config_value_<name>_<key>` |

**Validation patterns:**

| Field | Pattern |
|---|---|
| Domain | `/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i` |
| Path prefix | `/^\/[a-z0-9\/_-]*$/i` (must start with `/`) |
| Image name | `/^[a-z0-9]+([._\/:@-][a-z0-9]+)*$/i` |
| Email | `/^[^\s{}"#]+@[^\s{}"#]+\.[^\s{}"#]+$/` |
| Config key | `/^[A-Z][A-Z0-9_]*$/` |

These patterns are intentionally restrictive to prevent injection of control characters into generated Caddy, YAML, and env files. Newlines in domain/image/email values would allow injection of arbitrary Caddy directives or YAML keys.

**Config value sanitisation**: All config values (whether from built-in or custom channels) have `\r` and `\n` stripped and are trimmed at parse time. This prevents multi-line env var injection even if the spec file is hand-edited.

### 6.4 Custom Channel Requirements

| Condition | Error code |
|---|---|
| Custom channel has no `image` | `custom_channel_requires_image_<name>` |
| Custom channel has no `containerPort` | `custom_channel_requires_container_port_<name>` |

These checks do not apply to built-in channels.

### 6.5 Config Key Validation

For custom channels, every key in the `config` map must match `/^[A-Z][A-Z0-9_]*$/`:

| Condition | Error code |
|---|---|
| Key fails the pattern | `invalid_channel_config_key_<channelName>_<key>` |

Built-in channel config keys are not re-validated — only the predefined keys are accepted and all others are ignored.

### 6.6 Caddy Config Validation

| Condition | Error code |
|---|---|
| `caddy` is not a non-null object | `invalid_caddy_config` |
| `email` is not a string | `invalid_caddy_email` |
| `email` fails the email pattern | `invalid_caddy_email_format` |

### 6.7 Automation Validation

| Condition | Error code |
|---|---|
| `automations` is not an array | `invalid_automations` |
| Automation entry is not an object | `invalid_automation_<index>` |
| `id` is empty or missing | `invalid_automation_id_<index>` |
| `name` is empty or missing | `invalid_automation_name_<index>` |
| `schedule` is empty or missing | `invalid_automation_schedule_<index>` |
| `script` is empty or missing | `invalid_automation_script_<index>` |
| `enabled` is not a boolean | `invalid_automation_enabled_<index>` |

### 6.8 Secret Resolution Errors

These errors are thrown during artifact generation (step 7), not during spec parsing:

| Condition | Error code |
|---|---|
| A referenced secret key is absent from secrets map or its value is empty | `unresolved_secret_reference_<channel>_<configKey>_<secretName>` |

`StackManager.validateReferencedSecrets()` pre-validates all channel config secret references before calling `generateStackArtifacts`, producing errors of the form `missing_secret_reference_<channel>_<configKey>_<ref>`. This check is performed by `applyStack` before writing any artifacts.

---

## 7. Impact Engine

The impact engine (`stack-apply-engine.ts`, `impact-plan.ts`) determines which Docker services need to be restarted, reloaded, brought up, or taken down when a new spec is applied. It compares the freshly generated artifacts against the currently deployed artifacts on disk.

### 7.1 Change Detection

The engine reads the current on-disk artifacts through `readExistingArtifacts()` and then calls `generateStackArtifacts()` to produce the next set. It then computes a diff:

| Change type | How detected |
|---|---|
| Caddy config changed | `caddyJson` string differs |
| Gateway secrets changed | `gatewayEnv` string differs |
| System env changed | `systemEnv` string differs |
| Channel config changed | Any entry in `channelEnvs` differs (keyed by service name) |
| Assistant changed | `assistantEnv` string differs |
| OpenMemory changed | `openmemoryEnv` OR `postgresEnv` OR `qdrantEnv` differs |
| Compose file changed | `composeFile` string differs |

A new service (in generated but not in existing compose file) is detected by parsing service names out of the compose YAML and is marked for `up` instead of `restart`.

### 7.2 Impact Categories

`computeImpactFromChanges` maps detected changes to operations:

| Changed artifact | Operation | Services affected |
|---|---|---|
| Caddy config | `reload` | `caddy` |
| Gateway secrets | `restart` | `gateway` |
| System env | `restart` | `admin`, `gateway` |
| Channel config | `restart` | all changed channel service names |
| Assistant env | `restart` | `assistant` |
| OpenMemory env (any) | `restart` | `openmemory` |
| Compose file | `restart` | `gateway`, `assistant`, `openmemory`, `admin` |
| New service in compose | `up` | new service name(s) |

Services scheduled for `up` are removed from the `restart` list (`up` takes precedence).

### 7.3 Compose Service Operations

`applyStack` executes the impact plan in this order:

1. **`up`** — `docker compose up -d <service>` for each new service.
2. **`restart`** — `docker compose restart <service>` for each changed service.
3. **`reload`** — For `caddy`: `docker compose exec caddy caddy reload --config /etc/caddy/caddy.json`. For all other services in the reload list: `docker compose restart <service>`.

Any failure in a compose operation throws immediately with `compose_<op>_failed:<service>:<stderr>`.

---

## 8. File System Layout

The generator produces artifacts scoped to two root directories, resolved from environment variables at runtime:

| Env var | Default location | Purpose |
|---|---|---|
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Generated (rendered) runtime state |
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User intent files (spec, secrets) |

**Generated artifact paths** (under `$OPENPALM_STATE_HOME`):

```
$OPENPALM_STATE_HOME/
├── system.env                         # systemEnv artifact (loaded by admin + gateway)
├── rendered/
│   ├── caddy/
│   │   └── caddy.json                  # caddyJson artifact (Caddy JSON API format)
│   └── docker-compose.yml             # composeFile artifact
├── gateway/
│   └── .env                           # gatewayEnv artifact
├── openmemory/
│   └── .env                           # openmemoryEnv artifact
├── postgres/
│   └── .env                           # postgresEnv artifact
├── qdrant/
│   └── .env                           # qdrantEnv artifact
├── assistant/
│   └── .env                           # assistantEnv artifact
├── channel-chat/
│   └── .env                           # channelEnvs["channel-chat"]
├── channel-discord/
│   └── .env                           # channelEnvs["channel-discord"]
└── channel-<name>/
    └── .env                           # channelEnvs["channel-<name>"] for each enabled channel
```

**Input files** (under `$OPENPALM_CONFIG_HOME`):

```
$OPENPALM_CONFIG_HOME/
├── openpalm.yaml                      # StackSpec input (v3 YAML)
└── secrets.env                        # secrets input
```

---

## 9. Atomic Write Behaviour

`StackManager.writeStackSpecAtomically` writes `openpalm.yaml` atomically:

1. Write content to a temporary file at `<path>.<timestamp>.tmp`.
2. Rename the temporary file to the target path.

This prevents partial reads of the spec file during concurrent access. All other artifact writes use direct `writeFileSync` calls — they are not atomic but are idempotent, so a partial write at most causes a stale artifact that will be corrected on the next apply.

The `extra-user-overrides.caddy` snippet is **never overwritten** if it already exists on disk (checked in both `renderArtifacts` and `removeStaleRouteFiles`). This allows users to persist custom Caddy directives across spec changes.

---

## 10. Key Source Files

| File | Purpose |
|---|---|
| `packages/lib/admin/stack-spec.ts` | `StackSpec` type definitions, `parseStackSpec`, `createDefaultStackSpec`, `parseSecretReference` |
| `packages/lib/admin/stack-generator.ts` | `generateStackArtifacts` — the pure generation function |
| `packages/lib/admin/stack-manager.ts` | `StackManager` — file I/O orchestration, secret CRUD, channel/automation management |
| `packages/lib/admin/stack-apply-engine.ts` | `applyStack` — diff, impact computation, and compose operations |
| `packages/lib/admin/impact-plan.ts` | `computeImpactFromChanges` — maps diffs to reload/restart/up/down actions |
| `packages/lib/admin/runtime-env.ts` | Env file parsing/updating utilities and `sanitizeEnvScalar` |
| `packages/lib/admin/automations.ts` | Cron file generation and automation runner script |
| `packages/lib/admin/stack-generator.test.ts` | Comprehensive tests for artifact generation |
| `packages/lib/admin/stack-spec.test.ts` | Comprehensive tests for spec parsing and validation |
