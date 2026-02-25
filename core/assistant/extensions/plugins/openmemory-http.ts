/**
 * OpenMemory HTTP pipeline plugin for OpenCode.
 *
 * Implements a deterministic memory pipeline that uses OpenMemory's REST API
 * (no MCP in the runtime path):
 *
 *   A) Pre-turn  — recall injection into system prompt
 *   B) Post-turn — write-back of save-worthy items on session idle
 *   C) Compaction — preserve critical state
 *
 * All behaviour is configurable via environment variables and can be disabled
 * entirely by setting OPENPALM_MEMORY_MODE to a value other than "api".
 */

import {
  loadConfig,
  containsSecret,
  isSaveWorthy,
  formatRecallBlock,
  OpenMemoryClient,
} from "../lib/openmemory-client.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("plugin-openmemory");

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const enabled = cfg.mode === "api";

type PluginContext = { client?: any; $?: any; [key: string]: unknown };
type Plugin = (ctx: PluginContext) => Promise<Record<string, unknown>>;

export const OpenMemoryHTTP: Plugin = async ({ client }) => {
  if (!enabled) return {};

  const memClient = new OpenMemoryClient(cfg.baseUrl, cfg.apiKey || undefined);

  // Track the latest user message per session for memory queries.
  const latestMessage = new Map<string, string>();

  return {
    /**
     * A) Inject recalled memories into the system prompt before each turn.
     *
     * Uses experimental.chat.system.transform to push a <recalled_memories>
     * block into the system context. The user's latest message is captured
     * via chat.message and used as the query.
     */
    "experimental.chat.system.transform": async (
      _input: Record<string, unknown>,
      output: { system: string[] },
    ) => {
      const query = latestMessage.get("current") ?? "";
      if (!query.trim()) return;

      const start = Date.now();
      try {
        const hits = await memClient.queryMemory({
          query,
          limit: cfg.recallLimit,
        });

        const block = formatRecallBlock(hits, cfg.recallMaxChars);
        if (block) {
          output.system.push(block);
        }

        log.info("recall", {
          count: hits.length,
          chars: block.length,
          ms: Date.now() - start,
        });
      } catch (err: unknown) {
        log.error("recall_error", { error: String(err), ms: Date.now() - start });
      }
    },

    /**
     * Capture user messages so the system-transform hook has a query to use.
     */
    "chat.message": async (
      _input: Record<string, unknown>,
      output: { message?: { content?: string }; parts?: unknown[] },
    ) => {
      const text = output?.message?.content;
      if (typeof text === "string" && text.trim()) {
        latestMessage.set("current", text);
      }
    },

    /**
     * B) Write-back save-worthy content when the session goes idle.
     */
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (event.type !== "session.idle") return;
      if (!cfg.writebackEnabled) return;

      const sessionId = event.properties?.sessionID;
      if (!sessionId || !client) return;

      try {
        // Use the SDK client to retrieve the latest session messages.
        const session = await client.session.get({
          path: { id: sessionId },
        });
        const messages = session?.data?.messages ?? [];

        // Find the last assistant message.
        const lastAssistant = [...messages]
          .reverse()
          .find((m: any) => m.role === "assistant");
        if (!lastAssistant) return;

        const text =
          typeof lastAssistant.content === "string"
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content);

        if (!text.trim()) return;
        if (!isSaveWorthy(text)) return;
        if (containsSecret(text)) {
          log.warn("writeback_blocked", { reason: "secret_detected" });
          return;
        }

        const result = await memClient.addMemory({
          text,
          session_id: sessionId,
          tags: ["auto-writeback"],
        });
        log.info("writeback", { id: result.id ?? "unknown" });
      } catch (err: unknown) {
        log.error("writeback_error", { error: String(err) });
      }
    },

    /**
     * C) Preserve critical state during session compaction.
     *
     * Re-injects must-keep tagged memories into the compacted context so the
     * model retains critical information after compaction.
     */
    "experimental.session.compacting": async (
      input: { summary?: string; sessionID?: string; [key: string]: unknown },
      output: { context: string[]; prompt?: string },
    ) => {
      try {
        const hits = await memClient.queryMemory({
          query: input.summary ?? "session context",
          session_id: input.sessionID,
          limit: cfg.recallLimit,
          tags: ["must-keep"],
        });

        if (hits.length === 0) return;

        const block = formatRecallBlock(hits, cfg.recallMaxChars);
        if (block) {
          output.context.push(block);
        }

        log.info("compaction_preserve", { count: hits.length });
      } catch (err: unknown) {
        log.error("compaction_error", { error: String(err) });
      }
    },
  };
};
