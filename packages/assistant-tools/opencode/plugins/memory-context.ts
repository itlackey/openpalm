/**
 * OpenMemory Context Plugin — Automated Learning & Memory Management
 *
 * Lifecycle hooks:
 *   session.created   — retrieve relevant memories and inject as initial context
 *   session.idle       — extract learnings from the conversation via LLM
 *   session.deleted    — store episodic session summary, clean up state
 *   tool.execute.before — inject procedural memory for admin operations
 *   experimental.session.compacting — inject categorised memories into compaction
 *   shell.env          — expose OPENMEMORY env vars to child processes
 *
 * Enables "compound memory" — the assistant improves over time by accumulating
 * semantic, episodic, and procedural knowledge across sessions.
 */

import {
  type MemoryItem,
  OPENMEMORY_URL,
  USER_ID,
  addMemory,
  formatMemoriesForContext,
  getMemoryStats,
  isMemoryAvailable,
  searchMemories,
} from "./memory-lib.ts";
import { runQuickHygiene, buildHygienePrompt } from "./memory-hygiene.ts";

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  project: string;
  startedAt: string;
  contextInjected: boolean;
  idleCount: number;
  lastExtractionAt: number;
  extractedThisSession: string[];
}

const sessions = new Map<string, SessionState>();

// Module-level throttles
let lastHygieneRunAt = 0;
let sessionsSinceReflexion = 0;
const HYGIENE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const EXTRACTION_COOLDOWN_MS = 60_000; // 60 seconds between extractions
const MIN_IDLE_COUNT_FOR_EXTRACTION = 2;
const REFLEXION_SESSION_INTERVAL = 10;
const REFLEXION_EPISODE_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

function buildExtractionPrompt(state: SessionState): string {
  return `[SYSTEM: Memory Extraction]

Review the conversation so far and extract any important NEW information worth remembering long-term. For each item, call memory-add with the text and appropriate metadata JSON string.

Categories (use as the "category" field in metadata):
- "semantic" — general facts, user preferences, project decisions, technical knowledge
- "episodic" — specific events or outcomes from this session (what happened, results, errors)
- "procedural" — procedures, workflows, multi-step patterns that worked (how-to knowledge)

For each learning, call memory-add like this:
  memory-add({ text: "clear standalone statement", metadata: '{"category":"semantic","source":"auto-extract","session_id":"${state.sessionId}","project":"${state.project}"}' })

Rules:
- Only genuinely NEW information not already in memory
- Write each memory as a clear, self-contained statement
- Never store secrets, API keys, passwords, or tokens
- Skip ephemeral details (current git branch, temp file paths)
- Prefer quality over quantity — one precise statement over five vague ones
- After storing memories, briefly acknowledge what you learned (e.g. "Noted for future sessions: ...")

If nothing worth remembering was discussed, respond with "Nothing to extract." and no tool calls.`;
}

// ---------------------------------------------------------------------------
// Reflexion prompt builder
// ---------------------------------------------------------------------------

