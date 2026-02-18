# OpenPalm Architecture — Container / App / Channel

This document describes the three-layer container architecture for OpenPalm.

## Diagram

```mermaid
graph TB
    subgraph Channels["Channels (Layer 1)"]
        Discord["Discord<br/><small>:8184</small>"]
        Voice["Voice<br/><small>:8183</small>"]
        Chat["Chat<br/><small>:8181</small>"]
        Telegram["Telegram<br/><small>:8182</small>"]
    end

    subgraph Caddy["Caddy Reverse Proxy (:80/:443)"]
        direction LR
        Public["/channels/*<br/><small>LAN by default; configurable</small>"]
        LAN["/admin/* (includes /admin/opencode*, /admin/openmemory*)<br/><small>LAN only</small>"]
        GW_Route["/channels/*, /admin/*"]
    end

    subgraph Apps["Applications (Layer 2)"]
        Gateway["Gateway<br/><small>:8080 — auth + routing</small>"]
        OpenCodeCore["OpenCode Core<br/><small>:4096 — full agent runtime</small>"]
        OpenCodeChannel["OpenCode Channel<br/><small>:4097 — isolated intake runtime</small>"]
        OpenMemory["Open Memory<br/><small>:3000/:8765 — MCP</small>"]
        AdminApp["Admin App<br/><small>:8100 — admin API</small>"]
        Controller["Controller<br/><small>:8090 — container lifecycle</small>"]
    end

    subgraph Storage["Storage + Config (Layer 3)"]
        PSQL["PostgreSQL<br/><small>structured data</small>"]
        Qdrant["Qdrant<br/><small>vector storage</small>"]
        SharedFS["Shared FS<br/><small>XDG data mount</small>"]
    end

    subgraph UI["Dashboards (LAN only)"]
        AdminUI["Admin UI"]
        OpenMemoryUI["Open Memory UI"]
        OpenCodeUI["OpenCode UI"]
    end

    %% Channel flow — all through gateway, then intake validation before core forwarding
    Discord -->|HMAC signed| Gateway
    Voice -->|HMAC signed| Gateway
    Chat -->|HMAC signed| Gateway
    Telegram -->|HMAC signed| Gateway

    %% Caddy routing
    Public --> Chat
    Public --> Voice
    LAN --> AdminApp
    LAN --> OpenCodeCore
    LAN --> OpenMemory
    GW_Route --> Gateway

    %% Core data flow — gateway validates/summarizes via channel runtime, then forwards to core runtime
    Gateway -->|/channel/inbound (validate + summarize)| OpenCodeChannel
    OpenCodeChannel -->|valid summary| Gateway
    Gateway -->|forward validated summary| OpenCodeCore
    OpenCodeCore --> OpenMemory
    OpenCodeChannel --> OpenMemory

    %% Admin flow
    AdminApp --> Controller
    Controller -->|compose runtime| Apps

    %% Storage connections
    OpenMemory --> Qdrant
    OpenCodeCore --> SharedFS
    OpenCodeChannel --> SharedFS
    OpenMemory --> SharedFS
    AdminApp --> SharedFS

    %% UI served via Caddy
    AdminUI -.-> AdminApp
    OpenMemoryUI -.-> OpenMemory
    OpenCodeUI -.-> OpenCodeCore

    %% Styling
    classDef channel fill:#4a9eff,color:#fff,stroke:#2d7cd6
    classDef app fill:#34c759,color:#fff,stroke:#28a745
    classDef storage fill:#ff9500,color:#fff,stroke:#e68a00
    classDef proxy fill:#af52de,color:#fff,stroke:#9b30d0
    classDef ui fill:#8e8e93,color:#fff,stroke:#636366

    class Discord,Voice,Chat,Telegram channel
    class Gateway,OpenCodeCore,OpenCodeChannel,OpenMemory,AdminApp,Controller app
    class PSQL,Qdrant,SharedFS storage
    class Public,LAN,GW_Route proxy
    class AdminUI,OpenMemoryUI,OpenCodeUI ui
```

## Container inventory

Every box in the architecture is a distinct container, except **Shared FS** which is a shared mount point on the host.

| Container | Image | Network | Purpose |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | assistant_net | Reverse proxy, URL routing, LAN restriction |
| `postgres` | `postgres:16-alpine` | assistant_net | Structured data storage |
| `qdrant` | `qdrant/qdrant:latest` | assistant_net | Vector storage for embeddings |
| `openmemory` | `skpassegna/openmemory-mcp:latest` | assistant_net | Long-term memory (MCP server) |
| `opencode-core` | `./opencode` (build) | assistant_net | Primary agent runtime, full approvals/skills |
| `opencode-channel` | `./opencode` (build) | assistant_net | Isolated channel runtime, locked-down permissions |
| `gateway` | `./gateway` (build) | assistant_net | Minimal channel auth, rate limiting, runtime routing, audit |
| `admin-app` | `./admin-app` (build) | assistant_net | Admin API for all management functions |
| `controller` | `./controller` (build) | assistant_net | Container up/down/restart via configured runtime compose command |
| `channel-chat` | `./channels/chat` (build) | assistant_net | HTTP chat adapter (profile: channels) |
| `channel-discord` | `./channels/discord` (build) | assistant_net | Discord adapter (profile: channels) |
| `channel-voice` | `./channels/voice` (build) | assistant_net | Voice/STT adapter (profile: channels) |
| `channel-telegram` | `./channels/telegram` (build) | assistant_net | Telegram adapter (profile: channels) |

