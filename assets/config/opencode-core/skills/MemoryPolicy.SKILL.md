# MemoryPolicy

Store memory only when user intent is explicit (e.g. "remember this").
- Redact secrets before writing memory.
- Keep summaries concise and factual.
- Track source and confidence fields.
- The `openmemory-http` plugin automatically blocks persistence of any
  text that matches secret heuristics (API keys, tokens, passwords, etc.).
- Write-back only stores items classified as save-worthy (preferences,
  facts, decisions, TODOs, project state).
