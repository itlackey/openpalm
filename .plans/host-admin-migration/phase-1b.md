# Phase 1b: Chat UI — Implementation Plan

**Goal:** Build the primary user surface — a chat page at `/chat` that is the default landing after setup, with streaming POST to two OpenCode backends (assistant and admin), voice I/O integration, thread segmentation on backend toggle, and reconnect-on-focus.

**Prerequisites:** Phase 1a complete (Bun.serve proxy server running, `/proxy/assistant` and `/proxy/admin` routes forwarding to the two OpenCode backends, session creation handled server-side or surfaced as API).

**Repo root:** `/home/founder3/code/github/itlackey/openpalm`

---

## Architectural decisions

- The chat page lives at `/chat` in the SvelteKit app. The root `/` redirects there post-auth.
- The existing `+page.svelte` (current admin dashboard at `/`) becomes `/admin/+page.svelte` — a new route.
- The chat page is inside the existing auth gate: `authLocked` redirects to `AuthGate` the same way the current `/` does.
- All OpenCode HTTP calls go through two new SvelteKit API routes (`/proxy/assistant/[...path]` and `/proxy/admin/[...path]`) rather than directly from the browser to avoid CORS and to apply the admin token transparently.
- The proxy routes reuse the existing `getOpenCodeClient()` pattern in `$lib/server/helpers.ts`.
- Session IDs are created once per page load (one per backend) and stored in `$state`. They are NOT persisted to localStorage — a page reload starts a fresh session.
- Voice integration reuses `voice-state.svelte.ts` as-is; the chat input textarea becomes the `lastFocusedInput` target for dictation injection.
- The thread segmentation divider is a record inside the `messages` array (a discriminated union item with `type: 'divider'`), inserted when the user toggles the backend selector.
- Reconnect-on-focus uses a `visibilitychange` listener in `$effect` to re-probe the selected backend's `/provider` health endpoint.

---

## ✅ Step 1: Add new types to `$lib/types.ts`

**File:** `packages/admin/src/lib/types.ts` (append after line 86)
**Change type:** modify

**Context:** `types.ts` currently ends at line 86 with `OpenCodeAuthMethod`. The chat feature needs typed message records and a proxy result type.

**Exact change** — append after the last line:

```typescript
// ── Chat Types ──────────────────────────────────────────────────────────

export type ChatBackend = 'assistant' | 'admin';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  backend: ChatBackend;
  timestamp: number;
};

export type ChatDivider = {
  id: string;
  type: 'divider';
  label: string;
  timestamp: number;
};

export type ChatEntry = ChatMessage | ChatDivider;

export type OpenCodeMessageResponse = {
  parts: Array<{ type: string; text?: string }>;
};

export type ChatSessionState = {
  sessionId: string | null;
  status: 'idle' | 'connecting' | 'ready' | 'error';
  error: string;
};
```

**AKM assistance:** none

**Validation:** `cd packages/admin && npm run check` passes with 0 errors after this change.

---

## ✅ Step 2: Add chat proxy API functions to `$lib/api.ts`

**File:** `packages/admin/src/lib/api.ts` (append after line 317, end of file)
**Change type:** modify

**Context:** `api.ts` has a consistent pattern: `async function request(...)` + typed wrapper functions. The chat proxy calls need the same `x-admin-token` header forwarded. Two operations are needed: create session and send message.

**Exact change** — append after the last line:

```typescript
// ── Chat Proxy ──────────────────────────────────────────────────────────

/**
 * Create a new OpenCode session via the SvelteKit proxy.
 * backend: 'assistant' or 'admin' selects which proxy route to use.
 */
export async function createChatSession(
  token: string,
  backend: import('./types.js').ChatBackend
): Promise<{ id: string }> {
  const res = await requireOk(
    await request('POST', `/proxy/${backend}/session`, token, {})
  );
  return (await res.json()) as { id: string };
}

/**
 * Send a message to an existing OpenCode session via the SvelteKit proxy.
 * Returns the full parsed response body.
 */
export async function sendChatMessage(
  token: string,
  backend: import('./types.js').ChatBackend,
  sessionId: string,
  text: string
): Promise<import('./types.js').OpenCodeMessageResponse> {
  const res = await requireOk(
    await request(
      'POST',
      `/proxy/${backend}/session/${encodeURIComponent(sessionId)}/message`,
      token,
      { parts: [{ type: 'text', text }] }
    )
  );
  return (await res.json()) as import('./types.js').OpenCodeMessageResponse;
}

/**
 * Probe whether a backend is reachable.
 * Uses the /provider endpoint (same as opencode/status does).
 * Returns true if the probe succeeds.
 */
export async function probeChatBackend(
  token: string,
  backend: import('./types.js').ChatBackend
): Promise<boolean> {
  try {
    const res = await fetch(`/proxy/${backend}/provider`, {
      method: 'GET',
      headers: buildHeaders(token),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

**AKM assistance:** none

**Validation:** TypeScript resolves types correctly. `npm run check` passes. The functions are not called yet at this point.

---

## ✅ Step 3: Create the SvelteKit proxy route for the assistant backend

**File:** `packages/admin/src/routes/proxy/assistant/[...path]/+server.ts` (new file)
**Change type:** create

**Context:** This is a new SvelteKit catch-all API route. The Phase 1a Bun.serve server handles external traffic; these SvelteKit routes handle traffic from the browser SPA to the two OpenCode backends (assistant at `OP_OPENCODE_URL`, admin at `OP_ADMIN_OPENCODE_URL`). They must forward the full request body and method, strip internal headers, and apply the OpenCode password header if `OPENCODE_SERVER_PASSWORD` is set.

The `[...path]` catch-all matches `/proxy/assistant/session`, `/proxy/assistant/session/:id/message`, `/proxy/assistant/provider`, etc.

**Exact change** — create the file with this content:

```typescript
/**
 * Proxy route: forward /proxy/assistant/[...path] → assistant OpenCode server.
 *
 * Auth: requires x-admin-token (same as all admin API routes).
 * Forwards the full request body and method unchanged.
 * Applies HTTP Basic auth if OPENCODE_SERVER_PASSWORD is set.
 * Timeout: 150s — OpenCode responses can take 30–120s.
 */