function buildReflexionPrompt(
  episodes: MemoryItem[],
  project: string,
): string {
  const episodeList = episodes.map((e) => `- ${e.content}`).join("\n");
  return `[SYSTEM: Cross-Session Reflexion]

Review these past session episodes for project "${project}" and extract higher-level insights — recurring patterns, successful approaches, evolving preferences, or lessons learned across sessions:

${episodeList}

For each insight, call memory-add with metadata:
  memory-add({ text: "insight statement", metadata: '{"category":"semantic or procedural","source":"reflexion","project":"${project}","confidence":"0.5"}' })

Rules:
- Only extract genuinely novel insights not already captured as individual memories
- Generalise from specific episodes into reusable knowledge
- Prefer procedural memories for workflow patterns, semantic for facts/preferences

If no new insights emerge, respond with "No new insights." and no tool calls.`;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const MemoryContextPlugin = async (ctx: any) => {
  const client = ctx?.client;

  return {
    // ------------------------------------------------------------------
    // session.created — automated context retrieval
    // ------------------------------------------------------------------
    "session.created": async (input: any, output: any) => {
      const sessionId: string =
        input?.session?.id ?? input?.properties?.sessionId ?? "unknown";
      const project: string =
        input?.project?.name ?? ctx?.project?.name ?? ctx?.directory ?? "unknown";

      // Initialise session state
      sessions.set(sessionId, {
        sessionId,
        project,
        startedAt: new Date().toISOString(),
        contextInjected: false,
        idleCount: 0,
        lastExtractionAt: 0,
        extractedThisSession: [],
      });

      // Graceful degradation
      if (!(await isMemoryAvailable())) return;

      // Parallel retrieval: semantic + procedural + episodic + stats
      const [semanticMems, proceduralMems, episodicMems, stats] =
        await Promise.all([
          searchMemories(
            "user preferences project context conventions decisions",
            { size: 10, category: "semantic" },
          ),
          searchMemories("procedures workflows patterns how to", {
            size: 5,
            category: "procedural",
          }),
          searchMemories("recent sessions outcomes results", {
            size: 5,
            category: "episodic",
          }),
          getMemoryStats(),
        ]);

      // Project-scoped search (conditional)
      let projectMems: MemoryItem[] = [];
      if (project !== "unknown") {
        projectMems = await searchMemories(
          `${project} project specific context`,
          { size: 5 },
        );
      }

      // Build context block
      const lines: string[] = ["## OpenMemory — Session Context"];
      if (stats) {
        lines.push(
          `Memory store: ${stats.total_memories} memories across ${stats.total_apps} apps.`,
        );
      }
      lines.push("");

      if (semanticMems.length > 0) {
        lines.push("### Known Facts & Preferences");
        lines.push(formatMemoriesForContext(semanticMems));
        lines.push("");
      }

      if (proceduralMems.length > 0) {
        lines.push("### Learned Procedures");
        lines.push(
          "These are patterns and workflows learned from past sessions:",
        );
        lines.push(formatMemoriesForContext(proceduralMems));
        lines.push("");
      }

      if (episodicMems.length > 0) {
        lines.push("### Recent Session History");
        lines.push(formatMemoriesForContext(episodicMems));
        lines.push("");
      }

      if (projectMems.length > 0) {
        lines.push(`### Project Context (${project})`);
        lines.push(formatMemoriesForContext(projectMems));
        lines.push("");
      }

      lines.push("### Memory Instructions");
      lines.push(
        "You have access to OpenMemory tools. Use `memory-search` to find additional context. " +
          "Important learnings from this session will be automatically extracted and stored. " +
          "Use `memory-add` explicitly for anything the auto-extraction might miss.",
      );

      if (output?.context) {
        output.context.push(lines.join("\n"));
      }

      const state = sessions.get(sessionId);
      if (state) state.contextInjected = true;

      // --- Daily hygiene check ---
      const now = Date.now();
      if (now - lastHygieneRunAt > HYGIENE_INTERVAL_MS) {
        lastHygieneRunAt = now;
        try {
          const report = await runQuickHygiene();
          const prompt = buildHygienePrompt(report);
          if (
            prompt &&
            typeof client?.session?.prompt === "function"
          ) {
            await client.session.prompt({
              path: { id: sessionId },
              body: { parts: [{ type: "text", text: prompt }] },
            });
          }
        } catch {
          // Hygiene is best-effort
        }
      }

      // --- Cross-session reflexion ---
      sessionsSinceReflexion++;
      if (
        sessionsSinceReflexion >= REFLEXION_SESSION_INTERVAL &&
        episodicMems.length >= REFLEXION_EPISODE_THRESHOLD &&
        typeof client?.session?.prompt === "function"
      ) {
        sessionsSinceReflexion = 0;
        try {
          const prompt = buildReflexionPrompt(episodicMems, project);
          await client.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: prompt }] },
          });
        } catch {
          // Reflexion is best-effort
        }
      }
    },

    // ------------------------------------------------------------------
    // session.idle — automated learning extraction
    // ------------------------------------------------------------------
    "session.idle": async (input: any) => {
      const sessionId: string =
        input?.session?.id ?? input?.properties?.sessionId ?? "unknown";
      const state = sessions.get(sessionId);
      if (!state) return;

      state.idleCount++;

      // Skip trivial sessions
      if (state.idleCount < MIN_IDLE_COUNT_FOR_EXTRACTION) return;

      // Throttle extractions
      const now = Date.now();
      if (now - state.lastExtractionAt < EXTRACTION_COOLDOWN_MS) return;

      // Graceful degradation
      if (!(await isMemoryAvailable())) return;

      state.lastExtractionAt = now;

      // Use the agent to reflect and extract learnings
      const sessionClient = input?.client ?? client;
      if (typeof sessionClient?.session?.prompt !== "function") return;

      try {
        const prompt = buildExtractionPrompt(state);
        await sessionClient.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        });
      } catch {
        // Extraction is best-effort — don't break sessions
      }
    },

    // ------------------------------------------------------------------
    // session.deleted — episodic summary + state cleanup
    // ------------------------------------------------------------------
    "session.deleted": async (input: any) => {
      const sessionId: string =
        input?.session?.id ?? input?.properties?.sessionId ?? "unknown";
      const state = sessions.get(sessionId);
      if (!state) return;

      // Store episodic summary for non-trivial sessions
      if (state.idleCount >= MIN_IDLE_COUNT_FOR_EXTRACTION) {
        if (await isMemoryAvailable()) {
          const summary =
            `Session in project "${state.project}" started ${state.startedAt}. ` +
            `${state.extractedThisSession.length} learnings extracted across ` +
            `${state.idleCount} exchanges.`;
          await addMemory(summary, {
            category: "episodic",
            source: "auto-extract",
            session_id: sessionId,
            project: state.project,
            confidence: 0.8,
            created_by_hook: "session.deleted",
          });
        }
      }

      sessions.delete(sessionId);
    },

    // ------------------------------------------------------------------
    // tool.execute.before — applied learning (procedural injection)
    // ------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      const toolName: string | undefined = input?.tool?.name;
      if (!toolName) return;

      // Only inject for admin-operation tools where past procedures matter
      const proceduralPrefixes = [
        "admin-lifecycle",
        "admin-containers",
        "admin-channels",
        "admin-config",
      ];
      if (!proceduralPrefixes.some((p) => toolName.startsWith(p))) return;

      const memories = await searchMemories(
        `procedure for ${toolName.replace(/_/g, " ")} operations`,
        { size: 3, category: "procedural" },
      );
      if (memories.length === 0) return;

      const guidance = formatMemoriesForContext(
        memories,
        `### Relevant Procedures for ${toolName}`,
      );
      if (output?.context) {
        output.context.push(guidance);
      }
    },

    // ------------------------------------------------------------------
    // experimental.session.compacting — enhanced memory injection
    // ------------------------------------------------------------------
    "experimental.session.compacting": async (_input: any, output: any) => {
      const sessionId: string =
        _input?.session?.id ?? _input?.properties?.sessionId ?? "unknown";
      const state = sessions.get(sessionId);

      const [semanticMems, proceduralMems, stats] = await Promise.all([
        searchMemories(
          "user preferences project context important decisions",
          { size: 10, category: "semantic" },
        ),
        searchMemories("procedures patterns workflows", {
          size: 5,
          category: "procedural",
        }),
        getMemoryStats(),
      ]);

      const lines = ["## OpenMemory Context (Compaction)"];
      if (stats) {
        lines.push(
          `Memory store: ${stats.total_memories} memories across ${stats.total_apps} apps.`,
        );
      }

      if (semanticMems.length > 0) {
        lines.push("");
        lines.push("### Known Facts & Preferences");
        lines.push(formatMemoriesForContext(semanticMems));
      }

      if (proceduralMems.length > 0) {
        lines.push("");
        lines.push("### Learned Procedures");
        lines.push(formatMemoriesForContext(proceduralMems));
      }

      if (state) {
        lines.push("");
        lines.push("### Session State");
        lines.push(`- Project: ${state.project}`);
        lines.push(`- Session started: ${state.startedAt}`);
        lines.push(
          `- Memories extracted this session: ${state.extractedThisSession.length}`,
        );
      }

      lines.push("");
      lines.push("### Memory Instructions");
      lines.push(
        "You have access to OpenMemory tools. Use `memory-search` to find relevant context. " +
          "Important learnings are automatically extracted. Use `memory-add` for anything the auto-extraction might miss. " +
          "Memories are categorised as semantic (facts), episodic (events), or procedural (workflows).",
      );

      output.context.push(lines.join("\n"));
    },

    // ------------------------------------------------------------------
    // shell.env — environment variable injection (unchanged)
    // ------------------------------------------------------------------
    "shell.env": async (_input: any, output: any) => {
      output.env.OPENMEMORY_API_URL = OPENMEMORY_URL;
      output.env.OPENMEMORY_USER_ID = USER_ID;
    },
  };
};
