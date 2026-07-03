import type { ArgsDef, CommandContext } from 'citty';

/**
 * Wrap a citty `run` handler with the standard CLI error boundary:
 * on a thrown error, print a single-line message and exit non-zero (1),
 * matching citty's terse failure UX rather than a raw stack trace.
 *
 * This removes the `try { … } catch (err) { console.error(err.message);
 * process.exit(1); }` boilerplate that was copy-pasted across the command
 * files, keeping a single source of truth for how command failures surface.
 *
 * The `onError` hook lets a command customize the message it prints before
 * the exit (e.g. an "Error: " prefix, or an extra recovery hint) while still
 * sharing the exit(1) behavior.
 *
 * NOTE: only wrap handlers whose success path does NOT itself call
 * `process.exit`. Commands that exit with a non-1 code (e.g. `scan`/
 * `audit-secrets` exit 2 on bad input, or exit 0 explicitly) keep those
 * exits outside any try/catch so a mocked `process.exit` in tests is not
 * swallowed by this boundary.
 */
export function defineAction<T extends ArgsDef = ArgsDef>(
  fn: (context: CommandContext<T>) => void | Promise<void>,
  onError?: (message: string) => void,
): (context: CommandContext<T>) => Promise<void> {
  return async (context: CommandContext<T>): Promise<void> => {
    try {
      await fn(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (onError) onError(message);
      else console.error(message);
      process.exit(1);
    }
  };
}
