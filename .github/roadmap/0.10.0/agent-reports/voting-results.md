# v0.10.0 Agent Review — Consolidated Voting Results

Generated 2026-03-18 from 5 review agents: Architecture (A), Security (S), Implementation Feasibility (F), Product & UX (P), Technical Debt (T).

---

## Voting Legend

- **YES** = Agent explicitly recommends this change
- **NO** = Agent explicitly opposes this change
- **—** = Agent did not address this specific recommendation
- **PASS** = 3+ of 5 agents agree (majority rule)

---

## Issue-Level Changes

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| 1 | **DEFER #302 (TTS/STT) from 0.10.0** — No plan, no scope, no dependencies | YES | NO | YES | YES | NO | **3/5 PASS** |
| 2 | **CLOSE #13 as superseded by component system** — References dead code paths, all features subsumed by #301 | YES | YES | YES | YES | YES | **5/5 PASS** |
| 3 | **RETITLE #301 → "Unified Component System"** — Original "configurable services" concept subsumed by component model | YES | — | YES | YES | YES | **4/5 PASS** |
| 4 | **SCOPE DOWN #298 to Viking component + assistant tools only** — Defer eval framework and MemRL Q-values to 0.11.0 | YES | — | YES | YES | — | **3/5 PASS** |
| 5 | **SCOPE #304 to Phase 1-2 for 0.10.0** — Keep foundations + diagnostics, defer remediation + hardening | YES | YES | NO* | YES | YES | **4/5 PASS** |
| 6 | **SPLIT #300: Phases 0-4 in 0.10.0, defer Phases 5-7** — Ship hardening + auth + backend + pass + API; defer UI, connections refactor, migration tooling | YES | — | YES† | YES | — | **3/5 PASS** |
| 7 | **KEEP #315 (Azure ACA) in 0.10.0** — Pure additive, no core changes, can develop in parallel | YES | YES | NO | YES | YES | **4/5 PASS** |

\* Feasibility recommends deferring #304 entirely to 0.11.0, outvoted by 4 agents who say keep but scope down.
† Feasibility recommends Phases 0-1 only, but defers to the compromise of 0-4.

---

## Plan Document Changes

| # | Recommendation | A | S | F | P | T | Result |
|---|---------------|---|---|---|---|---|--------|
| 8 | **ADD CLI Integration section to components plan** — CLI must support component model without admin | YES | — | — | YES | YES | **3/5 PASS** |
| 9 | **ADD Cross-Component Env Injection section to components plan** — How Viking injects vars into assistant | YES | YES | YES | — | — | **3/5 PASS** |
| 10 | **ADD Upgrade path / migration detection** — Banner in admin UI, CLI warning for legacy channels | YES | — | YES | YES | YES | **4/5 PASS** |
| 11 | **ADD Component testing strategy** — Unit tests, E2E lifecycle, migration regression tests | YES | — | YES | — | YES | **3/5 PASS** |
| 12 | **SPLIT knowledge roadmap** — Viking + MCP stay 0.10.0; eval + MemRL become separate 0.11.0 docs | YES | — | YES | YES | — | **3/5 PASS** |
| 13 | **FIX component secret naming collision in pass plan** — Namespace by instance ID | YES | YES | — | — | — | **2/5 FAIL** |
| 14 | **REMOVE `eval` in pass-init.sh** — Shell injection risk | YES | YES | — | — | — | **2/5 FAIL** |
| 15 | **ADD Compose overlay validator for security** — Reject privileged, cap_add, restricted networks | — | YES | — | — | — | **1/5 FAIL** |
| 16 | **STANDARDIZE API path convention (/api/* vs /admin/*)** | YES | — | — | — | — | **1/5 FAIL** |
| 17 | **ADD tab consolidation plan to components proposal** — Target 5 tabs max | — | — | — | YES | — | **1/5 FAIL** |
| 18 | **KEEP Caddy as core service (not component) for 0.10.0** | — | — | YES | — | — | **1/5 FAIL** |
| 19 | **ADD new GitHub issues: component impl, legacy removal, CI updates** | — | — | — | — | YES | **1/5 FAIL** |
| 20 | **FIX broken writeOpenCodeProviderConfig()** | — | — | — | — | YES | **1/5 FAIL** |
| 21 | **ADD auth on admin OpenCode port 4097** | — | YES | — | — | — | **1/5 FAIL** |
| 22 | **ADD Quick Start wizard path (2-step minimum)** | — | — | — | YES | — | **1/5 FAIL** |

---

## Summary of Majority-Approved Changes

### Issues (7 changes):
1. DEFER #302 from 0.10.0 milestone
2. CLOSE #13 as superseded by #301
3. RETITLE #301 → "Unified Component System"
4. SCOPE DOWN #298 to Viking component + tools only
5. SCOPE #304 to Phase 1-2
6. SPLIT #300 to Phases 0-4 for 0.10.0
7. KEEP #315 in 0.10.0

### Plan Documents (5 changes):
8. ADD CLI Integration section to components plan
9. ADD Cross-Component Env Injection section to components plan
10. ADD Upgrade path / migration detection section
11. ADD Component testing strategy
12. SPLIT knowledge roadmap (Viking+MCP = 0.10.0, eval+MemRL = 0.11.0)

### Total: 12 approved changes to implement.
