# OpenPalm 0.14 architecture

OpenPalm owns the smallest reliable layer around one persistent OpenCode agent.

## Runtime

```text
Host
├── CLI                              install and lifecycle
├── Admin (optional)                 local setup/management wrapper
└── Docker Compose
    ├── Assistant                    always
    ├── Guardian                     optional gateway profile
    └── Portal                       optional Discord or Slack profile
```

Assistant is the product. The other components make it easier or safer to
operate and access Assistant; they are not independent platforms.

## Assistant

Assistant is one image containing:

- OpenCode, the agent runtime and provider integration layer;
- AKM CLI plus the image-baked AKM OpenCode plugin, for persistent knowledge
  and task definitions; and
- supercronic, for recurring work.

It mounts user knowledge at `/stash` and working files at `/work`. Its native
OpenCode server uses file-backed Basic authentication and is published to host
loopback by default.

Assistant contains no web UI, model runtime, Docker client, admin credential,
Guardian credential, provider proxy, VPN, or optional service installer.

## Knowledge and recurring work

AKM is part of the core product rather than an add-on. Knowledge, skills, and
task sources are user-owned and survive replacement of the Assistant
container. supercronic executes schedules inside Assistant; there is no
scheduler service or scheduler API.

Assistant instructions translate ordinary-language requests into the managed
`openpalm-task` interface, which provides create, pause, resume, list, run,
history, adopt, and remove operations over AKM. Runs record durable history;
the scheduled profile may also write a durable inbox report before an optional
portal notification is attempted. Imported schedules are inert until reviewed.

Scheduled agent runs use a dedicated least-privilege OpenCode profile. Remote
content retrieved by a schedule is treated as untrusted input.

## Provider boundary

OpenCode owns provider discovery, authentication methods, models, and provider
credentials. OpenPalm guides the native sign-in flow, persists OpenCode's
credential file, and runs a readiness request.

OpenPalm does not maintain a parallel provider registry, normalize provider
APIs, host models, or infer endpoint configuration. Advanced users may edit
normal OpenCode configuration after initial setup.

## Access paths

Two access paths coexist:

- trusted clients connect directly to the complete native OpenCode API; and
- less-trusted clients connect to Guardian's policy-scoped MCP API.

Direct access deliberately bypasses Guardian and therefore stays
loopback/private unless the operator explicitly changes the bind and supplies
appropriate transport security.

Guardian is optional. Its request path is:

```text
size/rate limits
  -> exact Origin policy
  -> bearer key or verified OAuth identity
  -> named credential and policy
  -> MCP validation
  -> hostile-input screening
  -> owned session/job/interaction handles
  -> policy-selected OpenCode profile
  -> Assistant
```

Guardian exposes stable agent operations: catalog discovery, resumable runs,
jobs, owned sessions, interactions, and policy-allowed workspace access. It
does not expose arbitrary OpenCode routes, provider administration, a shell
API, a compatibility chat API, or its own agent runtime.

## Identity and portals

The named credential registry is the single authorization model for Guardian:

```text
bearer key ---------------------┐
OAuth issuer + subject --------+--> named credential --> chat/read/full
Discord platform user ---------+
Slack platform user -----------┘
```

Portal allowlists remain a separate default-deny boundary. A portal receives
only the credential keys used by its fallback and explicit user mappings. It
can reach Guardian but not Assistant directly.

## Control plane

The CLI is the primary host orchestrator. Admin is an optional local wrapper
over the same `@openpalm/lib/lean` functions and has no server or background
process.

`state/stack.json` contains only:

- Assistant bind and port;
- Guardian enablement, bind, and port;
- named credential IDs and policies; and
- Discord and Slack enablement and fallback identities.

Portal user maps and OAuth identity maps are operator-owned files. Raw keys are
private files. `state/stack.env` is derived and contains no secrets.

The Compose project has exactly two inputs:

1. `system/stack/stack.compose.yml`, owned by the release; and
2. `config/stack/custom.compose.yml`, owned by the operator.

There is no managed overlay graph, add-on catalog, or service discovery layer.

## Package graph

```text
@openpalm/lib/lean <--------- CLI
        ^                     optional Admin
        |
managed home + Compose

Guardian ---> MCP server + OpenCode SDK
Portal -----> MCP client + Discord/Slack SDKs
Claude extension ---> local stdio-to-Guardian bridge
```

Guardian, Portal, and Skeleton are implementation packages, not public product
platforms. MCP and native OpenCode are the integration standards.

## Persistence

| Tree | Owner | Portable across the 0.14 boundary |
|---|---|---:|
| `knowledge/` | user and AKM | yes, allowlisted |
| `workspace/` | user | yes |
| `config/` | user | selected files only |
| `data/` | runtime | no |
| `state/` | control plane | no |
| `system/` | release | no; recreated |

0.14 never interprets a legacy home as a live control plane. Transition is a
fresh install followed by a previewable, allowlisted import. The old home is
left unchanged as the rollback artifact.
