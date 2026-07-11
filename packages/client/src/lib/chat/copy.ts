/**
 * Pure clipboard-copy logic (review 2026-07-10 §B7), extracted out of
 * ChatTurn.svelte so the write-and-report-success behavior unit-tests
 * without a real `navigator.clipboard` (packages/client's bun:test harness
 * has no DOM). The DOM-manipulation half (appending a copy button to each
 * rendered `<pre>`, `decorateCodeCopy`) stays a Svelte action in the
 * component — it has no logic worth extracting, only node creation.
 */

export type ClipboardLike = { writeText(text: string): Promise<void> };

export function isClipboardAvailable(clipboard: ClipboardLike | undefined | null): boolean {
  return typeof clipboard?.writeText === 'function';
}

/**
 * Write `text` to the clipboard. Never throws — a denied/unsupported write
 * resolves `false` so the caller can leave the copy affordance's label
 * unchanged instead of claiming success (mirrors the old `copyMessage`).
 */
export async function writeClipboardText(
  clipboard: ClipboardLike | undefined | null,
  text: string
): Promise<boolean> {
  if (!isClipboardAvailable(clipboard)) return false;
  try {
    await clipboard!.writeText(text);
    return true;
  } catch {
    return false;
  }
}
