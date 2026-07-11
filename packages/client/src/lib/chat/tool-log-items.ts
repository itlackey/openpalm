/**
 * P3 [MEDIUM] (PR #562 xhigh review, chat efficiency) —
 * `routes/chat/+page.svelte`'s `toolLogItems` derived value used to rebuild a
 * Set+array over ALL of `chatState.entries` on EVERY controller notify, even
 * a per-delta `pendingText`-only change that never touched `entries` at
 * all — because the page copies `controller.getState()` into a brand-new
 * `chatState` object on every notification (`chatState = { ...controller.
 * getState() }`), which invalidates any `$derived.by` reading
 * `chatState.entries` regardless of whether the array itself changed.
 *
 * Fix: memoize the expensive O(entries) "history" scan by the `entries`
 * array's REFERENCE (chat-controller.ts only ever assigns a NEW array to
 * `state.entries` when it actually changes — never on a text-delta-only
 * notify), and merge in the cheap O(pendingToolStates) "live" side fresh on
 * every call. Same output as re-scanning everything every time.
 */
import type { ToolStateSnapshot } from '../transport/index.js';

// `id` is required (not just `toolStates?`) so a ChatEntry union member with
// NO toolStates at all (the 'note' kind) still shares a real property with
// this type — every ChatEntry variant has an `id` — instead of TS's
// weak-object-type check rejecting the assignment as "no properties in
// common" (every OTHER property here is optional).
export type EntryWithToolStates = { id: string; toolStates?: ToolStateSnapshot[] };

function scanHistoryToolStates(entries: readonly EntryWithToolStates[]): ToolStateSnapshot[] {
  const seen = new Set<string>();
  const out: ToolStateSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.toolStates) continue;
    for (const tool of entry.toolStates) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      out.push(tool);
    }
  }
  return out;
}

/**
 * Returns a stateful deriver: dedupes committed-entry `toolStates` (history)
 * with the in-flight turn's `pendingToolStates` (live), by id — mirrors the
 * old chat-state's `toolLog` getter. The O(entries) history scan only
 * reruns when the `entries` array reference actually changes; a mutated
 * array with the SAME reference is served from cache (matches how
 * chat-controller.ts always assigns a fresh array to `state.entries` when
 * its contents change, never mutates one in place).
 */
export function createToolLogItemsDeriver(): (
  entries: readonly EntryWithToolStates[],
  pendingToolStates: readonly ToolStateSnapshot[]
) => ToolStateSnapshot[] {
  let cachedEntries: readonly EntryWithToolStates[] | null = null;
  let cachedHistory: ToolStateSnapshot[] = [];

  return (entries, pendingToolStates) => {
    if (entries !== cachedEntries) {
      cachedHistory = scanHistoryToolStates(entries);
      cachedEntries = entries;
    }
    if (pendingToolStates.length === 0) return cachedHistory;
    const seen = new Set(cachedHistory.map((tool) => tool.id));
    const out = [...cachedHistory];
    for (const tool of pendingToolStates) {
      if (seen.has(tool.id)) continue;
      seen.add(tool.id);
      out.push(tool);
    }
    return out;
  };
}