import { requireAdmin, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

const ASSISTANT_BASE_URL =
  process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? 'http://localhost:4096';

const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';

function buildForwardHeaders(incomingContentType: string | null): HeadersInit {
  const headers: HeadersInit = {};
  if (incomingContentType) {
    headers['content-type'] = incomingContentType;
  }
  if (OPENCODE_PASSWORD) {
    headers['authorization'] = `Basic ${btoa(`:${OPENCODE_PASSWORD}`)}`;
  }
  return headers;
}

const handler: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { path } = event.params;
  const targetUrl = `${ASSISTANT_BASE_URL}/${path}${event.url.search}`;

  const method = event.request.method;
  const contentType = event.request.headers.get('content-type');
  const body = method !== 'GET' && method !== 'HEAD' ? await event.request.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(contentType),
      body,
      signal: AbortSignal.timeout(150_000),
    });

    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (e) {
    console.warn('[proxy/assistant] Upstream request failed:', e);
    return new Response(
      JSON.stringify({ error: 'proxy_error', message: 'Assistant OpenCode is not reachable' }),
      {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      }
    );
  }
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

**AKM assistance:** none

**Validation:**
1. `npm run check` passes (types resolve for `event.params.path`).
2. With the dev stack running: `curl -X POST http://localhost:8100/proxy/assistant/session -H "x-admin-token: dev-admin-token" -H "content-type: application/json" -d '{}'` returns `{ id: "..." }`.

---

## ✅ Step 4: Create the SvelteKit proxy route for the admin OpenCode backend

**File:** `packages/admin/src/routes/proxy/admin/[...path]/+server.ts` (new file)
**Change type:** create

**Context:** Identical structure to Step 3 but targets the admin OpenCode instance. The admin OpenCode URL is separate from the assistant URL (`OP_ADMIN_OPENCODE_URL`, defaulting to `http://localhost:4096` within the container — but the port mapping differs on the host). The admin proxy must also require the admin token.

**Exact change** — create the file with this content:

```typescript
/**
 * Proxy route: forward /proxy/admin/[...path] → admin OpenCode server.
 *
 * Auth: requires x-admin-token.
 * The admin OpenCode server listens at OP_ADMIN_OPENCODE_URL (internal).
 * Timeout: 150s.
 */
import { requireAdmin, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

// Admin OpenCode runs on a separate container/port from the assistant.
// OP_ADMIN_OPENCODE_INTERNAL_URL is the container-internal URL (defaults to
// the same port as assistant if the admin has its own OpenCode sidecar).
const ADMIN_OPENCODE_BASE_URL =
  process.env.OP_ADMIN_OPENCODE_INTERNAL_URL ?? 'http://localhost:4096';

const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? '';

function buildForwardHeaders(incomingContentType: string | null): HeadersInit {
  const headers: HeadersInit = {};
  if (incomingContentType) {
    headers['content-type'] = incomingContentType;
  }
  if (OPENCODE_PASSWORD) {
    headers['authorization'] = `Basic ${btoa(`:${OPENCODE_PASSWORD}`)}`;
  }
  return headers;
}

const handler: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const { path } = event.params;
  const targetUrl = `${ADMIN_OPENCODE_BASE_URL}/${path}${event.url.search}`;

  const method = event.request.method;
  const contentType = event.request.headers.get('content-type');
  const body = method !== 'GET' && method !== 'HEAD' ? await event.request.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: buildForwardHeaders(contentType),
      body,
      signal: AbortSignal.timeout(150_000),
    });

    const responseBody = await upstream.arrayBuffer();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (e) {
    console.warn('[proxy/admin] Upstream request failed:', e);
    return new Response(
      JSON.stringify({ error: 'proxy_error', message: 'Admin OpenCode is not reachable' }),
      {
        status: 503,
        headers: { 'content-type': 'application/json', 'x-request-id': requestId },
      }
    );
  }
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

**Note on `OP_ADMIN_OPENCODE_INTERNAL_URL`:** In the compose stack the admin OpenCode sidecar is a separate container. Add `OP_ADMIN_OPENCODE_INTERNAL_URL=http://admin-opencode:4096` to `stack.env` or `compose.dev.yml` for the admin service. This is an env var addition, not a code change.

**AKM assistance:** none

**Validation:** `npm run check` passes. With the dev stack running: `curl -X POST http://localhost:8100/proxy/admin/session -H "x-admin-token: dev-admin-token" -H "content-type: application/json" -d '{}'` returns `{ id: "..." }`.

---

## ✅ Step 5: Move existing admin dashboard to `/admin` route

**File:** `packages/admin/src/routes/admin/+page.svelte` (new file — move content from `+page.svelte`)
**Change type:** create

**Context:** The current `+page.svelte` at `src/routes/+page.svelte` (lines 1–567) is the entire admin dashboard. It needs to become the `/admin` page so the root `/` can redirect to `/chat`. The file is moved verbatim — zero logic changes.

