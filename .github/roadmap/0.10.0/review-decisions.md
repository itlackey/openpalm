# 0.10.0 Review — Decision Log

Decisions made 2026-03-15 in response to the cross-plan alignment review report.

---

## Q1. OpenViking: Core Service or Component?

**Decision: Component.**

Remove from `assets/docker-compose.yml`. Create `registry/components/openviking/` with
`compose.yml` + `.env.schema`. Installed on demand like Ollama/SearXNG.

**Affected plans:** knowledge-system-roadmap.md, openpalm-components-plan.md

**Resolves:** H5 (Viking core vs component), C4 (network wiring — handled by component
compose overlay instead of core compose), D1 (container_name non-standard), D2 (image
version pinning — component .env.schema controls the tag).

---

## Q2. CONFIG_HOME Three-Tier Contract

**Decision: Preserve the three-tier XDG model.**

CONFIG_HOME stays as user-owned persistent source of truth. Component compose definitions
and persistent data go in DATA_HOME. The components plan must NOT propose eliminating
CONFIG_HOME.

**Affected plans:** openpalm-components-plan.md, core-principles.md (no change needed)

**Resolves:** C2 (CONFIG_HOME elimination breaks three-tier contract).

---

## Q3. Secret Management Model

**Decision: Unified secret manager wrapping Varlock.**

A single password manager wraps Varlock and the configured Varlock provider. ALL secrets
go through this system — core secrets, component secrets, and ad-hoc secrets. No separate
plaintext `.env` path for components.

**Affected plans:** openpalm-pass-impl-v3.md (major revision — must support component
and ad-hoc secrets, not just global), openpalm-components-plan.md (component `.env.schema`
must integrate with the unified secret manager).

**Resolves:** H1 (missing secrets — all secrets flow through one system), H2 (component
secrets model unreconciled — now reconciled under unified manager).

---

## Q4. Brokered Admin Instance Token

**Decision: ADMIN_TOKEN — full admin-level agent.**

The brokered OpenCode instance (#304) is an admin-level agent embedded in the admin UI.
It assists the user directly and can take requests from the assistant. It gets full admin
API access by design — this is NOT a violation of assistant isolation because it IS an
admin agent, not the assistant.

**Affected plans:** knowledge-system-roadmap.md, openpalm-pass-impl-v3.md

**Resolves:** H7 (broker token undefined). The broker module pattern is unnecessary —
the instance has direct admin access.

---

## Q5. Degraded Mode if #304 Is Delayed

**Decision: Shell automation type.**

Extend the automation system's `shell` action type to run eval and maintenance scripts
directly. No OpenCode dependency. Eval suites and maintenance tasks are shell-executable
with appropriate env access. The brokered instance calls these later when available, but
they work standalone via scheduled automations.

**Affected plans:** knowledge-system-roadmap.md (Phases 3 and 4C need fallback paths)

**Resolves:** H3 (33% of roadmap blocked on unbuilt #304).

---

## Q6. Q-Value Storage

**Decision: OpenPalm memory service. Viking stays optional add-on.**

Q-values (MemRL retrieval quality scores) are stored as procedural memories in
`@openpalm/memory` with resource URIs as keys. OpenViking is an optional component —
the core knowledge/learning system must not hard-depend on it. Viking enhances search
and context retrieval when installed but the learning lifecycle works without it.

**Affected plans:** knowledge-system-roadmap.md (must decouple Viking dependency from
core learning features)

**Resolves:** M3 (Q-value cross-system coupling — coupling is acceptable since memory
is the primary store, not Viking).

---

## Q7. Automations in the Unified Registry

**Decision: Keep automations separate.**

Automations remain their own registry mechanism (`registry/automations/`). Components
are containers; automations are scheduled tasks. Different concerns, different registries.
The unified registry plan covers components only.

**Affected plans:** openpalm-unified-registry-plan.md (add explicit statement that
automations are out of scope)

**Resolves:** M4 (automation registry orphaned — intentionally separate).

---

## Q8. Legacy Channel Migration

**Decision: Clean break — no migration, no coexistence.**

The legacy `CONFIG_HOME/channels/*.yml` format is dropped entirely. Components are the
only path for 0.10.0. No migration tool, no dual-format staging pipeline. Users must
reinstall channels as components.

**Affected plans:** openpalm-components-plan.md (remove any coexistence language, document
the clean break)

**Resolves:** M5 (no migration path — intentionally none needed).

---

## Q9. ov.conf Placement

**Decision: DATA_HOME.**

Since Viking is a component (Q1), its config lives in the component instance directory
under DATA_HOME. Admin mediates writes. Admin UI can update embedding provider config
without non-destructive lifecycle constraints. Advanced users can still edit since
DATA_HOME is user-accessible.

**Affected plans:** knowledge-system-roadmap.md

**Resolves:** M2 (ov.conf placement).

---

## Q10. Password Manager First-Boot Experience

**Decision: Wizard prompts choice.**

The setup wizard asks "Enable encrypted secrets?" during first boot. If yes, guides
through GPG key setup. If no, uses a plaintext backend. User makes an informed choice.
The plaintext backend ensures zero-friction fallback and non-breaking upgrades.

**Affected plans:** openpalm-pass-impl-v3.md (must implement PlaintextBackend as default
+ wizard integration for GPG opt-in)

**Resolves:** H6 (no upgrade fallback — PlaintextBackend is the fallback).

---

## Cascading Implications

These decisions create several cascading changes beyond the direct fixes:

1. **Viking as component** means the knowledge roadmap's entire Phase 1A (Viking
   integration) is really "create the Viking component + install it" rather than
   "wire up a core service." The compose overlay, .env.schema, healthcheck, and
   assistant_net attachment all come from the component directory.

2. **Unified secret manager** is a bigger scope than the original pass plan. It must:
   - Support per-component secret resolution (not just global secrets.env)
   - Provide ad-hoc secret storage API (for assistant-discovered credentials, etc.)
   - Integrate with the component lifecycle (secrets provisioned on install, cleaned on delete)

3. **ADMIN_TOKEN for brokered instance** simplifies the broker design significantly.
   No new token type, no mediation layer. But it means the admin UI must isolate the
   embedded OpenCode instance's UI context carefully (it has admin power but should
   present as a helpful assistant to the user).

4. **Clean break for channels** means 0.10.0 is a breaking release for anyone with
   custom channels. The upgrade path is: uninstall old channels, upgrade, reinstall
   as components. This needs prominent documentation in release notes.

5. **Memory service for Q-values** means the memory service needs a new "Q-value"
   memory type or a metadata field on procedural memories for numeric scoring.
   The existing positive/negative feedback becomes the reward signal for MemRL.

6. **Shell automation fallback** means eval suites must be CLI-executable scripts,
   not just OpenCode tool calls. This is actually a better design — eval as
   portable scripts that any automation or agent can invoke.
