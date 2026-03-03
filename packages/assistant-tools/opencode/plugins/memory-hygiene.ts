/**
 * Memory hygiene — lightweight quality management for OpenMemory.
 *
 * Called from the session.created hook (at most once per day) to detect
 * near-duplicate and stale memories.  Issues are reported back to the
 * agent for review rather than auto-deleted, keeping humans in the loop.
 */

import { pluginMemoryFetch, USER_ID } from "./memory-lib.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_DAYS = 30;
const LOW_CONFIDENCE_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HygieneReport {
  duplicatesFound: number;
  staleFound: number;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Quick scan of recent memories for obvious quality issues.
 * Returns counts only — the agent decides what to act on.
 */
export async function runQuickHygiene(): Promise<HygieneReport> {
  const report: HygieneReport = { duplicatesFound: 0, staleFound: 0 };

  try {
    const data = await pluginMemoryFetch("/api/v1/memories/filter", {
      method: "POST",
      body: JSON.stringify({
        user_id: USER_ID,
        page: 1,
        size: 50,
        sort_column: "created_at",
        sort_direction: "desc",
      }),
    });

    const items = data?.items;
    if (!items || items.length === 0) return report;

    // --- Duplicate detection (prefix-based) ---
    const seen = new Map<string, string>();
    for (const mem of items) {
      const key = normalise(mem.content ?? mem.memory ?? "");
      if (!key) continue;
      if (seen.has(key)) {
        report.duplicatesFound++;
      } else {
        seen.set(key, mem.id);
      }
    }

    // --- Staleness detection ---
    const now = Date.now();
    for (const mem of items) {
      const lastAccessed = mem.metadata?.last_accessed
        ? new Date(mem.metadata.last_accessed).getTime()
        : new Date(mem.created_at ?? now).getTime();
      const daysSince = (now - lastAccessed) / (1000 * 60 * 60 * 24);
      const confidence: number = mem.metadata?.confidence ?? 0.7;

      if (daysSince > STALE_THRESHOLD_DAYS && confidence < LOW_CONFIDENCE_THRESHOLD) {
        report.staleFound++;
      }
    }
  } catch {
    // Hygiene is best-effort
  }

  return report;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Returns a prompt the agent can act on, or null if the store is healthy.
 */
export function buildHygienePrompt(report: HygieneReport): string | null {
  if (report.duplicatesFound === 0 && report.staleFound === 0) return null;

  const parts: string[] = [
    "[SYSTEM: Memory Hygiene]",
    "",
    "A quick memory-store health check found potential issues:",
  ];

  if (report.duplicatesFound > 0) {
    parts.push(`- ${report.duplicatesFound} potential duplicate memories detected`);
  }
  if (report.staleFound > 0) {
    parts.push(`- ${report.staleFound} stale low-confidence memories found`);
  }

  parts.push("");
  parts.push(
    "Use memory-list to review and memory-delete to clean up obvious duplicates or stale entries. " +
      "Be conservative — only remove clearly redundant or incorrect information.",
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise content for dedup comparison: lowercase, strip punctuation, first 60 chars. */
function normalise(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim()
    .slice(0, 60);
}
