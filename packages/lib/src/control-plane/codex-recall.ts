import { buildComposeCliArgs, buildComposeOptions } from './compose.js';
import { composeProcessEnvironment, runDocker } from './docker.js';
import type { OpenPalmState } from './foundation.js';
import { acquireStackLock, releaseStackLock } from './lock.js';
import { requireInstall } from './state.js';

export type CodexRecallReview = {
	status: 'installed' | 'approval-needed' | 'ready';
	digest: string;
	hooks: Array<{
		key: string;
		hash: string;
		event: string;
		command: string;
		sourcePath: string;
		enabled: boolean;
		trust: 'trusted' | 'untrusted' | 'modified';
	}>;
};

function parseReview(value: unknown): CodexRecallReview {
	if (!value || typeof value !== 'object') throw new Error('Invalid native recall status.');
	const input = value as Record<string, unknown>;
	if (
		!['installed', 'approval-needed', 'ready'].includes(String(input.status)) ||
		!/^[a-f0-9]{64}$/.test(String(input.digest)) ||
		!Array.isArray(input.hooks) ||
		!input.hooks.length ||
		input.hooks.length > 16
	)
		throw new Error('Invalid native recall status.');
	for (const hook of input.hooks) {
		if (!hook || typeof hook !== 'object') throw new Error('Invalid native hook review.');
		const h = hook as Record<string, unknown>;
		if (
			['key', 'hash', 'event', 'command', 'sourcePath'].some(
				(k) => typeof h[k] !== 'string' || (h[k] as string).length > 8192
			) ||
			typeof h.enabled !== 'boolean' ||
			!['trusted', 'untrusted', 'modified'].includes(String(h.trust))
		)
			throw new Error('Invalid native hook review.');
	}
	return input as CodexRecallReview;
}

async function invoke(
	state: OpenPalmState,
	action: string,
	digest?: string
): Promise<CodexRecallReview> {
	requireInstall(state.homeDir);
	const result = await runDocker(
		[
			'compose',
			...buildComposeCliArgs(state),
			'exec',
			'-T',
			'--workdir',
			'/work',
			'assistant',
			'openpalm-codex-recall.mjs',
			action,
			...(digest ? [digest] : [])
		],
		{ env: composeProcessEnvironment(buildComposeOptions(state).envFiles), timeoutMs: 20_000 }
	);
	let value: unknown;
	try {
		value = JSON.parse(result.stdout);
	} catch {
		/* Older/stopped images have no review helper. */
	}
	if (!result.ok) {
		const error =
			value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
				? value.error
				: 'Cannot check Codex knowledge recall. Start Assistant and update to an image with guided recall setup.';
		throw new Error(error);
	}
	return parseReview(value);
}

export function reviewCodexRecall(state: OpenPalmState): Promise<CodexRecallReview> {
	return invoke(state, 'review');
}

/** Persist only an explicit, current review using Codex's version-checked writer. */
export async function changeCodexRecall(
	state: OpenPalmState,
	action: 'approve' | 'disable',
	digest: string,
	confirmed: boolean
): Promise<CodexRecallReview> {
	if (
		confirmed !== true ||
		!['approve', 'disable'].includes(action) ||
		!/^[a-f0-9]{64}$/.test(digest)
	)
		throw new Error('Review the current AKM hooks and explicitly confirm your choice first.');
	requireInstall(state.homeDir);
	const lock = acquireStackLock(state.dataDir);
	if (!lock) throw new Error('Another stack operation is running.');
	try {
		return await invoke(state, action, digest);
	} finally {
		releaseStackLock(lock);
	}
}
