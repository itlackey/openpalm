> REFERENCE-ONLY: This file is historical context and not an authoritative v1 implementation source.
> Any `ollama_native` content in this document is deferred for v1 and should not be treated as required scope.

Below is a **screen-by-screen UX spec** for a single setup wizard that supports **mixed providers per model type**, with only:

* **Local endpoints** (LM Studio / other local OpenAI-compatible servers; optionally Ollama)
* **OpenAI-compatible remote endpoints** (OpenAI, proxies, gateways, OpenRouter-style, etc.)

**Required:** LLM + Embeddings
**Optional:** Reranking, TTS, STT

It’s written as **screens, fields, defaults, validations, and what we store**, plus a short **mapping section** for **OpenCode** and **Mem0**.

Key doc anchors:

* OpenCode supports per-provider `baseURL` overrides for custom/proxy endpoints. ([OpenCode][1])
* OpenCode config sets `model` and `small_model`. ([OpenCode][2])
* Mem0 config structure is component blocks (`llm`, `embedder`, optional `reranker`). ([Mem0][3])
* Mem0 has explicit reranker config blocks and env var patterns (optional step). ([Mem0][4])
* Mem0 LM Studio needs `lmstudio_base_url` and separate LLM + embedding models loaded. ([Mem0][5])

---

## Wizard overview and core UX rules

### UX rules (apply everywhere)

1. **Connections are reusable.** Users can add multiple connections and reuse them across capabilities.
2. **Every capability picks a connection + a model.** No global “provider” assumption.
3. **Carry-forward defaults.**

   * Default capability connection = “last chosen connection”
   * Default embeddings connection = “same as LLM” (one click)
4. **Model selection is “pick if you can, type if you must.”**

   * If the endpoint can provide model IDs, show a picker.
   * Always allow manual entry.

---

## Data you store (canonical, app-agnostic)

### Connection (reusable)

* `connection.id` (stable)
* `connection.name` (user-friendly)
* `connection.kind`: `openai_compatible_remote` | `openai_compatible_local` | (optional) `ollama_native`
* `connection.base_url` (string; may be blank when using a known default)
* `connection.auth`:

  * `mode`: `api_key` | `none`
  * `api_key_secret_ref` (don’t store raw key in the “profile” object)

### Capability assignment

* `llm`: `{ connection_id, model, small_model? }` (required)
* `embeddings`: `{ connection_id, model, embedding_dims? }` (required)
* `reranker?`: `{ enabled, connection_id?, mode, model?, top_k?/top_n? }`
* `tts?`: `{ enabled, connection_id?, model?, voice? }`
* `stt?`: `{ enabled, connection_id?, model?, language? }`

---

## Screen-by-screen specification

### Screen 1 — Welcome / Scope

**Title:** “Set up models for your apps”
**Body copy (short):** “You’ll add one or more model connections (local and/or remote), then choose a default chat model and embedding model. Everything else is optional.”

**Controls**

* Primary: “Start”
* Secondary: “Import existing config” (optional later)

**No fields.**

---

### Screen 2 — Connections hub

**Title:** “Connections”
**Purpose:** Create 1+ endpoints the user can pick from later.

**UI sections**

* **Existing connections list**

  * Show: name, type icon (local/remote), base URL (shortened), “key set?” indicator
  * Actions per row: Edit, Duplicate, Remove
* **Add connection** button

**Default behavior**

* If zero connections exist, show a prominent “Add your first connection” CTA.

---

### Screen 3 — Add connection (type selection)

**Title:** “Add a connection”
**Question:** “Where is this model hosted?”

**Choices**

1. **Remote OpenAI-compatible**

   * help text: “API key + optional Base URL. Works for OpenAI and many proxy/gateway services.”
2. **Local OpenAI-compatible**

   * help text: “LM Studio or any local server that exposes an OpenAI-style /v1 API.”
3. *(Optional later)* **Ollama**

   * only if you want native convenience; Mem0 has dedicated Ollama examples. ([Mem0][6])

