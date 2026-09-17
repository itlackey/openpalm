import type { ArgsDef, CommandContext } from 'citty';

/** Give every CLI action the same terse error boundary. */
export function defineAction<T extends ArgsDef = ArgsDef>(
	fn: (context: CommandContext<T>) => void | Promise<void>,
	onError?: (message: string) => void
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
