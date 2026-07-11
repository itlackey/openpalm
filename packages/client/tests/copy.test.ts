/**
 * B7 [MEDIUM] (review 2026-07-10 §B7) — copy affordances (message-copy +
 * per-code-block copy), ported from `packages/ui/src/lib/components/chat/
 * ChatMessage.svelte` (`copyMessage`/`decorateCodeCopy`). The clipboard
 * write + success/failure outcome is extracted into a pure, injectable
 * function so it unit-tests without a real `navigator.clipboard` or DOM
 * (packages/client's bun:test harness has neither).
 *
 * RED until packages/client/src/lib/chat/copy.ts exists.
 */
import { describe, expect, test } from 'bun:test';

async function loadCopyModule() {
  return import('../src/lib/chat/copy.ts');
}

function fakeClipboard(written: string[]) {
  return {
    async writeText(text: string) {
      written.push(text);
    },
  };
}

describe('writeClipboardText', () => {
  test('writes the given text and resolves true on success', async () => {
    const { writeClipboardText } = await loadCopyModule();
    const written: string[] = [];
    const ok = await writeClipboardText(fakeClipboard(written), 'copy me');
    expect(ok).toBe(true);
    expect(written).toEqual(['copy me']);
  });

  test('resolves false (never throws) when the clipboard write is denied', async () => {
    const { writeClipboardText } = await loadCopyModule();
    const denied = {
      async writeText(): Promise<void> {
        throw new Error('permission denied');
      },
    };
    const ok = await writeClipboardText(denied, 'copy me');
    expect(ok).toBe(false);
  });

  test('resolves false when no clipboard is available (feature-detect)', async () => {
    const { writeClipboardText } = await loadCopyModule();
    const ok = await writeClipboardText(undefined, 'copy me');
    expect(ok).toBe(false);
  });
});

describe('isClipboardAvailable', () => {
  test('true when writeText is a function', async () => {
    const { isClipboardAvailable } = await loadCopyModule();
    expect(isClipboardAvailable(fakeClipboard([]))).toBe(true);
  });

  test('false when clipboard is undefined or has no writeText', async () => {
    const { isClipboardAvailable } = await loadCopyModule();
    expect(isClipboardAvailable(undefined)).toBe(false);
    expect(isClipboardAvailable({} as unknown as { writeText: unknown })).toBe(false);
  });
});
