
# OpenPalm MVP Cuts Checklist (Scope Guardrails)

This is a “what to delete / ignore / defer” checklist you can pin in the repo so PRD scope doesn’t creep back in. It’s written to preserve the **core architectural principles**: generated artifacts, Gateway-only ingress, Admin as orchestrator, CLI for host ops, assistant requests Admin operations (no Docker socket in assistant).

---

## 0) MVP “Spine” (must not be cut)

If you cut anything here, you’re changing the product:

- **Generated artifacts are the control surface**: stack intent → rendered compose/caddy/env → apply.
- **Gateway-only ingress**: channels never call the assistant directly.
- **Admin is the only orchestrator**: only Admin performs allowlisted lifecycle actions.
- **Host CLI exists** for humans on the host.
- **Assistant requests admin work via Admin API** (internal only), never via Docker socket.

---

## 1) Hard cuts (out of MVP)

These items are explicitly in the PRD but should be removed from the MVP definition.

### A) Setup wizard as a required path
**Cut from MVP requirements:**
- Two-phase install with setup-only ingress mode
- Wizard-driven full activation
- Auto-open browser UX requirements
- Resumable wizard step completion requirements

**Replace with (MVP):**
- `openpalm install` → writes config + brings up stack
- `openpalm render/apply` → calls Admin API

> Why: the PRD makes guided setup central, but it is not essential to proving the architecture. Keep “UI later, API now.”

### B) “Self-healing / self-maintaining” and built-in maintenance suite
**Cut from MVP requirements:**
- Built-in maintenance cron suite (pull/restart loop, security scans, pruning, DB maintenance, etc.)
- Recovery loops / automated remediation targets
- “Maintenance effectiveness” metrics

**Replace with (MVP):**
- `status`, `logs`, `restart` are manual operations via CLI/Admin API.

### C) User-defined automations
**Cut from MVP requirements:**
- Automation CRUD, schedules, isolation, dynamic pickup without restart
- Automation observability and retention requirements

**Replace with (MVP):**
- None. (You can keep dormant endpoints if already present, but they’re not “must ship.”)

### D) Multi-runtime support
**Cut from MVP requirements:**
- OrbStack as a “supported” runtime requirement

**Replace with (MVP):**
- Docker only.

### E) Developer scaffolding and “channel scaffolding helpers”
**Cut from MVP requirements:**
- CLI channel scaffolding workflows
- any “SDK generator” style workflows that expand your surface area early

**Replace with (MVP):**
- One working channel adapter shipped and documented.

---

## 2) Soft cuts (allowed if you need them, but not MVP gates)

These are nice-to-haves that routinely bloat MVPs.

### A) Full Admin UI
**Defer:**
- multi-page Admin UI for config editing, extension management, automations, secrets pages, etc.

**Keep:**
- Admin **API** is canonical.
- UI can be added later as a client of the same API.

### B) Deep config editor pipeline
**Defer:**
- complex parse/validate/lint/atomic-write-with-backup pipelines *unless already implemented*

**Keep (minimum):**
- reject unsafe permission widening (policy lint)
- validate config is parseable

### C) Multi-channel matrix
**Defer:**
- Discord/Telegram/Voice (unless one is already your best “killer demo”)

**Keep:**
- One channel end-to-end (recommend “chat/webhook” first).

---

## 3) MVP Additions (things you MUST explicitly add or tighten)

These are the “missing pieces” that prevent drift and keep the simplified model coherent.

### A) One canonical orchestration path (no dual-mode “maybe”)
**Decision (recommended):**
- CLI does *not* run compose directly in MVP.
- CLI always calls Admin API for render/apply/status/logs.

**Exception (optional):**
- A “break glass” mode may exist, but not required and not the default.

### B) Admin API: limit to allowlisted operations and audit every request
**Require:**
- Allowlisted lifecycle actions only (no arbitrary shell)
- Service name allowlist
- Operation record: who requested, what action, what args, result, timestamp

### C) Assistant → Admin: separate token/scope from human admin token
**Require:**
- A scoped token for the assistant (e.g., can restart allowlisted services, cannot modify secrets or widen permissions)
- Admin enforces scopes on endpoints

### D) Finalize the “Stack Intent” schema (do not leave as “YAML-first” if code uses JSON)
**Require:**
- One canonical intent format in MVP (whatever the generator actually uses)
- Document required fields and defaults (channels, exposure, accessScope, services)

### E) Secrets partitioning rules
**Require:**
- Canonical filenames and placement
- Which services read which secret env files
- Rotation steps (what needs restart)

### F) Gateway signing details (make it real, not hand-wavy)
**Require:**
- Header names
- HMAC algorithm
- Timestamp/nonce scheme (replay protection)
- Key rotation story

---

## 4) Security hardening: “socket proxy” recommendation (MVP-friendly)

If Admin currently mounts `/var/run/docker.sock`, reduce blast radius without adding a new orchestration system:

- Add a **Docker socket proxy** container that mounts the real socket.
- Admin talks to the proxy over the internal network.
- Proxy is deny-by-default and only exposes the Docker API sections Admin truly needs.

**Why this matters:**
Access to the Docker socket can effectively grant root-equivalent control of the host; a proxy lets you restrict reachable endpoints and return 403 for disallowed calls.

**MVP note:**
- This is a recommended MVP hardening, not a “make the installer wizard perfect” level of work.
- Keep it internal-only; never publish the proxy port outside the Docker network.

---

## 5) MVP Definition of Done (the only gates)

You’re done when:

1) A user can install and bring up the stack via CLI.
2) One channel works end-to-end: channel → gateway validate → assistant response.
3) Assistant can request an allowlisted admin action via Admin API (no Docker socket).
4) User can inspect the rendered compose/caddy/env artifacts in the state directory.
5) Admin operations are authenticated and audited.

---

## 6) One-page scope statement (paste into PRD header)

> **MVP scope:** Host CLI + internal Admin API + Gateway-only ingress + OpenCode assistant runtime. Admin is the only orchestrator. One channel works end-to-end. No setup wizard requirement, no user-defined automations, no self-healing maintenance suite, no multi-runtime support.
```

**Repo + spec sources used to derive cuts:** the current OpenPalm PRD explicitly calls out wizard-driven setup, two-phase install, multi-channel scope, automations/self-healing, OrbStack support, and admin UI breadth. ([GitHub][1])
**Architecture boundary sources:** Admin owns orchestration; Gateway validates ingress; assistant must not require Docker socket access. ([GitHub][2])
**Socket proxy references (for the hardening recommendation):** deny-by-default proxy with API sections enabled via env flags, returning 403 for blocked requests. ([github.com][3])

[1]: https://raw.githubusercontent.com/itlackey/openpalm/refs/heads/main/docs/prd.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/itlackey/openpalm/refs/heads/main/docs/development/architecture.md "raw.githubusercontent.com"
[3]: https://github.com/Tecnativa/docker-socket-proxy?utm_source=chatgpt.com "Tecnativa/docker-socket-proxy"
