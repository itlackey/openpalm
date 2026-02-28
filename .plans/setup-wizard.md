# Admin Setup Wizard — Implementation Specification

This document describes the admin-side changes required for the async container
download feature. The CLI (`scripts/setup.sh`) now starts **only the admin
container** and opens the browser to `/setup`. The admin UI is responsible for
collecting LLM provider configuration and triggering the full-stack install.

## Integration with `setup.sh`

The setup script flow is:

1. Pull only the admin Docker image (background, ~20-30s)
2. Prompt for admin token (single prompt, ~5s)
3. Write a minimal `secrets.env` with just `ADMIN_TOKEN` + paths/UIDs
4. Start only admin: `POSTGRES_PASSWORD=_pending docker compose up -d admin`
5. Wait for admin to become healthy on `:8100`
6. **Fresh install** → open `http://localhost:8100/setup`
7. **Update** (secrets.env already existed) → open `http://localhost:8100/`

The admin UI must serve a `/setup` page that guides the user through LLM
provider configuration and then triggers the full-stack install.

---

## Required Changes

### 1. `admin/vite.config.ts` — Load `.env` from repo root

The admin's Vite config needs to load environment variables from the repository
root so server-side code has access to values from `secrets.env` and `.env`.

**Current:**
```typescript
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      "$assets": resolve(__dirname, "../assets"),
      "$registry": resolve(__dirname, "../registry")
    }
  }
});
```

**Required:**
```typescript
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  for (const key in env) {
    process.env[key] ??= env[key];
  }

  return {
    plugins: [sveltekit()],
    envDir: rootDir,
    resolve: {
      alias: {
        "$assets": resolve(__dirname, "../assets"),
        "$registry": resolve(__dirname, "../registry")
      }
    }
  };
});
```

---

### 2. `admin/src/lib/server/control-plane.ts` — Add `updateSecretsEnv()`

Add a function that merges key-value pairs into `CONFIG_HOME/secrets.env`,
preserving comments and file structure. Place it after the existing
`ensureSecrets()` function (around line 812).

**Allowlisted keys** (constant):
```typescript
const SETUP_WRITABLE_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENMEMORY_USER_ID",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY"
]);
```

`ADMIN_TOKEN` is intentionally excluded — it's set by the CLI and must not be
changeable through the setup wizard.

**Function signature and behavior:**
```typescript
export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void
```

Algorithm:
1. Read `${state.configDir}/secrets.env` — throw if it doesn't exist
2. Filter `updates` to only keys in `SETUP_WRITABLE_KEYS`
3. **Pass 1**: For each line, strip leading `# ` and check if the key matches.
   If so, replace the entire line with `KEY=value` (uncomments commented lines).
4. **Pass 2**: Append any remaining keys that weren't found as existing lines.
5. Write the file back.

**Reference implementation:**
```typescript
export function updateSecretsEnv(
  state: ControlPlaneState,
  updates: Record<string, string>
): void {
  const secretsPath = `${state.configDir}/secrets.env`;
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.env does not exist — run setup first");
  }

  const raw = readFileSync(secretsPath, "utf-8");
  const lines = raw.split("\n");
  const remaining = new Map<string, string>();

  for (const [key, value] of Object.entries(updates)) {
    if (SETUP_WRITABLE_KEYS.has(key)) {
      remaining.set(key, value);
    }
  }

  // Pass 1: replace existing lines (including commented-out)
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^#\s*/, "").trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      lines[i] = `${key}=${remaining.get(key)}`;
      remaining.delete(key);
    }
  }

  // Pass 2: append keys not found in existing file
  if (remaining.size > 0) {
    lines.push("");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(secretsPath, lines.join("\n"));
}
```

Requires imports already present in the file: `readFileSync`, `writeFileSync`,
`existsSync` from `node:fs`.

The function must also be added to the module's exports so the setup endpoint
can import it.

---

### 3. `admin/src/routes/admin/setup/+server.ts` — API Endpoint

Create a new SvelteKit server route at `admin/src/routes/admin/setup/+server.ts`.

**Imports needed:**
```typescript
import {
  getRequestId, jsonResponse, errorResponse,
  requireAdmin, getActor, getCallerType, parseJsonBody
} from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import {
  updateSecretsEnv, ensureXdgDirs, ensureOpenCodeConfig,
  ensureSecrets, applyInstall, appendAudit,
  discoverStagedChannelYmls, buildComposeFileList, stagedEnvFile
} from "$lib/server/control-plane.js";
import { composeUp, checkDocker } from "$lib/server/docker.js";
import { readFileSync, existsSync } from "node:fs";
```

#### GET /admin/setup

Returns current configuration values read from `secrets.env`.

**Auth:** `x-admin-token` header required (use `requireAdmin()`).

**Response (200):**
```json
{
  "openaiApiKey": "sk-...",
  "openaiBaseUrl": "",
  "openmemoryUserId": "default_user",
  "installed": false
}
```

- `openaiApiKey`, `openaiBaseUrl`, `openmemoryUserId`: Read from
  `${state.configDir}/secrets.env` by parsing `KEY=value` lines.
- `installed`: `true` when any service other than `"admin"` has status
  `"running"` in `state.services`.

