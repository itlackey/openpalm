# Lean architecture

## System boundary

OpenPalm owns the smallest deployable layer around OpenCode:

```text
Host
├── openpalm CLI (primary lifecycle tool)
├── OpenPalm Admin (optional static Electron process)
└── Docker Compose
    ├── assistant                 always
    ├── guardian                  gateway/discord/slack profile
    ├── discord                   discord profile
    └── slack                     slack profile
```

The CLI and Admin import only `@openpalm/lib/lean`. They do not run a server or maintain a second lifecycle implementation.

## Assistant

Assistant is an immutable image containing:

- OpenCode;
- AKM CLI;
- the AKM OpenCode plugin as a local image-baked plugin; and
- supercronic.

The image contains no UI, browser client, optional CLI installer, model runtime, embedding bundle, notification service, Docker client, or admin credential.

Assistant mounts operator knowledge at `/stash`, a workspace at `/work`, and its own data home. Its native OpenCode server always uses file-backed Basic authentication. It is host-published on `127.0.0.1` by default and can be bound to another exact address through StackConfig.

Two access paths coexist:

- trusted native clients use the complete OpenCode API and normal Assistant
  permissions without passing through Guardian; and
- Guardian clients use a managed profile selected by their credential policy.

The managed Guardian profiles are `remote` (`chat`, no tools), `remote-read`
(`read`, bounded read/list tools with managed secret/env exclusions), and
`remote-full` (`full`, no additional Guardian tool denial). The last profile
still inherits the Assistant's global OpenCode permissions.

## Guardian

Guardian is an optional Bun service with one listener.

Request pipeline:

```text
request size / pre-auth rate
  -> exact Origin policy
  -> Bearer key to named credential identity
  -> principal rate + concurrency
  -> MCP schema validation
  -> policy-filtered capability catalog
  -> heuristic content screen for prompts and answers
  -> loopback LLM classification when suspicious
  -> encrypted handle + session-ownership validation
  -> policy-to-agent mapping for the authenticated credential
  -> async OpenCode job/session operation or contained read-only workspace access
  -> bounded response + audit record
```

Guardian does not proxy arbitrary OpenCode paths. It does not implement OpenAI,
Anthropic, or A2A compatibility. It exposes a curated agent catalog: resumable runs and jobs,
owned sessions, bounded workspace reads, explicit human interactions, useful
resources, and static workflow prompts. It deliberately does not mirror the
Assistant's raw routes or internal tool catalog.

Guardian mounts the operator workspace at `/work` read-only. Direct MCP file
reads are opened locally only after lexical, canonical-path, regular-file, and
opened-descriptor containment checks. Search results from Assistant are exposed
only when their paths independently pass that same filesystem boundary.

Guardian is stateless. Encrypted session/message/job/interaction handles carry bounded
continuity, while HMAC-bound OpenCode session metadata provides independently
verifiable ownership. OpenCode remains the source of truth for messages,
status, diffs, todos, and pending questions/permissions. `full` clients may
answer explicit `ask` decisions; ordinary prompt text never counts as approval.

The moderator is a second loopback OpenCode process in the Guardian container. Its managed configuration denies every tool. It receives only the untrusted message encoded as a JSON string plus heuristic signal names. Unavailable or malformed moderation fails closed.

## Portal

`@openpalm/portal` is one private package and one image. `PORTAL_ADAPTER` selects Discord or Slack.

Each adapter:

- enforces a default-deny platform allowlist;
- maps a platform thread/user scope to an opaque Guardian session handle in SQLite;
- serializes turns per platform conversation;
- calls Guardian with the standard MCP client; and
- never receives an OpenCode session ID or Assistant credential.

Each adapter is assigned one named Guardian credential and receives only that
credential's read-only key directory. The credential may also be used by a
direct MCP client. Platform-user-to-credential mapping is intentionally not in
the basic release.

The adapters do not have an `agent_net` path.

## Control plane

`StackConfigV2` is deliberately small:

```json
{
  "version": 2,
  "assistant": {
    "bindAddress": "127.0.0.1",
    "port": 3810
  },
  "gateway": {
    "enabled": false,
    "bindAddress": "127.0.0.1",
    "port": 3830
  },
  "credentials": {
    "owner": { "id": "owner", "policy": "full" },
    "discord": { "id": "discord", "policy": "chat" },
    "slack": { "id": "slack", "policy": "chat" }
  },
  "portals": {
    "discord": { "enabled": false, "credential": "discord" },
    "slack": { "enabled": false, "credential": "slack" }
  }
}
```

It is stored at `state/stack.json`. The control plane derives Compose profiles,
binds, ports, a key-free Guardian registry, and portal credential mounts from
it. Raw keys live separately under `state/credentials/<username>/key`.
Unsupported keys fail validation.

The Compose project is assembled from:

1. `system/stack/stack.compose.yml` — managed and replaced whole; and
2. `config/stack/custom.compose.yml` — operator-owned and seed-only.

No catalog or overlay discovery exists in the active control plane.

## Package graph

```text
@openpalm/lib (zero runtime dependencies)
   ↑                ↑
 CLI        optional Electron Admin

Guardian -> @modelcontextprotocol/server + @opencode-ai/sdk
Portal   -> @modelcontextprotocol/client + Discord/Slack SDKs
```

Guardian and Portal are private image components. MCP is the integration contract, not a published OpenPalm client SDK.

## Migration boundary

Legacy files are inputs and preserved artifacts, not active modules. The migration reads old add-on/access values only to derive Gateway, Discord, and Slack intent. It never imports old lifecycle code and never removes retired files or data.
