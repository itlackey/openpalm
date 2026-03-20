/**
 * Context assembly — the single path for building session context.
 * Prefers Viking when available, falls back to memory-only retrieval.
 */
import { isVikingConfigured, vikingFetch, vikingResponseHasError } from '../tools/viking-lib.ts';
import { estimateTokenCount, fitItemsInBudget } from './tokens.ts';
import { calculateRecommendedBudgets, type BudgetAllocation } from './budget.ts';

export type ContextItem = {
  source: 'viking' | 'memory';
  uri?: string;
  content: string;
  score?: number;
};

type AssembleContextOpts = {
  query: string;
  totalBudget?: number;
  vikingAvailable?: boolean;
  memorySearchFn?: (query: string, opts: { size: number }) => Promise<Array<{ id: string; content: string; score?: number }>>;
};

/**
 * Assemble context from Viking and/or memory sources.
 * Uses explicit token budgets and falls back cleanly to memory-only.
 */
export async function assembleContext(opts: AssembleContextOpts): Promise<{
  items: ContextItem[];
  budget: BudgetAllocation;
  totalTokens: number;
}> {
  const totalBudget = opts.totalBudget ?? 4000;
  const vikingAvailable = opts.vikingAvailable ?? isVikingConfigured();
  const budget = calculateRecommendedBudgets(totalBudget, vikingAvailable);

  const items: ContextItem[] = [];
  let totalTokens = 0;

  // Viking search when available
  if (vikingAvailable) {
    try {
      const searchResult = await vikingFetch('/search/find', {
        method: 'POST',
        body: JSON.stringify({
          query: opts.query,
          limit: 10,
        }),
      });

      if (!vikingResponseHasError(searchResult)) {
        try {
          const parsed = JSON.parse(searchResult) as {
            result?: {
              resources?: Array<{ uri: string; abstract?: string; score?: number }>;
              memories?: Array<{ uri: string; abstract?: string; score?: number }>;
            };
          };

          // Collect resource items within budget
          const resources = (parsed.result?.resources ?? []).map((r) => ({
            source: 'viking' as const,
            uri: r.uri,
            content: r.abstract ?? '',
            score: r.score,
          }));
          const fittedResources = fitItemsInBudget(resources, (i) => i.content, budget.vikingResources);
          items.push(...fittedResources);

          // Collect memory items within budget
          const memories = (parsed.result?.memories ?? []).map((m) => ({
            source: 'viking' as const,
            uri: m.uri,
            content: m.abstract ?? '',
            score: m.score,
          }));
          const fittedMemories = fitItemsInBudget(memories, (i) => i.content, budget.vikingMemories);
          items.push(...fittedMemories);
        } catch {
          // Malformed response — skip Viking results
        }
      }
    } catch {
      // Viking search failed — fall through to memory search
    }
  }

  // Memory search (always runs for remaining budget)
  if (opts.memorySearchFn) {
    try {
      const memoryResults = await opts.memorySearchFn(opts.query, { size: 10 });
      const memoryItems = memoryResults.map((m) => ({
        source: 'memory' as const,
        content: m.content,
        score: m.score,
      }));
      // Memory search uses combined budget — per-category enforcement deferred to 0.11.0
      const remainingBudget = budget.semanticMemory + budget.proceduralMemory + budget.episodicMemory;
      const fittedMemory = fitItemsInBudget(memoryItems, (i) => i.content, remainingBudget);
      items.push(...fittedMemory);
    } catch {
      // Memory search failed — return what we have
    }
  }

  totalTokens = items.reduce((sum, item) => sum + estimateTokenCount(item.content), 0);

  return { items, budget, totalTokens };
}

/**
 * Format assembled context items into a markdown string.
 */
export function formatAssembledContext(items: ContextItem[]): string {
  if (items.length === 0) return '';

  const vikingItems = items.filter((i) => i.source === 'viking');
  const memoryItems = items.filter((i) => i.source === 'memory');

  const lines: string[] = [];

  if (vikingItems.length > 0) {
    lines.push('### Viking Knowledge');
    for (const item of vikingItems) {
      const label = item.uri ?? 'knowledge';
      lines.push(`- **${label}**: ${item.content}`);
    }
  }

  if (memoryItems.length > 0) {
    lines.push('### Memory Context');
    for (const item of memoryItems) {
      lines.push(`- ${item.content}`);
    }
  }

  return lines.join('\n');
}