**Exact change:**
1. Copy the full content of `packages/admin/src/routes/+page.svelte` into `packages/admin/src/routes/admin/+page.svelte`. Do not alter any code.
2. Replace the content of `packages/admin/src/routes/+page.svelte` with a redirect:

```svelte
<script lang="ts">
  import { redirect } from '@sveltejs/kit';
</script>

<script context="module" lang="ts">
  export function load() {
    redirect(302, '/chat');
  }
</script>
```

Wait — SvelteKit redirects from a page component require a `+page.ts` load function, not a script block. Instead:

**Correct approach for step 5b** — replace `packages/admin/src/routes/+page.svelte` with a minimal passthrough that immediately navigates:

Create `packages/admin/src/routes/+page.ts`:
```typescript
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/chat');
};
```

Then replace `packages/admin/src/routes/+page.svelte` with an empty placeholder (SvelteKit requires the file to exist if there is a `+page.ts`):
```svelte
<!-- redirected by +page.ts load function -->
```

**AKM assistance:** none

**Validation:** Navigating to `http://localhost:5173/` in the browser redirects to `/chat`. The admin dashboard is accessible at `http://localhost:5173/admin`.

---

## ✅ Step 6: Create the `ChatMessage` display component

**File:** `packages/admin/src/lib/components/ChatMessage.svelte` (new file)
**Change type:** create

**Context:** A pure display component. Renders a single `ChatEntry` (either a message bubble or a thread-segmentation divider). No state, no side effects. Props-only.

**Exact change** — create the file:

```svelte
<script lang="ts">
  import type { ChatEntry } from '$lib/types.js';

  interface Props {
    entry: ChatEntry;
  }

  let { entry }: Props = $props();
</script>

{#if entry.type === 'divider'}
  <div class="thread-divider" aria-label={entry.label}>
    <span class="divider-line"></span>
    <span class="divider-label">{entry.label}</span>
    <span class="divider-line"></span>
  </div>
{:else}
  <div
    class="message"
    class:message-user={entry.role === 'user'}
    class:message-assistant={entry.role === 'assistant'}
    data-backend={entry.backend}
  >
    <div class="message-bubble">
      <p class="message-text">{entry.text}</p>
    </div>
    <span class="message-meta">
      {entry.role === 'user' ? 'You' : entry.backend === 'admin' ? 'Admin' : 'Assistant'}
      · {new Date(entry.timestamp).toLocaleTimeString()}
    </span>
  </div>
{/if}

<style>
  .thread-divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) 0;
    color: var(--color-text-tertiary);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .divider-label {
    flex-shrink: 0;
    padding: 0 var(--space-2);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
  }

  .message {
    display: flex;
    flex-direction: column;
    max-width: 80%;
  }

  .message-user {
    align-self: flex-end;
    align-items: flex-end;
  }

  .message-assistant {
    align-self: flex-start;
    align-items: flex-start;
  }

  .message-bubble {
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    line-height: var(--leading-normal);
  }

  .message-user .message-bubble {
    background: var(--color-primary);
    color: #000;
    border-bottom-right-radius: var(--radius-sm);
  }

  .message-assistant .message-bubble {
    background: var(--color-bg-tertiary);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-bottom-left-radius: var(--radius-sm);
  }

  /* Admin backend gets a subtle blue tint on the bubble */
  .message-assistant[data-backend='admin'] .message-bubble {
    background: var(--color-info-bg);
    border-color: rgba(51, 154, 240, 0.2);
  }

  .message-text {
    font-size: var(--text-base);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message-meta {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-tertiary);
  }
</style>
```

**AKM assistance:** none

**Validation:** `npm run check` passes — no TypeScript errors. The component is not yet rendered anywhere at this point.

---

## ✅ Step 7: Create the `ChatInput` component

**File:** `packages/admin/src/lib/components/ChatInput.svelte` (new file)
**Change type:** create

**Context:** Encapsulates the text input row: textarea (grows with content), send button, backend selector toggle, and voice mic button. The textarea must have `id="chat-input"` so `VoiceControl`'s `lastFocusedInput` tracking picks it up by DOM focus. Props are all callbacks — no internal async logic.

**Exact change** — create the file:

```svelte
<script lang="ts">
  import type { ChatBackend } from '$lib/types.js';

  interface Props {
    backend: ChatBackend;
    sending: boolean;
    onSend: (text: string) => void;
    onBackendChange: (b: ChatBackend) => void;
  }

  let { backend, sending, onSend, onBackendChange }: Props = $props();

  let inputText = $state('');
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit(): void {
    const text = inputText.trim();
    if (!text || sending) return;
    onSend(text);
    inputText = '';
    // Reset textarea height after clearing
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }
  }

  function handleInput(): void {
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  }
</script>

<div class="chat-input-row">
  <div class="backend-toggle" role="group" aria-label="Select assistant backend">
    <button
      class="backend-btn"
      class:backend-btn-active={backend === 'assistant'}
      type="button"
      onclick={() => onBackendChange('assistant')}
      aria-pressed={backend === 'assistant'}
    >
      Assistant
    </button>
    <button
      class="backend-btn"
      class:backend-btn-active={backend === 'admin'}
      type="button"
      onclick={() => onBackendChange('admin')}
      aria-pressed={backend === 'admin'}
    >
      Admin
    </button>
  </div>

  <div class="input-area">
    <textarea
      id="chat-input"
      bind:this={textareaEl}
      bind:value={inputText}
      onkeydown={handleKeydown}
      oninput={handleInput}
      placeholder="Send a message… (Enter to send, Shift+Enter for newline)"
      rows="1"
      disabled={sending}
      aria-label="Message input"
    ></textarea>
    <button
      class="send-btn"
      type="button"
      disabled={sending || !inputText.trim()}
      onclick={submit}
      aria-label="Send message"
    >
      {#if sending}
        <span class="spinner" aria-hidden="true"></span>
      {:else}
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      {/if}
    </button>
  </div>
</div>

<style>
  .chat-input-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .backend-toggle {
    display: flex;
    gap: var(--space-1);
    align-self: flex-start;
  }

  .backend-btn {
    padding: 3px 10px;
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .backend-btn:hover {
    border-color: var(--color-border-hover);
    color: var(--color-text);
  }

  .backend-btn-active {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #000;
    font-weight: var(--font-semibold);
  }

  .input-area {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }

  textarea {
    flex: 1;
    min-height: 40px;
    max-height: 160px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    resize: none;
    overflow-y: auto;
    transition: border-color var(--transition-fast);
  }

  textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
  }

  textarea:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    flex-shrink: 0;
    background: var(--color-primary);
    border: none;
    border-radius: var(--radius-md);
    color: #000;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .send-btn:hover:not(:disabled) {
    background: var(--color-primary-hover);
  }

  .send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
```

