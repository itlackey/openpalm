## Implementation Plan: Enhanced Install — Provider Auto-Detection & Staged Startup

> Full plan: [`plan.md` on branch `claude/bun-cli-tool-dWvjm`](https://github.com/itlackey/openpalm/blob/claude/bun-cli-tool-dWvjm/plan.md)
> This work is combined with [#58](https://github.com/itlackey/openpalm/issues/58) (CLI management tool) into a single Bun-compiled CLI binary.

### Provider Auto-Detection

A new `lib/detect-providers.ts` module probes for available AI providers during `openpalm install`:

| Provider | Detection Method |
|----------|-----------------|
| **Ollama** | HTTP probe `http://localhost:11434/api/tags` — parse available model list |
| **LM Studio** | HTTP probe `http://localhost:1234/v1/models` — parse available model list |
| **Anthropic** | Check `ANTHROPIC_API_KEY` env var |
| **OpenAI** | Check `OPENAI_API_KEY` env var |
| **Existing opencode config** | Scan `~/.config/opencode/`, `~/.opencode/`, `./opencode.jsonc` for provider settings |

Results are written to `$OPENPALM_DATA_HOME/admin/detected-providers.json` so the admin setup wizard can pre-populate provider configuration — eliminating manual API URL/key entry for common providers.

If an existing opencode config is found, the installer offers to import its settings.

### Small Model Selection

When multiple providers with small models are detected, the installer prompts the user to select one for `OPENPALM_SMALL_MODEL`. Example:

```
Detected AI providers:
  ✓ Anthropic (API key found)
  ✓ Ollama (running locally — 3 models available)
  ✓ OpenAI (API key found)

Select a small model for fast operations:
  1) ollama/llama3.2:3b (local, free)
  2) anthropic/claude-haiku-4-5 (API)
  3) openai/gpt-4o-mini (API)
  >
```

### Staged Install Flow

The `openpalm install` command implements a 4-phase startup so users get to the setup wizard as fast as possible:

```
Phase 1: Setup infrastructure
  → Generate .env, create XDG directories, seed configs
  → Detect AI providers, write seed data to admin seed file

Phase 2: Early UI access
  → Pull caddy + admin + postgres images only
  → Start caddy + admin + postgres
  → Wait for admin health check
  → Open browser to setup wizard immediately

Phase 3: Background pull (user is in the wizard)
  → Pull remaining images in the background:
    opencode-core, gateway, openmemory, qdrant, controller, channels
  → User completes setup (API keys, provider config, model selection)
    while downloads happen

Phase 4: Full stack
  → Start all remaining services
  → Print final status summary with service URLs
```

This significantly reduces time-to-first-interaction since only ~3 small images need to pull before the wizard opens, versus the current flow which pulls all ~12 images before showing anything.

### Acceptance Criteria Coverage

- [x] **Auto-detect and pre-configure providers** — Ollama, LM Studio, OpenAI, Anthropic detected and seeded
- [x] **Prompt for model selection** — interactive small model picker during install
- [x] **Launch wizard early; finish downloads in background** — 4-phase staged startup
- [x] **Detect and offer opencode config import** — scans standard config locations
- [ ] **Update documentation** — will be done in the implementation PR

### Key Files

| File | Purpose |
|------|---------|
| `cli/src/lib/detect-providers.ts` | Provider detection logic |
| `cli/src/commands/install.ts` | Staged install flow with provider seeding |
| `cli/src/lib/ui.ts` | Interactive prompts (model selection) |
