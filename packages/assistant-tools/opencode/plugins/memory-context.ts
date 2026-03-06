/**
 * OpenMemory Context Plugin — Automated Learning & Memory Management
 *
 * Lifecycle hooks:
 *   session.created   — retrieve relevant memories and inject as initial context
 *   session.idle       — extract learnings from the conversation via LLM
 *   session.deleted    — store episodic session summary, clean up state
 *   tool.execute.before — inject scoped procedural memory for admin/project tools
 *   tool.execute.after — emit outcome feedback for injected memories
 *   experimental.session.compacting — inject categorised memories into compaction
 *   shell.env          — expose OPENMEMORY env vars to child processes
 *
 * Enables "compound memory" — the assistant improves over time by accumulating
 * semantic, episodic, and procedural knowledge across sessions.
 */

import { basename } from "node:path";
import {
  type MemoryIdentity,
  type MemoryItem,
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
  OPENMEMORY_URL,
  USER_ID,
  addMemory,
  formatMemoriesForContext,
  getMemoryStats,
  isMemoryAvailable,
  sendMemoryFeedback,
  searchMemories,
} from "./memory-lib.ts";
import { runQuickHygiene, buildHygienePrompt } from "./memory-hygiene.ts";

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string;
  project: string;
  agentId: string;
  appId: string;
  startedAt: string;
  contextInjected: boolean;
  idleCount: number;
  lastExtractionAt: number;
}

const sessions = new Map<string, SessionState>();
const pendingToolFeedback = new Map<
  string,
  { memoryIds: string[]; identity: MemoryIdentity }
>();

// Module-level throttles
let lastHygieneRunAt = 0;
let sessionsSinceReflexion = 0;
const HYGIENE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const EXTRACTION_COOLDOWN_MS = 60_000; // 60 seconds between extractions
const MIN_IDLE_COUNT_FOR_EXTRACTION = 2;
const REFLEXION_SESSION_INTERVAL = 10;
const REFLEXION_EPISODE_THRESHOLD = 5;
const REFLEXION_DEFAULT_CONFIDENCE = 0.5;
const INCLUDE_GLOBAL_PROCEDURAL =
  (process.env.OPENMEMORY_INCLUDE_GLOBAL_PROCEDURAL ?? '').toLowerCase() === 'true';

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

