# @openpalm/memory

Fact extraction, vector search, and history tracking for OpenPalm. Ported from the [mem0 TypeScript SDK](https://github.com/mem0ai/mem0) with adaptations for `bun:sqlite` + `sqlite-vec`.

## Quick start

```ts
import { Memory } from '@openpalm/memory';

const mem = new Memory({
  llm: { provider: 'openai', config: { model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY } },
  embedder: { provider: 'openai', config: { model: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY } },
  vectorStore: { provider: 'sqlite-vec', config: { dbPath: './memory.db', dimensions: 1536 } },
});

await mem.initialize();

// Add with LLM inference (extracts facts automatically)
await mem.add('I prefer TypeScript and dark mode.', { userId: 'alice' });

// Add without inference (stores raw text)
await mem.add('User lives in NYC', { userId: 'alice', infer: false });

// Search by semantic similarity
const results = await mem.search('programming language', { userId: 'alice' });

// CRUD
const item = await mem.get(results[0].id);
await mem.update(item.id, 'User prefers TypeScript over JavaScript');
await mem.delete(item.id);

// Cleanup
mem.close();
```

## Architecture

```
Memory (orchestrator)
  +-- LLM adapter (OpenAI | Ollama)        -- fact extraction & update decisions
  +-- Embedder adapter (OpenAI | Ollama)    -- text -> vector
  +-- VectorStore (sqlite-vec)              -- ANN search in a single .db file
  +-- HistoryManager (sqlite)               -- audit trail of mutations
```

All external API calls use native `fetch()` with no SDK dependencies.

## Configuration

Pass a `MemoryConfig` to the constructor. All fields are optional and fall back to sensible defaults:

| Field | Default | Description |
|-------|---------|-------------|
| `llm.provider` | `openai` | LLM provider (`openai`, `azure_openai`, `ollama`) |
| `llm.config.model` | `gpt-4o-mini` | Model name |
| `llm.config.apiKey` | — | API key |
| `llm.config.baseUrl` | `https://api.openai.com/v1` | API base URL |
| `embedder.provider` | `openai` | Embedder provider (`openai`, `azure_openai`, `ollama`) |
| `embedder.config.model` | `text-embedding-3-small` | Embedding model |
| `embedder.config.dimensions` | `1536` | Vector dimensions |
| `vectorStore.provider` | `sqlite-vec` | Vector store (only `sqlite-vec` currently) |
| `vectorStore.config.dbPath` | `./memory.db` | SQLite database path |
| `vectorStore.config.collectionName` | `memory` | Table name prefix |
| `historyDbPath` | shared with vector store | Separate DB path for history |
| `disableHistory` | `false` | Disable mutation tracking |
| `customPrompt` | — | Override the fact extraction system prompt |

## API

### `Memory`

| Method | Description |
|--------|-------------|
| `initialize()` | Create tables. Call once before use. |
| `add(messages, opts?)` | Extract and store facts. Set `infer: false` to skip LLM. |
| `search(query, opts?)` | Semantic similarity search. |
| `get(id)` | Get a single memory by ID. |
| `getAll(opts?)` | List all memories (with optional filters). |
| `update(id, data, metadata?)` | Update content and re-embed. |
| `delete(id)` | Delete a single memory. |
| `deleteAll(opts?)` | Delete all memories for a user (or everything). |
| `history(id)` | Get the mutation audit trail for a memory. |
| `reset()` | Drop all data and reinitialize. |
| `close()` | Close database connections. |

### Filters

All query methods accept `userId`, `agentId`, and `runId` filters to scope results.

## Testing

```sh
bun test packages/memory/
```

## License

CC-BY-4.0
