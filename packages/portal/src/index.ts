#!/usr/bin/env bun

import { errorMessage, startHealthServer } from './runtime.js';

export async function startPortal(adapter = Bun.env.PORTAL_ADAPTER ?? ''): Promise<void> {
	if (adapter !== 'discord' && adapter !== 'slack') {
		throw new Error('PORTAL_ADAPTER must be discord or slack');
	}
	const health = startHealthServer(`portal:${adapter}`);
	if (adapter === 'discord') {
		const { DiscordPortal } = await import('./discord.js');
		await new DiscordPortal().start();
	} else {
		const { SlackPortal } = await import('./slack.js');
		await new SlackPortal().start();
	}
	health.ready();
}

if (import.meta.main) {
	startPortal().catch((error) => {
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: 'error',
				service: 'portal',
				event: 'startup_failed',
				fields: { error: errorMessage(error) }
			})
		);
		process.exit(1);
	});
}
