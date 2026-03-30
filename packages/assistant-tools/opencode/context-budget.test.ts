import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { estimateTokenCount, fitItemsInBudget } from './context/tokens.ts';
import { calculateRecommendedBudgets, parseBudgetString } from './context/budget.ts';
import { assembleContext, formatAssembledContext } from './context/assemble.ts';

// ---------------------------------------------------------------------------
// estimateTokenCount
// ---------------------------------------------------------------------------
describe('estimateTokenCount', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('returns 0 for undefined-like input', () => {
    expect(estimateTokenCount(undefined as unknown as string)).toBe(0);
    expect(estimateTokenCount(null as unknown as string)).toBe(0);
  });

  it('returns reasonable estimate for known text', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateTokenCount('hello world')).toBe(3);
  });

  it('handles very short text', () => {
    // "hi" = 2 chars → ceil(2/4) = 1
    expect(estimateTokenCount('hi')).toBe(1);
  });

  it('handles longer text proportionally', () => {
    const text = 'a'.repeat(400);
    // 400 chars → ceil(400/4) = 100
    expect(estimateTokenCount(text)).toBe(100);
  });

  it('rounds up partial tokens', () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokenCount('abcde')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// fitItemsInBudget
// ---------------------------------------------------------------------------
describe('fitItemsInBudget', () => {
  const items = [
    { id: 1, text: 'a'.repeat(40) },   // 10 tokens
    { id: 2, text: 'b'.repeat(80) },   // 20 tokens
    { id: 3, text: 'c'.repeat(120) },  // 30 tokens
    { id: 4, text: 'd'.repeat(40) },   // 10 tokens
  ];
  const getContent = (item: { text: string }) => item.text;

  it('returns empty for empty items', () => {
    expect(fitItemsInBudget([], getContent, 1000)).toEqual([]);
  });

  it('returns empty for zero budget', () => {
    expect(fitItemsInBudget(items, getContent, 0)).toEqual([]);
  });

  it('returns empty for negative budget', () => {
    expect(fitItemsInBudget(items, getContent, -100)).toEqual([]);
  });

  it('returns all items when they all fit', () => {
    const result = fitItemsInBudget(items, getContent, 1000);
    expect(result.length).toBe(4);
    expect(result.map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it('stops adding when budget is exhausted', () => {
    // Budget for 45 tokens: item1 (10) + item2 (20) = 30 fits, item3 (30) skipped (60>45), item4 (10) fits (40<=45)
    const result = fitItemsInBudget(items, getContent, 45);
    expect(result.map((i) => i.id)).toEqual([1, 2, 4]);
  });

  it('skips items too large and picks later smaller items', () => {
    // Budget for 15 tokens: item1 (10) fits, item2 (20) skipped, item3 (30) skipped, item4 (10) doesn't fit (10+10=20>15)
    const result = fitItemsInBudget(items, getContent, 15);
    expect(result.map((i) => i.id)).toEqual([1]);
  });

  it('handles single item that exceeds budget', () => {
    const bigItems = [{ id: 1, text: 'a'.repeat(4000) }]; // 1000 tokens
    const result = fitItemsInBudget(bigItems, getContent, 10);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// calculateRecommendedBudgets
// ---------------------------------------------------------------------------
describe('calculateRecommendedBudgets', () => {
  it('with Viking: all 5 categories get allocation', () => {
    const budget = calculateRecommendedBudgets(10000, true);
    expect(budget.semanticMemory).toBe(2500);
    expect(budget.proceduralMemory).toBe(2000);
    expect(budget.episodicMemory).toBe(1500);
    expect(budget.vikingResources).toBe(2500);
    expect(budget.vikingMemories).toBe(1500);
  });

  it('without Viking: vikingResources and vikingMemories are 0', () => {
    const budget = calculateRecommendedBudgets(10000, false);
    expect(budget.vikingResources).toBe(0);
    expect(budget.vikingMemories).toBe(0);
    expect(budget.semanticMemory).toBe(4000);
    expect(budget.proceduralMemory).toBe(3500);
    expect(budget.episodicMemory).toBe(2500);
  });

  it('defaults to Viking unavailable', () => {
    const budget = calculateRecommendedBudgets(10000);
    expect(budget.vikingResources).toBe(0);
    expect(budget.vikingMemories).toBe(0);
  });

  it('total of allocations <= totalBudget (due to floor)', () => {
    const budget = calculateRecommendedBudgets(10001, true);
    const total =
      budget.semanticMemory +
      budget.proceduralMemory +
      budget.episodicMemory +
      budget.vikingResources +
      budget.vikingMemories;
    expect(total).toBeLessThanOrEqual(10001);
  });

  it('budget of 0 returns all zeros', () => {
    const budget = calculateRecommendedBudgets(0, true);
    expect(budget.semanticMemory).toBe(0);
    expect(budget.proceduralMemory).toBe(0);
    expect(budget.episodicMemory).toBe(0);
    expect(budget.vikingResources).toBe(0);
    expect(budget.vikingMemories).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseBudgetString
// ---------------------------------------------------------------------------
describe('parseBudgetString', () => {
  it('"4k" -> 4000', () => {
    expect(parseBudgetString('4k')).toBe(4000);
  });

  it('"4000" -> 4000', () => {
    expect(parseBudgetString('4000')).toBe(4000);
  });

  it('"2.5k" -> 2500', () => {
    expect(parseBudgetString('2.5k')).toBe(2500);
  });

  it('"" -> 0', () => {
    expect(parseBudgetString('')).toBe(0);
  });

  it('"abc" -> 0', () => {
    expect(parseBudgetString('abc')).toBe(0);
  });

  it('handles whitespace around value', () => {
    expect(parseBudgetString('  4k  ')).toBe(4000);
  });

  it('"0" -> 0', () => {
    expect(parseBudgetString('0')).toBe(0);
  });

  it('"0k" -> 0', () => {
    expect(parseBudgetString('0k')).toBe(0);
  });

  it('"10K" -> 10000 (case insensitive)', () => {
    expect(parseBudgetString('10K')).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// assembleContext
// ---------------------------------------------------------------------------
describe('assembleContext', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OPENVIKING_URL = 'http://viking:9090';
    process.env.OPENVIKING_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
  });

  it('Viking available: returns viking items within budget', async () => {
    let fetchedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          result: {
            resources: [
              { uri: 'viking://docs/readme', abstract: 'Project README content', score: 0.95 },
            ],
            memories: [
              { uri: 'viking://memories/pref', abstract: 'User prefers Bun', score: 0.88 },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await assembleContext({
      query: 'how to build',
      vikingAvailable: true,
      totalBudget: 4000,
    });

    // Verify vikingFetch was called with the correct search endpoint
    expect(fetchedUrl).toContain('/api/v1/search/find');

    const vikingItems = result.items.filter((i) => i.source === 'viking');
    expect(vikingItems.length).toBe(2);
    expect(vikingItems[0].uri).toBe('viking://docs/readme');
    expect(vikingItems[1].content).toBe('User prefers Bun');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBeLessThanOrEqual(4000);
  });

  it('Viking unavailable: returns memory-only items', async () => {
    const mockMemorySearch = async (_query: string, _opts: { size: number }) => [
      { id: 'mem-1', content: 'User prefers TypeScript', score: 0.9 },
      { id: 'mem-2', content: 'Project uses Bun runtime', score: 0.85 },
    ];

    const result = await assembleContext({
      query: 'tech preferences',
      vikingAvailable: false,
      totalBudget: 4000,
      memorySearchFn: mockMemorySearch,
    });

    expect(result.items.length).toBe(2);
    expect(result.items.every((i) => i.source === 'memory')).toBe(true);
    expect(result.budget.vikingResources).toBe(0);
    expect(result.budget.vikingMemories).toBe(0);
  });

  it('Both sources: returns combined items', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          result: {
            resources: [{ uri: 'viking://docs/api', abstract: 'API docs', score: 0.9 }],
            memories: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const mockMemorySearch = async () => [
      { id: 'mem-1', content: 'Memory fact 1' },
    ];

    const result = await assembleContext({
      query: 'api usage',
      vikingAvailable: true,
      totalBudget: 4000,
      memorySearchFn: mockMemorySearch,
    });

    const vikingItems = result.items.filter((i) => i.source === 'viking');
    const memoryItems = result.items.filter((i) => i.source === 'memory');
    expect(vikingItems.length).toBe(1);
    expect(memoryItems.length).toBe(1);
  });

  it('Empty results: returns empty items', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ result: { resources: [], memories: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const mockMemorySearch = async () => [];

    const result = await assembleContext({
      query: 'nothing matches',
      vikingAvailable: true,
      totalBudget: 4000,
      memorySearchFn: mockMemorySearch,
    });

    expect(result.items.length).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it('Budget respected: total tokens <= totalBudget', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          result: {
            resources: Array.from({ length: 10 }, (_, i) => ({
              uri: `viking://docs/doc-${i}`,
              abstract: 'x'.repeat(400), // 100 tokens each
              score: 0.9,
            })),
            memories: Array.from({ length: 10 }, (_, i) => ({
              uri: `viking://mem/m-${i}`,
              abstract: 'y'.repeat(400), // 100 tokens each
              score: 0.8,
            })),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const mockMemorySearch = async () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        content: 'z'.repeat(400), // 100 tokens each
        score: 0.7,
      }));

    const result = await assembleContext({
      query: 'everything',
      vikingAvailable: true,
      totalBudget: 500,
      memorySearchFn: mockMemorySearch,
    });

    expect(result.totalTokens).toBeLessThanOrEqual(500);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('Viking fetch failure: falls back gracefully', async () => {
    globalThis.fetch = (() => {
      throw new Error('Connection refused');
    }) as typeof fetch;

    const mockMemorySearch = async () => [
      { id: 'mem-1', content: 'Fallback memory', score: 0.9 },
    ];

    const result = await assembleContext({
      query: 'test',
      vikingAvailable: true,
      totalBudget: 4000,
      memorySearchFn: mockMemorySearch,
    });

    // Viking failed but memory items should still be present
    expect(result.items.length).toBe(1);
    expect(result.items[0].source).toBe('memory');
  });

  it('Viking error response: falls back gracefully', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: true, message: 'internal error' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const mockMemorySearch = async () => [
      { id: 'mem-1', content: 'Fallback memory' },
    ];

    const result = await assembleContext({
      query: 'test',
      vikingAvailable: true,
      totalBudget: 4000,
      memorySearchFn: mockMemorySearch,
    });

    // Viking returned error, only memory items
    const vikingItems = result.items.filter((i) => i.source === 'viking');
    expect(vikingItems.length).toBe(0);
    expect(result.items.length).toBe(1);
    expect(result.items[0].source).toBe('memory');
  });

  it('No memory search fn: returns only viking items', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          result: {
            resources: [{ uri: 'viking://docs/a', abstract: 'doc A', score: 0.9 }],
            memories: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await assembleContext({
      query: 'test',
      vikingAvailable: true,
      totalBudget: 4000,
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0].source).toBe('viking');
  });

  it('defaults totalBudget to 4000 when not provided', async () => {
    const result = await assembleContext({
      query: 'test',
      vikingAvailable: false,
    });

    // Budget should be based on 4000 default
    const expectedSemantic = Math.floor(4000 * 0.40);
    expect(result.budget.semanticMemory).toBe(expectedSemantic);
  });
});

// ---------------------------------------------------------------------------
// formatAssembledContext
// ---------------------------------------------------------------------------
describe('formatAssembledContext', () => {
  it('formats mixed sources correctly', () => {
    const items = [
      { source: 'viking' as const, uri: 'viking://docs/readme', content: 'Project README' },
      { source: 'viking' as const, uri: 'viking://mem/pref', content: 'User prefers Bun' },
      { source: 'memory' as const, content: 'Memory fact about TypeScript' },
    ];

    const result = formatAssembledContext(items);
    expect(result).toContain('### Viking Knowledge');
    expect(result).toContain('**viking://docs/readme**: Project README');
    expect(result).toContain('**viking://mem/pref**: User prefers Bun');
    expect(result).toContain('### Memory Context');
    expect(result).toContain('- Memory fact about TypeScript');
  });

  it('returns empty string for empty items', () => {
    expect(formatAssembledContext([])).toBe('');
  });

  it('handles viking-only items', () => {
    const items = [
      { source: 'viking' as const, uri: 'viking://docs/a', content: 'doc content' },
    ];
    const result = formatAssembledContext(items);
    expect(result).toContain('### Viking Knowledge');
    expect(result).not.toContain('### Memory Context');
  });

  it('handles memory-only items', () => {
    const items = [
      { source: 'memory' as const, content: 'a memory' },
    ];
    const result = formatAssembledContext(items);
    expect(result).not.toContain('### Viking Knowledge');
    expect(result).toContain('### Memory Context');
  });

  it('uses "knowledge" label when uri is missing', () => {
    const items = [
      { source: 'viking' as const, content: 'some knowledge' },
    ];
    const result = formatAssembledContext(items);
    expect(result).toContain('**knowledge**: some knowledge');
  });
});