**AKM assistance:** none

**Validation:** `npm run check` passes.

---

## ✅ Step 8: Create the chat page route

**File:** `packages/admin/src/routes/chat/+page.svelte` (new file)
**Change type:** create

**Context:** This is the primary new page. It owns all chat state: message history, session IDs (one per backend), sending flag, and error state. It composes `ChatMessage`, `ChatInput`, `Navbar`, `AuthGate`, and `VoiceControl`. Voice TTS is triggered after each assistant response.

The page does NOT use a `+page.ts` load function — all data loading is client-side because session creation requires the admin token from localStorage (same pattern as the existing admin dashboard).

**Session lifecycle:** On mount (inside `$effect`), the page creates a session for the currently selected backend by calling `POST /proxy/{backend}/session`. It stores the session ID in `$state`. On backend toggle, a new session is created for the new backend if one doesn't exist yet, and a divider entry is pushed to the message history.

**Reconnect on focus:** A `visibilitychange` listener (inside `$effect`) re-probes the selected backend when the tab becomes visible again. If the probe fails and there was a prior session, the error state is set with a "Reconnect" button that calls `reconnect()` — which creates a new session and clears the error.

**Exact change** — create `packages/admin/src/routes/chat/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Navbar from '$lib/components/Navbar.svelte';
  import AuthGate from '$lib/components/AuthGate.svelte';
  import ChatMessage from '$lib/components/ChatMessage.svelte';
  import ChatInput from '$lib/components/ChatInput.svelte';
  import {
    voiceState,
    initVoice,
    destroyVoice,
    speakText,
    stopSpeaking,
  } from '$lib/voice/voice-state.svelte.js';
  import { getAdminToken, clearToken, storeToken, validateToken } from '$lib/auth.js';
  import {
    createChatSession,
    sendChatMessage,
    probeChatBackend,
  } from '$lib/api.js';
  import type { ChatBackend, ChatEntry, ChatMessage as ChatMessageType, ChatDivider } from '$lib/types.js';

  // ── Auth state ───────────────────────────────────────────────────────
  let authLocked = $state(true);
  let authLoading = $state(false);
  let authError = $state('');

  // ── Chat state ───────────────────────────────────────────────────────
  let backend = $state<ChatBackend>('assistant');
  let entries = $state<ChatEntry[]>([]);
  let sending = $state(false);
  let chatError = $state('');

  // ── Session state ────────────────────────────────────────────────────
  // Separate session ID per backend. null = not yet created.
  let assistantSessionId = $state<string | null>(null);
  let adminSessionId = $state<string | null>(null);
  let sessionInitializing = $state(false);

  // ── Scroll anchor ────────────────────────────────────────────────────
  let scrollAnchorEl = $state<HTMLDivElement | undefined>();

  // ── Derived ─────────────────────────────────────────────────────────
  let currentSessionId = $derived(
    backend === 'assistant' ? assistantSessionId : adminSessionId
  );

  // ── Helpers ──────────────────────────────────────────────────────────

  function setSessionId(b: ChatBackend, id: string): void {
    if (b === 'assistant') {
      assistantSessionId = id;
    } else {
      adminSessionId = id;
    }
  }

  async function ensureSession(b: ChatBackend): Promise<string | null> {
    const token = getAdminToken();
    if (!token) return null;
    const existing = b === 'assistant' ? assistantSessionId : adminSessionId;
    if (existing) return existing;

    sessionInitializing = true;
    try {
      const { id } = await createChatSession(token, b);
      setSessionId(b, id);
      return id;
    } catch (e) {
      const err = e as { message?: string };
      chatError = `Failed to start session with ${b}: ${err.message ?? 'unknown error'}`;
      return null;
    } finally {
      sessionInitializing = false;
    }
  }

  async function reconnect(): Promise<void> {
    chatError = '';
    // Clear session for current backend so ensureSession creates a new one
    setSessionId(backend, null as unknown as string);
    if (backend === 'assistant') assistantSessionId = null;
    else adminSessionId = null;
    await ensureSession(backend);
  }

  async function handleSend(text: string): Promise<void> {
    if (sending) return;
    const token = getAdminToken();
    if (!token) return;

    const sessionId = await ensureSession(backend);
    if (!sessionId) return;

    // Optimistically add user message
    const userEntry: ChatMessageType = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      backend,
      timestamp: Date.now(),
    };
    entries = [...entries, userEntry];
    chatError = '';
    sending = true;
    scrollToBottom();

    try {
      const response = await sendChatMessage(token, backend, sessionId, text);

      // Extract text from parts array
      const replyText = response.parts
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text ?? '')
        .join('');

      const assistantEntry: ChatMessageType = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: replyText || '(no response)',
        backend,
        timestamp: Date.now(),
      };
      entries = [...entries, assistantEntry];

      // TTS: speak if voice is supported and not already speaking
      if (voiceState.ttsSupported && replyText) {
        speakText(replyText);
      }
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 503 || err.status === 502) {
        chatError = `${backend === 'admin' ? 'Admin' : 'Assistant'} is not reachable. Try reconnecting.`;
        // Invalidate session — it may have died
        if (backend === 'assistant') assistantSessionId = null;
        else adminSessionId = null;
      } else {
        chatError = err.message ?? 'Message failed.';
      }
    } finally {
      sending = false;
      scrollToBottom();
    }
  }

  function handleBackendChange(newBackend: ChatBackend): void {
    if (newBackend === backend) return;

    // Insert a divider marking the context switch
    const divider: ChatDivider = {
      id: crypto.randomUUID(),
      type: 'divider',
      label: `Switched to ${newBackend === 'admin' ? 'Admin' : 'Assistant'}`,
      timestamp: Date.now(),
    };
    entries = [...entries, divider];
    backend = newBackend;

    // Pre-create session for the new backend if not already done
    void ensureSession(newBackend);
    scrollToBottom();
  }

  function scrollToBottom(): void {
    // Use microtask to allow DOM update first
    queueMicrotask(() => {
      scrollAnchorEl?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // ── Auth handlers ─────────────────────────────────────────────────────

  async function handleAuthSuccess(token: string): Promise<boolean> {
    if (authLoading) return false;
    authLoading = true;
    authError = '';
    try {
      const result = await validateToken(token);
      if (!result.allowed) {
        clearToken();
        authLocked = true;
        authError = 'Invalid admin token.';
        return false;
      }
      storeToken(token);
      authLocked = false;
      authError = '';
      // Start the initial session immediately on auth
      await ensureSession(backend);
      return true;
    } catch {
      authError = 'Unable to reach admin API.';
      return false;
    } finally {
      authLoading = false;
    }
  }

  function handleLogout(): void {
    stopSpeaking();
    clearToken();
    authLocked = true;
    authError = '';
    entries = [];
    chatError = '';
    assistantSessionId = null;
    adminSessionId = null;
    backend = 'assistant';
  }

  // ── Visibility-change reconnect ───────────────────────────────────────
  // When the tab regains focus, probe the current backend.
  // If unreachable AND there is no valid session, set an error.

  $effect(() => {
    let destroyed = false;

    function handleVisibilityChange(): void {
      if (destroyed || document.visibilityState !== 'visible') return;
      if (authLocked) return;
      const token = getAdminToken();
      if (!token) return;
      void (async () => {
        const reachable = await probeChatBackend(token, backend);
        if (!reachable && !destroyed) {
          chatError = `${backend === 'admin' ? 'Admin' : 'Assistant'} is not reachable. Try reconnecting.`;
          // Clear stale session
          if (backend === 'assistant') assistantSessionId = null;
          else adminSessionId = null;
        }
      })();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      destroyed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  // ── Mount ─────────────────────────────────────────────────────────────

  onMount(() => {
    initVoice();
    void (async () => {
      const token = getAdminToken();
      if (!token) {
        authLocked = true;
        return;
      }
      authLoading = true;
      try {
        const result = await validateToken(token);
        if (!result.allowed) {
          clearToken();
          authLocked = true;
          authError = 'Invalid admin token.';
          return;
        }
        authLocked = false;
        await ensureSession(backend);
      } catch {
        authLocked = true;
        authError = 'Unable to reach admin API.';
      } finally {
        authLoading = false;
      }
    })();
  });

  onDestroy(() => {
    destroyVoice();
  });
</script>

<svelte:head>
  <title>Chat — OpenPalm</title>
</svelte:head>

{#if authLocked}
  <AuthGate onSuccess={handleAuthSuccess} loading={authLoading} error={authError} />
{:else}
  <Navbar onLogout={handleLogout} adminLink="/admin" />

  <div class="chat-layout">
    <!-- Message history -->
    <section class="messages-area" aria-label="Chat history" aria-live="polite">
      {#if entries.length === 0 && !sessionInitializing}
        <div class="empty-state">
          <p>Start a conversation with your {backend === 'admin' ? 'Admin' : 'Assistant'}.</p>
        </div>
      {/if}

      {#if sessionInitializing}
        <div class="session-loading" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>Connecting to {backend === 'admin' ? 'Admin' : 'Assistant'}…</span>
        </div>
      {/if}

      {#each entries as entry (entry.id)}
        <ChatMessage {entry} />
      {/each}

      <div bind:this={scrollAnchorEl} aria-hidden="true"></div>
    </section>

    <!-- Error / reconnect banner -->
    {#if chatError}
      <div class="chat-error-banner" role="alert">
        <span>{chatError}</span>
        <button class="reconnect-btn" type="button" onclick={reconnect}>
          Reconnect
        </button>
        <button
          class="dismiss-btn"
          type="button"
          aria-label="Dismiss error"
          onclick={() => { chatError = ''; }}
        >
          &times;
        </button>
      </div>
    {/if}

    <!-- Input area — always at the bottom -->
    <ChatInput
      {backend}
      {sending}
      onSend={handleSend}
      onBackendChange={handleBackendChange}
    />
  </div>
{/if}

<style>
  .chat-layout {
    display: flex;
    flex-direction: column;
    height: calc(100dvh - var(--nav-height));
    max-width: var(--max-width);
    margin: 0 auto;
  }

  .messages-area {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-6);
    scroll-behavior: smooth;
  }

  .empty-state {
    margin: auto;
    text-align: center;
    color: var(--color-text-secondary);
    font-size: var(--text-base);
    padding: var(--space-8);
  }

  .session-loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-text-secondary);
    font-size: var(--text-sm);
    padding: var(--space-4);
    margin: auto;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }

  .chat-error-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-danger-bg);
    border-top: 1px solid rgba(250, 82, 82, 0.25);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .chat-error-banner span:first-child {
    flex: 1;
  }

  .reconnect-btn {
    padding: 3px 10px;
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--color-danger);
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--transition-fast);
  }

  .reconnect-btn:hover {
    background: var(--color-danger);
    color: #fff;
  }

  .dismiss-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--color-danger);
    cursor: pointer;
    font-size: var(--text-lg);
    line-height: 1;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .dismiss-btn:hover {
    background: rgba(250, 82, 82, 0.15);
  }

  @media (max-width: 768px) {
    .messages-area {
      padding: var(--space-3) var(--space-4);
    }
  }
</style>
```

