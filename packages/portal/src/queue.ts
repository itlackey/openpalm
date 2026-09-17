export class ConversationQueue {
	private readonly pending = new Map<string, Promise<void>>();
	private readonly depths = new Map<string, number>();

	constructor(
		private readonly maxActiveKeys = 256,
		private readonly maxPendingPerKey = 8
	) {}

	async run(key: string, task: () => Promise<void>): Promise<void> {
		const depth = this.depths.get(key) ?? 0;
		if (depth >= this.maxPendingPerKey) throw new Error('conversation queue is busy');
		if (depth === 0 && this.pending.size >= this.maxActiveKeys) {
			throw new Error('portal queue is busy');
		}
		this.depths.set(key, depth + 1);
		const previous = this.pending.get(key) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(task);
		this.pending.set(key, current);
		try {
			await current;
		} finally {
			if (this.pending.get(key) === current) this.pending.delete(key);
			const remaining = (this.depths.get(key) ?? 1) - 1;
			if (remaining === 0) this.depths.delete(key);
			else this.depths.set(key, remaining);
		}
	}
}
