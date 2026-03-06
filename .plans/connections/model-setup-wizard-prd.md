# Model Setup Wizard (Local + OpenAI-Compatible) — PRD

## Scope Decision (v1)
- Connection types in scope: `openai_compatible_remote` and `openai_compatible_local`.
- `ollama_native` is deferred and not required for v1 delivery.
- Required capabilities: LLM and embeddings.
- Optional capabilities: reranking, TTS, and STT.
- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.

## Summary
Create a single setup experience that helps users configure **multiple model connections** (local and/or remote OpenAI-compatible endpoints) and assign them to **capabilities** used by applications such as **OpenCode** and **Mem0**. The wizard must support **mixed providers per capability** (e.g., LLM remote + embeddings local).

**Required capabilities**
- LLM (chat) — required
- Embeddings — required

**Optional capabilities**
- Reranking
- TTS
- STT

## Goals
- **Fast first-time setup** with minimal required inputs.
- Support **multiple connections** and **mix-and-match** by capability.
- Provide **sane defaults** and carry-forward values to reduce user effort.
- Produce a **canonical “Connection Profile + Assignments”** that can be mapped into:
  - OpenCode configuration (LLM-focused)
  - Mem0 configuration (LLM + embedder, optional reranker)

## Non-goals (v1)
- Supporting every provider in the OpenCode provider list (AWS, Azure, etc.).
- Building a full “model marketplace” or price/performance recommender.
- Managing usage/billing, quotas, or advanced routing policies.
- Advanced per-model parameter tuning (beyond a few optional fields).

## Target Users
- Developers setting up OpenCode, Mem0, or related agentic apps.
- Users running **local** model servers (LM Studio / OpenAI-compatible servers) alongside **remote** endpoints (OpenAI-compatible).

## Key Concepts
### Connection
A reusable endpoint configuration with optional credentials.
- Example: “LM Studio local”, “Work proxy”, “OpenAI Prod”

### Capability Assignment
Per capability (LLM, embeddings, etc.), select:
- A connection
- A model (picker when possible, manual entry always supported)

## Primary User Stories
1. **As a user**, I can add a remote OpenAI-compatible endpoint with an API key and base URL.
2. **As a user**, I can add a local OpenAI-compatible endpoint and use it for either LLM or embeddings.
3. **As a user**, I can choose one connection/model for LLM and a different connection/model for embeddings.
4. **As a user**, I can skip optional add-ons and finish with only LLM + embeddings configured.
5. **As a user**, I can export mappings for OpenCode and Mem0.

## User Flow
1. Welcome
2. Connections Hub
3. Add Connection (Type)
4. Add Connection (Details + optional test + optional model fetch)
5. Required Models (LLM + Embeddings)
6. Optional Add-ons (Reranking, TTS, STT)
7. Review + Save + Export

## Data Model (Canonical)
### Connection
- `id` (stable)
- `name`
- `kind`: `openai_compatible_remote` | `openai_compatible_local`
- `base_url` (string; may be empty when default is implied)
- `auth`:
  - `mode`: `api_key` | `none`
  - `api_key_secret_ref` (store reference, not raw secret)

### Assignments
- `llm`: `{ connection_id, model, small_model? }`
- `embeddings`: `{ connection_id, model, embedding_dims? }`
- `reranker?`: `{ enabled, connection_id?, mode, model?, top_k?/top_n? }`
- `tts?`: `{ enabled, connection_id?, model?, voice?, format? }`
- `stt?`: `{ enabled, connection_id?, model?, language? }`

## Defaults & Automation Rules
- **Carry-forward connection:** default to last selected connection in subsequent capability pickers.
- **Embeddings default connection:** “Same as LLM” (one-click).
- **Model selection:** prefer picker from fetched model list; allow manual entry always.
- **Validation approach:** block only on required fields; otherwise warn with suggestions.
- **Model list retrieval fails:** continue with manual entry (no dead ends).

## Validation Rules
### Connection
- Name required
- Base URL must be valid URL if provided
- Warn (don’t block) if Base URL doesn’t end with `/v1`

### Required Models
- LLM connection + model required
- Embeddings connection + model required
- If `embedding_dims` provided → must be positive integer

## UX Requirements
- Must make “mixed providers” feel normal:
  - Every capability card includes “Connection” dropdown + “Model” control.
- Provide “Add new connection” inline on selection controls.
- Keep optional add-ons in a single screen with toggles; user can skip.

## Export Requirements (Mapping)
### OpenCode Mapping Output (v1)
- Set default `model` and optional `small_model`.
- For any connection requiring a custom endpoint, set provider `options.baseURL`.
- Credential handling is separate; export may include “where to put keys” guidance.

### Mem0 Mapping Output (v1)
- Emit `llm` block with provider + model + base URL + api key (or env var approach).
- Emit `embedder` block with provider + model + base URL + api key (or env var approach).
- If reranker enabled, emit `reranker` block (optional).

## Success Metrics
- % of users completing setup with only required steps
- Median time-to-first-working-config
- Drop-off rate at Connections vs Required Models screens
- Rate of successful “Test connection” and model list retrieval

## Open Questions (keep small)
- Do we standardize Mem0 provider strings to `openai` for all OpenAI-compatible endpoints, or expose `lmstudio` explicitly when local server is detected?
- Do we persist fetched model lists per connection for offline pickers, and how long?
