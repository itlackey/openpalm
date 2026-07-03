import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { CommandContext } from 'citty';
import { defineAction } from './action.ts';

const emptyContext = {} as CommandContext;

describe('defineAction', () => {
  const originalError = console.error;
  const originalExit = process.exit;

  afterEach(() => {
    console.error = originalError;
    process.exit = originalExit;
  });

  it('runs the handler and does not exit on success', async () => {
    const exit = mock((_code?: number) => { throw new Error(`exit(${_code})`); });
    process.exit = exit as unknown as typeof process.exit;
    let ran = false;

    await defineAction(async () => { ran = true; })(emptyContext);

    expect(ran).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('prints the error message and exits 1 on a thrown Error', async () => {
    const errors: string[] = [];
    console.error = mock((msg?: unknown) => { errors.push(String(msg)); }) as typeof console.error;
    const exit = mock((_code?: number) => { throw new Error('exited'); });
    process.exit = exit as unknown as typeof process.exit;

    await defineAction(async () => { throw new Error('boom'); })(emptyContext).catch(() => {});

    expect(errors).toEqual(['boom']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('routes the message through a custom onError before exiting 1', async () => {
    const errors: string[] = [];
    console.error = mock((msg?: unknown) => { errors.push(String(msg)); }) as typeof console.error;
    const exit = mock((_code?: number) => { throw new Error('exited'); });
    process.exit = exit as unknown as typeof process.exit;

    await defineAction(
      async () => { throw new Error('boom'); },
      (message) => console.error(`Error: ${message}`),
    )(emptyContext).catch(() => {});

    expect(errors).toEqual(['Error: boom']);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
