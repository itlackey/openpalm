#!/usr/bin/env bun

import { DiscordPortal } from './discord.js';
import { errorMessage, startHealthServer } from './runtime.js';
import { SlackPortal } from './slack.js';

export async function startPortal(adapter = Bun.env.PORTAL_ADAPTER ?? ''): Promise<void> {
	const health = startHealthServer(`portal:${adapter}`);
	if (adapter === 'discord') await new DiscordPortal().start();
	else if (adapter === 'slack') await new SlackPortal().start();
	else throw new Error('PORTAL_ADAPTER must be discord or slack');
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
