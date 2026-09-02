import { defineCommand } from 'citty';
import { clearRollbackPins, SERVICE_VERSION_KEYS } from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';
import { ensureValidState } from '../lib/cli-state.ts';

export default defineCommand({
	meta: {
		name: 'unpin',
		description:
			'Clear a stack.env rollback-generation-* image pin left behind by a failed update, so the next update/start pulls the normal release tag again. Never touches a deliberate operator pin.'
	},
	run: defineAction(async () => {
		await runUnpinAction();
	})
});

export async function runUnpinAction(): Promise<void> {
	const state = ensureValidState();
	const { cleared, kept } = clearRollbackPins(state);
	const clearedKeys = Object.keys(cleared) as Array<keyof typeof cleared>;

	if (clearedKeys.length === 0) {
		console.log('No rollback-generation-* pins found in state/stack.env. Nothing to clear.');
		return;
	}

	console.log('Cleared the following rollback pin(s):');
	for (const key of clearedKeys) {
		const change = cleared[key];
		if (!change) continue;
		console.log(`  ${key}: ${change.from} -> ${change.to}`);
	}

	const untouched = SERVICE_VERSION_KEYS.filter((key) => !clearedKeys.includes(key));
	if (untouched.length > 0) {
		console.log('Left the following key(s) untouched (not a rollback pin):');
		for (const key of untouched) {
			console.log(`  ${key}: ${kept[key]}`);
		}
	}

	console.log('This only updates state/stack.env. Run `openpalm update` (or `openpalm start`) to apply it.');
}