## Data flow

### Message processing (channel inbound)
```
User → Channel Adapter → [HMAC sign] → Gateway → OpenCode Channel (validate/summarize)
  → Gateway → OpenCode Core (full agent) → Open Memory → Response
```

The gateway receives HMAC-signed payloads from channel adapters and processes them in two stages:

1. **Intake validation** — Gateway forwards the message to `opencode-channel` (the isolated runtime) which validates and summarizes the input. If the intake is rejected, the gateway returns a 422 error.
2. **Core forwarding** — If the intake is valid, the gateway forwards only the validated summary to `opencode-core` (the full agent runtime) for processing.

The gateway is intentionally thin. It verifies HMAC signatures, applies rate limiting (120 req/min/user), logs audit events, and routes traffic between the two OpenCode runtimes.

- `opencode-channel` runs with deny-by-default permissions (bash, edit, webfetch all denied).
- `opencode-core` uses approval gates for tool access.

This separation relies on OpenCode's built-in permission model for isolation rather than duplicating complex security logic in the gateway.

### Admin operations
```
Admin (LAN) -> Caddy (/admin/*) -> Admin App -> Controller -> Compose Runtime
```

The admin app provides the API for all admin functions:
- Add/remove containers via the controller
- Edit Caddy configuration to map sub-urls to containers
- Manage extensions and config

### URL routing via Caddy

| URL Path | Target | Rewritten To | Access |
|---|---|---|---|
| `/channels/chat*` | channel-chat:8181 | `/chat` | LAN by default (public toggle via Admin API) |
| `/channels/voice*` | channel-voice:8183 | `/voice/transcription` | LAN by default (public toggle via Admin API) |
| `/channels/discord*` | channel-discord:8184 | `/discord/webhook` | LAN by default (public toggle via Admin API) |
| `/channels/telegram*` | channel-telegram:8182 | `/telegram/webhook` | LAN by default (public toggle via Admin API) |
| `/admin/api*` | admin-app:8100 | prefix stripped to `/admin/*` | LAN only |
| `/admin/opencode*` | opencode-core:4096 | prefix stripped to `/*` | LAN only |
| `/admin/openmemory*` | openmemory:3000 | prefix stripped to `/*` | LAN only |
| `/admin*` (catch-all) | admin-app:8100 | pass-through | LAN only |

Channel access defaults to LAN-only (`abort @not_lan` in Caddyfile). The Admin API can rewrite channel blocks to remove the LAN restriction, making them publicly accessible.

### Storage

Host directories follow the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/) with three categories:

| Category | Host Path | Env Var | Contents |
|---|---|---|---|
| **Data** | `~/.local/share/openpalm/` | `OPENPALM_DATA_HOME` | PostgreSQL, Qdrant, Open Memory, Shared FS, Caddy TLS, Admin App |
| **Config** | `~/.config/openpalm/` | `OPENPALM_CONFIG_HOME` | Agent configs, Caddyfile, channel env files |
| **State** | `~/.local/state/openpalm/` | `OPENPALM_STATE_HOME` | Runtime state, audit logs, workspace |

| Store | Used by | Purpose |
|---|---|---|
| PostgreSQL | Admin App | Structured data |
| Qdrant | Open Memory | Vector embeddings for memory search |


## Security model — defense in depth

Security is enforced at multiple layers, each with a distinct responsibility:

1. **Caddy** — Network-level access control. LAN-only restriction for admin/dashboard URLs. TLS termination. Non-LAN requests to restricted paths are TCP-aborted.
2. **Gateway** — Thin auth and routing layer. HMAC signature verification, lightweight rate limiting (120 req/min/user), and audit logging. Routes requests to isolated OpenCode runtimes.
3. **OpenCode runtime isolation** — `opencode-channel` is a dedicated runtime with deny-by-default permissions; `opencode-core` remains the full runtime with approval gates.
4. **OpenCode plugins** — Runtime tool-call interception. The `policy-and-telemetry` plugin detects secrets in tool arguments and blocks the call.
5. **Agent rules (AGENTS.md)** — Behavioral constraints: never store secrets, require confirmation for destructive actions, deny data exfiltration, recall-first for user queries.
6. **Skills** — Standardized operating procedures: `ChannelIntake` (validate/summarize/dispatch), `RecallFirst`, `MemoryPolicy`, `ActionGating`.
7. **Admin auth** — Password-protected admin API, restricted to LAN-only access via Caddy.
8. **Controller isolation** — Only the controller container has access to the container engine socket.
