/**
 * OpenMemory HTTP pipeline plugin for OpenCode.
 *
 * Implements a deterministic memory pipeline that uses OpenMemory's REST API
 * (no MCP in the runtime path):
 *
 *   A) Pre-turn  — recall injection into context
 *   B) Post-turn — write-back of save-worthy items
 *   C) Compaction — preserve critical state
 *
 * All behaviour is configurable via environment variables and can be disabled
 * entirely by setting OPENPALM_MEMORY_MODE to a value other than "api".
 */

import {
  loadConfig,
  containsSecret,
  isSaveWorthy,
  OpenMemoryClient,
} from "./openmemory-client.ts";

import type { MemoryHit } from "./openmemory-client.ts";

// ---------------------------------------------------------------------------
// Types – kept minimal; mirrors the shapes OpenCode plugins receive
// ---------------------------------------------------------------------------

interface PluginOutput {
  context?: string;
  prompt?: string;
}

interface TurnStartEvent {
  message?: string;
  sessionId?: string;
  userId?: string;
  output?: PluginOutput;
  metadata?: Record<string, unknown>;
}

interface TurnEndEvent {
  response?: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface CompactingEvent {
  sessionId?: string;
  userId?: string;
  summary?: string;
  output?: PluginOutput;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(kind: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ plugin: "openmemory-http", kind, ts: new Date().toISOString(), ...payload }));
}

/**
 * Format recalled memories into a clearly-delimited context block that
 * the model can reference without confusion.
 */
export function formatRecallBlock(hits: MemoryHit[], maxChars: number): string {
  if (hits.length === 0) return "";
  let block = "<recalled_memories>\n";
  let chars = block.length;
  for (const hit of hits) {
    const line = `- [${hit.id}] ${hit.text}\n`;
    if (chars + line.length > maxChars) {
      block += "- (additional memories truncated)\n";
      break;
    }
    block += line;
    chars += line.length;
  }
  block += "</recalled_memories>";
  return block;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const enabled = cfg.mode === "api";

let client: OpenMemoryClient | undefined;
if (enabled) {
  client = new OpenMemoryClient(cfg.baseUrl, cfg.apiKey || undefined);
}

export default {
  name: "openmemory-http",

  /**
   * A) Pre-turn: inject recalled memories into the model context.
   */
  async onTurnStart(event: TurnStartEvent) {
    if (!enabled || !client) return;

    const query = event.message ?? "";
    if (!query.trim()) return;

    const start = Date.now();
    try {
      const hits = await client.queryMemory({
        query,
        user_id: event.userId,
        session_id: event.sessionId,
        limit: cfg.recallLimit,
      });

      const block = formatRecallBlock(hits, cfg.recallMaxChars);
      if (block && event.output) {
        event.output.context = [event.output.context, block].filter(Boolean).join("\n\n");
      }

      log("recall", { count: hits.length, chars: block.length, ms: Date.now() - start });
    } catch (err: unknown) {
      log("recall_error", { error: String(err), ms: Date.now() - start });
    }
  },

  /**
   * B) Post-turn: persist save-worthy items from the response.
   */
  async onTurnEnd(event: TurnEndEvent) {
    if (!enabled || !client || !cfg.writebackEnabled) return;

    const text = event.response ?? "";
    if (!text.trim()) return;
    if (!isSaveWorthy(text)) return;
    if (containsSecret(text)) {
      log("writeback_blocked", { reason: "secret_detected" });
      return;
    }

    try {
      const result = await client.addMemory({
        text,
        user_id: event.userId,
        session_id: event.sessionId,
        tags: ["auto-writeback"],
      });
      log("writeback", { id: result.id ?? "unknown" });
    } catch (err: unknown) {
      log("writeback_error", { error: String(err) });
    }
  },

  /**
   * C) Compaction: preserve critical state so it survives session compaction.
   */
  async "experimental.session.compacting"(event: CompactingEvent) {
    if (!enabled || !client) return;

    try {
      const hits = await client.queryMemory({
        query: event.summary ?? "session context",
        user_id: event.userId,
        session_id: event.sessionId,
        limit: cfg.recallLimit,
        tags: ["must-keep"],
      });

      if (hits.length === 0) return;

      const block = formatRecallBlock(hits, cfg.recallMaxChars);
      if (block && event.output) {
        // Re-inject must-keep state into the compacted prompt so the model
        // retains critical context after compaction.
        event.output.prompt = [event.output.prompt, block].filter(Boolean).join("\n\n");
      }

      log("compaction_preserve", { count: hits.length });
    } catch (err: unknown) {
      log("compaction_error", { error: String(err) });
    }
  },
};