function buildExtractionPrompt(state: SessionState): string {
  return `[SYSTEM: Memory Extraction]

Review the conversation so far and extract up to 5 important NEW learnings worth long-term memory.
Build a JSON array internally (do not print it) where each item has:
- "scope": "personal" | "stack" | "global"
- "category": "semantic" | "procedural" | "episodic"
- "text": string (single atomic memory)
- "confidence": number from 0.0 to 1.0
- "keywords": string[]
- "expiration_days": number | null

Identity context for this run:
- agent_id: "${state.agentId}"
- app_id: "${state.appId}"
- run_id: "${state.sessionId}"

Rules:
- Keep entries reusable and standalone ("do X because Y"), not session logs
- Never include secrets, tokens, credentials, or raw logs
- Discard transient one-off details
- Use scope carefully:
  - personal: user preferences and project conventions
  - stack: OpenPalm runtime/admin/container/platform behavior
  - global: cross-user universal rules (rare)
- Add expiration_days for hacks/workarounds/environment-specific facts

Do not print explanatory prose.
Use that internal JSON array to call memory-add once per object:
memory-add({
  text: "<text>",
  metadata: "{\"scope\":\"<scope>\",\"category\":\"<category>\",\"source\":\"auto-extract\",\"confidence\":<confidence>,\"keywords\":[...],\"expiration_days\":<expiration_days>,\"session_id\":\"${state.sessionId}\",\"project\":\"${state.project}\",\"agent_id\":\"${state.agentId}\",\"app_id\":\"${state.appId}\",\"run_id\":\"${state.sessionId}\"}"
})

If nothing is worth storing, respond with "Nothing to extract." and do not call tools.
If tool calling is unavailable, return only the JSON array and nothing else.`;
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
  memory-add({ text: "insight statement", metadata: '{"category":"semantic or procedural","source":"reflexion","project":"${project}","confidence":${REFLEXION_DEFAULT_CONFIDENCE}}' })

Rules:
- Only extract genuinely novel insights not already captured as individual memories
- Generalise from specific episodes into reusable knowledge
- Prefer procedural memories for workflow patterns, semantic for facts/preferences

If no new insights emerge, respond with "No new insights." and no tool calls.`;
}

function normaliseIdValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

function deriveAppId(project: string): string {
  if (!project || project === "unknown") return DEFAULT_APP_ID;
  return normaliseIdValue(basename(project));
}

function getSessionIdentity(
  state: SessionState | undefined,
  sessionId: string,
  scope: "personal" | "stack" | "global",
): MemoryIdentity {
  return {
    scope,
    agentId: state?.agentId ?? DEFAULT_AGENT_ID,
    appId: state?.appId ?? DEFAULT_APP_ID,
    runId: sessionId,
  };
}

function feedbackKey(sessionId: string, toolName: string): string {
  return `${sessionId}::${toolName}`;
}

function isProjectCodeTool(toolName: string): boolean {
  const codePrefixes = [
    "bash",
    "view",
    "rg",
    "glob",
    "task",
    "search_code_subagent",
    "apply_patch",
    "read_bash",
    "write_bash",
    "code_review",
  ];
  return codePrefixes.some((prefix) => toolName.startsWith(prefix));
}

function isToolResultFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  if ("error" in record && Boolean(record.error)) return true;
  if ("ok" in record && record.ok === false) return true;
  if ("success" in record && record.success === false) return true;
  return false;
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
      const agentId: string =
        input?.agent?.name ?? ctx?.agent?.name ?? DEFAULT_AGENT_ID;
      const appId = deriveAppId(project);

      // Initialise session state
      sessions.set(sessionId, {
        sessionId,
        project,
        agentId,
        appId,
        startedAt: new Date().toISOString(),
        contextInjected: false,
        idleCount: 0,
        lastExtractionAt: 0,
      });
      const sessionState = sessions.get(sessionId);

      // Graceful degradation: fetch stats once and bail out if unavailable
      const stats = await getMemoryStats();
      if (!stats) return;

      // Policy-based retrieval: personal + project + stack + global
      const [personalSemantic, personalProcedural, projectMems, stackSemantic, stackProcedural, globalProcedural, projectEpisodic] =
        await Promise.all([
          searchMemories(
            "user preferences project context conventions decisions",
            {
              size: 10,
              category: "semantic",
              ...getSessionIdentity(sessionState, sessionId, "personal"),
            },
          ),
          searchMemories("procedures workflows patterns how to", {
            size: 5,
            category: "procedural",
            ...getSessionIdentity(sessionState, sessionId, "personal"),
          }),
          project !== "unknown"
            ? searchMemories(`${project} project conventions coding patterns`, {
              size: 5,
              ...getSessionIdentity(sessionState, sessionId, "personal"),
            })
            : Promise.resolve([] as MemoryItem[]),
          searchMemories("openpalm platform runtime conventions", {
            size: 5,
            category: "semantic",
            ...getSessionIdentity(sessionState, sessionId, "stack"),
          }),
          searchMemories("openpalm operations procedures workflows", {
            size: 5,
            category: "procedural",
            ...getSessionIdentity(sessionState, sessionId, "stack"),
          }),
          INCLUDE_GLOBAL_PROCEDURAL
            ? searchMemories("global procedural rules", {
              size: 3,
              category: "procedural",
              ...getSessionIdentity(sessionState, sessionId, "global"),
            })
            : Promise.resolve([] as MemoryItem[]),
          project !== "unknown"
            ? searchMemories(`${project} recent sessions outcomes results`, {
              size: 8,
              category: "episodic",
              ...getSessionIdentity(sessionState, sessionId, "personal"),
            })
            : Promise.resolve([] as MemoryItem[]),
        ]);

      // Build context block
      const lines: string[] = ["## OpenMemory — Session Context"];
      if (stats) {
        lines.push(
          `Memory store: ${stats.total_memories} memories across ${stats.total_apps} apps.`,
        );
      }
      lines.push("");

      if (personalSemantic.length > 0) {
        lines.push("### Personal Facts & Preferences");
        lines.push(formatMemoriesForContext(personalSemantic));
        lines.push("");
      }

      if (personalProcedural.length > 0) {
        lines.push("### Personal Procedures");
        lines.push(formatMemoriesForContext(personalProcedural));
        lines.push("");
      }

      if (projectMems.length > 0) {
        lines.push(`### Project Context (${appId})`);
        lines.push(formatMemoriesForContext(projectMems));
        lines.push("");
      }

      if (stackSemantic.length > 0 || stackProcedural.length > 0) {
        lines.push("### OpenPalm Stack Memory");
        if (stackSemantic.length > 0) {
          lines.push(formatMemoriesForContext(stackSemantic));
        }
        if (stackProcedural.length > 0) {
          lines.push(formatMemoriesForContext(stackProcedural));
        }
        lines.push("");
      }

      if (globalProcedural.length > 0) {
        lines.push("### Global Procedures");
        lines.push(formatMemoriesForContext(globalProcedural));
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
        projectEpisodic.length >= REFLEXION_EPISODE_THRESHOLD &&
        typeof client?.session?.prompt === "function"
      ) {
        sessionsSinceReflexion = 0;
        try {
          const prompt = buildReflexionPrompt(projectEpisodic, project);
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
            `Automated memory extraction was run across ${state.idleCount} exchanges.`;
          await addMemory(summary, {
            category: "episodic",
            source: "auto-extract",
            session_id: sessionId,
            project: state.project,
            confidence: 0.8,
            created_by_hook: "session.deleted",
          }, getSessionIdentity(state, sessionId, "personal"));
        }
      }

      sessions.delete(sessionId);
      for (const key of pendingToolFeedback.keys()) {
        if (key.startsWith(`${sessionId}::`)) {
          pendingToolFeedback.delete(key);
        }
      }
    },

    // ------------------------------------------------------------------
    // tool.execute.before — applied learning (procedural injection)
    // ------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      const toolName: string | undefined = input?.tool?.name;
      if (!toolName) return;
      const sessionId: string =
        input?.session?.id ?? input?.properties?.sessionId ?? "unknown";
      const state = sessions.get(sessionId);

      if (toolName.startsWith("memory-")) return;

      const isAdminTool = toolName.startsWith("admin-");
      if (!isAdminTool && !isProjectCodeTool(toolName)) return;
      const adminIdentity = getSessionIdentity(state, sessionId, "stack");
      const personalIdentity = getSessionIdentity(state, sessionId, "personal");
      const [stackProcedural, personalProcedural, projectScoped] = isAdminTool
        ? await Promise.all([
          searchMemories(
            `openpalm procedure for ${toolName.replace(/_/g, " ")} operations`,
            {
              size: 4,
              category: "procedural",
              timeoutMs: 1_200,
              ...adminIdentity,
            },
          ),
          Promise.resolve([] as MemoryItem[]),
          Promise.resolve([] as MemoryItem[]),
        ])
        : await Promise.all([
          Promise.resolve([] as MemoryItem[]),
          searchMemories(`preferred workflow for ${toolName.replace(/_/g, " ")}`, {
            size: 3,
            category: "procedural",
            timeoutMs: 1_200,
            ...personalIdentity,
          }),
          searchMemories(`${state?.appId ?? DEFAULT_APP_ID} project patterns for ${toolName}`, {
            size: 3,
            timeoutMs: 1_200,
            ...personalIdentity,
          }),
        ]);
      const memories = [...stackProcedural, ...personalProcedural, ...projectScoped];
      const uniqueMemories = memories.filter(
        (memory, index, arr) => arr.findIndex((m) => m.id === memory.id) === index,
      );
      if (uniqueMemories.length === 0) return;

      const guidance = formatMemoriesForContext(
        uniqueMemories,
        `### Relevant Procedures for ${toolName}`,
      );
      if (output?.context) {
        output.context.push(guidance);
      }
      pendingToolFeedback.set(feedbackKey(sessionId, toolName), {
        memoryIds: uniqueMemories.map((memory) => memory.id),
        identity: isAdminTool ? adminIdentity : personalIdentity,
      });
    },

    "tool.execute.after": async (input: any, output: any) => {
      const toolName: string | undefined = input?.tool?.name;
      if (!toolName) return;
      const sessionId: string =
        input?.session?.id ?? input?.properties?.sessionId ?? "unknown";
      const pending = pendingToolFeedback.get(feedbackKey(sessionId, toolName));
      if (!pending || pending.memoryIds.length === 0) return;

      const result = output?.result ?? input?.result;
      const failed = Boolean(
        output?.error ||
        input?.error ||
        isToolResultFailure(result),
      );
      const reason = failed
        ? `Tool ${toolName} failed after memory injection`
        : `Tool ${toolName} succeeded using injected memory`;
      await Promise.all(
        pending.memoryIds.map((memoryId) =>
          sendMemoryFeedback(memoryId, !failed, reason, {
            ...pending.identity,
            runId: sessionId,
          })
        ),
      );
      pendingToolFeedback.delete(feedbackKey(sessionId, toolName));
    },

    // ------------------------------------------------------------------
    // experimental.session.compacting — enhanced memory injection
    // ------------------------------------------------------------------
    "experimental.session.compacting": async (_input: any, output: any) => {
      const sessionId: string =
        _input?.session?.id ?? _input?.properties?.sessionId ?? "unknown";
      const state = sessions.get(sessionId);

      const stats = await getMemoryStats(1_500);
      if (!stats) return;
      const [semanticMems, proceduralMems, stackProcedural] = await Promise.all([
        searchMemories(
          "user preferences project context important decisions",
          {
            size: 8,
            category: "semantic",
            timeoutMs: 1_500,
            highSignalOnly: true,
            ...getSessionIdentity(state, sessionId, "personal"),
          },
        ),
        searchMemories("procedures patterns workflows", {
          size: 5,
          category: "procedural",
          timeoutMs: 1_500,
          highSignalOnly: true,
          ...getSessionIdentity(state, sessionId, "personal"),
        }),
        searchMemories("openpalm stack procedures", {
          size: 5,
          category: "procedural",
          timeoutMs: 1_500,
          highSignalOnly: true,
          ...getSessionIdentity(state, sessionId, "stack"),
        }),
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

      if (stackProcedural.length > 0) {
        lines.push("");
        lines.push("### OpenPalm Stack Procedures");
        lines.push(formatMemoriesForContext(stackProcedural));
      }

      if (state) {
        lines.push("");
        lines.push("### Session State");
        lines.push(`- Project: ${state.project}`);
        lines.push(`- Session started: ${state.startedAt}`);
        lines.push(`- Automated extraction idle count: ${state.idleCount}`);
      }

      lines.push("");
      lines.push("### Memory Instructions");
      lines.push(
        "You have access to OpenMemory tools. Use `memory-search` to find relevant context. " +
          "Important learnings are automatically extracted. Use `memory-add` for anything the auto-extraction might miss. " +
          "Memories are categorised as semantic (facts), episodic (events), or procedural (workflows).",
      );

      if (!output) return;
      if (!output.context) {
        output.context = [];
      }
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
