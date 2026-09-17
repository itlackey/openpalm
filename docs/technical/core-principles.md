# OpenPalm Core Principles

This document is the living architecture and security contract for OpenPalm.
Code, Compose, docs, CI, and release automation must agree with it at each
handoff, but the document is not a veto against simplifying or improving the
product. When an intentional design change makes a principle stale, update the
principle and implementation together.

## 1. Core purpose

OpenPalm hosts one personal AI agent and makes it easy to use safely from standard tools.

The product must provide:

1. a dependable local OpenCode runtime;
2. durable AKM knowledge and scheduled tasks;
3. direct native OpenCode access for trusted clients;
4. a common, policy-scoped remote interface through MCP;
5. a security boundary for untrusted remote input; and
6. a small host-side lifecycle tool.

Everything else must justify its runtime cost, attack surface, configuration burden, and maintenance burden. Convenience alone is not enough.

## 2. Product boundary

### Required runtime

The default stack contains exactly one service: **Assistant**.

Assistant includes:

- the pinned OpenCode runtime;
- the pinned AKM CLI and image-baked AKM OpenCode plugin; and
- supercronic for user-authored AKM tasks.

### Optional runtime

Three Compose profiles exist:

- `gateway` — Guardian MCP ingress;
- `discord` — Guardian plus the Discord adapter; and
- `slack` — Guardian plus the Slack adapter.

Discord and Slack use the same private portal package and image.

### Explicit non-goals

The active product does not own:

- a chat UI or general web application;
- OpenAI-compatible, Anthropic-compatible, or A2A endpoints;
- local model serving or model catalogs;
- speech synthesis/transcription;
- VPN/tunnel orchestration or mDNS discovery;
- Paperclip or other multi-agent control planes;
- hardware-specific service variants;
- a plugin marketplace or public portal SDK; or
- a containerized admin API.

Clients should integrate through MCP or the native OpenCode API. A separate static Electron admin app may manage the stack but is never required by it.

## 3. Service and network contract

```text
                                  agent_net
Guardian ----------------------------------------------> Assistant
   ^                                                       ^
   | ingress_net                                           | authenticated host publish
Portal (Discord/Slack)                                     |
   ^                                                       |
external platform                               trusted native OpenCode client
```

- Assistant joins only `agent_net`.
- Guardian joins `agent_net` and `ingress_net`.
- Portal adapters join only `ingress_net`.
- Assistant's host publish defaults to `127.0.0.1`; the operator may explicitly
  bind it to another IP for trusted native OpenCode clients.
- Guardian defaults to `127.0.0.1`; a non-loopback exact IP requires explicit operator intent.
- Portal adapters publish no host port.
- The managed Compose surface is one file plus one user overlay.

## 4. Security invariants

These invariants may not be weakened by a feature or compatibility promise.

1. **No control-plane capability in Assistant.** Assistant receives no Docker socket, host admin credential, or delegated ingress credential.
2. **Explicit trust paths.** Guardian is the security boundary for MCP traffic.
   Direct native OpenCode access is a separate, operator-enabled trust path,
   always protected by OpenCode authentication and loopback-bound by default.
3. **One narrow Guardian surface.** Guardian serves `GET /health` and MCP at `/mcp`; unrelated routes return 404.
4. **Strong named bearer identities.** Operators manage named credentials with a stable internal identity, private key, and explicit `chat`, `read`, or `full` policy. Duplicate, weak, malformed, or unknown keys are rejected. Transport does not determine privilege: the same credential may be used by an MCP client or assigned to a portal.
5. **Opaque continuity and ownership.** Guardian encrypts and authenticates
   session, message, job, and interaction handles. Handles expire, cannot cross
   credential identities, and reveal no upstream identifiers. Guardian-created
   OpenCode sessions carry key-bound ownership metadata so listing and mutation
   cannot escape the caller's credential identity. Signed handles from the prior
   one-tool release are accepted only to claim their original session.
6. **Policy-scoped remote agents.** Guardian selects a managed OpenCode profile
   from the authenticated credential. `chat` denies every tool, `read`
   permits only read/list access to the workspace and non-secret knowledge tree,
   and `full` delegates tool decisions to Assistant's OpenCode policy. Guardian
   policy can narrow Assistant permissions but never expand them.
7. **Contained workspace reads.** Guardian's direct MCP workspace operations
   use its own read-only `/work` mount. Relative-path policy, canonical-path
   containment, regular-file checks, and an opened-file descriptor check all
   pass before content is returned. OpenCode's native file endpoint is not the
   authorization boundary.
8. **Mandatory layered screening.** Cheap heuristics screen every untrusted
   prompt or human-input answer before it reaches the agent. Suspicious input
   escalates to a separate loopback classifier. A classifier failure,
   malformed result, `flag`, or `block` does not reach Assistant.
9. **Default-deny portals.** A portal refuses use until at least one explicit scope is configured; every configured scope must match.
10. **Exact browser origins.** Browser-originated MCP requests require an exact HTTP(S) origin allowlist. Wildcards and path-bearing values are invalid.
11. **Bounded work.** Guardian limits body size, message size, concurrency, pre-auth traffic, and per-principal traffic.
12. **File-secret boundary.** Named Guardian keys live in private `state/credentials/<username>/key` directories. Guardian receives the whole read-only credential store; each portal receives only its selected credential directory; Assistant receives neither. Other runtime credentials remain Compose file secrets under `state/secrets/`. Provider `auth.json` is the sole credential file under the Assistant-readable knowledge tree.
13. **No secrets in stack env.** `state/stack.env` may contain paths, IDs, image versions, binds, ports, profiles, selected credential usernames, and completion state only.
14. **No root runtime.** Managed services run as the resolved non-root operator UID/GID and drop all Linux capabilities. The control plane refuses UID or GID 0.
15. **No shell Docker execution.** The control plane invokes Docker with an executable plus argument array.
16. **No boot-time installs.** Images contain their runtime dependencies. Entrypoints validate and start; they do not fetch packages.