**AKM assistance:** none

**Validation:**
1. `npm run check` passes.
2. Navigate to `http://localhost:5173/chat` — auth gate appears if no token is stored.
3. After auth, the empty state message is visible.
4. The backend toggle shows "Assistant" and "Admin" buttons.

---

## ✅ Step 9: Update `Navbar.svelte` to add the Admin link

**File:** `packages/admin/src/lib/components/Navbar.svelte` (lines 1–147)
**Change type:** modify

**Context:** The Navbar currently takes only `onLogout`. The chat page passes `adminLink="/admin"` to it (Step 8, line in template). The Navbar needs to accept an optional `adminLink` prop and render an anchor when it is provided.

**Exact changes:**

1. Lines 3–9 (Props interface + destructure) — add optional `adminLink`:

```svelte
  interface Props {
    onLogout: () => void;
    adminLink?: string;
  }

  let { onLogout, adminLink }: Props = $props();
```

2. Lines 21–24 (navbar-actions div) — add the Admin link before VoiceControl:

```svelte
    <div class="navbar-actions">
      {#if adminLink}
        <a href={adminLink} class="btn btn-secondary btn-sm">Admin</a>
      {/if}
      <VoiceControl />
      <button class="btn btn-secondary btn-sm" type="button" onclick={onLogout}>Sign Out</button>
    </div>
```

