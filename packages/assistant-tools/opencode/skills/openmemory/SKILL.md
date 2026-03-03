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

Compound memory means the assistant improves over time by accumulating knowledge. Follow this pattern:

### 1. Retrieve Before Acting

**Always search memory before starting a task:**

```
memory-search({ query: "user preferences for TypeScript projects" })
memory-search({ query: "project architecture decisions" })
```

This retrieves relevant context from past sessions so you don't ask questions the user has already answered.

### 2. Learn During Interaction

**Store important facts as you discover them:**

- User preferences: "User prefers Bun over npm for package management"
- Project decisions: "OpenPalm uses SvelteKit for the control plane UI"
- Technical discoveries: "OpenCode custom tools must use 'args' not 'parameters'"
- Environment facts: "Production server runs Ubuntu 24.04 with Docker Compose"
- Behavioral preferences: "User wants concise responses, no emojis"

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

The `memory-context` plugin automatically:

1. **On compaction** — injects relevant memories into the compaction prompt so context survives window resets
2. **Shell environment** — ensures `OPENMEMORY_API_URL` and `OPENMEMORY_USER_ID` are available

## When to Use This Skill

Load this skill when:
- Starting a new session and needing to recall past context
- The user asks about their preferences or past decisions
- You need to understand the project's technical constraints
- Managing the memory store (browsing, cleaning up, reviewing what's stored)
- Diagnosing why the assistant is or isn't remembering things