**Controls**

* Next / Back

---

### Screen 4 — Add connection (details)

**Title:** “Connection details”

#### Fields (all connection types)

* **Connection name** (required)

  * placeholder: “Work proxy”, “LM Studio local”, “OpenAI Prod”
  * validation: non-empty, unique-ish (warn on duplicate)

* **Base URL** (optional but recommended for non-OpenAI endpoints)

  * placeholder examples:

    * Remote: `https://…/v1`
    * Local: `http://localhost:1234/v1` (LM Studio typical default) ([Mem0][5])
  * validation:

    * must be a valid URL
    * should end with `/v1` (warn, don’t block)
    * show a “This looks like a root URL; did you mean /v1?” hint when missing

* **Authentication**

  * toggle: “Requires API key?”

    * If on: **API key** input (masked)
    * If off: nothing (some local servers/proxies don’t require a key)

#### Convenience actions

* **Test connection** (button)

  * success: “Connection works”
  * failure: show error + suggested fixes (wrong base URL, missing key)
* **Fetch model list** (button)

  * if it works: store model IDs for pickers
  * if not: keep manual entry path

**Controls**

* Save connection
* Cancel

---

### Screen 5 — Required capabilities

**Title:** “Required models”
Two cards. Each card has the same structure: Connection picker → Model picker/manual.

#### Card A — Default LLM (required)

**Fields**

* **Connection** (required dropdown)

  * default: last-used connection (or first connection)
  * quick action: “Add new connection…”

* **Model** (required)

  * picker if model list exists; else text input
  * validation: non-empty

* **Small model for lightweight tasks** (optional)

  * help text: “Optional cheaper model for small tasks.”
  * OpenCode supports `small_model` explicitly. ([OpenCode][2])
  * validation: if set, non-empty

**Smart defaults**

* If the selected connection has model list:

  * preselect last used model on that connection
* If not:

  * leave blank and focus input

#### Card B — Embeddings (required)

**Fields**

* **Connection** (required dropdown)

  * default: same as LLM connection (with “Use same as LLM” one-click action)

* **Embedding model** (required)

  * picker if available; else manual
  * validation: non-empty

* **Embedding dimensions override** (optional, collapsed “Advanced”)

  * only shown if user expands
  * validation: integer > 0

Mem0’s embedder is an explicit block in config and is designed to be provider + config (including model). ([Mem0][7])

**Controls**

* Next / Back

---

### Screen 6 — Optional capabilities (single “Add-ons” screen)

**Title:** “Optional add-ons”
Toggles that expand inline when enabled.

#### Toggle: Reranking (optional)

If enabled, show:

* **Reranker type**

  * Option 1: “Use an LLM as reranker”
  * Option 2: “Use a dedicated reranker provider”
  * (Keep the dedicated list short at first; Mem0 supports several. ([Mem0][4]))

**If “LLM reranker”**

* Connection (dropdown; default = LLM connection)
* Model (picker/manual)
* Advanced (collapsed):

  * `top_n` (optional)
  * temperature/max tokens (optional)
    Mem0 documents both “LLM-based” and “LLM Reranker” styles and their parameters. ([Mem0][4])

**If “Dedicated reranker”**

* Provider selector (e.g., “Sentence Transformer (local)”, “Cohere”, “Zero Entropy”)
* Auth (if needed)
* Model (if needed)
* `top_k` / `top_n` (optional)
  Mem0 reranker config page explicitly lists common parameters and env vars. ([Mem0][4])

#### Toggle: TTS (optional)

If enabled:

* Connection (dropdown)
* Model (optional; some APIs use “voice” more than “model”)
* Voice (optional)
* Output format (optional; default “wav”)

#### Toggle: STT (optional)

If enabled:

* Connection (dropdown)
* Model (optional)
* Language (optional; default “en”)

**Controls**

* Next / Back

---

### Screen 7 — Review and output

**Title:** “Review & generate configs”
Show a summary:

