import { beforeEach, describe, expect, test } from 'vitest';
import { runAction, resource } from './actions.svelte.js';
import { notifications } from './notifications.svelte.js';

/** A promise whose settlement we control, so we can observe `loading` mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  notifications.clear();
});

describe('runAction', () => {
  test('loading is true until the fn settles, then false; result resolves to the value', async () => {
    const d = deferred<number>();
    const handle = runAction(() => d.promise, { notify: false });

    expect(handle.loading).toBe(true);
    expect(handle.error).toBe('');

    d.resolve(42);
    const value = await handle.result;

    expect(value).toBe(42);
    expect(handle.loading).toBe(false);
    expect(handle.error).toBe('');
  });

  test('captures an Error message via toMessage and resolves to undefined', async () => {
    const handle = runAction(() => Promise.reject(new Error('boom')), { notify: false });

    const value = await handle.result;

    expect(value).toBeUndefined();
    expect(handle.error).toBe('boom');
    expect(handle.loading).toBe(false);
  });

  test('non-Error throws degrade to the provided fallback', async () => {
    const handle = runAction(() => Promise.reject('nope'), {
      fallback: 'fell back',
      notify: false,
    });

    await handle.result;

    expect(handle.error).toBe('fell back');
  });

  test('errors are pushed to the notifications store by default', async () => {
    const handle = runAction(() => Promise.reject(new Error('bad')));

    await handle.result;

    expect(notifications.toasts.some((t) => t.kind === 'error' && t.message === 'bad')).toBe(true);
  });

  test('a success message is pushed as a toast when the fn resolves', async () => {
    const handle = runAction(() => Promise.resolve('ok'), { success: 'Saved!' });

    await handle.result;

    expect(notifications.toasts.some((t) => t.kind === 'success' && t.message === 'Saved!')).toBe(true);
  });
});

describe('resource', () => {
  test('starts idle with null data', () => {
    const r = resource(async () => 7);

    expect(r.data).toBeNull();
    expect(r.loading).toBe(false);
    expect(r.error).toBe('');
  });

  test('reload toggles loading and stores the fetched value', async () => {
    const r = resource(async () => 7);

    const pending = r.reload();
    expect(r.loading).toBe(true);

    await pending;

    expect(r.data).toBe(7);
    expect(r.loading).toBe(false);
    expect(r.error).toBe('');
  });

  test('reload captures a fetch failure via toMessage and leaves data null', async () => {
    const r = resource(() => Promise.reject(new Error('load fail')), { fallback: 'x' });

    await r.reload();

    expect(r.data).toBeNull();
    expect(r.error).toBe('load fail');
    expect(r.loading).toBe(false);
  });
});
