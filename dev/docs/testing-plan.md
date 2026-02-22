# OpenPalm Testing Plan

## Goals

Detect regressions, feature drift, implementation gaps, and security violations across the full stack with layered automated testing that runs locally and in CI.

---

## Implementation Status (Current)

The following items from this plan are now implemented in-repo:

- ✅ Layer 1 unit tests for gateway (`rate-limit`, `audit`, intake/security/client edge cases), admin routes, and channel adapters.
- ✅ Layer 1 admin tests for `automations`, `automation-history`, `stack-manager`, and `stack-spec`.
- ✅ Layer 2 integration suites for channel→gateway and admin→admin flows.
- ✅ Layer 3 contract suites for channel-message validation and docs parity checks.
- ✅ Layer 4 security suites for auth, HMAC edge rejection, and input bounds.
- ⚠️ Layer 5 admin UI Playwright tests are scaffolded under `packages/ui/e2e/` and require expansion to full page-object coverage listed below.

Run status-oriented lanes with:

- `bun test --filter integration`
- `bun test --filter contract`
- `bun test --filter security`

---

## Layer 1: Unit Tests (fast, no network, no Docker)

Run: `bun test` — target < 5 seconds total.

### Gateway

| Module | File | What to test |
|--------|------|--------------|
| `rate-limit.ts` | `rate-limit.test.ts` | allows under limit; blocks at limit; window resets after expiry; distinct keys are independent |
| `audit.ts` | `audit.test.ts` | writes JSONL to file; creates directory if missing; each event is one line; event shape matches `AuditEvent` |
| `channel-intake.ts` | _(exists)_ | add: missing `{` / `}` in response; empty string; double-encoded JSON; truncated JSON |
| `channel-security.ts` | _(exists)_ | add: empty secret; empty body; timing-safe path (ensure `timingSafeEqual` is used, not `===`) |
| `assistant-client.ts` | _(exists)_ | add: timeout behavior; non-200 status; malformed JSON response; retry-after headers |
| `server.ts` | `server.test.ts` | `validatePayload` extracted or tested inline: missing fields, empty strings, text > 10k, unknown channel, valid payload |

### Admin

| Module | File | What to test |
|--------|------|--------------|
| `server.ts` | `server.test.ts` | route matching; token auth rejection; allowed-service filter; disallowed service returns 400; health endpoint no auth; mock `runCompose` to test response shaping |

### Channel Adapters (chat, discord, voice, telegram)

Each adapter shares the same pattern. For each:

| Concern | What to test |
|---------|--------------|
| Health | `GET /health` returns `{ ok: true }` |
| Auth | rejects missing token when token env is set; allows when token matches |
| Payload normalization | output matches `ChannelMessage` shape with correct `channel` field |
| HMAC signing | signature header is present and matches expected HMAC |
| Input validation | missing text returns 400; missing userId gets default |
| Gateway forwarding | mock gateway; verify correct URL, headers, and body forwarded |

Telegram-specific: non-text updates silently skipped, secret token header validated.
Discord-specific: interactions endpoint handles type 1 (ping) and type 2 (command); webhook endpoint normalizes `guildId`/`channelId`.
Voice-specific: `GET /voice/stream` returns 501.

### Admin

| Module | File | What to test |
|--------|------|--------------|
| `setup.ts` | _(exists)_ | add: concurrent writes don't corrupt state; invalid step names rejected |
| `runtime-env.ts` | _(exists)_ | add: missing file handled gracefully; malformed lines skipped |
| `automations.ts` | `automations.test.ts` | cron sync; trigger automation; payload file management |
| `automation-history.ts` | `automation-history.test.ts` | read history; get latest run; history file rotation |

### OpenMemory plugin

_(20 tests exist)_ — add:

| Concern | What to test |
|---------|--------------|
| Edge cases | empty recall results; maximum `RECALL_LIMIT` hit; `OPENPALM_MEMORY_MODE=off` disables all |
| Secret patterns | API keys, tokens, passwords, connection strings detected and redacted |

