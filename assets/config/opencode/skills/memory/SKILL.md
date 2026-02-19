# Memory Policy

## Record

Store memory only when user intent is explicit (e.g. "remember this").
- Redact secrets before writing memory.
- Keep summaries concise and factual.
- Track source and confidence fields.
- The `openmemory-http` plugin automatically blocks persistence of any
  text that matches secret heuristics (API keys, tokens, passwords, etc.).
- Write-back only stores items classified as save-worthy (preferences,
  facts, decisions, TODOs, project state).

## Recall

Before answering user-specific questions:
1. Relevant memories are automatically injected into context via the
   `openmemory-http` plugin (look for the `<recalled_memories>` block).
2. Explain why recalled memories are relevant to the user's question.
3. Include memory IDs (from the `[id]` prefix) in the final response.
