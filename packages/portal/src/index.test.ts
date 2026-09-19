import { beforeEach, expect, it, mock } from 'bun:test';

const loaded: string[] = [];
const started: string[] = [];
const ready: string[] = [];

mock.module('./discord.js', () => {
	loaded.push('discord');
	return {
		DiscordPortal: class {
			async start() {
				started.push('discord');
			}
		}
	};
});

mock.module('./slack.js', () => {
	loaded.push('slack');
	return {
		SlackPortal: class {
			async start() {
				started.push('slack');
			}
		}
	};
});

mock.module('./runtime.js', () => ({
	errorMessage: (error: unknown) => String(error),
	startHealthServer: (service: string) => ({
		ready: () => ready.push(service)
	})
}));

const { startPortal } = await import('./index.js');

beforeEach(() => {
	loaded.length = 0;
	started.length = 0;
	ready.length = 0;
});

it('loads and starts only the selected adapter', async () => {
	await startPortal('discord');
	expect(loaded).toEqual(['discord']);
	expect(started).toEqual(['discord']);
	expect(ready).toEqual(['portal:discord']);

	loaded.length = 0;
	started.length = 0;
	ready.length = 0;

	await startPortal('slack');
	expect(loaded).toEqual(['slack']);
	expect(started).toEqual(['slack']);
	expect(ready).toEqual(['portal:slack']);
});

it('rejects an unknown adapter before loading modules or opening health', async () => {
	await expect(startPortal('unknown')).rejects.toThrow('PORTAL_ADAPTER must be discord or slack');
	expect(loaded).toEqual([]);
	expect(started).toEqual([]);
	expect(ready).toEqual([]);
});
