---
name: openmemory
description: OpenMemory integration guide — compound memory, automatic context retrieval, and memory management for the OpenPalm assistant
license: MIT
compatibility: opencode
metadata:
  audience: assistant
  workflow: memory-management
---

## What This Skill Does

This skill teaches you how to use OpenMemory — the persistent, semantic memory layer that makes you smarter over time. OpenMemory stores facts, preferences, decisions, and context that persist across sessions. You should actively use memory to provide better, more personalized assistance.

## Architecture

OpenMemory runs as a service in the OpenPalm stack:

| Service | Port | Role |
|---------|------|------|
| `openmemory` | 8765 | FastAPI server with vector search (Qdrant) + relational DB (Postgres) |
| `openmemory-ui` | 3001 | Dashboard for browsing/managing memories |
| `qdrant` | 6333 | Vector database for semantic similarity search |
| `postgres` | 5432 | Relational store for memory metadata, access logs, app tracking |

The assistant connects to `http://openmemory:8765` via REST API.

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

### Memory Management

| Tool | Description |
|------|-------------|
| `memory-apps_list` | List all apps/clients contributing memories with counts. |
| `memory-apps_get` | Get details for a specific app. |
| `memory-apps_memories` | List memories created by a specific app. |
| `memory-stats` | Quick overview: total memories and app count. |

## Compound Memory Pattern

Compound memory means the assistant improves over time by accumulating knowledge. Steps 1 and 2 are now **automated** by the memory-context plugin, but you can still perform them manually for targeted operations.

### 1. Retrieve Before Acting (Automated)

On session start, the plugin automatically retrieves relevant semantic, episodic, and procedural memories and injects them as context. You can still search explicitly for deeper or more specific context:

```
memory-search({ query: "user preferences for TypeScript projects" })
memory-search({ query: "project architecture decisions" })
```

### 2. Learn During Interaction (Automated)

When you finish responding, the plugin automatically extracts important learnings from the conversation and stores them with the appropriate category. You can still add memories manually for things the auto-extraction might miss:

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
memory-delete({ memory_ids: ["uuid1", "uuid2"] })
```

Memory hygiene checks also run automatically once per day, prompting you to review duplicates and stale entries.

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
- "The assistant container uses OPENCODE_CONFIG_DIR=/opt/opencode for immutable config"

**Bad:**
- "Use TypeScript" (too vague)
- "The bug was fixed" (no context)
- "See the code in admin-containers.ts" (not self-contained)

## Automatic Behavior

The `memory-context` plugin provides full lifecycle automation:

### On Session Start (`session.created`)
- Retrieves relevant semantic, procedural, and episodic memories in parallel
- Injects project-specific context if the working directory is identified
- Runs a daily memory hygiene check (detects duplicates and stale entries)
- Triggers cross-session reflexion when enough episodes have accumulated (every ~10 sessions)

### During Interaction (`session.idle`)
- After the agent finishes responding (throttled to once per 60 seconds, skipping single-turn interactions)
- Automatically reflects on the conversation and extracts learnings using the LLM
- Categorises memories as semantic, episodic, or procedural
- Transparently acknowledges key learnings to the user

### Before Tool Execution (`tool.execute.before`)
- For admin operation tools, searches for relevant procedural memories
- Injects past procedures and patterns as guidance before the tool runs

### On Compaction (`experimental.session.compacting`)
- Injects categorised memories (semantic + procedural) into the compaction context
- Preserves session state metadata so context survives window resets

### On Session End (`session.deleted`)
- Stores an episodic summary of the session for cross-session learning
- Cleans up per-session tracking state

### Shell Environment
- Ensures `OPENMEMORY_API_URL` and `OPENMEMORY_USER_ID` are available to child processes

## Memory Categories

All memories are tagged with a category in their metadata:

| Category | Tag | What to Store | Examples |
|----------|-----|--------------|----------|
| **Semantic** | `[semantic]` | Facts, preferences, knowledge | "User prefers Bun over npm" |
| **Episodic** | `[episodic]` | Session events, outcomes, errors | "Restarted openmemory to fix dimension mismatch" |
| **Procedural** | `[procedural]` | Workflows, patterns, how-tos | "When adding a channel: check registry, install, verify health" |

### Confidence Scoring

Memories carry a confidence value (0.0–1.0):
- **Manual** memories (via `memory-add` tool): 1.0
- **Auto-extracted** (session.idle): 0.7
- **Reflexion** insights (cross-session synthesis): 0.5

### Cross-Session Reflexion

When enough episodic memories accumulate for a project (~5+ episodes), the plugin asks the LLM to synthesise higher-level insights — recurring patterns, successful approaches, and lessons learned. These are stored as semantic or procedural memories with `source: "reflexion"`.

## When to Use This Skill

Load this skill when:
- You need to understand how the automated memory system works
- The user asks about their preferences or past decisions
- You need to understand the project's technical constraints
- Managing the memory store (browsing, cleaning up, reviewing what's stored)
- Diagnosing why the assistant is or isn't remembering things
- You want to manually add memories the auto-extraction might miss
