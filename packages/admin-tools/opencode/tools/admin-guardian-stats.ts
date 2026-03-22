import { tool } from "@opencode-ai/plugin";
import { buildAdminHeaders } from "./lib.ts";

const MISSING_ASSISTANT_TOKEN = JSON.stringify({
  error: true,
  message: 'Missing OP_ASSISTANT_TOKEN. Admin-token fallback is disabled for assistant/admin-tools contexts.',
});

export default tool({
  description:
    "Get internal metrics from the guardian service: rate limiter state, nonce cache size, session count, and per-channel request counts. Calls the guardian directly (not through admin).",
  async execute() {
    const headers = buildAdminHeaders();
    if (!headers) return MISSING_ASSISTANT_TOKEN;

    try {
      const res = await fetch("http://guardian:8080/stats", {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      const body = await res.text();
      if (!res.ok) return JSON.stringify({ error: true, status: res.status, body });
      return body;
    } catch (err) {
      return JSON.stringify({
        error: true,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
