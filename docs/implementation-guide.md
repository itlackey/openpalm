# Implementation Guide — OpenPalm with OpenCode + OpenMemory
*A secure, robust implementation guide using OpenCode server/SDK, plugins/tools/skills, and OpenMemory for long-term memory.*

## 0) Target architecture (minimal but robust)

### Components
1. **OpenCode server** (agent runtime + events)
   - Runs the LLM orchestration loop and exposes HTTP + SSE events.
2. **Gateway service** (the gateway/control plane)
   - Receives messages from channels (HTTP/CLI first).
   - Calls OpenCode via **`@opencode-ai/sdk`**.
   - Owns auth, sessions, approvals, audit logs, and observability export.
3. **OpenMemory** (long-term memory)
   - Exposed as an **MCP server (SSE transport)**.
4. **OpenCode plugins** (guardrails + telemetry enrichment)
   - Enforce policy at tool boundaries.
   - Emit structured events/logs.

### Data flow
User message -> Channel Adapter -> **Gateway** -> **OpenCode Server** (channel-intake agent: validate/summarize) -> **Gateway** -> **OpenCode Server** (default agent: model/tools) -> **OpenMemory (HTTP API)** -> response -> Channel Adapter.

---

## 1) Run OpenMemory (MCP) and keep it private

### Practical rules
- Run OpenMemory on a private network (localhost or internal Docker network).
- Treat it as sensitive: it contains personal memory.
- Never expose OpenMemory directly to the public internet.

### Minimal memory contract
Even if OpenMemory supports more, standardize on these operations in your assistant:
- **remember**: write memory `{content, tags, source, confidence, timestamp}`
- **recall**: search memory `{query, top_k, filters}`
- **explain_recall**: include why memory was returned (for trust)

### Memory policy (non-negotiable)
- Do not store secrets, tokens, passwords, private keys.
- Prefer “explicit save”: only store when the user says “remember this…”
- For stable preferences (tone, formatting), store only after user affirmation.

---

## 2) Run OpenCode server and use it as your agent runtime

### Why OpenCode server
- Your gateway can be thin; OpenCode does orchestration.
- You get an event stream for observability (SSE).

### Configuration sources
Keep these co-located with your project:
- `opencode.jsonc` – primary config
- `AGENTS.md` – rules (hard constraints)
- `skills/*.SKILL.md` – reusable behavioral SOPs
- `plugins/*` – local plugins (in `OPENCODE_CONFIG_DIR`)
- `tools/*` – local tools (in `OPENCODE_CONFIG_DIR`)

---

## 3) Configure OpenCode to use OpenMemory

### What you’re doing
- Register the `openmemory-http` plugin in OpenCode config.
- The plugin calls OpenMemory’s REST API directly (no MCP in the runtime path).
- Memory recall is injected automatically before each turn; save-worthy items are persisted after each turn.
- Session compaction preserves critical state via the `experimental.session.compacting` hook.

### `opencode.jsonc` template (shape)
```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "permission": {
    "bash": "ask",
    "edit": "ask",
    "webfetch": "ask"
  },

  // MCP transport kept for optional external tooling; disabled by default
  // because runtime memory now uses the HTTP API plugin.
  "mcp": {
    "openmemory": {
      "enabled": false
      // transport details (SSE URL) per your environment
    }
  },

  // Plugins are auto-discovered from OPENCODE_CONFIG_DIR/plugins/
  // No need to list them explicitly in opencode.jsonc when using
  // OPENCODE_CONFIG_DIR — they are loaded automatically at startup.
}
```

### Environment variables (all optional — defaults work inside Docker Compose)
| Variable | Default | Description |
|---|---|---|
| `OPENPALM_MEMORY_MODE` | `api` | Set to `api` to enable the HTTP plugin. Any other value disables it. |
| `OPENMEMORY_BASE_URL` | `http://openmemory:8765` | OpenMemory REST endpoint |
| `OPENMEMORY_API_KEY` | *(empty)* | Bearer token for OpenMemory (if auth is enabled) |
| `RECALL_LIMIT` | `5` | Max memories to inject per turn (1–50) |
| `RECALL_MAX_CHARS` | `2000` | Max characters for the recall context block (100–20000) |
| `WRITEBACK_ENABLED` | `true` | Enable automatic write-back of save-worthy items |
| `TEMPORAL_ENABLED` | `false` | Enable temporal knowledge graph writes |

