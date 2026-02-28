/**
 * OpenMemory Context Plugin
 *
 * Automatically integrates OpenMemory with OpenCode sessions:
 * - On session.created: searches memories for relevant context and injects it
 * - On session.idle: extracts learnings from the conversation and stores them
 * - On compaction: injects memory context so it survives context window compaction
 *
 * This enables "compound memory" — the assistant gets smarter over time by
 * accumulating knowledge about the user, their preferences, and their projects.
 */

const OPENMEMORY_URL = process.env.OPENMEMORY_API_URL || "http://openmemory:8765";
const USER_ID = process.env.OPENMEMORY_USER_ID || "default_user";
const APP_NAME = "openpalm-assistant";

async function memorySearch(query: string): Promise<string> {
  try {
    const res = await fetch(`${OPENMEMORY_URL}/api/v1/memories/filter`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: USER_ID, search_query: query, page: 1, size: 10 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const items = data?.items || [];
    if (items.length === 0) return "";
    return items
      .map((m: any) => `- ${m.content}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function memoryAdd(text: string): Promise<void> {
  try {
    await fetch(`${OPENMEMORY_URL}/api/v1/memories/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: USER_ID,
        text,
        app: APP_NAME,
        metadata: { source: "auto-extract" },
        infer: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Silently fail — don't break sessions for memory failures
  }
}

async function getMemoryStats(): Promise<string> {
  try {
    const res = await fetch(
      `${OPENMEMORY_URL}/api/v1/stats/?user_id=${encodeURIComponent(USER_ID)}`,
      {
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(3_000),
      }
    );
    if (!res.ok) return "";
    const data = await res.json();
    return `Memory store: ${data.total_memories || 0} memories across ${data.total_apps || 0} apps.`;
  } catch {
    return "";
  }
}

export const MemoryContextPlugin = async (ctx: any) => {
  return {
    /**
     * Inject memory context into the compaction prompt so that relevant
     * memories survive when the context window is compacted.
     */
    "experimental.session.compacting": async (_input: any, output: any) => {
      const memories = await memorySearch("user preferences project context important decisions");
      const stats = await getMemoryStats();

      const lines = ["## OpenMemory Context"];
      if (stats) lines.push(stats);
      if (memories) {
        lines.push("");
        lines.push("### Relevant Memories");
        lines.push("The following memories from OpenMemory should be preserved:");
        lines.push(memories);
      }
      lines.push("");
      lines.push("### Memory Instructions");
      lines.push(
        "You have access to OpenMemory tools. Use `memory-search` to find relevant context before starting tasks. " +
        "Use `memory-add` to store important learnings, user preferences, and project decisions discovered during this session."
      );

      output.context.push(lines.join("\n"));
    },

    /**
     * Inject environment variables so memory tools can resolve the API URL.
     */
    "shell.env": async (_input: any, output: any) => {
      output.env.OPENMEMORY_API_URL = OPENMEMORY_URL;
      output.env.OPENMEMORY_USER_ID = USER_ID;
    },
  };
};
