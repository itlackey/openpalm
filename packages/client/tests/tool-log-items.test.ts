/**
 * P3 [MEDIUM] (PR #562 xhigh review, chat efficiency) — pure memoizing
 * deriver for `routes/chat/+page.svelte`'s `toolLogItems`, extracted so its
 * caching behavior unit-tests with bun:test (no Svelte component-render
 * harness in packages/client).
 *
 * `toolLogItems` used to rebuild a Set+array scan over ALL of
 * `chatState.entries` on EVERY controller notify — even a pendingText-only
 * delta that never touched `entries` — because +page.svelte replaces
 * `chatState` wholesale on every notify. This pins that the deriver only
 * rescans `entries` when the ARRAY REFERENCE actually changes (which
 * chat-controller.ts only ever does when entries genuinely changes), while
 * still merging in `pendingToolStates` fresh every call and producing
 * identical output to a full rescan.
 *
 * RED until packages/client/src/lib/chat/tool-log-items.ts exists.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolStateSnapshot } from '../src/lib/transport/index.ts';

async function loadModule() {
  return import('../src/lib/chat/tool-log-items.ts');
}

function tool(overrides: Partial<ToolStateSnapshot> = {}): ToolStateSnapshot {
  return {
    id: 'call-1',
    tool: 'bash',
    status: 'running',
    title: 'bash',
    detail: '',
    output: '',
    error: '',
    updatedAt: 0,
    ...overrides,
  };
}

describe('createToolLogItemsDeriver', () => {
  test('scans entries + pending tool states, deduped by id, same as a full rescan', async () => {
    const { createToolLogItemsDeriver } = await loadModule();
    const derive = createToolLogItemsDeriver();
    const entries = [{ toolStates: [tool({ id: 't1' })] }, { toolStates: [tool({ id: 't2' })] }];
    const out = derive(entries, [tool({ id: 't3' })]);
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  test('a pending tool state with the SAME id as a history entry is not duplicated', async () => {
    const { createToolLogItemsDeriver } = await loadModule();
    const derive = createToolLogItemsDeriver();
    const entries = [{ toolStates: [tool({ id: 't1', status: 'running' })] }];
    const out = derive(entries, [tool({ id: 't1', status: 'completed' })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('t1');
  });

  test('does NOT rescan the history side when the entries array reference is unchanged, even if its contents mutate', async () => {
    const { createToolLogItemsDeriver } = await loadModule();
    const derive = createToolLogItemsDeriver();
    const entryWithMutableToolStates: { toolStates?: ToolStateSnapshot[] } = { toolStates: [tool({ id: 't1' })] };
    const entries = [entryWithMutableToolStates];

    const first = derive(entries, []);
    expect(first.map((t) => t.id)).toEqual(['t1']);

    // Mutate the SAME array's content in place (no new array reference) —
    // chat-controller.ts never does this (it always assigns a fresh array
    // to state.entries when entries change), so the cache must NOT pick
    // this up.
    entryWithMutableToolStates.toolStates!.push(tool({ id: 't2' }));

    const second = derive(entries, []);
    expect(second.map((t) => t.id)).toEqual(['t1']);
  });

  test('DOES rescan when a NEW entries array reference is passed, even with equivalent-looking content', async () => {
    const { createToolLogItemsDeriver } = await loadModule();
    const derive = createToolLogItemsDeriver();
    const entriesA = [{ toolStates: [tool({ id: 't1' })] }];
    derive(entriesA, []);

    const entriesB = [{ toolStates: [tool({ id: 't1' })] }, { toolStates: [tool({ id: 't2' })] }];
    const out = derive(entriesB, []);
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('two independent derivers do not share cache state', async () => {
    const { createToolLogItemsDeriver } = await loadModule();
    const deriveA = createToolLogItemsDeriver();
    const deriveB = createToolLogItemsDeriver();
    const entries = [{ toolStates: [tool({ id: 't1' })] }];
    deriveA(entries, []);
    const outB = deriveB(entries, [tool({ id: 't2' })]);
    expect(outB.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});