* Connections created (names + base URLs)
* Required assignments:

  * LLM: connection + model (+ small model if set)
  * Embeddings: connection + model (+ dims if set)
* Optional add-ons enabled (if any)

**Buttons**

* “Save”
* “Export for OpenCode”
* “Export for Mem0”
* (Optional) “Export combined (profile + mappings)”

---

## Mapping spec

### Output A — OpenCode mapping (what you generate)

OpenCode supports:

* default `model` and `small_model` in `opencode.json` ([OpenCode][2])
* per-provider `options.baseURL` override ([OpenCode][1])

**From the wizard:**

* If the LLM connection has a custom base URL:

  * emit a provider entry with `options.baseURL = connection.base_url`
* Set:

  * `model = "<provider_id>/<model_id>"`
  * `small_model = "<provider_id>/<small_model_id>"` (if user set it)

**Credential storage UX**

* Don’t force users to paste keys into config output. Provide a “Next steps” note:

  * “Add API keys via OpenCode’s connect/auth flow; OpenCode stores them separately.” (OpenCode docs and common guidance point users to `/connect` and key storage separate from config; plus references to auth.json are common in ecosystem docs/issues.) ([GitHub][8])

*(You can still export env-var hints if you want a keyless flow.)*

### Output B — Mem0 mapping (LLM + embedder required)

Mem0 config is a single object with component blocks; `llm` is required, `embedder` optional in Mem0 but required in **your wizard**. ([Mem0][3])

**From the wizard:**

* `llm` block uses the LLM assignment’s connection + model
* `embedder` block uses the embedding assignment’s connection + model (+ dims if set)
* If reranker enabled, include `reranker` block per chosen mode. ([Mem0][4])

**Provider naming strategy (keep it simple)**

* For OpenAI-compatible endpoints (remote or local), standardize on Mem0 provider `"openai"` and set the appropriate base URL field (Mem0’s docs consistently emphasize provider-specific base URL configuration, e.g. LM Studio requires `lmstudio_base_url` when using the LM Studio provider). ([Mem0][5])
* For LM Studio specifically, you may choose Mem0’s `"lmstudio"` provider and set `lmstudio_base_url` (and remind users they need *both* a chat model and an embedding model loaded if they want both capabilities locally). ([Mem0][5])

---

## Edge cases (UX handling, not implementation)

1. **Embeddings hosted somewhere else**

* Fully supported: embeddings card picks a different connection + model.

2. **Local server has no embedding model**

* Show a friendly warning when the user picks a local connection for embeddings:

  * “Make sure your local server exposes an embedding-capable model.”
  * For LM Studio this is explicitly called out. ([Mem0][5])

3. **Endpoint won’t list models**

* Fall back to manual model entry; store it as user-provided.

4. **Reranker config shape drift**

* Mem0’s reranker docs and issues show there can be nuance in nesting/fields; keep reranker optional and “advanced” in UX for v1. ([Mem0][4])

---

If you want the next refinement: I can rewrite this into a **literal UI copy deck** (exact helper text + error messages + button labels) so you can drop it straight into a ticket/PRD without rewording.

[1]: https://opencode.ai/docs/providers/?utm_source=chatgpt.com "Providers"
[2]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[3]: https://docs.mem0.ai/components/llms/config?utm_source=chatgpt.com "Configurations - Mem0"
[4]: https://docs.mem0.ai/components/rerankers/config?utm_source=chatgpt.com "Config"
[5]: https://docs.mem0.ai/components/llms/models/lmstudio?utm_source=chatgpt.com "LM Studio"
[6]: https://docs.mem0.ai/cookbooks/companions/local-companion-ollama?utm_source=chatgpt.com "Self-Hosted AI Companion"
[7]: https://docs.mem0.ai/components/embedders/config?utm_source=chatgpt.com "Configurations"
[8]: https://github.com/anomalyco/opencode/issues/5674?utm_source=chatgpt.com "Custom OpenAI-compatible provider options not being ..."
