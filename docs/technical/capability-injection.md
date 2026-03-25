# Capability Injection (OP_CAP_* Variables)

This document describes how OpenPalm resolves provider connections into
environment variables that services consume at runtime.

Primary sources:

- `packages/lib/src/control-plane/spec-to-env.ts` — resolution logic
- `packages/lib/src/control-plane/stack-spec.ts` — capability types
- `packages/lib/src/provider-constants.ts` — provider URLs and key mappings
- `.openpalm/stack/core.compose.yml` — compose variable consumption
- `.openpalm/vault/stack/stack.env.schema` — env schema with OP_CAP_* entries

---

## Why OP_CAP_* Exists

Services need provider credentials (API keys, base URLs, model names) but
should not know how those credentials were configured. The user picks a
provider and model in `stack.yml`; the control plane resolves those choices
into a flat set of `OP_CAP_*` env vars written to `stack.env`. Compose
files reference these vars via `${OP_CAP_*}` substitution, mapping them to
each service's own env var names.

This keeps compose files static (no template rendering), centralizes
credential resolution in one function, and lets services remain agnostic
to which provider is backing a capability.

---

## Resolution Pipeline

```
stack.yml capabilities
        |
        v
writeCapabilityVars()          (packages/lib/src/control-plane/spec-to-env.ts)
  |-- parseCapabilityString()  parse "provider/model" into parts
  |-- PROVIDER_DEFAULT_URLS    resolve provider -> base URL
  |-- PROVIDER_KEY_MAP         resolve provider -> API key env var name
  |-- reads raw keys from      vault/stack/stack.env
        |
        v
OP_CAP_* vars merged into      vault/stack/stack.env
        |
        v
compose ${OP_CAP_*} subst      .openpalm/stack/core.compose.yml + addon overlays
        |
        v
service-local env vars          (SYSTEM_LLM_*, EMBEDDING_*, TTS_*, etc.)
```

### Step by step

1. **User configures capabilities** in `config/stack.yml`:
   ```yaml
   capabilities:
     llm: "anthropic/claude-sonnet-4-20250514"
     slm: "ollama/qwen2.5-coder:3b"
     embeddings:
       provider: ollama
       model: nomic-embed-text
       dims: 768
     memory:
       userId: default_user
   ```

2. **`writeCapabilityVars(spec, vaultDir)`** reads the spec and current
   `stack.env`, then for each capability:
   - Parses `"provider/model"` strings via `parseCapabilityString()`
   - Resolves the base URL from `PROVIDER_DEFAULT_URLS` (with special
     handling: Ollama in-stack addon uses `http://ollama:11434`; OpenAI
     checks for a `OPENAI_BASE_URL` override in `stack.env`)
   - Appends `/v1` to URLs for OpenAI-compatible providers (not Ollama or Google)
   - Looks up the raw API key from `stack.env` using `PROVIDER_KEY_MAP`
   - Writes `OP_CAP_<SLOT>_<FIELD>` vars

3. **Compose substitution** maps `OP_CAP_*` into service-local names:
   ```yaml
   # core.compose.yml — memory service
   environment:
     SYSTEM_LLM_PROVIDER: ${OP_CAP_LLM_PROVIDER:-}
     EMBEDDING_MODEL: ${OP_CAP_EMBEDDINGS_MODEL:-}
   ```

---

## Capability Slots

Each capability slot produces a set of `OP_CAP_<SLOT>_<FIELD>` variables.

### LLM (required)

Configured as `capabilities.llm: "provider/model"` in stack.yml.

| Variable | Content |
|---|---|
| `OP_CAP_LLM_PROVIDER` | Provider name (e.g. `openai`, `anthropic`, `ollama`) |
| `OP_CAP_LLM_MODEL` | Model identifier |
| `OP_CAP_LLM_BASE_URL` | Resolved API endpoint |
| `OP_CAP_LLM_API_KEY` | API key (from stack.env raw key) |

### SLM (optional)

Configured as `capabilities.slm: "provider/model"`. Same fields as LLM
with `SLM` prefix. Empty strings when not configured.

| Variable | Content |
|---|---|
| `OP_CAP_SLM_PROVIDER` | Provider name |
| `OP_CAP_SLM_MODEL` | Model identifier |
| `OP_CAP_SLM_BASE_URL` | Resolved API endpoint |
| `OP_CAP_SLM_API_KEY` | API key |

### Embeddings (required)