**Helper for reading config:**
```typescript
function readCurrentConfig(): {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openmemoryUserId: string;
} {
  const state = getState();
  const secretsPath = `${state.configDir}/secrets.env`;
  const values: Record<string, string> = {};

  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      values[key] = trimmed.slice(eq + 1).trim();
    }
  }

  return {
    openaiApiKey: values.OPENAI_API_KEY ?? "",
    openaiBaseUrl: values.OPENAI_BASE_URL ?? "",
    openmemoryUserId: values.OPENMEMORY_USER_ID ?? "default_user"
  };
}
```

#### POST /admin/setup

Saves configuration to `secrets.env` and triggers the full-stack install.

**Auth:** `x-admin-token` header required.

**Request body:**
```json
{
  "openaiApiKey": "sk-...",
  "openaiBaseUrl": "http://host.docker.internal:11434/v1",
  "openmemoryUserId": "default_user"
}
```

All fields are optional strings. Only provided fields are written.

**Flow:**
1. Build update map: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENMEMORY_USER_ID`
2. Call `updateSecretsEnv(state, updates)`
3. Run install sequence: `ensureXdgDirs()` → `ensureOpenCodeConfig()` →
   `ensureSecrets(state)` → `applyInstall(state)`
4. Discover staged channel YMLs and register channel services in state
5. Check Docker availability, then `composeUp()` with full compose file list
6. Append audit log entry for `"setup.install"`

**Response (200):**
```json
{
  "ok": true,
  "started": ["caddy", "postgres", "qdrant", "openmemory", "openmemory-ui",
              "assistant", "guardian", "admin", "channel-chat"],
  "dockerAvailable": true,
  "composeResult": { "ok": true, "stderr": "" }
}
```

**Error response (500) if config save fails:**
```json
{
  "error": "config_save_failed",
  "message": "Failed to update secrets.env: ...",
  "details": {},
  "requestId": "..."
}
```

---

### 4. `admin/src/routes/setup/+page.svelte` — Setup Wizard UI

A standalone page at `/setup` with no dependency on the main console page.

#### Auth Gate

Before showing the wizard, require the admin token:
- Input field for pasting the admin token shown in the terminal
- Verify by calling `GET /admin/access-scope` with the token
- Store valid token in `localStorage` as `openpalm.adminToken`
- Same pattern used by the main `+page.svelte` auth gate

#### Wizard Steps

**Step 1: LLM Provider**
- **OpenAI API Key** — password input, placeholder: `sk-... (leave empty to
  configure later)`, hint: "Required for OpenMemory embeddings. Can be added
  later via secrets.env."
- **OpenAI Base URL** — url input, placeholder: `https://api.openai.com/v1
  (default if empty)`, hint: "For Ollama:
  `http://host.docker.internal:11434/v1`"
- "Next" button → step 2

**Step 2: OpenMemory**
- **User ID** — text input, default: `default_user`, hint: "Identifies the
  memory owner. Use a unique name if running multiple instances."
- "Back" and "Next" buttons

**Step 3: Review & Install**
- Summary grid showing entered values (API key masked, base URL, user ID)
- "Back" and "Install Stack" buttons
- On click "Install Stack":
  - `POST /admin/setup` with `{ openaiApiKey, openaiBaseUrl, openmemoryUserId }`
  - Show spinner with "Pulling container images and starting services..."
  - On success: show checkmark, list of started services, "Go to Console" link
    to `/`
  - On error: show error message, allow retry

#### Behavior on Load

- `onMount`: Check for stored admin token, verify it, load current config via
  `GET /admin/setup`
- If `config.installed === true`, skip to "done" state
- All API calls include headers: `x-admin-token`, `x-requested-by: ui`,
  `x-request-id: <uuid>`

#### Styling

Use existing design tokens from `admin/src/app.css`. Key tokens:
- Colors: `--color-bg-secondary`, `--color-surface`, `--color-border`,
  `--color-primary`, `--color-text`, `--color-text-secondary`,
  `--color-success`, `--color-danger`
- Spacing: `--space-*` scale
- Typography: `--text-sm`, `--text-base`, `--text-lg`, `--text-2xl`,
  `--font-mono`, `--font-bold`
- Effects: `--radius-md`, `--radius-lg`, `--shadow-sm`, `--transition-fast`

---

## Verification Checklist

- [ ] `GET /admin/setup` returns current config from secrets.env
- [ ] `GET /admin/setup` returns `installed: true` when services are running
- [ ] `POST /admin/setup` saves values to secrets.env (only allowlisted keys)
- [ ] `POST /admin/setup` triggers full install (same as `POST /admin/install`)
- [ ] `ADMIN_TOKEN` cannot be modified via the setup endpoint
- [ ] `/setup` page loads and shows auth gate
- [ ] Auth gate accepts valid admin token and rejects invalid ones
- [ ] Wizard navigates between all 3 steps correctly
- [ ] "Install Stack" triggers POST and shows progress
- [ ] On success, shows started services and "Go to Console" link
- [ ] On error, shows error and allows retry
- [ ] If already installed, `/setup` shows "done" state on load
- [ ] TypeScript check passes: `cd admin && npx svelte-check`
- [ ] All tests pass: `cd admin && npx vitest run`
- [ ] `vite.config.ts` loads env from repo root correctly