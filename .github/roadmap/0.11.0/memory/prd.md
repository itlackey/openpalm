# Product Requirements Document: `mem` — Epistemic Memory CLI for AI Agents

**Version:** 0.2.0-draft  
**Date:** March 22, 2026  
**Authors:** IT (Dimm City / OpenPalm)  
**Status:** Draft for Research Implementation  
**Changes from v1:** Entity-relationship graph moved from OpenViking filesystem objects to embedded SQLite via `bun:sqlite`. All memory content remains in OpenViking. SQLite serves as a derived, rebuildable index for relational entity queries.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement & Motivation](#2-problem-statement--motivation)
3. [Prior Art & Landscape Analysis](#3-prior-art--landscape-analysis)
4. [Design Principles](#4-design-principles)
5. [Architecture Overview](#5-architecture-overview)
6. [Command Surface & API Design](#6-command-surface--api-design)
7. [Core Subsystems](#7-core-subsystems)
8. [Data Model & Storage Conventions](#8-data-model--storage-conventions)
9. [Agent Integration Patterns](#9-agent-integration-patterns)
10. [Known Gaps & Challenges](#10-known-gaps--challenges)
11. [Performance & Quality Considerations](#11-performance--quality-considerations)
12. [Evaluation Framework & Benchmarks](#12-evaluation-framework--benchmarks)
13. [Implementation Roadmap](#13-implementation-roadmap)
14. [Appendix: Configuration Schema](#14-appendix-configuration-schema)
15. [References](#15-references)

---

## 1. Executive Summary

`mem` is a Bun.js CLI tool that adds epistemic memory capabilities — classification of knowledge by type, multi-strategy retrieval, temporal fact management, entity-relationship tracking, disposition-conditioned reasoning, and learned relevance scoring — on top of OpenViking's filesystem-based context database. It is designed to be invoked by any CLI-capable AI agent (OpenCode, Claude Code, Cursor, LangGraph, custom loops) and provides a framework-agnostic memory substrate that closes the architectural gaps between OpenViking's hierarchical context management and the state-of-the-art capabilities demonstrated by Hindsight, Zep/Graphiti, and Mem0.

The core thesis is that OpenViking's filesystem paradigm — with its `viking://` URI scheme, L0/L1/L2 tiered context loading, and directory recursive retrieval — provides the best structural foundation for agent memory, but lacks the epistemic classification, temporal reasoning, relationship modeling, and adaptive scoring that benchmark-leading systems provide through heavier infrastructure (PostgreSQL, Neo4j, dedicated graph engines). `mem` bridges this gap with approximately 1,200 lines of TypeScript, adding cognitive capabilities through filesystem conventions for memory storage and a local SQLite database (via Bun's built-in `bun:sqlite`) for the entity-relationship graph — the one subsystem where relational queries are fundamentally better suited than filesystem operations. No external database processes are required; the SQLite file is a zero-dependency, embedded artifact managed entirely by the CLI.

---

## 2. Problem Statement & Motivation

### 2.1 The Agent Memory Problem

Current-generation AI agents suffer from five categories of memory failure that directly impact task completion, consistency, and user trust:

1. **Epistemic confusion.** Agents cannot distinguish between what they observed, what they concluded, and what they believe. When an agent retrieves "the API uses OAuth2" alongside "I think the rate limit is too low," both arrive as undifferentiated context. Hindsight's research demonstrates that structurally separating evidence from inference — organizing memory into world facts, agent experiences, synthesized observations, and evolving opinions — improves accuracy on LongMemEval from 39.0% to 91.4% with an open-source 20B model [Latimer et al., 2025].

2. **Flat retrieval.** Standard vector similarity search returns the top-K most semantically similar fragments regardless of their structural context. An agent asking about authentication might retrieve a semantically similar but operationally irrelevant passage from an unrelated project. OpenViking's directory recursive retrieval partially addresses this by constraining search within hierarchical directories, but it relies on a single retrieval strategy per query. Hindsight's TEMPR system runs four parallel strategies (semantic, BM25, graph traversal, temporal filtering) fused with Reciprocal Rank Fusion, achieving significantly higher recall than any single strategy [Latimer et al., 2025].

3. **Temporal blindness.** Without temporal validity tracking, agents treat all retrieved facts as equally current. If "Alice manages the API team" was stored in January and "Bob manages the API team" in March, both facts have equal retrieval weight. Zep/Graphiti addresses this through bitemporal modeling — tracking both event time and ingestion time for every node and edge — enabling precise reasoning about what was true at any point [Rasmussen et al., 2025].

4. **Disconnected entities.** Agents cannot reason about relationships between entities. Knowing "Alice works at Google" and "Google's headquarters is in Mountain View" should enable answering "Where does Alice work?" even if that composite fact was never explicitly stored. Graph-based systems like Graphiti model these relationships as typed, directional edges with temporal validity [Rasmussen et al., 2025].

5. **Static relevance.** Retrieved memories have no signal about whether they were previously useful. A fact that was retrieved ten times and led to successful outcomes is weighted the same as a fact that was retrieved once and led to a correction. MemRL-inspired approaches suggest that reinforcement-based scoring — strengthening traces that contribute to good outcomes — can significantly improve retrieval precision over time [Yan et al., 2025].

### 2.2 Why OpenViking + CLI

OpenViking (by ByteDance/Volcengine, Apache 2.0) addresses the structural foundation of agent memory better than any competing system. Its filesystem paradigm with `viking://` URIs provides navigable, hierarchical context organization. Its L0/L1/L2 tiered loading achieves 91% token cost reduction while improving task completion by 43% over baseline [OpenViking README, LoCoMo10 benchmarks]. Its directory recursive retrieval preserves global context structure during search. Its retrieval trajectory visualization provides unique debugging observability.

However, OpenViking does not provide epistemic classification, multi-strategy retrieval fusion, temporal fact validity, entity-relationship graphs, disposition-conditioned reasoning, or learned relevance scoring. These capabilities exist in other systems — Hindsight, Zep/Graphiti, Mem0 — but those systems require PostgreSQL, Neo4j, or other heavyweight infrastructure and are not filesystem-based.

A Bun.js CLI that adds these capabilities as filesystem conventions within OpenViking provides several advantages over framework-specific integrations:

- **Framework agnosticism.** Any agent that can execute a shell command gets the full memory stack. OpenCode defines a tool that shells out to `mem recall`. Claude Code calls it from its sandbox. A LangGraph node invokes it via subprocess. The integration surface is universally available.
- **Composability with existing tooling.** The `akm` (Agent-i-Kit) CLI already supports OpenViking as a first-class stash provider. `mem` operates on the same `viking://` namespace without conflict — akm manages `viking://resources/` and `viking://agent/skills/`, while `mem` manages `viking://agent/memory/`. The entity-relationship graph lives in a local SQLite database outside of OpenViking, cleanly separating content storage (OpenViking) from relational indexing (SQLite).
- **Self-hosted simplicity.** The only infrastructure dependency is a running OpenViking server, which itself runs as a single process. The entity graph uses `bun:sqlite` (Bun's built-in SQLite driver), which requires no external process — it's an embedded database file at `~/.local/share/mem/entities.db`. No PostgreSQL, no Neo4j, no additional services.
- **Testability.** CLI tools are trivially testable from shell scripts, CI pipelines, and evaluation harnesses.

---

## 3. Prior Art & Landscape Analysis

### 3.1 Systems Compared

| System | Architecture | Epistemic Classification | Retrieval Strategy | Temporal Model | Entity Graph | OpenCode Support | Self-Hosted | License |
|--------|-------------|------------------------|-------------------|---------------|-------------|-----------------|-------------|---------|
| **Hindsight** | 4-network memory bank + PostgreSQL | World/Experience/Opinion/Observation | TEMPR: 4-way parallel + RRF + reranker | Entity-aware timestamps | Entity-relationship via PostgreSQL | Skills only (`npx skills add`) | Docker (single container) | MIT |
| **OpenViking** | Filesystem hierarchy + vector DB | None (domain-based only) | Directory recursive (single strategy) | File timestamps only | None (PR pending) | Native plugin + npm package | Python server | Apache 2.0 |
| **Zep/Graphiti** | Temporal knowledge graph + Neo4j | None | Semantic + BM25 + BFS graph traversal | Bitemporal (event + ingestion time) | Full Neo4j graph | None | Cloud or self-hosted | Apache 2.0 (Graphiti) |
| **Mem0** | Vector + optional graph layer | None | Semantic + optional graph | Decay/confidence metadata | Optional (Pro tier) | None | Managed or self-hosted | Apache 2.0 |
| **Letta/MemGPT** | LLM-as-OS with memory tiers | None (block-based) | Agent-controlled tool calls | None | None | Letta Code (own runtime) | Docker + PostgreSQL | Apache 2.0 |

### 3.2 Benchmark Reference Points

The primary benchmarks used to evaluate agent memory systems are LongMemEval and LoCoMo. These test different aspects of long-horizon conversational memory:

**LongMemEval** evaluates multi-session recall, temporal reasoning, knowledge updates, and open-domain questions across conversations spanning up to 1.5 million tokens.

| System | LongMemEval Overall | Multi-Session | Temporal | Knowledge Update |
|--------|-------------------|--------------|----------|-----------------|
| Hindsight (Mistral-Small-24B) | 83.6% | 79.7% | 79.7% | 84.6% |
| Hindsight (scaled backbone) | 91.4% | — | — | — |
| Full-context GPT-4o | 60.2% | — | — | — |
| Full-context OSS-20B | 39.0% | 21.1% | 31.6% | 60.3% |

*Source: Latimer et al., "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects," arXiv:2512.12818, December 2025.*

**LoCoMo** (Long-range Conversational Memory) tests fact retrieval, preference tracking, and multi-hop reasoning across extended dialogue histories.

| System | LoCoMo Overall |
|--------|---------------|
| Hindsight (best) | 89.61% |
| Prior best open system | 75.78% |
| Mem0 (graph variant) | 68.5% (self-reported) |
| Mem0 (base) | ~49.0% (LongMemEval) |
| OpenViking + OpenClaw | 52.08% (with 91% token reduction) |
| OpenViking + OpenClaw (no native memory) | 35.65% baseline → 52.08% |

*Sources: Latimer et al. (2025); Chhikara et al., "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory," arXiv:2504.19413, 2025; OpenViking README LoCoMo10 benchmarks.*

### 3.3 Key Architectural Insights from Prior Art

**From Hindsight:** The four-network epistemic separation (world/experience/opinion/observation) is the single highest-impact architectural decision for memory quality. The CARA disposition system (skepticism/literalism/empathy as tunable parameters) addresses a problem no other system tackles — consistent interpretive stance across sessions. TEMPR's multi-strategy retrieval with Reciprocal Rank Fusion is well-established in IR literature and straightforward to implement.

**From Zep/Graphiti:** Bitemporal modeling (event time + ingestion time) is essential for domains with evolving facts. The invalidation-not-deletion approach to superseded facts preserves historical accuracy. However, the Neo4j dependency is heavyweight for single-user/small-team deployments.

**From Mem0:** The extraction-update pipeline (two-phase: extract salient facts, then consolidate/deduplicate) is a clean abstraction. The Mem0ᵍ graph variant demonstrates that entity relationships improve multi-hop reasoning even when stored alongside flat vector memories. However, Mem0 doesn't distinguish fact types epistemically.

**From Letta/MemGPT:** The core/recall/archival memory hierarchy (analogous to RAM/cache/disk) is an effective mental model but couples memory management to a specific agent runtime. The self-editing memory pattern (agent decides what to remember) is powerful but unpredictable — memory quality depends entirely on model judgment.

**From OpenViking:** The filesystem paradigm is uniquely navigable and observable. L0/L1/L2 tiered loading is the best token management approach in the space. Directory recursive retrieval preserves structural context during search. The `viking://` URI scheme provides stable, addressable references to all context.

---

## 4. Design Principles

### 4.1 Filesystem-Native Memory, Relational Entity Index

Memory content — classified facts, experiences, opinions, observations, supersession records, disposition configuration — is stored as OpenViking filesystem objects accessible via `viking://` URIs. This ensures that OpenViking's L0/L1/L2 abstraction, directory recursive retrieval, and observability features apply to all memory data. Agents navigate memory with `ls`, `find`, and `read` — the same operations they use for all other context.

The entity-relationship graph is stored in a local SQLite database (`~/.local/share/mem/entities.db`) via Bun's built-in `bun:sqlite` driver. This is a deliberate exception to the filesystem-first principle, motivated by three concrete problems that filesystem storage creates for graph data: multi-hop traversal requires O(hops × fan-out) sequential file reads, conflict detection during ingestion requires indexed entity lookups on every write, and relationship queries (joins across entities, relationships, and mentions) are the fundamental operation of a relational engine, not a filesystem.

**Rationale:** The entity graph is a *derived index* of what's in OpenViking, not a separate source of truth. If the SQLite file is deleted, `mem index rebuild` re-scans all memory files in OpenViking and reconstructs the entity graph from canonical content. This preserves OpenViking as the single source of truth while using the right tool for relational queries. SQLite via `bun:sqlite` adds zero deployment complexity — no external process, no configuration, no port binding — making it effectively as simple to operate as a local file.

### 4.2 Convention over Infrastructure

`mem` achieves capabilities that other systems require dedicated infrastructure for (graph databases, temporal engines) through filesystem conventions and embedded storage: directory structures for epistemic classification, naming conventions for fact versioning, JSON frontmatter for confidence scores and temporal validity, and an embedded SQLite database for entity-relationship queries. The only external dependency is OpenViking itself.

**Rationale:** The target deployment is a self-hosted, single-user or small-team agent platform. At this scale, Neo4j or a dedicated graph service is overhead that exceeds the problem's complexity. SQLite provides the relational query capability needed for entity graphs without any operational burden — it's a file, not a service. Filesystem conventions handle everything else.

### 4.3 Agent-Agnostic CLI Interface

`mem` exposes its capabilities as CLI commands that return structured JSON by default. Any agent framework that can execute a subprocess and parse stdout can use the full memory stack. Thin wrapper integrations for specific frameworks (OpenCode plugins, Claude Code slash commands, MCP tool definitions) are generated from the CLI surface, not hand-coded.

**Rationale:** The agent framework landscape is evolving rapidly. Building native integrations for each framework creates maintenance burden and framework lock-in. A CLI is universally accessible, testable, and composable.

### 4.4 Incremental Adoption

Each subsystem (epistemic classification, multi-strategy retrieval, temporal validity, entity graph, disposition, scoring) is independently valuable and can be adopted incrementally. An agent using only `mem retain` and `mem recall` gets epistemic classification and multi-strategy retrieval without needing entity graphs or scoring.

**Rationale:** All-or-nothing adoption creates deployment risk. Incremental adoption lets teams validate each capability independently and roll back if needed.

---

## 5. Architecture Overview

### 5.1 System Context

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Layer                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ OpenCode │  │Claude    │  │ Cursor   │  │ Custom │  │
│  │ Plugin   │  │Code Cmd  │  │ Rule     │  │ Agent  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │              │              │             │       │
│       └──────────────┼──────────────┼─────────────┘       │
│                      │ subprocess / shell                 │
└──────────────────────┼───────────────────────────────────┘
                       │
┌──────────────────────┼───────────────────────────────────┐
│                 mem CLI (Bun.js)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │  Epistemic   │ │  Retrieval   │ │    Entity        │  │
│  │  Tagger      │ │  Orchestrator│ │    Manager       │  │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘  │
│         │                │                   │            │
│  ┌──────┴───────┐ ┌──────┴───────┐ ┌────────┴─────────┐  │
│  │  Temporal    │ │  Disposition │ │    Relevance     │  │
│  │  Validator   │ │  Engine      │ │    Scorer        │  │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘  │
│         │                │                   │            │
│         └──────────┬─────┴───────────┬───────┘            │
│              HTTP API │         bun:sqlite │               │
└──────────────────────┼───────────────┼───────────────────┘
                       │               │
┌──────────────────────┼───────┐ ┌─────┼───────────────────┐
│      OpenViking Server       │ │  SQLite (embedded)      │
│  ┌──────────┐ ┌────────────┐ │ │  ~/.local/share/mem/    │
│  │ VikingFS │ │ Vector DB  │ │ │  └── entities.db        │
│  │(Memories)│ │ (Search)   │ │ │  ┌────────────────────┐ │
│  └──────────┘ └────────────┘ │ │  │ entities           │ │
│  ┌──────────────────────────┐│ │  │ relationships      │ │
│  │  Session Mgmt            ││ │  │ mentions           │ │
│  │  (Memory Extraction)     ││ │  └────────────────────┘ │
│  └──────────────────────────┘│ │  (derived index,        │
└──────────────────────────────┘ │   rebuildable from OV)  │
                                 └─────────────────────────┘
```

### 5.2 Data Flow

**Ingestion (retain):**
```
Content → Epistemic Tagger (LLM classify) → Type-routed directory write →
  → Entity Extractor (LLM extract) → SQLite entity index upsert →
  → Conflict Detector (SQLite entity lookup + search existing facts) → Supersession if needed →
  → OpenViking write (content + metadata)
```

**Retrieval (recall):**
```
Query → Query Analyzer (temporal refs? entity mentions?) →
  → Parallel retrieval strategies:
    ├── Semantic: OpenViking find (vector similarity)
    ├── Keyword: OpenViking text search
    ├── Temporal: Date-range filtered search
    └── Entity: SQLite graph traversal → URI collection → targeted OpenViking reads
  → Reciprocal Rank Fusion (merge + score) →
  → Relevance weighting (apply learned scores) →
  → L0/L1/L2 progressive loading (token budget) →
  → Disposition framing (prepend interpretive context) →
  → Structured JSON output
```

**Reflection (reflect):**
```
Query → Recall (full pipeline above) →
  → Disposition config loaded →
  → LLM reflection prompt (query + retrieved context + disposition) →
  → Synthesized response →
  → Optional: new observations written back via retain
```

---

## 6. Command Surface & API Design

### 6.1 Core Memory Operations

#### `mem retain`

Ingests content into the memory system with epistemic classification, entity extraction, and conflict detection.

```bash
# Basic retain — auto-classifies epistemic type
mem retain "Alice was promoted to senior engineer in March"

# Explicit type override
mem retain "I think our API rate limits are too aggressive" --type opinion --confidence 0.7

# With context (aids classification and entity extraction)
mem retain "The deploy script failed on the staging server" --context "debugging session"

# From stdin (for piping agent transcripts)
echo "Meeting notes from sprint planning..." | mem retain --context "sprint-42"

# With timestamp (for historical data ingestion)
mem retain "Q3 revenue was $2.4M" --timestamp "2025-10-01T00:00:00Z"
```

**Output (JSON):**
```json
{
  "action": "retained",
  "uri": "viking://agent/memory/world/alice-promotion.md",
  "type": "world",
  "confidence": null,
  "entities_extracted": ["alice", "senior-engineer"],
  "conflicts_detected": [],
  "superseded": []
}
```

**Processing pipeline:**
1. If `--type` is not provided, invoke the LLM epistemic classifier
2. Extract entities and relationships from content
3. Search existing facts for entity overlap (conflict detection)
4. If conflicts found, invoke LLM conflict resolver → supersede or coexist
5. Write content to appropriate epistemic directory with metadata
6. Update SQLite entity index (upsert entities, relationships, mentions)
7. Return structured result

#### `mem recall`

Retrieves memories using multi-strategy search with Reciprocal Rank Fusion.

```bash
# Basic recall — runs all applicable strategies
mem recall "What does Alice do?"

# Specific strategies only
mem recall "authentication changes last week" --strategies semantic,temporal

# With token budget (controls L0/L1/L2 expansion)
mem recall "project architecture" --budget 4000

# Entity-focused recall
mem recall "Alice" --strategies entity --hops 2

# Filter by epistemic type
mem recall "rate limits" --type opinion

# Output format options
mem recall "deploy process" --format human   # Pretty-printed for terminal
mem recall "deploy process" --format context  # Pre-formatted for LLM injection
```

**Output (JSON, default):**
```json
{
  "action": "recalled",
  "query": "What does Alice do?",
  "strategies_used": ["semantic", "keyword", "entity"],
  "results": [
    {
      "uri": "viking://agent/memory/world/alice-promotion.md",
      "type": "world",
      "content": "Alice was promoted to senior engineer in March 2026",
      "level": "L1",
      "scores": {
        "semantic": 0.89,
        "keyword": 0.72,
        "entity": 1.0,
        "fused": 0.87,
        "relevance_weight": 1.2
      },
      "temporal": {
        "created": "2026-03-15T10:00:00Z",
        "valid": true,
        "supersedes": null
      },
      "entities": ["alice", "senior-engineer"]
    }
  ],
  "tokens_used": 847,
  "budget_remaining": 3153
}
```

**Output (context format, for LLM injection):**
```
## Retrieved Context (4 memories, 847 tokens)

### World Facts
- Alice was promoted to senior engineer in March 2026 [confidence: high, source: viking://agent/memory/world/alice-promotion.md]

### Agent Experiences
- (none relevant)

### Opinions
- Our API rate limits may be too aggressive [confidence: 0.7, source: viking://agent/memory/opinions/api-rate-limits.md]

### Observations
- Alice is a key contributor to the API team with growing responsibilities [source: viking://agent/memory/observations/alice-summary.md]
```

#### `mem reflect`

Performs disposition-conditioned reasoning over retrieved memories.

```bash
# Basic reflection
mem reflect "Should we increase the API rate limits?"

# With explicit disposition override
mem reflect "Is Alice ready for a team lead role?" --skepticism 0.9 --empathy 0.3

# Generate and store new observations
mem reflect "What patterns do I see in recent deploy failures?" --store-observations
```

**Output (JSON):**
```json
{
  "action": "reflected",
  "query": "Should we increase the API rate limits?",
  "disposition": {
    "skepticism": 0.8,
    "literalism": 0.6,
    "empathy": 0.4
  },
  "response": "Based on world facts, the current rate limits are set at 1000 req/min. There is a moderately-held opinion (confidence 0.7) that these limits are too aggressive. However, no concrete evidence of customer impact has been recorded. Recommend gathering usage data before changing limits.",
  "memories_consulted": 4,
  "observations_generated": [
    {
      "uri": "viking://agent/memory/observations/rate-limit-assessment.md",
      "content": "Rate limit policy lacks supporting usage data for either direction"
    }
  ]
}
```

### 6.2 Entity Management

```bash
# List known entities
mem entity list                          # All entities
mem entity list --type person            # Filter by type
mem entity list --related-to alice       # Entities related to Alice

# Show entity detail with relationships
mem entity show alice

# Manually create or update a relationship
mem entity link alice "manages" api-team --since "2026-03-01"

# Remove a relationship (marks as invalid, preserves history)
mem entity unlink alice "manages" api-team --reason "Bob took over"

# Multi-hop traversal
mem entity traverse alice --hops 2 --format tree
```

**Entity show output:**
```json
{
  "name": "alice",
  "type": "person",
  "storage": "sqlite://entities/alice",
  "summary": "Senior engineer, manages the API team since March 2026",
  "relationships": [
    { "target": "api-team", "relation": "manages", "since": "2026-03-01", "valid": true },
    { "target": "openpalm", "relation": "contributes-to", "since": "2025-09-01", "valid": true }
  ],
  "mentions": [
    "viking://agent/memory/world/alice-promotion.md",
    "viking://resources/project-docs/team-structure.md"
  ],
  "mention_count": 7,
  "last_updated": "2026-03-20T14:22:00Z"
}
```

### 6.3 Temporal Operations

```bash
# Show what superseded a fact
mem supersede show viking://agent/memory/world/alice-role.md

# Manually supersede a fact
mem supersede viking://agent/memory/world/old-api-endpoint.md \
  --reason "API v3 migration completed"

# Timeline of an entity's facts
mem timeline alice --from "2025-01-01" --to "2026-03-22"

# Show all currently-valid facts (filter out superseded)
mem recall "api team" --valid-only
```

### 6.4 Maintenance & Scoring

```bash
# Run time-decay on relevance scores
mem score decay --half-life 30d

# Boost a specific memory's relevance (positive feedback signal)
mem score boost viking://agent/memory/world/deploy-process.md \
  --reason "Successfully used in troubleshooting"

# Penalize a memory's relevance (negative feedback signal)
mem score penalize viking://agent/memory/opinions/old-approach.md \
  --reason "Led to incorrect recommendation"

# Rebuild all indexes (entity index, relevance scores)
mem index rebuild

# Show memory statistics
mem stats
```

### 6.5 Configuration

```bash
# Show current configuration
mem config show

# Set OpenViking endpoint
mem config set openviking.endpoint http://localhost:1933

# Set disposition defaults
mem config set disposition.skepticism 0.8
mem config set disposition.literalism 0.6
mem config set disposition.empathy 0.4

# Set default LLM for classification/extraction
mem config set llm.provider ollama
mem config set llm.model mistral-small
mem config set llm.endpoint http://localhost:11434

# Set retrieval defaults
mem config set retrieval.default_strategies "semantic,keyword,temporal,entity"
mem config set retrieval.default_budget 4000
mem config set retrieval.rrf_k 60
```

---

## 7. Core Subsystems

### 7.1 Epistemic Tagger

**Purpose:** Classify incoming content into one of four epistemic types before storage.

**Classification taxonomy (derived from Hindsight's four-network model):**

| Type | Definition | Directory | Example |
|------|-----------|-----------|---------|
| `world` | Objective facts about the external environment. Verifiable, not dependent on the agent's perspective. | `viking://agent/memory/world/` | "The API uses OAuth2 for authentication" |
| `experience` | Records of the agent's own actions and their outcomes. First-person perspective. | `viking://agent/memory/experiences/` | "I ran the deploy script and it failed with exit code 1" |
| `opinion` | Subjective judgments, preferences, assessments. Include confidence score (0.0–1.0). | `viking://agent/memory/opinions/` | "The rate limits seem too aggressive for our traffic patterns" |
| `observation` | Synthesized, preference-neutral summaries of entities or patterns. Derived from multiple facts/experiences. | `viking://agent/memory/observations/` | "Alice has been consistently involved in API-related work since Q3 2025" |

**Classification implementation:**

The tagger uses a single LLM call with a structured output prompt. The prompt includes:

```
Given the following content and optional context, classify it into exactly one
epistemic type and extract a confidence score if applicable.

Types:
- world: Objective, verifiable facts about things external to the agent
- experience: Records of the agent's own actions, tool calls, and their outcomes
- opinion: Subjective judgments, preferences, or assessments (assign confidence 0.0-1.0)
- observation: Synthesized summaries derived from multiple pieces of evidence

Content: "{content}"
Context: "{context}"

Respond with JSON only:
{"type": "world|experience|opinion|observation", "confidence": null|0.0-1.0, "reasoning": "brief explanation"}
```

**Fallback behavior:** If the LLM call fails or times out, default to `world` type with a `classification: "auto-fallback"` metadata flag. This ensures retain operations never block on classifier availability.

**Validation:** The `--type` flag allows explicit override, which is important for two cases:
1. Agents that have already determined the type upstream (avoids redundant LLM call)
2. Correction of misclassified memories

### 7.2 Retrieval Orchestrator

**Purpose:** Execute multi-strategy retrieval and fuse results using Reciprocal Rank Fusion.

**Strategy implementations:**

**Semantic strategy.** Delegates to OpenViking's native `POST /api/v1/search/find` with vector similarity. This is the baseline strategy and always runs unless explicitly excluded.

**Keyword strategy.** Delegates to OpenViking's text search mode (`POST /api/v1/search/find` with `searchType: "text"`). This catches exact matches that semantic search might miss — particularly important for technical identifiers, error codes, and proper nouns.

**Temporal strategy.** Activated when the query contains temporal references. The query analyzer (a lightweight regex + LLM hybrid) extracts date ranges from phrases like "last week," "before the refactor," "in March," "since sprint 12." These are converted to ISO date ranges and applied as filters on OpenViking search results by file modification/creation timestamp.

**Entity strategy.** Activated when the query mentions known entities. Queries the SQLite entity index to resolve mentioned names to entity slugs (including alias matching), collects all associated `viking://` URIs from the `mentions` table, and retrieves those URIs directly from OpenViking. Supports multi-hop traversal via recursive CTE: if the query implies a relationship chain (e.g., "projects that Alice's team works on"), the traversal follows relationship edges for the configured number of hops (default: 2), collecting mention URIs at each hop.

**Reciprocal Rank Fusion (RRF):**

RRF is a well-established rank fusion technique [Cormack et al., 2009] that combines results from multiple strategies without requiring score normalization. For each result `d` appearing at rank `r` in strategy `s`:

```
RRF_score(d) = Σ_s  1 / (k + rank_s(d))
```

Where `k` is a smoothing constant (default: 60, following standard IR practice). Results not returned by a strategy receive no contribution from that strategy.

After RRF scoring, the relevance weight from the scoring subsystem is applied as a multiplier:

```
final_score(d) = RRF_score(d) × relevance_weight(d)
```

Results are sorted by final score descending, then L0/L1/L2 progressive loading is applied within the token budget.

**Progressive loading within token budget:**

1. Load L0 abstracts for all top-N results
2. If budget remains, expand top results to L1 overviews
3. If budget still remains, expand the highest-scored result to L2 full content
4. Continue expanding L1→L2 in score order until budget exhausted
5. Return results with the level loaded for each

### 7.3 Temporal Validator

**Purpose:** Manage fact versioning and temporal validity within the filesystem.

**Supersession model:**

When a new world fact conflicts with an existing one (detected by entity overlap + LLM conflict resolution), the old fact is:

1. Moved to a `superseded/` subdirectory within the same epistemic directory
2. Renamed with a timestamp suffix: `{original-name}.{ISO-date}.md`
3. A metadata link is added to the new fact pointing to the superseded URI
4. A metadata link is added to the superseded fact pointing to the new URI

Example filesystem state:
```
viking://agent/memory/world/
├── api-team-lead.md                          # Current: "Bob manages the API team"
│   metadata: { supersedes: "viking://agent/memory/world/superseded/api-team-lead.2026-01-15.md" }
└── superseded/
    └── api-team-lead.2026-01-15.md           # Previous: "Alice manages the API team"
        metadata: { superseded_by: "viking://agent/memory/world/api-team-lead.md",
                    valid_from: "2025-06-01", valid_until: "2026-03-01" }
```

**Conflict detection prompt:**

```
You are evaluating whether a new fact conflicts with an existing fact about the same entities.

New fact: "{new_content}"
Existing fact: "{existing_content}"
Shared entities: {entity_list}

Determine:
1. Do these facts describe the same relationship or attribute?
2. If yes, does the new fact update/replace the existing one, or can they coexist?

Respond with JSON only:
{"conflicts": true|false, "resolution": "supersede|coexist", "reasoning": "brief explanation"}
```

**Bitemporal approximation:** Full bitemporal modeling (Graphiti-style event time + ingestion time) would require storing two timestamps per fact and querying across both dimensions. The filesystem convention approximates this with:
- `created_at` metadata: when the fact was ingested (ingestion time)
- `valid_from` / `valid_until` metadata on superseded facts (event time approximation)
- The `--timestamp` flag on `mem retain` for backdating event time

This covers the 80% case — knowing what's current and being able to look back — without the query complexity of full bitemporal joins.

### 7.4 Entity Manager

**Purpose:** Maintain an entity-relationship graph in an embedded SQLite database, providing indexed lookups, multi-hop traversal, and relationship queries that filesystem storage cannot efficiently support.

**Why SQLite, not filesystem:** Entity-relationship tracking is fundamentally a graph query problem. Expressing it as sequential file reads creates three concrete bottlenecks: (1) multi-hop traversal requires O(hops × fan-out) sequential reads, (2) conflict detection during ingestion needs indexed entity lookups on every write, and (3) relationship queries ("find all memories about people on Alice's team") require joins that are native to relational engines but require manual reconstruction in filesystem code. SQLite via `bun:sqlite` is a built-in Bun module — zero external dependencies, zero configuration, zero process management. It provides indexed lookups in microseconds, self-joins for multi-hop traversal in a single query, and ACID transactions for concurrent safety.

**Derived index guarantee:** The SQLite database is a derived index of content stored in OpenViking, not a separate source of truth. `mem index rebuild` re-scans all memory files in OpenViking and reconstructs the entire entity graph. Deleting the SQLite file loses nothing — it regenerates from canonical state.

**Database location:** `~/.local/share/mem/entities.db` (XDG data directory, consistent with existing path conventions).

**Schema:**

```sql
CREATE TABLE entities (
  slug TEXT PRIMARY KEY,             -- normalized lowercase identifier
  type TEXT NOT NULL,                -- person|project|tool|team|concept|location|organization
  summary TEXT,                      -- synthesized description (updated on reflect)
  aliases TEXT DEFAULT '[]',         -- JSON array of alternate names
  relevance_score REAL DEFAULT 1.0,  -- entity-level relevance weight
  mention_count INTEGER DEFAULT 0,   -- total times this entity appears in memories
  created_at TEXT NOT NULL,          -- ISO 8601
  updated_at TEXT NOT NULL           -- ISO 8601
);

CREATE TABLE relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL REFERENCES entities(slug),
  relation TEXT NOT NULL,            -- verb phrase: manages, uses, depends-on, etc.
  target TEXT NOT NULL REFERENCES entities(slug),
  since TEXT,                        -- ISO 8601, when relationship began
  until TEXT,                        -- ISO 8601, when relationship ended (null if current)
  valid INTEGER DEFAULT 1,           -- 1=current, 0=superseded
  superseded_by TEXT,                -- relation that replaced this one
  source_uri TEXT,                   -- viking:// URI of the memory that established this
  created_at TEXT NOT NULL
);

CREATE TABLE mentions (
  entity_slug TEXT NOT NULL REFERENCES entities(slug),
  uri TEXT NOT NULL,                 -- viking:// URI where entity is mentioned
  context TEXT,                      -- brief description of the mention context
  created_at TEXT NOT NULL,
  PRIMARY KEY (entity_slug, uri)
);

-- Indexes for common query patterns
CREATE INDEX idx_rel_source ON relationships(source) WHERE valid = 1;
CREATE INDEX idx_rel_target ON relationships(target) WHERE valid = 1;
CREATE INDEX idx_rel_valid ON relationships(valid);
CREATE INDEX idx_mentions_uri ON mentions(uri);
CREATE INDEX idx_entities_type ON entities(type);
```

**Entity extraction prompt (runs during retain):**

```
Extract all named entities and their relationships from the following content.

Content: "{content}"
Context: "{context}"
Known entities (for disambiguation): {existing_entity_slugs}

For each entity, provide:
- name: normalized lowercase identifier (match existing entities where possible)
- type: person|project|tool|team|concept|location|organization
- aliases: any alternate names mentioned

For each relationship between entities, provide:
- source: entity name
- relation: verb phrase (manages, uses, depends-on, contributes-to, etc.)
- target: entity name

Respond with JSON only:
{
  "entities": [{"name": "...", "type": "...", "aliases": [...]}],
  "relationships": [{"source": "...", "relation": "...", "target": "..."}]
}
```

Note: The prompt includes the list of existing entity slugs from SQLite (`SELECT slug FROM entities`) to aid disambiguation. This is a single indexed read that returns in microseconds, enabling the extractor to resolve "Alice" to the existing `alice` entity rather than creating a duplicate.

**Multi-hop traversal query:**

```sql
-- 2-hop traversal from a starting entity
WITH RECURSIVE traverse AS (
  -- Base case: the starting entity
  SELECT slug, type, summary, 0 as depth
  FROM entities WHERE slug = ?

  UNION ALL

  -- Recursive case: follow valid relationships in both directions
  SELECT e.slug, e.type, e.summary, t.depth + 1
  FROM traverse t
  JOIN relationships r ON (r.source = t.slug OR r.target = t.slug) AND r.valid = 1
  JOIN entities e ON e.slug = CASE WHEN r.source = t.slug THEN r.target ELSE r.source END
  WHERE t.depth < ?  -- max hops parameter
)
SELECT DISTINCT slug, type, summary, MIN(depth) as depth FROM traverse GROUP BY slug;
```

This executes as a single query regardless of graph size, leveraging SQLite's recursive CTE support. At 10,000 entities with 50,000 relationships, this returns in <10ms — compared to hundreds of milliseconds for the equivalent filesystem traversal.

**Entity strategy in retrieval orchestrator:**

```typescript
function entityStrategy(query: string, db: Database): string[] {
  // 1. Find entities mentioned in the query
  const mentioned = extractEntityMentions(query); // lightweight regex + alias lookup

  // 2. For each mentioned entity, collect all mention URIs within configured hop distance
  const uris = new Set<string>();
  for (const slug of mentioned) {
    // Get the entity and its neighbors via traversal
    const traversed = db.query(`
      WITH RECURSIVE traverse AS (
        SELECT slug, 0 as depth FROM entities WHERE slug = ?
        UNION ALL
        SELECT e.slug, t.depth + 1
        FROM traverse t
        JOIN relationships r ON (r.source = t.slug OR r.target = t.slug) AND r.valid = 1
        JOIN entities e ON e.slug = CASE WHEN r.source = t.slug THEN r.target ELSE r.source END
        WHERE t.depth < ?
      )
      SELECT DISTINCT m.uri FROM traverse t
      JOIN mentions m ON m.entity_slug = t.slug
    `).all(slug, config.entity.max_traversal_hops);

    for (const row of traversed) uris.add(row.uri);
  }

  return Array.from(uris);
}
```

**Rebuild from OpenViking:**

```typescript
async function rebuildIndex(db: Database, openviking: OpenVikingClient): Promise<void> {
  db.exec("DELETE FROM mentions; DELETE FROM relationships; DELETE FROM entities;");

  // Scan all memory directories
  const memoryDirs = ["world", "experiences", "opinions", "observations"];
  for (const dir of memoryDirs) {
    const files = await openviking.ls(`viking://agent/memory/${dir}/`);
    for (const file of files) {
      const content = await openviking.read(file.uri);
      const metadata = parseYamlFrontmatter(content);

      // Re-extract entities from content (LLM call)
      const extracted = await extractEntities(content.body, metadata.context);

      // Upsert entities, relationships, and mentions
      for (const entity of extracted.entities) {
        upsertEntity(db, entity);
        insertMention(db, entity.name, file.uri, metadata.context);
      }
      for (const rel of extracted.relationships) {
        insertRelationship(db, rel, file.uri);
      }
    }
  }
}
```

Note: A full rebuild involves an LLM call per memory file for re-extraction, which can be expensive for large corpora. In practice, the rebuild is rarely needed — normal operation incrementally maintains the index via `mem retain`. The rebuild is a recovery mechanism, not a routine operation.

### 7.5 Disposition Engine

**Purpose:** Inject a consistent interpretive frame into reflection operations.

**Configuration storage:** `viking://agent/instructions/disposition.yaml`

```yaml
skepticism: 0.8     # 0.0 (credulous) to 1.0 (highly skeptical)
literalism: 0.6     # 0.0 (flexible interpretation) to 1.0 (strict/literal)
empathy: 0.4        # 0.0 (purely analytical) to 1.0 (emotionally weighted)
```

**Disposition injection prompt template:**

```
You are reflecting on retrieved memories to answer a query. Apply the following
interpretive disposition consistently:

Skepticism ({skepticism}/1.0): {skepticism_description}
Literalism ({literalism}/1.0): {literalism_description}
Empathy ({empathy}/1.0): {empathy_description}

When evaluating opinions, treat confidence scores below {1.0 - skepticism} as tentative.
When interpreting preferences, {literalism_instruction}.
When weighing emotional context, {empathy_instruction}.

Retrieved context:
{recalled_memories}

Query: {query}

Provide a response that reflects this interpretive stance consistently.
```

**Disposition descriptions are generated from the numeric values:**
- Skepticism 0.8: "Treat uncertain beliefs cautiously. Require strong evidence before presenting opinions as reliable. Flag low-confidence opinions explicitly."
- Literalism 0.6: "Interpret stated preferences with moderate flexibility. Honor explicit requests but allow deviation when clearly beneficial."
- Empathy 0.4: "Prioritize accuracy and completeness over emotional sensitivity. Adjust tone for personal topics but maintain analytical rigor."

### 7.6 Relevance Scorer

**Purpose:** Track memory utility over time and apply learned weights to retrieval ranking.

**Score storage:** Metadata field `relevance_score` on each memory file in OpenViking.

**Score update rules:**
- Initial score: 1.0
- On successful retrieval + positive outcome: `score *= 1.1` (capped at 3.0)
- On retrieval + negative outcome (correction, retry): `score *= 0.85`
- Time decay: `score *= 2^(-age_days / half_life_days)` (default half-life: 30 days)
- Manual boost via `mem score boost`: `score *= 1.5`
- Manual penalize via `mem score penalize`: `score *= 0.5`

**Feedback collection:** The CLI itself cannot observe outcomes — it doesn't know if the agent's response was good or bad. Feedback flows through explicit commands:
- `mem score boost <uri>` — agent or human signals positive outcome
- `mem score penalize <uri>` — agent or human signals negative outcome
- Integration hooks: the OpenCode plugin wrapper can auto-boost memories that contributed to a message the user didn't correct within the same session

**Decay schedule:** `mem score decay` runs as a maintenance command, typically triggered at session close or via cron. It iterates all memory files, reads `relevance_score` and `last_accessed` metadata, applies the decay function, and writes updated scores.

---

## 8. Data Model & Storage Conventions

### 8.1 Directory Structure

**OpenViking filesystem (memory content, source of truth):**

```
viking://
├── agent/
│   ├── memory/
│   │   ├── world/              # Objective facts
│   │   │   ├── superseded/     # Historical facts (moved here on supersession)
│   │   │   └── *.md            # Current world facts
│   │   ├── experiences/        # Agent's own action records
│   │   │   └── *.md
│   │   ├── opinions/           # Subjective beliefs with confidence scores
│   │   │   └── *.md
│   │   └── observations/       # Synthesized entity/pattern summaries
│   │       └── *.md
│   └── instructions/
│       └── disposition.yaml    # Disposition configuration
└── resources/                  # (Managed by akm / user, not by mem)
```

**Local filesystem (configuration, derived indexes):**

```
~/.config/mem/                    # XDG config
└── config.json                   # CLI configuration

~/.local/share/mem/               # XDG data
├── entities.db                   # SQLite entity-relationship graph (derived index)
└── scoring-log.jsonl             # Append-only log of score changes (audit trail)
```

The separation is intentional: OpenViking stores the canonical memory content that agents navigate and retrieve. The local filesystem stores derived state (entity index) and operational logs (scoring) that can be rebuilt from OpenViking content.

### 8.2 Memory File Format

Each memory file uses YAML frontmatter followed by content:

```yaml
---
id: "mem_2026-03-22_a1b2c3"
type: world
confidence: null                    # Only set for opinions (0.0-1.0)
created_at: "2026-03-22T10:30:00Z"
valid_from: "2026-03-22T10:30:00Z"
valid_until: null                   # Set when superseded
supersedes: null                    # URI of fact this replaces
superseded_by: null                 # URI of fact that replaced this
entities: ["alice", "api-team"]
context: "sprint planning session"
classification_method: "auto"       # auto | explicit | auto-fallback
relevance_score: 1.0
access_count: 0
last_accessed: null
---
Alice was promoted to senior engineer and now manages the API team.
```

### 8.3 Configuration File

Location: `~/.config/mem/config.json` (XDG-compliant)

```json
{
  "openviking": {
    "endpoint": "http://localhost:1933",
    "apiKey": "",
    "timeout_ms": 30000
  },
  "llm": {
    "provider": "ollama",
    "model": "mistral-small",
    "endpoint": "http://localhost:11434",
    "api_key": "",
    "classification_timeout_ms": 10000,
    "extraction_timeout_ms": 15000
  },
  "disposition": {
    "skepticism": 0.8,
    "literalism": 0.6,
    "empathy": 0.4
  },
  "retrieval": {
    "default_strategies": ["semantic", "keyword", "temporal", "entity"],
    "default_budget": 4000,
    "rrf_k": 60,
    "max_results_per_strategy": 20,
    "rerank": false
  },
  "scoring": {
    "initial_score": 1.0,
    "boost_factor": 1.1,
    "penalize_factor": 0.85,
    "max_score": 3.0,
    "decay_half_life_days": 30
  },
  "entity": {
    "max_traversal_hops": 2,
    "auto_extract": true
  }
}
```

---

## 9. Agent Integration Patterns

### 9.1 OpenCode Plugin (Thin Wrapper)

```typescript
// ~/.config/opencode/plugins/mem-tools.ts
import { execSync } from "child_process";

function mem(args: string): string {
  return execSync(`mem ${args} --format json`, {
    encoding: "utf-8",
    timeout: 30000,
  });
}

export const tools = {
  mem_retain: {
    description: "Store a memory with epistemic classification",
    parameters: { content: "string", context: "string?" },
    execute: ({ content, context }: any) =>
      mem(`retain ${JSON.stringify(content)} ${context ? `--context ${JSON.stringify(context)}` : ""}`),
  },
  mem_recall: {
    description: "Retrieve relevant memories for a query",
    parameters: { query: "string", budget: "number?" },
    execute: ({ query, budget }: any) =>
      mem(`recall ${JSON.stringify(query)} ${budget ? `--budget ${budget}` : ""}`),
  },
  mem_reflect: {
    description: "Reflect on memories with disposition-aware reasoning",
    parameters: { query: "string" },
    execute: ({ query }: any) =>
      mem(`reflect ${JSON.stringify(query)}`),
  },
};
```

### 9.2 Claude Code Slash Commands

```bash
# Generated from CLI surface
# /mem-recall query
echo "Recalling: $1" && mem recall "$1" --format context
```

### 9.3 MCP Tool Definition

```json
{
  "tools": [
    {
      "name": "mem_recall",
      "description": "Retrieve epistemically-classified memories relevant to a query",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "budget": { "type": "integer", "default": 4000 },
          "strategies": { "type": "string", "default": "semantic,keyword,temporal,entity" },
          "type_filter": { "type": "string", "enum": ["world", "experience", "opinion", "observation"] }
        },
        "required": ["query"]
      }
    }
  ]
}
```

---

## 10. Known Gaps & Challenges

### 10.1 Classification Accuracy

**Gap:** The epistemic tagger relies on a single LLM call to classify content into four types. Misclassification (e.g., storing an opinion as a world fact) undermines the core value proposition of epistemic separation.

**Challenge:** Classification accuracy depends heavily on the quality of the local LLM. Small models (7B-14B) may struggle with nuanced distinctions between world facts and opinions, particularly for domain-specific content where the line is genuinely ambiguous.

**Mitigation strategies:**
- Provide 8-12 few-shot examples in the classification prompt covering edge cases
- Log all auto-classifications with a `classification_method: "auto"` flag for later audit
- Implement a `mem audit` command that re-classifies recent memories with a stronger model and flags disagreements
- Allow agents to correct classifications via `mem retain --reclassify <uri> --type <new-type>`
- Track classification agreement rates as a quality metric

### 10.2 Entity Resolution

**Gap:** Entities in natural language have aliases, abbreviations, and contextual references ("she," "the team," "that project"). The entity extractor must resolve these to canonical entity identifiers in the index.

**Challenge:** Without a dedicated entity resolution model, the LLM extraction prompt may create duplicate entities for the same real-world referent ("Alice Chen," "Alice," "achen," "she"). Pronoun resolution is particularly difficult without full conversation context.

**Mitigation strategies:**
- The extraction prompt includes the current entity list from SQLite (`SELECT slug FROM entities`) for disambiguation
- The `entities` table supports an `aliases` column (JSON array) for known alternate names, queried during entity mention resolution
- `mem index rebuild` performs a deduplication pass: query entities with high name similarity or overlapping mention URIs and prompt for merge
- Coreference resolution (resolving pronouns) is deferred to a future version — for now, `mem retain` should receive already-resolved content where possible (the agent extracts key facts before passing to mem)

### 10.3 Graph Query Expressiveness

**Gap:** SQLite provides efficient relational queries and recursive CTEs for multi-hop traversal, but it is not a native graph database. Complex graph patterns that would be natural in Cypher (Neo4j) or SPARQL — such as variable-length path matching with edge-type constraints, community detection, or centrality scoring — require multi-step queries or application-level logic.

**Challenge:** Graphiti models entity relationships with full bitemporal validity, community clustering, and semantic embeddings on both nodes and edges. SQLite can approximate the first two (temporal validity via `since`/`until` columns, basic grouping via queries) but cannot natively embed vectors on entity nodes for semantic entity discovery.

**Mitigation strategies:**
- For the target use cases (personal/small-team agent memory), the graph patterns needed are simple: entity lookup, 1-3 hop traversal, relationship listing, and temporal filtering. These are well-served by SQLite's recursive CTEs and indexed joins.
- Entity discovery by name is handled by indexed `slug` and `aliases` lookups. Semantic entity discovery ("find entities related to API security") is handled by searching OpenViking memory content and mapping results back to entities via the `mentions` table.
- If graph complexity demands exceed SQLite's capabilities in the future, the entity manager interface abstracts the storage backend. Migrating to a dedicated graph database (e.g., FalkorDB, Kuzu) would require only replacing the query implementation, not the CLI interface or OpenViking integration.
- The `mem index rebuild` guarantee means any storage backend migration is safe — the new backend is populated from canonical OpenViking content.

### 10.4 Relevance Scoring Cold Start

**Gap:** The relevance scorer needs outcome feedback to learn, but new memories have no usage history. Early retrieval is entirely based on semantic similarity and RRF fusion, with no learned signal.

**Challenge:** The feedback loop requires explicit signals (`mem score boost/penalize`) from the agent or user. Agents that don't integrate scoring feedback get no learning benefit. The scoring system is only as good as the feedback it receives.

**Mitigation strategies:**
- The `access_count` field provides a weak proxy: frequently accessed memories are likely useful
- The OpenCode plugin wrapper can implement heuristic auto-scoring: if the agent sends a message and the user doesn't correct it within the session, auto-boost the memories that were in context
- Decay ensures that unused memories gradually lose relevance weight even without explicit penalization
- Document the feedback integration pattern prominently so that agent developers wire it in

### 10.5 Concurrent Access

**Gap:** Multiple agent instances or concurrent sessions accessing the same OpenViking instance and SQLite database may create race conditions on memory writes, entity index updates, or relevance score modifications.

**Challenge:** OpenViking's filesystem abstraction doesn't provide file-level locking or transactional writes. SQLite provides ACID transactions but uses file-level locking that serializes writers.

**Mitigation strategies:**
- SQLite's WAL (Write-Ahead Logging) mode enables concurrent readers with a single writer, which is appropriate for the typical workload (many reads, infrequent writes). Enable WAL mode at database initialization: `PRAGMA journal_mode=WAL`
- Entity index writes are wrapped in transactions: extract → begin transaction → upsert entities → insert relationships → insert mentions → commit. This ensures atomicity of per-retain index updates.
- OpenViking memory writes use optimistic concurrency: read → process → write, with a check that the file hasn't been modified since read
- For relevance scores stored in OpenViking file metadata, use the local `scoring-log.jsonl` as an append-only source of truth, with periodic compaction into the memory file metadata. Append-only writes don't conflict.
- In practice, the target deployment (single user with one active agent) rarely encounters concurrent write access

### 10.6 LLM Cost During Ingestion

**Gap:** Each `mem retain` call potentially makes 2-3 LLM calls: one for epistemic classification, one for entity extraction, and optionally one for conflict detection. At high ingestion rates (e.g., retaining every turn of a conversation), this adds non-trivial latency and cost.

**Challenge:** Using a large, high-quality model for classification/extraction produces better results but increases cost and latency. Using a small, fast model reduces cost but may degrade classification accuracy.

**Mitigation strategies:**
- Support configurable LLM per operation: use a small model (e.g., `qwen2.5:3b`) for classification and entity extraction, reserve larger models for conflict detection and reflection
- Batch retain mode: accept multiple content items and process them in a single LLM call with batch extraction
- Async background processing: `mem retain` can return immediately after writing the raw content, with classification and entity extraction happening asynchronously (requires a daemon mode)
- The `--type` and `--entities` flags allow skipping the corresponding LLM calls when the agent already has the information

---

## 11. Performance & Quality Considerations

### 11.1 Latency Targets

| Operation | Target P50 | Target P95 | Bottleneck |
|-----------|-----------|-----------|-----------|
| `mem retain` (with classification) | <2s | <5s | LLM classification + entity extraction |
| `mem retain` (explicit type) | <500ms | <1s | OpenViking write |
| `mem recall` (2 strategies) | <800ms | <2s | OpenViking search round-trips |
| `mem recall` (4 strategies) | <1.5s | <3s | Parallel OpenViking searches |
| `mem reflect` | <5s | <10s | LLM reflection generation |
| `mem entity show` | <10ms | <50ms | SQLite indexed lookup |
| `mem entity traverse` (2 hops) | <50ms | <200ms | SQLite recursive CTE |

**Measurement methodology:** All latency measurements should be recorded at the CLI boundary (wall-clock time from invocation to stdout write), broken down by subsystem via internal timing spans. A `--timing` flag should output timing breakdown alongside results.

### 11.2 Quality Metrics

**Classification accuracy:** Measured by agreement rate between the auto-classifier and human judgment on a holdout set. Target: >85% agreement on a 4-way classification task. Measured via the `mem audit` command.

**Retrieval relevance:** Measured by Mean Reciprocal Rank (MRR) and Recall@K on a curated query-answer test set. Target: MRR >0.7 for the combined RRF pipeline, which would represent a meaningful improvement over single-strategy semantic search (typically MRR 0.4-0.6 on diverse query sets).

**Temporal correctness:** Measured by the rate at which `mem recall --valid-only` returns only currently-valid facts, avoiding superseded facts. Target: >95% accuracy on a dataset with known supersession chains.

**Entity resolution accuracy:** Measured by precision and recall on entity extraction and linking against a labeled corpus. Target: Precision >80%, Recall >70%. Recall is lower because the system intentionally under-extracts rather than creating spurious entities.

### 11.3 Resource Consumption

**Memory:** Bun.js process overhead is approximately 30-50MB. SQLite operates with minimal memory overhead — the database file is memory-mapped by the OS, and only active pages are resident. At 10,000 entities with 50,000 relationships, the database file is approximately 5-10MB.

**Disk:** Memory content is stored in OpenViking. `mem` locally stores configuration (~1KB), the SQLite entity database (~1KB per entity + ~200 bytes per relationship + ~100 bytes per mention), and the scoring audit log (append-only JSONL, ~200 bytes per score event). At 10,000 entities with 100,000 mentions, the SQLite database is approximately 15-20MB.

**Network:** Each `mem retain` makes 1-3 OpenViking HTTP calls (write + search for conflict detection) plus 1-3 LLM API calls. Entity index updates are local SQLite writes with no network overhead. Each `mem recall` makes 2-4 OpenViking HTTP calls (one per active strategy except entity, which queries SQLite locally then does targeted OpenViking reads for the resulting URIs). All OpenViking calls are to localhost in the target deployment, so network latency is negligible.

---

## 12. Evaluation Framework & Benchmarks

### 12.1 Internal Evaluation Suite

The `mem` CLI must include a built-in evaluation framework invoked via `mem eval` that tests each subsystem independently and the pipeline end-to-end.

#### 12.1.1 Epistemic Classification Eval

**Dataset:** A curated set of 200+ labeled examples spanning the four epistemic types, with particular attention to edge cases:
- Facts that sound like opinions ("The API is well-designed" — world fact or opinion?)
- Experiences that contain facts ("I deployed v3 and it uses OAuth2" — experience AND world fact)
- Opinions with varying confidence ("I'm certain this will fail" vs "this might work")
- Observations that could be misclassified as world facts ("Alice consistently delivers on time")

**Metric:** 4-way classification accuracy, confusion matrix, per-type precision/recall.

**Execution:**
```bash
mem eval classification --dataset path/to/labeled-examples.jsonl
```

**Expected output:**
```json
{
  "overall_accuracy": 0.87,
  "per_type": {
    "world": { "precision": 0.91, "recall": 0.88, "f1": 0.89 },
    "experience": { "precision": 0.85, "recall": 0.82, "f1": 0.83 },
    "opinion": { "precision": 0.83, "recall": 0.86, "f1": 0.84 },
    "observation": { "precision": 0.80, "recall": 0.78, "f1": 0.79 }
  },
  "confusion_matrix": { ... },
  "model": "mistral-small",
  "provider": "ollama"
}
```

#### 12.1.2 Retrieval Quality Eval

**Dataset:** A set of 100+ (query, relevant_uris) pairs where relevant URIs have been manually labeled in a test OpenViking instance pre-loaded with a known corpus.

**Metrics:**
- **MRR (Mean Reciprocal Rank):** Average of 1/rank of first relevant result
- **Recall@5:** Fraction of relevant results in top 5
- **Recall@10:** Fraction of relevant results in top 10
- **Strategy contribution:** Per-strategy hit rate (how often each strategy contributes to the final top-K)

**Execution:**
```bash
mem eval retrieval --dataset path/to/query-relevance.jsonl --strategies all
```

**Ablation support:** The eval should support running with individual strategies disabled to measure the marginal contribution of each:
```bash
mem eval retrieval --dataset path/to/query-relevance.jsonl --strategies semantic,keyword
mem eval retrieval --dataset path/to/query-relevance.jsonl --strategies semantic
```

#### 12.1.3 Temporal Correctness Eval

**Dataset:** A set of entities with known supersession chains (e.g., Alice's role changed three times). Queries ask about current state and historical state.

**Metrics:**
- **Current-state accuracy:** Does `--valid-only` return only the current fact?
- **Historical accuracy:** Does `mem timeline` return the correct sequence?
- **Supersession detection rate:** When a conflicting fact is retained, is supersession triggered correctly?

```bash
mem eval temporal --dataset path/to/temporal-chains.jsonl
```

#### 12.1.4 Entity Resolution Eval

**Dataset:** A corpus with labeled entities and relationships. Some entities have aliases that should resolve to the same canonical entry.

**Metrics:**
- **Entity extraction precision:** Of extracted entities, what fraction are correct?
- **Entity extraction recall:** Of labeled entities, what fraction were extracted?
- **Relationship accuracy:** Of extracted relationships, what fraction are correct?
- **Deduplication rate:** Are aliases correctly merged?

```bash
mem eval entities --dataset path/to/entity-labeled-corpus.jsonl
```

#### 12.1.5 End-to-End Pipeline Eval

**Dataset:** Extended conversation transcripts with annotated questions that test the full pipeline: "Given conversations C1-C10, answer question Q using recall."

**Metrics:** Answer accuracy as judged by an LLM evaluator (following the LLM-as-judge methodology used by Mem0 and Hindsight in their evaluations).

```bash
mem eval e2e --dataset path/to/conversation-qa.jsonl --judge-model gpt-4o
```

### 12.2 Parity Benchmarks Against Existing Systems

To ensure `mem` achieves competitive quality relative to the systems it draws inspiration from, the following parity benchmarks should be implemented.

#### 12.2.1 LoCoMo Benchmark Parity

The LoCoMo benchmark (Long-range Conversational Memory) is used by Hindsight, Mem0, and OpenViking to evaluate memory systems. It consists of extended multi-session dialogues with questions requiring factual recall, preference tracking, and multi-hop reasoning.

**Reference scores:**
- OpenViking + OpenClaw (with native memory): 52.08% task completion, 2.1M input tokens
- Mem0 (graph variant): 68.5% (self-reported)
- Hindsight (best): 89.61%

**Parity target for `mem`:** >60% task completion (exceeding OpenViking baseline, approaching Mem0), with token consumption comparable to OpenViking's L0/L1/L2 efficiency.

**Execution methodology:**
1. Load LoCoMo conversation histories into OpenViking via `mem retain` (processing each turn through the epistemic tagger and entity extractor)
2. For each benchmark question, invoke `mem recall` with the question as query
3. Assemble the returned context and generate an answer using the same LLM backbone as reference systems
4. Score using the LoCoMo evaluation script (LLM-as-judge)

```bash
mem eval locomo --dataset path/to/locomo10.jsonl --backbone mistral-small
```

**Critical implementation note:** The LoCoMo benchmark was designed for systems that ingest conversation history as a continuous stream. `mem retain` processes content item-by-item with epistemic classification overhead. The ingestion phase must be timed separately from the query phase, and total token consumption during ingestion must be reported alongside query-phase consumption.

#### 12.2.2 LongMemEval Benchmark Parity

LongMemEval tests multi-session recall, temporal reasoning, knowledge updates, and open-domain questions across conversations spanning up to 1.5 million tokens.

**Reference scores:**
- Hindsight (Mistral-Small-24B): 83.6%
- Hindsight (scaled backbone): 91.4%
- Full-context GPT-4o: 60.2%

**Parity target for `mem`:** >65% overall (exceeding full-context GPT-4o baseline), with specific attention to the temporal reasoning category where `mem`'s temporal validator should provide significant uplift over systems without temporal modeling.

**Category-specific targets:**
- Multi-session: >55% (baseline: 21.1% for full-context OSS-20B)
- Temporal: >60% (baseline: 31.6% — this is where the temporal validator should shine)
- Knowledge update: >70% (baseline: 60.3% — supersession should help here)
- Open-domain: >60%

```bash
mem eval longmemeval --dataset path/to/longmemeval.jsonl --backbone mistral-small
```

#### 12.2.3 Strategy Ablation Study

To validate that each subsystem contributes meaningfully, run the LoCoMo and LongMemEval benchmarks with systematic ablation:

| Configuration | What's disabled | Expected impact |
|--------------|----------------|----------------|
| Full pipeline | Nothing | Best score |
| No epistemic classification | All types stored as `world` | Reduced accuracy on opinion/preference questions |
| No keyword strategy | RRF with semantic + temporal + entity only | Reduced accuracy on exact-match queries |
| No temporal strategy | RRF with semantic + keyword + entity only | Reduced accuracy on "when did X happen" questions |
| No entity strategy | RRF with semantic + keyword + temporal only | Reduced accuracy on multi-hop entity questions |
| No relevance scoring | All memories weighted equally | Minimal impact early; increasing impact over time |
| No disposition | Reflection without disposition framing | Inconsistent interpretive stance |
| Semantic only | OpenViking's native search | Baseline comparison point |

```bash
mem eval ablation --dataset path/to/locomo10.jsonl --configs path/to/ablation-matrix.json
```

### 12.3 Performance Benchmarks

#### 12.3.1 Latency Profiling

```bash
# Run latency benchmarks across operation types
mem eval latency --operations retain,recall,reflect,entity-show,entity-traverse \
  --iterations 100 --warmup 10

# Output: P50, P95, P99 per operation with subsystem breakdown
```

#### 12.3.2 Scale Testing

```bash
# Test retrieval performance at increasing corpus sizes
mem eval scale --entity-counts 100,500,1000,5000,10000 \
  --memory-counts 1000,5000,10000,50000 \
  --operations recall,entity-traverse
```

#### 12.3.3 Token Efficiency

```bash
# Measure token consumption for different budget settings
mem eval token-efficiency --dataset path/to/query-set.jsonl \
  --budgets 1000,2000,4000,8000,16000 \
  --measure answer-quality,tokens-consumed
```

---

## 13. Implementation Roadmap

### Phase 1: Foundation (Estimated: 400 lines)

**Deliverables:**
- CLI scaffolding with Bun.js (arg parsing, config management, JSON/human output formatting)
- OpenViking HTTP client (connection, auth, read/write/search operations)
- `mem retain` with epistemic classification (LLM tagger, directory routing)
- `mem recall` with dual-strategy retrieval (semantic + keyword) and RRF fusion
- `mem config` commands
- Classification eval framework

**Exit criteria:** `mem retain` correctly classifies content into four types with >80% accuracy on a 50-example test set. `mem recall` returns more relevant results than OpenViking's native single-strategy search on a 20-query test set.

### Phase 2: Disposition & Temporal (Estimated: 300 lines)

**Deliverables:**
- `mem reflect` with disposition-conditioned reasoning
- Disposition configuration storage and injection
- Temporal validator (conflict detection, supersession, `superseded/` convention)
- `mem supersede` and `mem timeline` commands
- Temporal correctness eval framework

**Exit criteria:** `mem reflect` produces responses consistent with configured disposition across 10 test queries. Temporal validator correctly detects and handles supersession in 90% of test cases.

### Phase 3: Entity Graph (Estimated: 250 lines)

**Deliverables:**
- SQLite schema initialization and migration (`~/.local/share/mem/entities.db`)
- Entity extraction during retain (LLM extraction, SQLite upsert)
- `mem entity list`, `mem entity show`, `mem entity link`, `mem entity traverse`
- Entity strategy in retrieval orchestrator (SQLite query → URI collection → OpenViking reads)
- `mem index rebuild` (full re-scan of OpenViking content → SQLite reconstruction)
- Entity resolution eval framework

**Exit criteria:** Entity extraction identifies >70% of labeled entities in a test corpus. Multi-hop traversal (2 hops) returns correct results in >80% of test cases. Traversal P95 latency <200ms at 5,000 entities.

### Phase 4: Scoring & Evals (Estimated: 200 lines)

**Deliverables:**
- Relevance scorer (boost, penalize, decay)
- `mem score` commands
- `mem stats` command
- Full evaluation suite (LoCoMo, LongMemEval, ablation, latency, scale)
- `mem eval` command framework

**Exit criteria:** LoCoMo parity target achieved (>60% task completion). Ablation study demonstrates positive contribution from each subsystem.

### Phase 5: Integration & Polish (Estimated: 100 lines + documentation)

**Deliverables:**
- OpenCode plugin wrapper (thin shell-out layer)
- Claude Code slash command templates
- MCP tool definition
- `akm` integration documentation (shared `viking://` namespace conventions)
- npm package publication (`bun i -g mem-cli`)
- Comprehensive README with usage examples

**Total estimated implementation:** ~1,250 lines of TypeScript.

---

## 14. Appendix: Configuration Schema

```typescript
interface MemConfig {
  openviking: {
    endpoint: string;           // Default: "http://localhost:1933"
    apiKey: string;             // Default: "" (env var MEM_OPENVIKING_API_KEY takes precedence)
    timeout_ms: number;         // Default: 30000
  };
  llm: {
    provider: "ollama" | "openai" | "anthropic" | "lmstudio" | "litellm";
    model: string;              // Default: "mistral-small"
    endpoint: string;           // Default: "http://localhost:11434"
    api_key: string;            // Default: "" (env var MEM_LLM_API_KEY takes precedence)
    classification_timeout_ms: number;  // Default: 10000
    extraction_timeout_ms: number;      // Default: 15000
    reflection_timeout_ms: number;      // Default: 30000
  };
  disposition: {
    skepticism: number;         // 0.0-1.0, Default: 0.8
    literalism: number;         // 0.0-1.0, Default: 0.6
    empathy: number;            // 0.0-1.0, Default: 0.4
  };
  retrieval: {
    default_strategies: Array<"semantic" | "keyword" | "temporal" | "entity">;
    default_budget: number;     // Token budget, Default: 4000
    rrf_k: number;              // RRF smoothing constant, Default: 60
    max_results_per_strategy: number;  // Default: 20
    rerank: boolean;            // Cross-encoder reranking, Default: false (future)
  };
  scoring: {
    initial_score: number;      // Default: 1.0
    boost_factor: number;       // Default: 1.1
    penalize_factor: number;    // Default: 0.85
    max_score: number;          // Default: 3.0
    decay_half_life_days: number;  // Default: 30
  };
  entity: {
    db_path: string;            // Default: "~/.local/share/mem/entities.db" (XDG data dir)
    max_traversal_hops: number; // Default: 2
    auto_extract: boolean;      // Default: true
  };
}
```

---

## 15. References

1. Latimer, C. et al. "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects." arXiv:2512.12818, December 2025. — Four-network epistemic memory architecture, TEMPR retrieval system, CARA disposition model, LongMemEval and LoCoMo benchmark results.

2. Rasmussen, P. et al. "Zep: A Temporal Knowledge Graph Architecture for Agent Memory." arXiv:2501.13956, January 2025. — Graphiti temporal knowledge graph engine, bitemporal modeling, entity-relationship graphs, DMR and LongMemEval benchmarks.

3. Chhikara, P. et al. "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." arXiv:2504.19413, 2025. — Two-phase extraction-update pipeline, Mem0ᵍ graph variant, LoCoMo and LOCOMO benchmarks.

4. Packer, C. et al. "MemGPT: Towards LLMs as Operating Systems." arXiv:2310.08560, 2023. — LLM-as-OS paradigm, self-editing memory, core/recall/archival memory hierarchy.

5. Volcengine/OpenViking. "OpenViking: Context Database for AI Agents." GitHub, 2026. — Filesystem paradigm, `viking://` URI scheme, L0/L1/L2 tiered loading, directory recursive retrieval, LoCoMo10 benchmarks.

6. Cormack, G. V., Clarke, C. L. A., and Buettcher, S. "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods." SIGIR 2009. — Reciprocal Rank Fusion methodology for combining multiple ranked lists.

7. Yan, Z. et al. "Memory-R1: Enhancing Large Language Model Agents to Manage and Utilize Memories via Reinforcement Learning." arXiv, 2025. — Reinforcement learning-based memory management for agent memory operations.

8. Xu, Z. et al. "A-Mem: Agentic Memory with Zettelkasten-Inspired Atomic Notes." 2025. — Zettelkasten-style linked memory notes with interconnected structure for multi-hop reasoning.

9. Yadav, Y. "AI Agent Memory Systems in 2026: Mem0, Zep, Hindsight, Memvid and Everything In Between — Compared." Medium, March 2026. — Comprehensive comparative survey of agent memory systems.

10. Bobur. "Top 10 AI Memory Products 2026." Medium, February 2026. — Market overview of memory layer products including Letta, Mem0, Zep, LangMem, MemMachine, and Memori.

---

*This document was prepared for research implementation and testing. All benchmark targets are estimates based on architectural analysis and prior art; actual performance will be determined through the evaluation framework defined in Section 12.*