---

## Layer 2: Integration Tests (mock external services, no Docker)

Run: `bun test --filter integration` — target < 15 seconds.

Use mock `Bun.serve()` instances to simulate service-to-service communication.

### 2a. Gateway Integration

Spin up a real gateway server + mock OpenCode Core server:

| Scenario | Assertions |
|----------|------------|
| **Happy path** | Channel adapter → gateway → intake → core → 200 response with answer |
| **Intake rejects** | intake returns `valid:false` → gateway returns 422 |
| **Intake timeout** | mock delays > `OPENCODE_TIMEOUT_MS` → 502 |
| **Core timeout** | intake passes, core delays → 502 |
| **Invalid HMAC** | wrong signature → 403 |
| **Missing channel secret** | unconfigured channel → 403 |
| **Rate limit** | 121 rapid requests → 429 on the 121st |
| **Malformed payload** | partial JSON → 400 |
| **Audit trail** | after each scenario, verify audit log file contains correct event |

### 2b. Admin → Admin Integration

Spin up admin + mock admin:

| Scenario | Assertions |
|----------|------------|
| Container list | admin proxies list correctly |
| Restart service | admin sends restart, admin receives correct service name |
| Disallowed service | admin rejects, admin surfaces error |
| Auth cascade | missing admin token → 401; missing admin token → 401 |

### 2c. Channel → Gateway Integration

For each channel adapter, spin up the adapter + mock gateway:

| Scenario | Assertions |
|----------|------------|
| Full roundtrip | POST to channel → channel signs + forwards → mock gateway receives valid `ChannelMessage` with correct HMAC |
| Gateway error propagation | mock gateway returns 502 → channel returns 502 to caller |

---

## Layer 3: Contract Tests

Verify that services conform to the API contracts in `docs/api-reference.md`.

### Approach

Create a shared `test/contracts/` directory with:

1. **`channel-message.schema.ts`** — Zod or hand-rolled validator for `ChannelMessage`
2. **`intake-decision.schema.ts`** — validator for `IntakeDecision`
3. **`admin-api.contracts.ts`** — expected status codes and response shapes for every admin endpoint
4. **`admin-api.contracts.ts`** — expected status codes and response shapes for admin endpoints

### What to test

| Contract | Test |
|----------|------|
| Every channel adapter output matches `ChannelMessage` schema | Parse output with schema; fail on extra/missing fields |
| Gateway error codes match docs | Trigger each documented error; verify exact error string and status |
| Admin endpoints return documented shapes | Hit each endpoint; validate response against contract |
| Admin allowed-service set matches docs | Compare `ALLOWED` set in code to `docs/api-reference.md` list |

---

## Layer 4: Security Tests

Run: `bun test --filter security`

