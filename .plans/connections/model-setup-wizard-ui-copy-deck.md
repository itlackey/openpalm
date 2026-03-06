# Model Setup Wizard — UI Copy Deck

## Scope Decision (v1)
- Connection types in scope: `openai_compatible_remote` and `openai_compatible_local`.
- `ollama_native` is deferred and not required for v1 delivery.
- Required capabilities: LLM and embeddings.
- Optional capabilities: reranking, TTS, and STT.
- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.

This deck contains screen titles, helper text, field labels, placeholders, and error messages for the wizard.

---

## Screen 1 — Welcome

**Title:** Set up your models  
**Body:** Add one or more model connections (local and/or remote), then choose a default chat model and embedding model. You can optionally add reranking, text-to-speech, and speech-to-text later.

**Primary button:** Start  
**Secondary button:** Skip for now

---

## Screen 2 — Connections hub

**Title:** Connections  
**Body:** Connections let you reuse the same endpoint (and credentials) across different model types. You can mix local and remote hosts.

**Empty state headline:** No connections yet  
**Empty state body:** Add a connection to a local server (like LM Studio) or a remote OpenAI-compatible endpoint.  
**CTA button (empty state):** Add your first connection

**List columns / row labels**
- Name
- Type (Local / Remote)
- Base URL
- Auth (Key set / No key)

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
**Help text:** Use this for LM Studio or any local server that exposes an OpenAI-style `/v1` API.  
**Example:** `http://localhost:1234/v1`

**Primary button:** Next  
**Secondary button:** Back

---

## Screen 4 — Add connection: details

**Title:** Connection details  
**Body:** Give this connection a name, point to the API endpoint, and add an API key if required.

### Field: Connection name
- **Label:** Connection name
- **Placeholder:** e.g., “LM Studio local”, “Work proxy”, “OpenAI Prod”
- **Error (blocking):** Connection name is required.
- **Warning (non-blocking):** A connection with this name already exists.

### Field: Base URL
- **Label:** Base URL
- **Placeholder (remote):** https://api.example.com/v1
- **Placeholder (local):** http://localhost:1234/v1
- **Help text:** Use the full `/v1` base URL when available.
- **Error (blocking):** Enter a valid URL.
- **Warning (non-blocking):** This URL doesn’t end with `/v1`. Many OpenAI-compatible servers expect `/v1`.

### Field: Authentication
- **Label:** Authentication
- **Toggle label:** This endpoint requires an API key
  - **On → Field label:** API key
  - **Placeholder:** Paste your API key
  - **Help text:** Your key will be stored securely and reused when you select this connection.

### Buttons / actions
- **Button:** Test connection
  - **Success:** Connection successful.
  - **Failure:** Connection failed. Check the Base URL and API key.
  - **Failure details (optional):**
    - Unauthorized (401/403): Unauthorized. This endpoint may require a valid API key.
    - Not found (404): Endpoint not found. Verify the Base URL includes `/v1`.
    - Timeout: Couldn’t reach the server. Confirm it’s running and accessible.

- **Button:** Fetch models
  - **Success:** Models loaded.
  - **Failure:** Couldn’t load model list. You can still type model IDs manually.

**Primary button:** Save connection  
**Secondary button:** Cancel

---

## Screen 5 — Required models

**Title:** Required models  
**Body:** Choose a default chat model and a default embedding model. These can use different connections (local and remote).

### Card A — Chat model (LLM)

**Card title:** Chat model (LLM)  
**Card help:** This model is used for responses and tool use in supported apps.

- **Field label:** Connection
  - **Help text:** Pick which endpoint hosts your chat model.
  - **Inline action:** Add new connection

- **Field label:** Model
  - **Placeholder:** e.g., gpt-4.1-mini, llama3.2, etc.
  - **Error (blocking):** Chat model is required.

**Optional section**
- **Field label:** Small model (for lightweight tasks)
  - **Help text:** Optional cheaper model for small tasks.
  - **Placeholder:** e.g., gpt-4.1-mini

### Card B — Embeddings

**Card title:** Embeddings  
**Card help:** Used for vector search / memory features.

- **Field label:** Connection
  - **Quick action:** Use same as Chat model

- **Field label:** Embedding model
  - **Placeholder:** e.g., text-embedding-3-small, nomic-embed-text, etc.
  - **Error (blocking):** Embedding model is required.

**Advanced (collapsed)**
- **Toggle label:** Advanced embedding settings
- **Field label:** Embedding dimensions override
  - **Placeholder:** 1536
  - **Help text:** Only set this if you know your embedder’s output dimensions.
  - **Error (blocking if present):** Must be a positive number.

**Inline warning (non-blocking, when local is selected):**
If you use a local server for embeddings, make sure it exposes an embedding-capable model.

**Primary button:** Continue  
**Secondary button:** Back

---

## Screen 6 — Optional add-ons

**Title:** Optional add-ons  
**Body:** Enable these only if you need them. You can set them up later.

### Toggle: Reranking
- **Label:** Enable reranking
- **Help text:** Improves search result relevance by re-ordering retrieved items.

If enabled:
- **Field label:** Reranker type
  - **Options:** Use an LLM to rerank · Use a dedicated reranker

**LLM reranker**
- **Field label:** Connection
- **Field label:** Model
- **Advanced:** Top N results to keep

**Dedicated reranker**
- **Field label:** Provider
- **Field label:** API key (if required)
- **Field label:** Model (if applicable)
- **Advanced:** Top K / Top N

### Toggle: Text-to-speech (TTS)
- **Label:** Enable text-to-speech
- **Help text:** Turns responses into audio.

If enabled:
- **Field label:** Connection
- **Field label:** Model (optional)
- **Field label:** Voice (optional)
- **Field label:** Output format (optional)

### Toggle: Speech-to-text (STT)
- **Label:** Enable speech-to-text
- **Help text:** Transcribes audio into text.

If enabled:
- **Field label:** Connection
- **Field label:** Model (optional)
- **Field label:** Language (optional)

**Primary button:** Continue  
**Secondary button:** Back  
**Link:** Skip add-ons

---

## Screen 7 — Review

**Title:** Review your setup  
**Body:** Confirm connections and model selections. You can edit anything before saving.

### Section headers
- Connections
- Required models
- Optional add-ons

**Primary button:** Save  
**Secondary button:** Back  
**Optional buttons:** Export OpenCode config · Export Mem0 config

---

## Global error message library
- This field is required.
- Enter a valid URL.
- Unauthorized. This endpoint may require a valid API key.
- Couldn’t load model list. You can type a model ID instead.
- Couldn’t reach the server. Confirm it’s running and the Base URL is correct.
