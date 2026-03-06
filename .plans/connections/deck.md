> REFERENCE-ONLY: This file is a duplicate artifact for historical reference.
> Canonical wizard copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.

Below is a **UI copy deck** you can drop into a wizard (titles, helper text, field labels, placeholders, validations, and error messages). It assumes:

* Multiple **Connections** (local + remote), reused across capabilities
* **Required:** LLM + Embeddings
* **Optional:** Reranking, TTS, STT
* Under the hood you’ll later map to:

  * OpenCode: provider `options.baseURL`, `model`, `small_model` ([OpenCode][1])
  * Mem0: component blocks `llm`, `embedder` (+ optional `reranker`) ([Mem0][2])

---

## Screen 1 — Welcome

**Title:** Set up your models
**Body:** Add one or more model connections (local and/or remote), then choose a default chat model and embedding model. You can optionally add reranking, text-to-speech, and speech-to-text later.

**Primary button:** Start
**Secondary button:** Skip for now (optional)

---

## Screen 2 — Connections hub

**Title:** Connections
**Body:** Connections let you reuse the same endpoint (and credentials) across different model types. You can mix local and remote hosts.

**Empty state headline:** No connections yet
**Empty state body:** Add a connection to a local server (like LM Studio) or a remote OpenAI-compatible endpoint.

**CTA button (empty state):** Add your first connection

**List columns / row text**

* **Name**
* **Type:** Local / Remote
* **Base URL:** (shortened)
* **Auth:** Key set / No key

**Row actions:** Edit · Duplicate · Remove

**Primary button:** Continue
**Secondary button:** Add connection

---

## Screen 3 — Add connection: type

**Title:** Add a connection
**Prompt:** Where is this endpoint hosted?

### Option A: Remote (OpenAI-compatible)

**Label:** Remote OpenAI-compatible
**Help text:** Use this for OpenAI, proxies, gateways, and any service that exposes an OpenAI-style `/v1` API.

### Option B: Local (OpenAI-compatible)

**Label:** Local OpenAI-compatible
**Help text:** Use this for LM Studio or any local server that exposes an OpenAI-style `/v1` API. LM Studio’s default is typically `http://localhost:1234/v1`. ([Mem0][3])

**Primary button:** Next
**Secondary button:** Back

---

## Screen 4 — Add connection: details

**Title:** Connection details
**Body:** Give this connection a name, point to the API endpoint, and add an API key if required.

### Field: Connection name

* **Label:** Connection name
* **Placeholder:** e.g., “LM Studio local”, “Work proxy”, “OpenAI Prod”
* **Validation (blocking):** Name is required.
* **Validation (non-blocking):** Name already exists. Continue anyway?

### Field: Base URL

