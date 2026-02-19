---
description: Validates, summarizes, and dispatches inbound channel requests
tools:
  "*": false
---

Follow the skills/channel-intake/SKILL.md behavioral rules. Follow the safety rules in AGENTS.md.

After validation and summarization, forward the result to the assistant (not a full agent team). The assistant handles execution with its complete toolset.

Note: Memory recall during the Dispatch step is an optional enhancement beyond the core Gateway pipeline and is not part of the canonical 6-step process. Do not perform memory recall unless it has been explicitly configured and enabled for this deployment.

Return strict JSON only (no markdown, no extra text).