| Category | Tests |
|----------|-------|
| **HMAC** | Replay attack (same nonce rejected or at least doesn't bypass signature); empty signature rejected; truncated signature rejected |
| **Auth** | Every admin endpoint without `x-admin-token` → 401; admin without `x-admin-token` → 401 |
| **Input bounds** | text > 10,000 chars → 400; userId with injection chars handled; nonce length limits |
| **Channel isolation** | channel-intake agent has tools denied (verify agent config); valid intake cannot escalate to tool use |
| **Config safety** | `POST /config` with permission widening to `allow` → rejected |
| **Secret detection** | memory write-back with API keys, tokens, connection strings → blocked |
| **Rate limiting** | per-user enforcement; different users have independent limits |

---

## Layer 5: Admin UI Tests

The admin UI is a vanilla JS SPA (SvelteKit app in `packages/ui/src/routes/+page.svelte`) with hash-based routing, no framework. UI tests use Playwright (headless Chromium) against a real admin server with mocked backend dependencies (admin, gateway, assistant).

### Test tooling

- **Playwright** (`@playwright/test`) for browser automation
- Real admin `Bun.serve()` instance started per test suite on a random port
- Mock admin and mock gateway via `Bun.serve()` on random ports
- Temp filesystem for admin state (setup.json, cron-store.json (Automations backend), config files)
- Tests in `packages/ui/e2e/` directory

Run: `bun run test:ui` — target < 30 seconds.

### 5a. Page Navigation and Layout

| Test | Assertions |
|------|------------|
| All 7 nav tabs render | click each tab → correct `#page-*` visible, others hidden |
| Active tab styling | clicked tab has active class; others don't |
| Default page on load | extensions page shown by default (or setup wizard if first boot) |
| OpenCode iframe | navigating to OpenCode tab loads iframe with correct src |
| OpenMemory iframe | navigating to OpenMemory tab loads iframe with correct src |

### 5b. Setup Wizard

| Test | Assertions |
|------|------------|
| First-boot trigger | when `setupComplete: false`, wizard overlay appears automatically |
| Step progression | click Next → advances through all 8 steps in order |
| Back button | click Back → returns to previous step; Back hidden on step 1 |
| Progress dots | correct dot highlighted for current step |
| **Welcome step** | renders overview text; Next button enabled |
| **Access scope step** | radio buttons for "Host only" / "LAN"; selection persists on Next/Back; calls `POST /command` (`setup.access_scope`) |
| **Service instances step** | form fields for OpenMemory URL, Postgres URL, Qdrant URL, OpenAI endpoint, OpenAI API key; calls `POST /command` (`setup.service_instances`) on Next |
| **Health check step** | shows status dots for gateway, admin, assistant, openmemory, admin; calls `GET /setup/health-check`; green dots for healthy, red for failed |
| **Security step** | admin password input; password saved to localStorage; displays active protections list |
| **Channels step** | checkboxes for chat, discord, voice, telegram; selection posted to `POST /command` (`setup.channels`) |
| **Complete step** | calls `POST /command` (`setup.complete`); shows "Continue to Admin" button; clicking dismisses overlay |
| Wizard not shown after complete | reload page with `setupComplete: true` → no overlay |
| Re-run wizard from settings | click "Open Setup Wizard" in settings → overlay reappears |

### 5c. Extensions Page (Plugin Management)

| Test | Assertions |
|------|------------|
| Lists installed plugins | page shows plugins currently in opencode.json `plugin[]` array |
| Install plugin | enter plugin ID → click Install → calls `POST /plugins/install` → plugin appears in list |
| Uninstall plugin | click Uninstall → confirm → calls `POST /plugins/uninstall` → plugin removed from list |
| Install requires auth | install without admin token → error alert |
| Requires auth | page without admin token shows auth-required message or empty |

### 5e. Services Page

| Test | Assertions |
|------|------------|
| Health status grid | shows gateway, admin, assistant, openmemory, admin with dot indicators |
| Healthy service dot | mock returns healthy → green dot |
| Unhealthy service dot | mock returns error → red dot |
| Channel cards | shows chat, discord, voice, telegram with access badge (LAN/PUBLIC) |
| Toggle channel access | click "Set Public" → confirm → calls `POST /channels/access` → badge updates |
| Edit channel config | click "Edit Config" → prompt with key=value → calls `POST /channels/config` |
| Container action: restart | click Restart on a service → calls `POST /command` (`service.restart`) → success message |
| Container action: up | click Up → calls `POST /command` (`service.up`) |
| Container action: down | click Down → calls `POST /containers/down` |
| Container actions require auth | without token → error |
| All known services listed | grid includes: gateway, assistant, openmemory, openmemory-ui, admin, admin, channel-chat, channel-discord, channel-voice, channel-telegram, caddy |

### 5f. Automations Page

| Test | Assertions |
|------|------------|
| Empty state | no automations → shows empty message or empty list |
| Create automation | fill name, schedule, prompt → click Create → automation appears in list; calls `POST /automations` |
| Automation card content | shows name, enabled/disabled badge, schedule in `<code>`, prompt preview (truncated 120 chars) |
| Validation: missing fields | submit with empty name → "All fields are required" error |
| Validation: invalid schedule | submit with bad expression → server error shown |
| Edit automation | click Edit → form populated with automation data → modify → save → list updated; calls `POST /command` (`automation.upsert`) |
| Delete automation | click Delete → confirm → automation removed from list; calls `POST /command` (`automation.delete`) |
| Toggle enable/disable | click Enable/Disable → badge toggles; calls `POST /command` (`automation.upsert`) |
| Run Now | click Run Now → calls `POST /command` (`automation.trigger`) → success message |
| Multiple automations | create 3 automations → all 3 visible in list |
| Persistence | create automation → reload page → automation still listed (re-fetched from API) |

### 5g. Settings Page

| Test | Assertions |
|------|------------|
| Admin password field | type password → stored in localStorage under `op_admin` |
| Password sent as header | after setting password, API calls include `x-admin-token` header |
| Service instances form | fields for OpenMemory, Postgres, Qdrant, OpenAI endpoint, OpenAI key |
| Save service instances | fill fields → click Save → calls `POST /command` (`setup.service_instances`) |
| Warning displayed | shows warning about breaking workflows |
| Re-run setup button | click "Open Setup Wizard" → wizard overlay appears |

### 5h. Channel secret references

Channel configs reference secrets directly from `secrets.env` using `${SECRET_NAME}` values. Stack apply validates that all referenced keys are present.

| Test | Assertions |
|------|------------|
| Validate secret references | stack apply rejects missing `${SECRET_NAME}` references before rendering/apply |
| Secrets storage | after creating/updating secrets, verify `secrets.env` contains user-defined keys and values |
| Requires auth | secret CRUD operations without admin token return 401 |

### 5i. Error Handling (cross-cutting)

| Test | Assertions |
|------|------------|
| API 401 on protected action | mock returns 401 → alert shown with error message |
| API 500 on server error | mock returns 500 → alert shown with error text |
| Network failure | mock server down → error alert or "Could not load" text |
| Extensions load failure | mock returns error → "Could not load" message in extensions area |
| Automations load failure | mock returns error → "Could not load" message in automations area |

### 5j. Auth Flow (cross-cutting)

| Test | Assertions |
|------|------------|
| No token set | install button → error; container actions → error |
| Token set in settings | set password → install succeeds; container actions succeed |
| Token persists across reload | set token → reload → token still in localStorage → API calls still authed |
| Wrong token | set incorrect token → API returns 401 → error shown |

### UI Test File Organization

```
packages/ui/e2e/
├── setup-wizard.ui.test.ts
├── extensions.ui.test.ts       # Plugin management page
├── services.ui.test.ts
├── automations.ui.test.ts      # Automations page
├── secrets.ui.test.ts          # Secrets CRUD (stack spec env var -> secret key refs)
├── settings.ui.test.ts
├── navigation.ui.test.ts
├── auth-flow.ui.test.ts
├── error-handling.ui.test.ts
└── helpers/
    ├── admin-harness.ts        # starts admin server + mocks on random ports
    ├── page-objects.ts         # page object helpers (selectors, common actions)
    └── mock-responses.ts       # canned API responses for automations, secrets, etc.
```

### CI considerations for UI tests

- UI tests run in CI using `playwright` with `chromium` (headless).
- Added as a separate job in `test.yml` after unit tests pass.
- No Docker required — admin server + mocks are all in-process `Bun.serve()`.

---

## Layer 6: Compose Stack Tests (Docker required, local only)

Run: `bun run test:compose` — target < 2 minutes.

Requires the full Docker Compose stack running (`bun run dev:up`).

### Smoke tests

| Test | How |
|------|-----|
| All services healthy | `GET /health` on every service port; all return `{ ok: true }` |
| Caddy routing | request to `/` routes to admin; `/channels/chat*` routes to chat |
| LAN restriction | `/` not accessible from non-LAN IP (test with Caddy config parsing) |
| Service discovery | gateway can reach `assistant:4096`; channels can reach `gateway:8080` |

### E2E API flow tests

| Test | Flow |
|------|------|
| Chat roundtrip | POST `/channels/chat` → chat adapter → gateway → assistant → response |
| Discord webhook roundtrip | POST `/channels/discord` → discord adapter → gateway → assistant → response |
| Admin container lifecycle | `POST /command` (`service.restart`) → admin restarts service → service comes back healthy |
| Plugin install/uninstall | install plugin via admin API → verify config updated → uninstall → verify removed |
| Setup wizard flow | complete setup wizard steps in order → verify `setupComplete: true` |
| Memory integration | send message → verify openmemory receives write-back → send follow-up → verify recall injected |

### E2E UI flow tests (compose + Playwright)

Full browser-driven tests against the live compose stack. These exercise the real admin UI against real backend services — the highest-fidelity tests in the suite.

| Test | Flow |
|------|------|
| Setup wizard → extensions → install | complete setup wizard in browser → navigate to extensions → install a plugin → verify on extensions page |
| Automation CRUD lifecycle | create automation → verify listed → edit schedule → verify updated → run now → delete → verify gone |
| Container restart from UI | navigate to services → click Restart on a service → verify service comes back healthy |
| Channel access toggle | set channel to public → verify badge updates → set back to LAN |
| Config editor roundtrip | open settings → modify service instance URL → save → reload → verify value persisted |

---

## Layer 7: Regression Guards

### Config drift detection

| Guard | Implementation |
|-------|---------------|
| Allowed channels in gateway match docs | test reads `ALLOWED_CHANNELS` from source and compares to `docs/API.md` |
| Allowed services in admin match docs | test reads `ALLOWED` set from source and compares to `docs/API.md` |
| Docker compose services match architecture | test parses `dev/docker-compose.dev.yml` service names and compares to `docs/architecture.md` |
| Channel adapter ports match docs | test reads each adapter's `PORT` default and compares to `docs/API.md` |
| Admin UI nav tabs match implemented pages | test parses nav buttons in `index.html` and compares to `#page-*` divs |

### Schema drift detection

| Guard | Implementation |
|-------|---------------|
| `ChannelMessage` type matches test contracts | if type changes, contract tests fail |
| Stack spec schema validation | validate `assets/config/stack-spec.json` against expected schema |
| Admin API routes match docs | test enumerates all routes in server source; compare to `docs/API.md` endpoint list |
| UI fetch calls match API routes | test extracts all `fetch()` URLs from `index.html` and `setup-ui.js`; verify each has a corresponding server route |

---

## CI Configuration

### GitHub Actions: `test.yml` (runs on every PR and push to main)

```yaml
name: test
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run typecheck
      - run: bun test

  integration:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test --filter integration

  contracts:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test --filter contract

  security:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test --filter security

  ui:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx playwright install --with-deps chromium
      - run: bun run test:ui
```

### Workflow tests (local pre-push verification)

All GitHub Actions workflows can be tested locally using [act](https://github.com/nektos/act):

```bash
bun run test:workflows                      # Test all 7 workflows
./dev/test-workflows.sh publish-images      # Test one workflow
./dev/test-workflows.sh --dry-run           # Validate YAML only
```

This covers: `test`, `publish-images`, `publish-cli`, `release`, `validate-registry`, `update-registry-index`, and `version-bump-pr`. The script builds all Docker images locally, bundles the CLI, validates the npm package, and runs workflow YAML through act.

**Developers must run `bun run test:workflows` after all other tests pass and before pushing to the remote.**

### Local-only (not in CI)

- **Layer 6 (compose stack tests)**: requires Docker + full stack. Run with `bun run test:compose`.
- **Compose E2E UI tests**: requires full stack. Run with `bun run test:compose:ui`.
- **Memory integration tests**: require OpenMemory + PostgreSQL + Qdrant running.

---

## Test File Organization

```
<workspace>/
├── src/
│   ├── module.ts
│   ├── module.test.ts              # unit tests (Layer 1)
│   └── module.integration.test.ts  # integration tests (Layer 2)
packages/ui/e2e/                     # admin UI tests (Layer 5)
├── setup-wizard.ui.test.ts
├── extensions.ui.test.ts           # Plugin management page
├── services.ui.test.ts
├── automations.ui.test.ts          # Automations page
├── secrets.ui.test.ts          # Secrets CRUD (stack spec env var -> secret key refs)
├── settings.ui.test.ts
├── navigation.ui.test.ts
├── auth-flow.ui.test.ts
├── error-handling.ui.test.ts
└── helpers/
    ├── admin-harness.ts            # starts admin server + mocks on random ports
    ├── page-objects.ts             # page object helpers (selectors, common actions)
    └── mock-responses.ts           # canned API responses for automations, secrets, etc.
test/
├── contracts/                      # contract schemas and tests (Layer 3)
│   ├── channel-message.contract.ts
│   ├── intake-decision.contract.ts
│   ├── admin-api.contract.test.ts
│   └── admin-api.contract.test.ts
├── security/                       # security tests (Layer 4)
│   ├── hmac.security.test.ts
│   ├── auth.security.test.ts
│   └── input-bounds.security.test.ts
├── compose/                        # compose stack tests (Layer 6)
│   ├── smoke.compose.test.ts
│   ├── e2e-flow.compose.test.ts
│   └── e2e-ui.compose.test.ts     # Playwright tests against live stack
├── regression/                     # drift detection (Layer 7)
│   ├── config-drift.test.ts
│   ├── schema-drift.test.ts
│   └── ui-api-drift.test.ts       # UI fetch URLs vs server routes
└── helpers/
    ├── mock-gateway.ts             # reusable mock Bun.serve() for gateway
    ├── mock-opencode.ts            # reusable mock for assistant
    ├── mock-admin.ts          # reusable mock for admin
    └── fixtures.ts                 # shared test data (valid payloads, tokens, etc.)
```

---

## package.json Scripts

```json
{
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test --filter '!integration|contract|security|compose|ui'",
    "test:integration": "bun test --filter integration",
    "test:contracts": "bun test --filter contract",
    "test:security": "bun test --filter security",
    "test:ui": "bun test --filter ui.test",
    "test:compose": "bun test --filter compose",
    "test:compose:ui": "bun test --filter e2e-ui.compose",
    "test:ci": "bun run typecheck && bun test --filter '!compose'",
    "test:workflows": "./dev/test-workflows.sh",
    "typecheck": "bunx tsc --noEmit"
  }
}
```

---

## Priority Order for Implementation

1. **Shared test helpers** (`test/helpers/`) — mock servers, fixtures, factory functions
2. **Missing unit tests** — rate-limit, audit, admin, channel adapters (highest coverage gap)
3. **Contract tests** — catch drift between docs and implementation
4. **Gateway integration tests** — the most critical path (channel → intake → core)
5. **Security tests** — HMAC, auth, input bounds
6. **Admin UI tests** — setup wizard, extensions, automations, services, settings (Layer 5)
7. **Regression guards** — config/schema/UI drift detection
8. **CI workflow** — `test.yml` running layers 1-5 + typecheck
9. **Compose stack tests** — local-only E2E (API + UI)

---

## Coverage Targets

| Layer | Current | Target |
|-------|---------|--------|
| Gateway unit | ~40% (3 of 6 modules) | 100% |
| Admin unit | ~50% (3 of 6 modules) | 100% |
| Admin unit | 0% | 100% |
| Channel adapters unit | 0% | 100% (all 4) |
| Admin UI | 0% | all pages, all CRUD flows, auth, errors |
| Integration | 0% | all critical paths |
| Contracts | 0% | all API endpoints |
| Security | 0% | all auth + input boundaries |
| Compose E2E | 0% | happy path per channel + UI flows |
