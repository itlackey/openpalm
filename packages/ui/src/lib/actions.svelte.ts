/**
 * Async-action helpers — one home for the
 * `loading = true; try { … } catch { … } finally { loading = false }`
 * scaffold the admin tabs repeat, and one convention for surfacing the
 * failure. Two primitives:
 *
 *   • `resource(fetchFn)`  — a load-into-a-slot handle: { data, loading, error, reload }.
 *   • `runAction(fn, opts) — a one-shot mutation:      { loading, error, result }.
 *
 * User-facing errors standardise on the notifications store (`runAction`
 * pushes an error toast by default; `resource` opts in with `notify`), so we
 * stop hand-rolling per-tab error banners and per-row `$state` maps. Error
 * text always flows through the canonical `toMessage` helper from
 * `$lib/api/errors`, so a non-Error throw degrades to a stable fallback
 * instead of `String(err)` noise.
 */
import { toMessage } from '$lib/api/errors.js';
import { notifications } from '$lib/notifications.svelte.js';

export interface RunActionOptions {
  /** Message used when the thrown value isn't an Error. */
  fallback?: string;
  /** Push the error to the notifications store as a toast (default: true). */
  notify?: boolean;
  /** Push this message as a success toast when the action resolves. */
  success?: string;
}

export interface ActionHandle<T> {
  /** True from the moment the action starts until it settles. */
  readonly loading: boolean;
  /** The failure message (via `toMessage`), or '' while ok. */
  readonly error: string;
  /** Resolves to the fn's value, or `undefined` if it threw. Never rejects. */
  readonly result: Promise<T | undefined>;
}

class Action<T> implements ActionHandle<T> {
  loading = $state(true);
  error = $state('');
  result: Promise<T | undefined>;

  constructor(fn: () => Promise<T>, opts: RunActionOptions) {
    this.result = (async (): Promise<T | undefined> => {
      try {
        const value = await fn();
        if (opts.success) notifications.push('success', opts.success);
        return value;
      } catch (e) {
        const message = toMessage(e, opts.fallback ?? 'Something went wrong.');
        this.error = message;
        if (opts.notify ?? true) notifications.push('error', message);
        return undefined;
      } finally {
        this.loading = false;
      }
    })();
  }
}

/**
 * Run a one-shot async action, tracking its `loading`/`error` state and
 * routing the failure to the notifications store. Returns immediately with a
 * live handle — read `handle.loading`/`handle.error` in markup and `await
 * handle.result` for the value (which is `undefined` when the action threw).
 */
export function runAction<T>(
  fn: () => Promise<T>,
  opts: RunActionOptions = {},
): ActionHandle<T> {
  return new Action(fn, opts);
}

export interface ResourceOptions {
  /** Message used when the thrown value isn't an Error. */
  fallback?: string;
  /** Also push load failures to the notifications store as a toast. */
  notify?: boolean;
}

/**
 * A lazily-loaded value plus its request state. `data` is `null` until the
 * first successful `reload()`; a failed load leaves `data` untouched and
 * records `error` (rendered inline by the caller, or toasted with `notify`).
 */
export class Resource<T> {
  data = $state<T | null>(null);
  loading = $state(false);
  error = $state('');
  #fetchFn: () => Promise<T>;
  #opts: ResourceOptions;

  constructor(fetchFn: () => Promise<T>, opts: ResourceOptions = {}) {
    this.#fetchFn = fetchFn;
    this.#opts = opts;
  }

  async reload(): Promise<void> {
    this.loading = true;
    this.error = '';
    try {
      this.data = await this.#fetchFn();
    } catch (e) {
      const message = toMessage(e, this.#opts.fallback ?? 'Failed to load.');
      this.error = message;
      if (this.#opts.notify) notifications.push('error', message);
    } finally {
      this.loading = false;
    }
  }
}

export function resource<T>(
  fetchFn: () => Promise<T>,
  opts: ResourceOptions = {},
): Resource<T> {
  return new Resource(fetchFn, opts);
}
