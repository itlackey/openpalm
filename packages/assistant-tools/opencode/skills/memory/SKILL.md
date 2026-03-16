---
name: memory
description: Memory integration guide — compound memory, automatic context retrieval, and memory management for the OpenPalm assistant
license: MIT
compatibility: opencode
metadata:
  audience: assistant
  workflow: memory-management
---

## What This Skill Does

This skill teaches you how to use the memory service — the persistent, semantic memory layer that makes you smarter over time. It stores facts, preferences, decisions, and context that persist across sessions. You should actively use memory to provide better, more personalized assistance.

## Architecture

The memory service runs in the OpenPalm stack:

| Service | Port | Role |
|---------|------|------|
| `memory` | 8765 | Bun-based OpenPalm memory API backed by SQLite and `sqlite-vec` |

The assistant connects to `http://memory:8765` via REST API. The service
wraps the local `@openpalm/memory` library and preserves the older REST surface
for compatibility. Configuration is read from `/app/default_config.json`.

## Available Tools

### Core Memory Operations

| Tool | Description |
|------|-------------|
| `memory-search` | **Semantic search** — find relevant memories by meaning, not keywords. Use this FIRST before starting any task. |
| `memory-add` | **Store a memory** — save facts, preferences, decisions, or context. The system auto-extracts and deduplicates. |
| `memory-list` | **Browse memories** — paginated list with text filtering and sorting. |
| `memory-get` | **Inspect a memory** — get full details by UUID including categories and metadata. |
| `memory-update` | **Correct a memory** — update content when facts change. |
| `memory-delete` | **Remove memories** — delete by UUID when information is wrong or user asks to forget. |
| `memory-feedback` | **Reinforce/demote memory quality** — submit positive/negative outcomes for injected memories. |
| `memory-exports_create` | **Create export job** — start a snapshot/audit export pipeline. |
| `memory-exports_get` | **Inspect export job** — fetch export status/details by export id. |
| `memory-events_get` | **Poll async event** — check completion state for async memory operations. |

### Memory Management

| Tool | Description |
|------|-------------|
| `memory-apps_list` | List all apps/clients contributing memories with counts. |
| `memory-apps_get` | Get details for a specific app. |
| `memory-apps_memories` | List memories created by a specific app. |
| `memory-stats` | Quick overview: total memories and app count. |

## Compound Memory Pattern

Compound memory means the assistant improves over time by accumulating knowledge. Core retrieval, reinforcement, synthesis, and hygiene are automated by the memory lifecycle plugin; manual tools remain available for targeted edits.

### 1. Retrieve Before Acting (Automated)

On session start, the plugin automatically retrieves relevant semantic, episodic, and procedural memories and injects them as context. You can still search explicitly for deeper or more specific context:

```
memory-search({ query: "user preferences for TypeScript projects" })
memory-search({ query: "project architecture decisions" })
```

### 2. Learn During Interaction (Automated)

During session activity, the plugin tracks command and tool outcomes, reinforces successful procedural memories, records repeated failures as cautionary procedural memories, and stores episodic summaries at session end. You can still add memories manually for anything automation misses:

```
memory-add({ text: "User prefers Bun over npm", metadata: '{"category":"semantic"}' })
memory-add({ text: "When deploying channels: check registry first", metadata: '{"category":"procedural"}' })
```

### 3. Update When Things Change

**Correct memories when facts evolve:**

```
memory-update({ memory_id: "uuid", memory_content: "Updated fact..." })
```

### 4. Clean Up Bad Data

**Delete incorrect or outdated memories:**

```
memory-delete({ memory_ids: "uuid1,uuid2" })
```

Memory hygiene also runs automatically (dedupe + stale pruning) with conservative safety rules.

## What to Remember

### Always Store:
- **User preferences** — coding style, tool choices, communication style
- **Project architecture decisions** — tech stack, patterns, constraints
- **Environment details** — OS, runtime versions, deployment targets
- **Bug patterns** — what went wrong and how it was fixed
- **Domain knowledge** — business rules, terminology, workflows
- **Discoveries** — undocumented behaviors, workarounds, gotchas

### Never Store:
- **Secrets** — API keys, passwords, tokens
- **Ephemeral state** — current git branch, temp file paths
- **Obvious facts** — things any LLM would know
- **Raw code** — store the decision/pattern, not the implementation

## Writing Good Memories

Write memories as clear, self-contained statements that will make sense out of context:

**Good:**
- "User prefers TypeScript with strict mode enabled for all projects"
- "OpenPalm admin API authenticates with x-admin-token header, not Authorization Bearer"
- "The assistant container uses OPENCODE_CONFIG_DIR=/etc/opencode for immutable config"

**Bad:**
- "Use TypeScript" (too vague)
- "The bug was fixed" (no context)
- "See the code in admin-containers.ts" (not self-contained)

## Automatic Behavior

The `memory-context` plugin provides full lifecycle automation:

### On Session Start (`session.created`)
- Retrieves scoped memories in parallel:
  - personal semantic + procedural
  - project/app scoped context (`app_id`)
  - stack procedural (`user_id=openpalm`)
  - optional global procedures (`user_id=global`)
- Runs scheduled hygiene (dedupe + stale pruning with pinned/immutable protection)
- Runs periodic cross-session synthesis from episodic outcomes

### During Interaction (`session.idle`)
- Periodically consolidates tracked tool outcomes into procedural memories
- Reinforces high-success patterns and stores cautionary notes for repeated failures
- Uses novelty checks to avoid duplicate low-value writes

### Before Tool Execution (`tool.execute.before`)
- For admin operation tools, retrieves stack procedural memory only (`user_id=openpalm`)
- For project/code tools, retrieves personal procedural + project-scoped memory
- Captures injected memory ids to drive post-tool outcome feedback

### After Tool Execution (`tool.execute.after`)
- Emits positive feedback when execution succeeds
- Emits negative feedback with a short reason when execution fails

### On Compaction (`experimental.session.compacting`)
- Injects only high-signal memories (pinned/immutable/high-confidence/positive-feedback-biased)
- Preserves session state metadata so context survives window resets

### On Session End (`session.deleted`)
- Stores an episodic summary of tool outcomes for cross-session learning
- Cleans up per-session tracking state

### Shell Environment
- Ensures `MEMORY_API_URL` and `MEMORY_USER_ID` are available to child processes

## Memory Categories

All memories are tagged with a category in their metadata:

| Category | Tag | What to Store | Examples |
|----------|-----|--------------|----------|
| **Semantic** | `[semantic]` | Facts, preferences, knowledge | "User prefers Bun over npm" |
| **Episodic** | `[episodic]` | Session events, outcomes, errors | "Restarted memory service to fix dimension mismatch" |
| **Procedural** | `[procedural]` | Workflows, patterns, how-tos | "When adding a channel: check registry, install, verify health" |

### Confidence Scoring

Memories carry a confidence value (0.0-1.0):
- **Manual** memories (via `memory-add`): default 1.0
- **Automated procedural consolidation**: dynamic confidence based on observed success/failure rates
- **Cross-session synthesis**: moderate confidence, then reinforced via outcome feedback

## When to Use This Skill

Load this skill when:
- You need to understand how the automated memory system works
- The user asks about their preferences or past decisions
- You need to understand the project's technical constraints
- Managing the memory store (browsing, cleaning up, reviewing what's stored)
- Diagnosing why the assistant is or isn't remembering things
- You want to manually add memories the auto-extraction might miss