**No style changes needed** — `.btn`, `.btn-secondary`, `.btn-sm` already exist in Navbar.svelte (lines 89–125).

**AKM assistance:** none

**Validation:** `npm run check` passes. The Admin button appears in the navbar on the chat page and does not appear on the admin dashboard page (because `adminLink` is not passed there).

---

## ✅ Step 10: Add a "Chat" link to the admin dashboard Navbar call

**File:** `packages/admin/src/routes/admin/+page.svelte` (the file created in Step 5)
**Change type:** modify

**Context:** After Step 5, the admin dashboard is at `/admin/+page.svelte`. Its Navbar call (copied verbatim from the original `+page.svelte`) passes only `onLogout`. We need to add a link back to `/chat`.

**Exact change** — locate the Navbar usage in the template section (around the equivalent of original line 472):

```svelte
  <Navbar onLogout={handleLogout} adminLink="/chat" />
```

Wait — the Navbar prop is called `adminLink` but here we're linking to Chat. Rename the prop in Step 9 to be more general:

**Correction to Step 9:** rename `adminLink` to `navLink` with a label prop:

```typescript
interface Props {
  onLogout: () => void;
  navLink?: { href: string; label: string };
}
let { onLogout, navLink }: Props = $props();
```

Template in Navbar:
```svelte
{#if navLink}
  <a href={navLink.href} class="btn btn-secondary btn-sm">{navLink.label}</a>
{/if}
```

Then Step 8's chat page passes: `<Navbar onLogout={handleLogout} navLink={{ href: '/admin', label: 'Admin' }} />`

And Step 10 in admin page passes: `<Navbar onLogout={handleLogout} navLink={{ href: '/chat', label: 'Chat' }} />`

**AKM assistance:** none

**Validation:** Both pages show the correct nav link. `npm run check` passes.

---

## ✅ Step 11: Wire `sendChatMessage` timeout to 150s in `api.ts`

**File:** `packages/admin/src/lib/api.ts` (the `request` helper, lines 19–34)
**Change type:** modify

**Context:** The base `request()` function uses the default `fetch` timeout (no explicit timeout — browser default is no timeout but the connection may be dropped). OpenCode responses can take 120s. The `sendChatMessage` function added in Step 2 needs an explicit timeout. The base `request()` does not accept a signal, so `sendChatMessage` should call `fetch` directly instead of using `request()`.

**Exact change** — replace the `sendChatMessage` function from Step 2 with a direct `fetch` call:

