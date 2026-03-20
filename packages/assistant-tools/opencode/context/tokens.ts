/**
 * Token estimation and budget fitting utilities.
 * Portable, side-effect free helpers for context assembly.
 */

/** Rough token estimation: ~4 characters per token for English text */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Fit items into a token budget, skipping items that exceed the remaining
 * capacity and continuing with subsequent items that do fit.
 */
export function fitItemsInBudget<T>(
  items: T[],
  getContent: (item: T) => string,
  budgetTokens: number,
): T[] {
  if (budgetTokens <= 0) return [];
  const result: T[] = [];
  let used = 0;
  for (const item of items) {
    const content = getContent(item);
    const tokens = estimateTokenCount(content);
    if (used + tokens > budgetTokens) continue;
    result.push(item);
    used += tokens;
  }
  return result;
}
