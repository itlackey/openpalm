import {
  loadConfig,
  containsSecret,
  isSaveWorthy,
  formatRecallBlock,
  OpenMemoryClient,
} from "../lib/openmemory-client.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("plugin-openmemory");

const cfg = loadConfig();
const enabled = cfg.mode === "api";

type PluginContext = { client?: Record<string, Record<string, { get: (opts: Record<string, unknown>) => Promise<Record<string, unknown>> }>>; [key: string]: unknown };
type Plugin = (ctx: PluginContext) => Promise<Record<string, unknown>>;

export const OpenMemoryHTTP: Plugin = async ({ client }) => {
  if (!enabled) return {};

  const memClient = new OpenMemoryClient(cfg.baseUrl, cfg.apiKey || undefined);
  let latestUserMessage = "";

  return {
    "experimental.chat.system.transform": async (
      _input: Record<string, unknown>,
      output: { system: string[] },
    ) => {
      if (!latestUserMessage.trim()) return;

      const start = Date.now();
      try {
        const hits = await memClient.queryMemory({
          query: latestUserMessage,
          limit: cfg.recallLimit,
        });

        const block = formatRecallBlock(hits, cfg.recallMaxChars);
        if (block) output.system.push(block);
        log.info("recall", { count: hits.length, chars: block.length, ms: Date.now() - start });
      } catch (err: unknown) {
        log.error("recall_error", { error: String(err), ms: Date.now() - start });
      }
    },

    "chat.message": async (
      _input: Record<string, unknown>,
      output: { message?: { content?: string } },
    ) => {
      const text = output?.message?.content;
      if (typeof text === "string" && text.trim()) {
        latestUserMessage = text;
      }
    },

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type !== "session.idle") return;
      if (!cfg.writebackEnabled) return;

      const sessionId = event.properties?.sessionID as string | undefined;
      if (!sessionId || !client) return;

      try {
        const session = await client.session.get({
          path: { id: sessionId },
        });
        const data = session?.data as Record<string, unknown> | undefined;
        const messages = (data?.messages ?? []) as Array<{ role: string; content: unknown }>;

        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
        if (!lastAssistant) return;

        const text = typeof lastAssistant.content === "string"
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
        if (block) output.context.push(block);
        log.info("compaction_preserve", { count: hits.length });
      } catch (err: unknown) {
        log.error("compaction_error", { error: String(err) });
      }
    },
  };
};