```typescript
export async function sendChatMessage(
  token: string,
  backend: import('./types.js').ChatBackend,
  sessionId: string,
  text: string
): Promise<import('./types.js').OpenCodeMessageResponse> {
  const res = await fetch(
    `/proxy/${backend}/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...buildHeaders(token),
      },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(150_000),
    }
  );
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid admin token.'), { status: 401 });
  }
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()) as import('./types.js').OpenCodeMessageResponse;
}
```

**Note:** `readErrorMessage` is defined at lines 36–54 of `api.ts` and is not exported. It is accessible from within the same file. The `sendChatMessage` in Step 2's code sketch (which used `requireOk`) is replaced by this version.

**AKM assistance:** none

**Validation:** A 150s timeout is applied to the fetch. `npm run check` passes.

---

## ✅ Step 12: Create the `+page.ts` redirect for the root route

**File:** `packages/admin/src/routes/+page.ts` (new file)
**Change type:** create

**Context:** Step 5 described creating this file. This step provides the exact content. SvelteKit `load` functions that call `redirect()` must use the `@sveltejs/kit` import.

**Exact change** — create `packages/admin/src/routes/+page.ts`:

```typescript
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(302, '/chat');
};
```

And replace `packages/admin/src/routes/+page.svelte` with:

```svelte
<!-- Root route: redirected to /chat by +page.ts load function -->
```

**AKM assistance:** none

**Validation:** `GET /` returns `302 → /chat`. Existing Playwright tests that navigate to `/` will need their `goto('/')` calls updated to `goto('/admin')` if they test the dashboard directly (see Step 15).

---

## ✅ Step 13: Add `OP_ADMIN_OPENCODE_INTERNAL_URL` to `compose.dev.yml`

**File:** `compose.dev.yml` (repo root)
**Change type:** modify

**Context:** The admin proxy route for the admin OpenCode backend reads `process.env.OP_ADMIN_OPENCODE_INTERNAL_URL`. In the dev stack the admin service does not have a separate OpenCode sidecar by default — this needs to be configured so the proxy doesn't silently fall back to `localhost:4096` (which is the assistant's port inside its own container, not accessible from the admin container). In dev, the admin OpenCode URL from the host perspective is `http://localhost:3881` (external) but from within the admin container it's `http://admin-opencode:4096` (if a separate service exists) or simply not configured. Add the env var as empty-or-correct for dev.

**Exact change** — locate the `admin` service environment block in `compose.dev.yml` and add:

```yaml
      - OP_ADMIN_OPENCODE_INTERNAL_URL=${OP_ADMIN_OPENCODE_INTERNAL_URL:-http://localhost:4096}
```

This defaults to `localhost:4096` within the admin container, which is incorrect in prod (where the assistant is a separate container), but is acceptable for dev if the admin OpenCode runs as a sibling process or is proxied. The correct prod value is set in `stack.env` when the admin OpenCode addon is enabled.

**AKM assistance:** none

**Validation:** `docker compose config` shows the variable for the admin service.

---

## ✅ Step 14: Add `VoiceControl` import to chat layout for singleton mount

**File:** `packages/admin/src/routes/chat/+page.svelte` (Step 8)
**Change type:** clarification (no additional file change needed)

**Context:** `VoiceControl.svelte` calls `initVoice()` and sets up the `focusin` listener on `document` in `onMount`. In the existing app it is rendered inside `Navbar`. The chat page imports `voice-state.svelte.ts` functions directly (`initVoice`, `destroyVoice`, `speakText`, `stopSpeaking`) and calls them directly — it does NOT render `<VoiceControl />`. This means the mic button in the Navbar will not appear on the chat page.

**Decision:** Render `VoiceControl` in `Navbar.svelte` on the chat page as well. Since `Navbar` already contains `<VoiceControl />` (line 22 of Navbar.svelte), and the chat page renders Navbar, `VoiceControl` is already mounted. The `focusin` listener in `VoiceControl` will track the chat textarea's focus automatically.

**No code change is needed here** — the design in Step 8 correctly calls `initVoice()` in `onMount` for TTS setup, and the Navbar's `VoiceControl` handles the mic button and the `focusin` listener for the textarea.

**Remove** the `initVoice` and `destroyVoice` calls from the chat page's `onMount`/`onDestroy` — those are handled by `VoiceControl`. Keep only the `speakText` and `stopSpeaking` imports for the TTS-on-response behavior.

**Exact correction to Step 8:** In `packages/admin/src/routes/chat/+page.svelte`:

Remove from imports:
```typescript
  import {
    voiceState,
    initVoice,
    destroyVoice,
    speakText,
    stopSpeaking,
  } from '$lib/voice/voice-state.svelte.js';
```

Replace with:
```typescript
  import { voiceState, speakText, stopSpeaking } from '$lib/voice/voice-state.svelte.js';
```

Remove `onDestroy` import from svelte (only needed if not already used for cleanup).

Remove from `onMount`:
```typescript
    initVoice();
```

Remove from `onDestroy`:
```typescript
    destroyVoice();
```

Keep `onMount` and `onDestroy` if other cleanup is needed; remove them entirely if the only content was `initVoice`/`destroyVoice`.

**AKM assistance:** none

**Validation:** The mic button appears in the Navbar on the chat page. Clicking it while the chat textarea is focused injects dictated text into the textarea input binding.

---

## ✅ Step 15: Update Playwright e2e tests that navigate to `/`

**File:** `packages/admin/e2e/` — any test that calls `page.goto('/')` and expects the admin dashboard
**Change type:** modify

**Context:** After Step 12, `GET /` redirects to `/chat`. Existing e2e tests that test the admin dashboard by going to `/` will instead land on the chat page. Find all affected tests and update the `goto` target.

**Exact change** — run:

```bash
grep -r "goto('/')" packages/admin/e2e/
grep -r 'goto("/")' packages/admin/e2e/
```

For each match where the intent is the admin dashboard: change `goto('/')` to `goto('/admin')`.

Do not change tests that are intentionally testing the redirect behavior (if any).

**AKM assistance:** none

