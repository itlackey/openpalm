# Model Setup Wizard — Screen-by-Screen UX Spec

## Scope Decision (v1)
- Connection types in scope: `openai_compatible_remote` and `openai_compatible_local`.
- `ollama_native` is deferred and not required for v1 delivery.
- Required capabilities: LLM and embeddings.
- Optional capabilities: reranking, TTS, and STT.
- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.

## Scope (v1)
Supported connection types:
- Remote OpenAI-compatible
- Local OpenAI-compatible (e.g., LM Studio / any local OpenAI-compatible server)

Required:
- LLM
- Embeddings

Optional:
- Reranking, TTS, STT

---

## Screen 1 — Welcome / Scope
**Goal:** Set expectations and start the wizard.

**Elements**
- Title, short explanation
- Start button
- Optional “Skip for now”

**Notes**
- No data captured

---

## Screen 2 — Connections Hub
**Goal:** Manage reusable endpoints.

**Elements**
- List of existing connections (name, type, base URL summary, “key set?”)
- Actions: Edit / Duplicate / Remove
- Primary CTA: Continue
- Secondary CTA: Add connection

**Empty state**
- “Add your first connection”

---

## Screen 3 — Add Connection (Type)
**Goal:** Choose the minimal shape of connection fields.

**Options**
1) Remote OpenAI-compatible
2) Local OpenAI-compatible

**Navigation**
- Next / Back

---

## Screen 4 — Add Connection (Details)
**Goal:** Capture endpoint + auth, optionally validate.

**Fields**
- Connection name (required)
- Base URL (optional but recommended)
- Toggle: “Requires API key?”
  - API key (masked) if enabled

**Actions**
- Test connection (optional UX; shows success/failure)
- Fetch models (optional UX; populates model picker)

**Validation**
- Block: name required
- Block: base URL must be valid URL when provided
- Warn: base URL doesn’t end with `/v1`

**Save**
- Save connection returns to Connections Hub

---

## Screen 5 — Required Models
**Goal:** Assign LLM and embeddings (may use different connections).

### Card A: LLM (required)
- Connection selector (required)
- Model selector (required; picker or manual)
- Small model (optional)

### Card B: Embeddings (required)
- Connection selector (required; default same as LLM)
- Embedding model selector (required; picker or manual)
- Advanced: embedding dimensions (optional)

**Validation**
- Block: both cards must have connection + model
- Block: embedding dimensions, if set, must be positive integer

---

## Screen 6 — Optional Add-ons
**Goal:** Configure optional capabilities without lengthening core path.

**Toggles**
- Reranking
- TTS
- STT

**When enabled**
- Each add-on expands inline with:
  - Connection selector
  - Model selector (if applicable)
  - Minimal advanced options

---

## Screen 7 — Review & Save
**Goal:** Confirm choices and output mappings.

**Summary sections**
- Connections
- Required models
- Optional add-ons

**Actions**
- Save
- Export OpenCode mapping
- Export Mem0 mapping
