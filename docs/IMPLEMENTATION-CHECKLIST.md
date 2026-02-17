# Implementation Checklist vs Root Guides

## 01-implementation-guide.md
- [x] OpenMemory private service wiring in compose
- [x] OpenCode runtime service and config
- [x] OpenMemory MCP referenced from OpenCode config
- [x] Gateway `/message` and `/health`
- [x] Tool firewall (allowlist, approval gates)
- [x] Observability/audit event logging
- [x] Rules + skills for recall-first + memory policy + action gating

## 02-docker-compose-hosting-and-extensibility.md
- [x] Single compose stack with Gateway + OpenCode + OpenMemory
- [x] Optional channel services as dumb adapters
- [x] MCP/custom-tool extension path documented
- [x] Safety hard rules implemented (egress allowlist, replay, auth)

## 03-admin-implementation-guide.md
- [x] Installer script with checks + bootstrap
- [x] Staged change manager endpoints (propose/validate/apply/rollback)
- [x] Config edit + safe write + restart flow
- [x] compose-control sidecar (no Docker socket in gateway)
- [x] Step-up auth enforced for high-risk admin operations

## 04-admin-ui-extensions-install-enable.md
- [x] OpenCode `plugin[]` treated as canonical extension registry
- [x] API flow to request/install/disable plugin IDs
- [x] Preflight validation and risk tagging
- [x] API/CLI-first approval flow (not UI-manual)
- [x] Optional ops dashboard retained read-only