The user-owned custom Compose overlay is an explicit operator extension point. Before activation, the control plane rejects replacement core images, commands, hooks, mounts, health commands, logging, runtime users, published ports that do not match StackConfig, plaintext secret environment values, secret paths outside `OP_HOME`, altered core grants or networks, custom managed-secret grants or access to `agent_net`, network bridges, privileged services, dangerous OpenCode overrides, added capabilities, host namespaces/devices, container-runtime mounts, and removal of managed hardening. Preflight and activation receive the same sanitized process environment; `state/stack.env` cannot redirect Docker or alter the host executable search path.

## 5. Protocol contract

### Trusted native interface

Assistant exposes the native OpenCode HTTP API with mandatory Basic
authentication. It is loopback-bound by default and may be bound to an explicit
operator-selected IP. OpenPalm does not wrap or duplicate that API.

### Untrusted/remote interface

Guardian uses MCP Streamable HTTP. One implementation serves both modern MCP
and stateless 2025-era clients. Its curated domain surface is:

- agent execution through resumable `agent.run`, `job.get`, and `job.cancel` tools;
- owned session discovery, inspection, fork, and deletion;
- bounded non-secret workspace search/read for `read` and `full` policies;
- explicit question and permission responses;
- resources for workspace files, session messages/diffs/todos, and jobs; and
- static implementation, debugging, review, and explanation prompts.

Every operation that is essential to complete work remains available as a tool
for clients that do not consume MCP resources or prompts. Guardian exposes
OpenCode capabilities as stable OpenPalm domain operations, not as a raw mirror
of OpenCode routes or its internal tool catalog. It never remotely exposes
shell endpoints, auth/config/provider administration, sharing, TUI control, or
OpenCode's own MCP administration.

The authenticated named credential selects the managed `chat`, `read`, or `full` Assistant
profile and filters the MCP catalog itself. `full` means Guardian adds no agent
tool denial and may relay explicit OpenCode permission decisions; Assistant's
own OpenCode permission rules remain authoritative. Session, job, and
interaction references are Guardian handles, never upstream IDs.

The basic credential release uses bearer keys. A portal currently runs under
one selected credential for all of its allowed platform users. Mapping Discord
or Slack users to different credentials and adding OAuth authorization are
future authentication layers; neither may bypass the same named identity,
policy, ownership, moderation, and audit boundaries.

## 6. Filesystem contract

`OP_HOME` defaults to `~/.openpalm`.

| Path | Ownership | Contract |
|---|---|---|
| `system/` | release | only the managed allowlist is overwritten whole |
| `config/` | operator | defaults are seeded only when missing |
| `knowledge/` | operator and AKM | durable; never lifecycle-replaced |
| `workspace/` | operator | durable; never lifecycle-replaced |
| `state/` | control plane | intent, derived env, and delegated secrets |
| `data/` | containers | durable runtime data and append-only audit logs |

The managed update allowlist is defined in `lean-seed.ts`. It intentionally does not synchronize whole directories. Files left by an older version remain until the operator approves their exact removal.

Runtime directories below `OP_HOME` must be real directories, not symlinks.
Choose the desired storage location with `OP_HOME`; lifecycle code refuses a
symlinked subtree rather than following it outside the declared filesystem
boundary.

### Intent and derived state

- `state/stack.json` is the only stack-intent document.
- Its schema is versioned as `StackConfigV2`.
- It can enable only Gateway, Discord, and Slack; set Assistant and Guardian
  bind addresses/ports; manage named credential metadata and policy; and select
  the credential used by each portal. Raw keys remain separate files.
- `state/stack.env` is regenerated from that intent while preserving unrelated operator pins.
- Unsupported JSON keys are rejected rather than silently becoming product surface.

## 7. Lifecycle contract

- CLI is the primary orchestrator.
- Admin is an optional local wrapper over the same lean library.
- Install and update materialize selected whole files; they do not render Compose templates.
- Install/update seed user files only when absent.
- Migration from a legacy stack maps only surviving intent and performs zero automatic deletions.
- `stop` uses Compose `down` without `--volumes`.
- The lean CLI has no purge/uninstall command.
- Lifecycle mutations use a process lock and validate the resolved Compose project before activation.

## 8. Complexity budget

A proposed feature belongs in core only when all are true:

1. it is necessary to run, secure, integrate, or operate the hosted agent;
2. a standard external tool cannot reasonably provide it;
3. it does not create a second source of truth;
4. it does not add a compatibility interface beside MCP/OpenCode;
5. its security boundary can be stated and tested; and
6. its operational cost is smaller than the problem it solves.

Prefer a documented integration, user Compose overlay, or separate project when any answer is no.

## 9. Verification contract

The active gate must prove:

- strict type checking of all active packages;
- unit and protocol tests for stack intent, migration, Guardian, and portals;
- MCP client/server interoperability without a network socket;
- rejection of retired API routes;
- Compose validation with every profile;
- non-root image users;
- exact active workspace and release surfaces; and
- successful standalone CLI and optional admin builds.

Legacy files are not evidence of active functionality. A feature is active only if it is reachable from a root workspace, package export, active entrypoint, managed Compose file, CI job, or release job.