### How it works
1. **Pre-turn recall** — On each user message the plugin queries OpenMemory and injects a `<recalled_memories>` block into the model context.
2. **Post-turn write-back** — After the assistant responds, the plugin persists any save-worthy content (preferences, facts, decisions, TODOs, project state) while blocking secrets.
3. **Session compaction** — When OpenCode compacts a session, the plugin re-injects `must-keep` tagged memories so they survive the compaction.

### Guardrail note (design for defense in depth)
Assume policy hooks may not always intercept **every** tool call path in every build.
Design so your Gateway is the final authority for destructive/external actions.

---

## 4) Build the Gateway using OpenCode SDK (control plane)

### Responsibilities
- Authenticate users (even if single-user MVP).
- Create/track sessions.
- Apply a strict tool firewall:
  - allowlist tools
  - validate arguments
  - require approvals for risky actions
- Subscribe to OpenCode events and emit telemetry.

### Suggested API
- `POST /channel/inbound` – ingest signed channel payloads (single inbound path)
- `GET /health` – readiness
- `POST /admin/*` – admin ops (later guide)

### Observability (minimum)
- Correlation IDs: `request_id`, `session_id`, `user_id`
- Log every tool call and outcome (redacted)
- Record approvals requested/approved/denied

---

## 5) Security model (practical and strict)

### The “tool firewall” principle
Treat tools as the real attack surface. Your model can only do what tools allow.

#### Tool categories
- **Safe**: memory recall, formatting, local read-only queries
- **Medium**: “safe fetch” allowlisted domains, non-destructive file edits (ask)
- **High**: shell commands, filesystem deletes, external API calls, payments

#### Gating rules
- Any destructive action requires explicit user confirmation.
- Any network egress requires domain allowlist.
- Any action that could exfiltrate data is denied by default.

### Keep subagents optional in MVP
If you allow subagents / tasks, verify tool policy is enforced across them.
If not verified, disable subagent spawning for MVP.

---

## 6) Skills + Rules (make behavior deterministic)

### `AGENTS.md` (rules)
Put immutable constraints here:
- Never store secrets in memory.
- Always show citations/IDs when recalling memory.
- Require confirmation for destructive actions.
- Default to recall-first before answering user-specific questions.

### Skills (SOPs)
Create skills that the assistant can load:
- `RecallFirst.SKILL.md` – always query memory for user-specific context
- `MemoryPolicy.SKILL.md` – when to store; redaction; summarization
- `ActionGating.SKILL.md` – when to ask; what to refuse

---

## 7) Custom tools vs MCP tools (when to use what)

### Prefer MCP for “big integrations”
- GitHub, Slack, calendars, search, etc.
- Benefits: isolation, revocability, simpler security boundaries.

### Use OpenCode custom tools for “glue”
- Redaction + memory write wrapper
- Safe HTTP fetch with allowlist
- Gateway RPC tools like `create_reminder()` that are centrally enforced

---

## 8) “Recursive learning” safely (no self-modifying agent)

### Recommended loop
- Capture feedback and failures as audit events.
- Store “lessons learned” as a memory category.
- Periodically run an offline eval suite and propose updates to:
  - `AGENTS.md`
  - skills
  - tool schemas/allowlists
- Require admin confirmation before applying changes.

---

## 9) Build order (shortest path to robust)

1. Run OpenMemory and validate add/search.
2. Run OpenCode server and validate SDK control.
3. Connect OpenMemory via MCP in OpenCode config.
4. Add a policy+telemetry plugin (minimal).
5. Add rules + skills for recall-first and gating.
6. Add channels one at a time as dumb adapters.