**Validation:** `bun run admin:test:e2e:mocked` passes. If any tests verify the auth gate at `/`, they should now instead verify it at `/admin` or `/chat` as appropriate.

---

## ✅ Step 16: Type-check and build verification

**File:** none — verification step
**Change type:** none

**Exact commands to run in order:**

```bash
cd packages/admin && npm run check
# Expected: 0 errors

cd packages/admin && npm run build
# Expected: 0 errors, some a11y warnings acceptable

bun run admin:test:unit
# Expected: all existing tests pass
```

**Specific things to verify during `npm run check`:**
- `$types` for the new `[...path]` catch-all routes resolve correctly. SvelteKit generates types for `event.params.path` as `string` for `[...path]` segments.
- `import type { PageLoad }` in `+page.ts` resolves.
- `ChatEntry` discriminated union is correctly narrowed in `ChatMessage.svelte` (`entry.type === 'divider'`).
- `navLink` prop is optional and does not cause type errors in existing admin dashboard page call.

**AKM assistance:** none

---

## ✅ Step 17: Manual smoke test checklist

**File:** none — manual verification
**Change type:** none

Perform each item in order with the dev stack running (`bun run dev:stack` or `bun run dev:build`):

1. `GET http://localhost:5173/` → redirects to `/chat`.
2. Auth gate appears at `/chat` when no token is stored.
3. Enter `dev-admin-token` → auth succeeds, empty chat state appears.
4. "Connecting to Assistant…" spinner appears briefly, then disappears.
5. Type a message and press Enter → user bubble appears, spinner shows in send button.
6. After ~5–120s → assistant bubble appears with response text.
7. If voice is supported (Chrome/Edge), the response text is read aloud.
8. Click "Admin" toggle → divider appears: "Switched to Admin".
9. Type a message to Admin → user + admin bubble appear.
10. Navigate to `/admin` via the Admin nav link → admin dashboard loads correctly with all tabs.
11. Admin dashboard shows "Chat" nav link → navigates back to `/chat`.
12. Close and reopen the tab → token is still in localStorage, chat page loads without re-auth.
13. Stop the assistant container (`docker compose stop assistant`) → send a message → error banner appears with "Reconnect" button.
14. Restart assistant → click Reconnect → new session created, chat resumes.
15. Switch to a tab with the page, then switch back → `visibilitychange` probe runs, no spurious errors if backend is up.

---

## Summary of files created/modified

| File | Action |
|------|--------|
| `packages/admin/src/lib/types.ts` | Modified — add `ChatBackend`, `ChatMessage`, `ChatDivider`, `ChatEntry`, `OpenCodeMessageResponse`, `ChatSessionState` |
| `packages/admin/src/lib/api.ts` | Modified — add `createChatSession`, `sendChatMessage`, `probeChatBackend` |
| `packages/admin/src/routes/proxy/assistant/[...path]/+server.ts` | Created — SvelteKit catch-all proxy to assistant OpenCode |
| `packages/admin/src/routes/proxy/admin/[...path]/+server.ts` | Created — SvelteKit catch-all proxy to admin OpenCode |
| `packages/admin/src/routes/+page.ts` | Created — redirect `GET /` → `/chat` |
| `packages/admin/src/routes/+page.svelte` | Modified — empty placeholder (redirected by `+page.ts`) |
| `packages/admin/src/routes/admin/+page.svelte` | Created — verbatim copy of original `+page.svelte` (existing dashboard) |
| `packages/admin/src/routes/chat/+page.svelte` | Created — primary chat UI page |
| `packages/admin/src/lib/components/ChatMessage.svelte` | Created — message/divider display component |
| `packages/admin/src/lib/components/ChatInput.svelte` | Created — input row with backend toggle |
| `packages/admin/src/lib/components/Navbar.svelte` | Modified — add optional `navLink` prop |
| `compose.dev.yml` | Modified — add `OP_ADMIN_OPENCODE_INTERNAL_URL` to admin service |
| `packages/admin/e2e/**` | Modified — update `goto('/')` → `goto('/admin')` in admin dashboard tests |

## Environment variables required

| Variable | Default | Purpose |
|----------|---------|---------|
| `OP_OPENCODE_URL` or `OP_ASSISTANT_URL` | `http://localhost:4096` | Assistant OpenCode internal URL (already used by existing routes) |
| `OP_ADMIN_OPENCODE_INTERNAL_URL` | `http://localhost:4096` | Admin OpenCode internal URL (new — for `/proxy/admin/` route) |
| `OPENCODE_SERVER_PASSWORD` | (empty) | HTTP Basic password for OpenCode, applied to both proxy routes |

## Complexity flags

The following items were considered and deliberately kept simple or deferred:

- **Message persistence across page reload:** Not implemented. Sessions are in-memory only. Justification: OpenCode sessions are server-side; there is no client-side replay mechanism. A future phase can add localStorage persistence of the display text only.
- **Streaming SSE:** Not implemented. The brief states "plain HTTP POST — NOT SSE". The 150s timeout on `sendChatMessage` is the correct mechanism.
- **Markdown rendering in message bubbles:** Not implemented — `white-space: pre-wrap` handles code/newlines adequately. A future phase can add a markdown renderer.
- **Multiple concurrent sessions per backend:** Not implemented — one session per backend per page load. A future phase can add session history/switching.
- **Admin OpenCode proxy authentication:** The same `OPENCODE_SERVER_PASSWORD` env var is used for both backends. If they require different passwords, two separate env vars would be needed (`OPENCODE_SERVER_PASSWORD` and `ADMIN_OPENCODE_SERVER_PASSWORD`). Flagged as future work if the two backends are independently deployed.
