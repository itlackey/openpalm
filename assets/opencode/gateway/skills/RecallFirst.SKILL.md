# RecallFirst

Before answering user-specific questions:
1. Relevant memories are automatically injected into context via the
   `openmemory-http` plugin (look for the `<recalled_memories>` block).
2. Explain why recalled memories are relevant to the user's question.
3. Include memory IDs (from the `[id]` prefix) in the final response.
