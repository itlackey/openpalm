/**
 * Context budget allocation and calculation utilities.
 * Determines how to split a total token budget across knowledge sources.
 */

export type BudgetAllocation = {
  /** Tokens for personal semantic memories (facts, preferences) */
  semanticMemory: number;
  /** Tokens for procedural memories (workflows, patterns) */
  proceduralMemory: number;
  /** Tokens for episodic memories (session history) */
  episodicMemory: number;
  /** Tokens for Viking resources (uploaded docs, repos) */
  vikingResources: number;
  /** Tokens for Viking-extracted memories */
  vikingMemories: number;
};

/** Default budget splits (percentages) */
const DEFAULT_SPLITS = {
  semanticMemory: 0.25,
  proceduralMemory: 0.20,
  episodicMemory: 0.15,
  vikingResources: 0.25,
  vikingMemories: 0.15,
} as const;

/** Budget splits when Viking is not available (sum to 1.0) */
const MEMORY_ONLY_SPLITS = {
  semanticMemory: 0.40,
  proceduralMemory: 0.35,
  episodicMemory: 0.25,
  vikingResources: 0,
  vikingMemories: 0,
} as const;

/**
 * Calculate recommended budget allocation for context assembly.
 * Allocates tokens across knowledge sources based on availability.
 */
export function calculateRecommendedBudgets(
  totalBudget: number,
  vikingAvailable: boolean = false,
): BudgetAllocation {
  const splits = vikingAvailable ? DEFAULT_SPLITS : MEMORY_ONLY_SPLITS;
  return {
    semanticMemory: Math.floor(totalBudget * splits.semanticMemory),
    proceduralMemory: Math.floor(totalBudget * splits.proceduralMemory),
    episodicMemory: Math.floor(totalBudget * splits.episodicMemory),
    vikingResources: Math.floor(totalBudget * splits.vikingResources),
    vikingMemories: Math.floor(totalBudget * splits.vikingMemories),
  };
}

/**
 * Parse a budget string (e.g., "4k", "8000", "2.5k") into token count.
 * Returns 0 for invalid input.
 */
export function parseBudgetString(budgetStr: string): number {
  if (!budgetStr) return 0;
  const trimmed = budgetStr.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*k?$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  // Regex already prevents negative values; this guards NaN/Infinity only
  if (!Number.isFinite(value)) return 0;
  return trimmed.endsWith('k') ? Math.floor(value * 1000) : Math.floor(value);
}
