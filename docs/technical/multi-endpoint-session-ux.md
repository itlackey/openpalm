# Multi-Endpoint Session UX

Status: Design proposal. No code changes have landed for this work.
Owner: chat UI / endpoint switcher.
Branch context: `release/0.11.0` — written after the auth/proxy refactor and the endpoint switcher landed.

---

## 1. Problem statement

The endpoint switcher (`packages/ui/src/lib/components/EndpointSwitcher.svelte`) lets a user point the UI at "Local Assistant" (containerized OpenCode), "OpenPalm Admin" (Electron-spawned local OpenCode), or any user-added remote OpenCode. Server-side that selection is durable; client-side the chat state is a single in-memory singleton (`packages/ui/src/lib/chat/chat-state.svelte.ts`) tracking one `sessionId` and one `entries[]`. On switch, `endpointsService.activate()` nulls the session id (`chat.dropCurrentSession()`); the UI never remembers the per-endpoint session or enumerates sessions OpenCode already has on disk.

The user wants per-endpoint history persistence (switching to X restores X's most recent conversation), a session picker, default-to-most-recent on switch, and continuation across switches (Local → Admin → Local lands back in the previous Local conversation). OpenCode already persists sessions on disk per server, so this is a UI/state-shape problem, not a data-modeling problem.

---

## 2. Findings: OpenCode session API surface

Source: `node_modules/.bun/@opencode-ai+sdk@1.15.10/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`. The HTTP surface is also what `/proxy/assistant/[...path]` already forwards.

- **List** — `GET /session` (`types.gen.d.ts:1796–1810`). Query: optional `directory`. Response: `Array<Session>`. The spec does **not** guarantee ordering; UI must sort by `time.updated` desc. No pagination — response is the full array. For long-lived installs that's potentially hundreds; render top 50 with a "show all" affordance.
- **`Session` shape** (`types.gen.d.ts:465–492`): `{ id, projectID, directory, parentID?, summary?, share?, title, version, time: { created, updated, compacting? }, revert? }`. `title` is empty until OpenCode summarizes after enough turns (`POST /session/{id}/summarize`, `types.gen.d.ts:2175–2208`).
- **Get session** — `GET /session/{id}` → `Session` (`types.gen.d.ts:1888–1915`).
- **Get messages** — `GET /session/{id}/message` → `Array<{ info: Message, parts: Part[] }>` (`types.gen.d.ts:2209–2243`). Query: `directory`, `limit`. `Message = UserMessage | AssistantMessage` (`types.gen.d.ts:39–128`), `Part = TextPart | ...` (`types.gen.d.ts:142–345`).
- **Lifecycle**: create `POST /session` with optional `{ parentID?, title? }` (`1811–1835`); rename `PATCH /session/{id}` (`1916–1945`); delete `DELETE /session/{id}` (`1860–1887`); fork `POST /session/{id}/fork` (`2040–2058`); abort `POST /session/{id}/abort` (`2059–2086`); share/unshare `POST/DELETE /session/{id}/share` (`2087–2142`).
- **Real-time**: SSE event stream emits `session.created`/`updated`/`deleted` (`types.gen.d.ts:493–509`). Not needed for v1 — fetch-on-switch is enough; subscribe later if staleness becomes a problem.

---

## 3. Proposed data model

The chat singleton becomes an endpoint-keyed map. Sessions cached per endpoint; messages cached only for the **currently rendered** session (the rest are refetched on selection). Nothing about this is persisted across UI reloads — OpenCode is the source of truth, we just re-fetch on mount.

```ts
// packages/ui/src/lib/chat/chat-state.svelte.ts (proposed)

type EndpointId = string;
type SessionId = string;

export type SessionSummary = {
  id: SessionId;
  title: string;        // empty until OpenCode summarizes; show "Untitled" + relative time
  createdAt: number;
  updatedAt: number;
};

type EndpointChatState = {
  sessions: SessionSummary[];     // sorted desc by updatedAt
  sessionsLoaded: boolean;
  sessionsLoading: boolean;
  sessionsError: string;
  activeSessionId: SessionId | null;
};

class ChatService {
  // Per-endpoint state. Map (not record) so $state reactivity is straightforward.
  byEndpoint = $state<Map<EndpointId, EndpointChatState>>(new Map());

  // The active endpoint is mirrored from endpointsService.activeId so the
  // chat layer doesn't have to import the endpoint store everywhere.
  activeEndpointId = $state<EndpointId>('default');

  // Messages for the currently rendered session only.
  entries = $state<ChatEntry[]>([]);
  entriesLoading = $state(false);
  sending = $state(false);
  error = $state('');

  // Derived: the active session id for the active endpoint.
  activeSessionId = $derived<SessionId | null>(
    this.byEndpoint.get(this.activeEndpointId)?.activeSessionId ?? null
  );
}
```

Why a `Map` keyed by endpoint id, not nested in the endpoint entry itself: endpoints come from a server-side store, sessions are client-side ephemeral. Keeping them separate matches the existing layering.

**Persistence question.** We do *not* persist `activeSessionId` per endpoint to localStorage. OpenCode already has the data, the round trip is one request, and persistence creates a stale-state class of bugs (session deleted out-of-band, wrong session resumed in a new tab). The Electron "OpenPalm Admin" case is the same — the random per-launch password lives in `runtime.json`, but sessions on disk under `${OP_HOME}/data/admin-opencode/` are auth-agnostic and survive relaunch. They're just data that OpenCode itself indexes.

---

## 4. Loading sequence

```
User clicks endpoint X in switcher
  ├─ client: endpointsService.activate(X)
  │   ├─ POST /admin/endpoints/active { id: X }
  │   └─ chat.onEndpointChanged(X)
  │       ├─ activeEndpointId = X
  │       ├─ entries = []                  // clear old render
  │       ├─ if byEndpoint.has(X) and sessions cached → use them
  │       │  else: GET /proxy/assistant/session  (list X's sessions)
  │       │       sort desc by time.updated
  │       │       store in byEndpoint.get(X).sessions
  │       ├─ pick activeSessionId: previous if still present, else newest
  │       └─ if activeSessionId:
  │             GET /proxy/assistant/session/{id}/message?limit=200
  │             map → ChatEntry[]
  │             render
  │         else: empty state with "Start new session" CTA
  └─ on send: existing send() path; if activeSessionId null, ensureSession()
                                     creates one on X then continues.
```

**Latency.** Two sequential proxy round-trips on switch: list sessions (small payload) + fetch messages (limit 200). Both go through the same SvelteKit broker the chat already uses. On localhost p50 is sub-50 ms; on a remote endpoint it depends on RTT and OpenCode's I/O. We render a skeleton on the chat page while `entriesLoading` is true; the switcher itself does not block (it just flips the active label).

**Unreachable endpoint.** The proxy returns 503 with `endpoint_unreachable` (`packages/ui/src/routes/proxy/assistant/[...path]/+server.ts:99–115`). The session list call surfaces that; the chat page shows the existing "Assistant is not reachable" affordance with a "Retry" button. The endpoint stays active server-side; reconnect is one click.

---

## 5. UI design

**Recommendation: a sessions menu adjacent to the endpoint switcher in the navbar.** Same dropdown idiom, scoped to "active endpoint's sessions". On narrow widths it collapses to an icon-only button like the endpoint switcher.

Alternatives considered: (a) inline under each endpoint in the switcher dropdown — rejected, two-level menus are unwieldy and 280px is too narrow; (b) sidebar list — rejected, heavy layout commitment, competes with the chat scroll region; defer to a follow-up; (c) sessions tab on `/admin/endpoints` — rejected as primary, switching is frequent and shouldn't require navigation. The endpoints page still hosts bulk admin (rename/delete) as a secondary surface.

### Markup sketch (Svelte 5 pseudocode)

```svelte
<!-- Navbar.svelte (excerpt) -->
<EndpointSwitcher />
<SessionPicker /> <!-- new -->
```

```svelte
<!-- SessionPicker.svelte (new) -->
<script lang="ts">
  import { chat } from '$lib/chat/chat-state.svelte.js';
  import { endpointsService } from '$lib/endpoints-state.svelte.js';

  const active = $derived(endpointsService.active);
  const state = $derived(chat.byEndpoint.get(active?.id ?? '') ?? null);
  const sessions = $derived(state?.sessions ?? []);
  const currentTitle = $derived(
    sessions.find((s) => s.id === chat.activeSessionId)?.title || 'New session'
  );

  let open = $state(false);

  async function pick(id: string) {
    await chat.openSession(id);   // sets activeSessionId, fetches messages
    open = false;
  }

  async function startNew() {
    await chat.startNewSession(); // POST /session, sets activeSessionId, empties entries
    open = false;
  }
</script>

<button onclick={() => (open = !open)} title={currentTitle}>
  {currentTitle}<span class="caret">▾</span>
</button>
{#if open}
  <div role="menu">
    <button onclick={startNew}>+ New session</button>
    {#each sessions as s (s.id)}
      <button class:active={s.id === chat.activeSessionId} onclick={() => pick(s.id)}>
        <span class="title">{s.title || 'Untitled'}</span>
        <time>{formatRelative(s.updatedAt)}</time>
      </button>
    {/each}
  </div>
{/if}
```

### Affordances scoped for v1

- Show the current session title.
- List sessions for the active endpoint, sorted by most recent.
- Pick a different session.
- "+ New session" button — no title prompt. OpenCode summarizes after enough turns; we render "Untitled" as a placeholder.
- **Defer** rename and delete to v2. Both exist on the API (`PATCH /session/{id}` and `DELETE /session/{id}`) but they need a destructive-action confirmation flow that's better paired with the bulk admin surface on `/admin/endpoints`.

---

## 6. Edge cases

- **Zero sessions on switch** — render empty chat, input enabled; first send triggers `ensureSession()`. No special UI.
- **List fetch fails** — single-line error inside the picker ("Couldn't load sessions — Retry"); chat still works, lazily creating a session on send.
- **Switch mid-message (`sending=true`)** — block the switch with a toast ("Wait for the current reply"). `POST /session/{id}/abort` is available for a future Stop button.
- **Two tabs** — each tab tracks its own active session (tab-local); the active endpoint is shared via the server-side store. Matches chat-app expectations; no cross-tab sync needed. Electron has one window today.
- **OpenPalm Admin sessions across Electron relaunches** — sessions persist on disk; only the wire password rotates. `endpoints.json` still points to `local-electron`, `runtime.json` carries the new password, the picker re-fetches the unchanged session list. No special handling.
- **Session created with a different model than the current default** — each user/assistant message carries its own `model` (`types.gen.d.ts:52–55, 108–109`); OpenCode resumes accordingly. New prompts can override via `POST /session/{id}/message`'s optional `model` (`types.gen.d.ts:2244–2289`); v1 lets OpenCode use its default. Per-session model selection is v2.

---

## 7. Backward compatibility / migration

- The current `chat` singleton state is in-memory only — no localStorage, no IndexedDB. Nothing to migrate; the new model replaces the old struct.
- `localStorage` keys today are user preferences (e.g. `openpalm.tts.auto`) — none are session-keyed. Safe.
- No "stale local state" prompt needed.
- API: the proxy is generic (`/proxy/assistant/[...path]`), so all the new OpenCode endpoints work without server-side changes.
- `chat.dropCurrentSession()` and `chat.reset()` callers (`endpoints-state.svelte.ts:54`, `routes/chat/+page.svelte:23, 78`) need updates: on logout, clear the per-endpoint map; on endpoint switch, defer to `chat.onEndpointChanged()`.

---

## 8. Phased implementation plan

**Phase A — per-endpoint history, single session per endpoint. Small (~150 LOC net).** Replace the `sessionId: string | null` field with `byEndpoint: Map<EndpointId, EndpointChatState>`. On switch, fetch the most recent session and its messages. Render. Done. No UI surface change beyond the chat page itself.

**Phase B — session picker dropdown. Medium (~250 LOC + new component).** Add `SessionPicker.svelte` and wire it into the navbar. Adds list-fetch, message-fetch on selection, and "+ New session". This is the user-visible feature; A is plumbing.

**Phase C — rename, delete, model-per-session, abort-in-flight. Medium (~200 LOC across components).** Pair with bulk admin on `/admin/endpoints`. Adds a destructive-confirm modal.

**Phase D (optional) — live updates via SSE.** Subscribe to `session.created`/`updated`/`deleted` events on the proxy event stream and reconcile the per-endpoint cache. Defer until users complain about staleness; the explicit refresh button covers v1.

Ship A and B together as one PR. C and D can land independently.

---

## 9. Open questions

1. **Should the picker show sessions across endpoints or only the active one?** Recommendation: only active. Cross-endpoint discovery belongs on `/admin/endpoints`, not in a 280px navbar dropdown. But this is the highest-impact UX decision in the doc — worth a quick gut-check.
2. **What's the session list cap before we paginate or virtualize?** Recommendation: render top 50 with a "Show all" expand, no virtualization in v1. If real users have >200 sessions on a single OpenCode the cap may need to drop and a search box may need to appear.
3. **Should switching mid-generation cancel the in-flight reply (abort) or block the switch?** Recommendation: block in v1 (safer; no risk of orphan replies), revisit once we have the abort UI built.
4. **Do we pre-fetch the message body when the picker opens, or only on pick?** Recommendation: on pick. Pre-fetching all sessions' messages on dropdown-open balloons traffic for marginal latency gain.

---

## 10. Files to touch

| File | Change |
|------|--------|
| `packages/ui/src/lib/chat/chat-state.svelte.ts` | Replace singleton shape with per-endpoint Map; add `onEndpointChanged`, `openSession`, `startNewSession`, `loadSessions`. |
| `packages/ui/src/lib/endpoints-state.svelte.ts` | Replace `chat.dropCurrentSession()` call with `chat.onEndpointChanged(id)`. |
| `packages/ui/src/lib/api.ts` | Add `listSessions()`, `getSessionMessages(id)`, `createSession()`, (Phase C) `renameSession`, `deleteSession`. Existing `createChatSession` / `sendChatMessage` stay. |
| `packages/ui/src/lib/types.ts` | Add `SessionSummary`, `EndpointChatState`. Map OpenCode `Message`+`Part` to `ChatEntry` in a new helper. |
| `packages/ui/src/lib/components/SessionPicker.svelte` (new) | The dropdown. |
| `packages/ui/src/lib/components/Navbar.svelte` | Mount `SessionPicker` next to `EndpointSwitcher`. |
| `packages/ui/src/routes/chat/+page.svelte` | Loading skeleton while `chat.entriesLoading`; remove `reconnect()`'s `dropCurrentSession`. |
| `packages/ui/src/lib/chat/chat-state.vitest.ts` (new) | Unit-test the per-endpoint Map transitions, esp. switch-then-switch-back continuity. |
| `packages/ui/e2e/session-picker.pw.ts` (new, gated `RUN_DOCKER_STACK_TESTS=1`) | Stack-level test: Local → Admin → Local restores prior session. |

No server-side changes. No `packages/lib/` changes. No guardian or assistant container changes.