Configured as a structured object in stack.yml.

| Variable | Content |
|---|---|
| `OP_CAP_EMBEDDINGS_PROVIDER` | Provider name |
| `OP_CAP_EMBEDDINGS_MODEL` | Model identifier |
| `OP_CAP_EMBEDDINGS_BASE_URL` | Resolved API endpoint |
| `OP_CAP_EMBEDDINGS_API_KEY` | API key |
| `OP_CAP_EMBEDDINGS_DIMS` | Vector dimensions (integer) |

### TTS (optional)

Enabled via `capabilities.tts.enabled: true`. Falls back to the LLM provider
when `tts.provider` is not set.

| Variable | Content |
|---|---|
| `OP_CAP_TTS_PROVIDER` | Provider name |
| `OP_CAP_TTS_MODEL` | TTS model |
| `OP_CAP_TTS_BASE_URL` | Resolved API endpoint |
| `OP_CAP_TTS_API_KEY` | API key |
| `OP_CAP_TTS_VOICE` | Voice selection |
| `OP_CAP_TTS_FORMAT` | Output audio format |

### STT (optional)

Enabled via `capabilities.stt.enabled: true`. Falls back to the LLM provider
when `stt.provider` is not set.

| Variable | Content |
|---|---|
| `OP_CAP_STT_PROVIDER` | Provider name |
| `OP_CAP_STT_MODEL` | STT model |
| `OP_CAP_STT_BASE_URL` | Resolved API endpoint |
| `OP_CAP_STT_API_KEY` | API key |
| `OP_CAP_STT_LANGUAGE` | Language hint |

### Reranking (optional)

Enabled via `capabilities.reranking.enabled: true`. Falls back to the LLM
provider when `reranking.provider` is not set.

| Variable | Content |
|---|---|
| `OP_CAP_RERANKING_PROVIDER` | Provider name |
| `OP_CAP_RERANKING_MODEL` | Reranking model |
| `OP_CAP_RERANKING_BASE_URL` | Resolved API endpoint |
| `OP_CAP_RERANKING_API_KEY` | API key |
| `OP_CAP_RERANKING_TOP_K` | Candidates to consider |
| `OP_CAP_RERANKING_TOP_N` | Results to return |

### Memory (always present)

| Variable | Content |
|---|---|
| `MEMORY_USER_ID` | User identity for memory operations (no `OP_CAP_` prefix) |

---

## Service Consumption

Which services consume which capability slots via compose substitution:

| Service | Capabilities consumed | Notes |
|---|---|---|
| **memory** | LLM, Embeddings | LLM for fact extraction; embeddings for vector storage |
| **assistant** | LLM (provider only) | `SYSTEM_LLM_PROVIDER` for provider detection. Raw API keys passed separately for OpenCode |
| **voice** (addon) | SLM, TTS, STT | SLM for lightweight voice inference |
| **openviking** (addon) | Embeddings | Semantic search and indexing |

The assistant is a special case: it receives raw provider API keys
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) directly because OpenCode
manages its own provider configuration. Only `SYSTEM_LLM_PROVIDER` from
the capability system is passed through, used for provider detection logic.

---

## Provider Resolution Details

### Base URL resolution

`PROVIDER_DEFAULT_URLS` in `provider-constants.ts` maps each provider to its
default API endpoint. Two special cases:

- **Ollama with in-stack addon**: When the `ollama` addon is enabled in
  stack.yml, the URL resolves to `http://ollama:11434` (Docker network)
  instead of `http://host.docker.internal:11434`.
- **OpenAI base URL override**: If `OPENAI_BASE_URL` exists in stack.env,
  it takes precedence over the default.

For OpenAI-compatible providers, `/v1` is appended to the URL if not already
present. Ollama and Google are excluded from this suffix.

### API key resolution

`PROVIDER_KEY_MAP` maps provider names to the env var that holds the raw API
key in stack.env (e.g. `openai` -> `OPENAI_API_KEY`, `anthropic` ->
`ANTHROPIC_API_KEY`). Local providers (ollama, lmstudio, model-runner) have
no key mapping and resolve to empty strings.

---

## When Resolution Runs

`writeCapabilityVars()` is called during:

- **Install** (`packages/lib/src/control-plane/setup.ts`) — initial setup
- **Update** (`packages/lib/src/control-plane/config-persistence.ts`) — config changes via admin UI/API
- **Capability assignment changes** — when the user reassigns a capability to a different provider/model
