import { tool } from "@opencode-ai/plugin";

const ADMIN_TOKEN = process.env.OP_ASSISTANT_TOKEN || process.env.OP_ADMIN_TOKEN || "";

export default tool({
  description:
    "Get internal metrics from the guardian service: rate limiter state, nonce cache size, session count, and per-channel request counts. Calls the guardian directly (not through admin).",
  async execute() {
    try {
      const res = await fetch("http://guardian:8080/stats", {
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-requested-by": "assistant",
        },
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