* **Label:** Base URL
* **Placeholder (remote):** [https://api.example.com/v1](https://api.example.com/v1)
* **Placeholder (local):** [http://localhost:1234/v1](http://localhost:1234/v1)
* **Help text:** Use the full `/v1` base URL when available.
* **Validation (blocking):** Enter a valid URL.
* **Validation (non-blocking):** This URL doesn’t end with `/v1`. Many OpenAI-compatible servers expect `/v1`.

### Field: Authentication

* **Label:** Authentication
* **Toggle label:** This endpoint requires an API key

  * **On → Field label:** API key
  * **Placeholder:** Paste your API key
  * **Help text:** Your key will be stored securely and reused when you select this connection.

### Buttons / actions

* **Button:** Test connection

  * **Success toast:** Connection successful.
  * **Failure toast (generic):** Connection failed. Check the Base URL and API key.
  * **Failure details (expandable):**

    * **401/403:** “Unauthorized. This endpoint may require a valid API key.”
    * **404:** “Endpoint not found. Verify the Base URL includes `/v1`.”
    * **Timeout:** “Couldn’t reach the server. Confirm it’s running and accessible.”

* **Button:** Fetch models (optional)

  * **Success toast:** Models loaded.
  * **Failure toast:** Couldn’t load model list. You can still type model IDs manually.

**Primary button:** Save connection
**Secondary button:** Cancel

---

## Screen 5 — Required models

**Title:** Required models
**Body:** Choose a default chat model and a default embedding model. These can use different connections (local and remote).

---

### Card A — Chat model (LLM)

**Card title:** Chat model (LLM)
**Card help:** This model is used for responses and tool use in supported apps.

#### Field: Connection

* **Label:** Connection
* **Help text:** Pick which endpoint hosts your chat model.
* **Default:** Last used connection (or first available)
* **Inline action:** Add new connection

#### Field: Model

* **Label:** Model
* **Placeholder:** e.g., gpt-4.1-mini, llama3.2, etc.
* **Help text (if picker available):** Choose from detected models or type a model ID.
* **Validation (blocking):** Model is required.

#### Optional: Small model

* **Section label:** Optional
* **Field label:** Small model (for lightweight tasks)
* **Help text:** Used for quick/cheap tasks (like title generation) when supported. ([OpenCode][4])
* **Placeholder:** e.g., gpt-4.1-mini
* **Validation (non-blocking):** If unavailable, the main model will be used instead. *(You can phrase this as expectation; OpenCode exposes `small_model` as a separate setting.)* ([OpenCode][4])

---

### Card B — Embeddings

**Card title:** Embeddings
**Card help:** Used for vector search / memory features.

#### Field: Connection

* **Label:** Connection
* **Default:** Same as Chat model
* **Quick button:** Use same as Chat model

#### Field: Embedding model

* **Label:** Embedding model
* **Placeholder:** e.g., text-embedding-3-small, nomic-embed-text, etc.
* **Validation (blocking):** Embedding model is required.

#### Advanced (collapsed)

* **Toggle label:** Advanced embedding settings
* **Field label:** Embedding dimensions override
* **Placeholder:** 1536
* **Help text:** Only set this if you know your embedder’s output dimensions.
* **Validation (blocking if present):** Must be a positive number.

**Inline warning (non-blocking, show when local LM Studio connection selected):**
If you use LM Studio for both chat and embeddings, make sure you have **an LLM model** and **an embedding model** loaded and that the server is running. ([Mem0][3])

**Primary button:** Continue
**Secondary button:** Back

---

## Screen 6 — Optional add-ons

**Title:** Optional add-ons
**Body:** Enable these only if you need them. You can set them up later.

### Toggle: Reranking

* **Label:** Enable reranking
* **Help text:** Improves search result relevance by re-ordering retrieved items.

If enabled:

**Field: Reranker type**

* **Label:** Reranker type
* **Options:**

  * Use an LLM to rerank
  * Use a dedicated reranker

**If “Use an LLM to rerank”**

* **Label:** Connection (default: Chat model connection)
* **Label:** Model
* **Advanced (collapsed):**

  * **Label:** Top N results to keep
  * **Help text:** Fewer results = faster reranking.
    Mem0 documents LLM-based and reranker config patterns. ([Mem0][5])

**If “Dedicated reranker”**

* **Label:** Provider
* **Help text:** Choose a supported reranker provider.
* **Label:** API key (only if provider requires it)
* **Label:** Model (if applicable)
* **Advanced:** Top K / Top N
  Mem0 reranker configuration parameters vary by provider and are explicitly documented. ([Mem0][5])

### Toggle: Text-to-speech (TTS)

* **Label:** Enable text-to-speech
* **Help text:** Turns responses into audio.

If enabled:

* **Label:** Connection
* **Label:** Model (optional)
* **Label:** Voice (optional)
* **Label:** Output format (optional; default: WAV)

### Toggle: Speech-to-text (STT)

* **Label:** Enable speech-to-text
* **Help text:** Transcribes audio into text.

If enabled:

* **Label:** Connection
* **Label:** Model (optional)
* **Label:** Language (optional; default: English)

**Primary button:** Continue
**Secondary button:** Back
**Tertiary link:** Skip add-ons

---

## Screen 7 — Review

**Title:** Review your setup
**Body:** Confirm connections and model selections. You can edit anything before saving.

### Section: Connections

* List each connection: Name · Type · Base URL · Auth (key set?)

### Section: Required models

* Chat model: Connection → Model (+ small model if set)
* Embeddings: Connection → Embedding model (+ dimensions override if set)

### Section: Optional add-ons

* Reranking: Enabled/Disabled (+ details if enabled)
* TTS: Enabled/Disabled
* STT: Enabled/Disabled

**Primary button:** Save
**Secondary button:** Back
**Optional buttons (if you expose exports):**

* Export OpenCode config
* Export Mem0 config

---

## Inline error message library

Use these consistently across screens:

* **Required field missing:** “This field is required.”
* **Invalid URL:** “Enter a valid URL.”
* **Auth missing:** “This endpoint appears to require an API key.”
* **Model list not available:** “Couldn’t load models from this endpoint. You can type a model ID instead.”
* **Local server not reachable:** “Couldn’t reach the local server. Confirm it’s running and the Base URL is correct.”

---

## Microcopy for “What gets generated” (optional tooltip text)

### Tooltip: OpenCode

“OpenCode supports setting a default `model` and optional `small_model`, and you can override any provider endpoint using `options.baseURL` for proxies or custom endpoints.” ([OpenCode][1])

### Tooltip: Mem0

“Mem0 uses separate component blocks like `llm` and `embedder`, each with its own provider + config. That’s why your chat model and embedding model can come from different connections.” ([Mem0][2])

---

If you want the *next* layer, tell me what UI surface this is (CLI prompts, web wizard, or TUI) and I’ll adapt this copy deck into the exact interaction style (including example runs for CLI).

[1]: https://opencode.ai/docs/providers/?utm_source=chatgpt.com "Providers"
[2]: https://docs.mem0.ai/components/llms/config?utm_source=chatgpt.com "Configurations - Mem0"
[3]: https://docs.mem0.ai/components/llms/models/lmstudio?utm_source=chatgpt.com "LM Studio"
[4]: https://opencode.ai/docs/config/?utm_source=chatgpt.com "Config"
[5]: https://docs.mem0.ai/integrations/keywords?utm_source=chatgpt.com "Keywords AI - Mem0"
