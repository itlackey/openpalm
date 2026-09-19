import { defineCommand } from 'citty';

import {
	acquireLeanLock,
	applyLeanImport,
	classifyLeanInstall,
	createLeanState,
	ensureLeanRuntime,
	planLeanImport,
	releaseLeanLock,
	type LeanImportOptions,
	type LeanImportPlan
} from '@openpalm/lib/lean';

function optionsFromArgs(args: Record<string, unknown>): LeanImportOptions {
	return {
		sourceHome: String(args.from ?? ''),
		destinationHome: createLeanState().homeDir,
		includeProviderAuth: args['include-provider-auth'] === true,
		includeUserEnv: args['include-user-env'] === true,
		includePortalMaps: args['include-portal-maps'] === true,
		includeOAuth: args['include-oauth'] === true
	};
}

function printPlan(plan: LeanImportPlan, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	console.log(`Import source: ${plan.sourceHome}`);
	console.log(`Fresh 0.14 destination: ${plan.destinationHome}`);
	for (const entry of plan.entries) {
		console.log(`${entry.action.padEnd(16)} ${entry.relativeSource} -> ${entry.relativeDestination}`);
	}
	for (const warning of plan.warnings) console.warn(`warning: ${warning}`);
	console.log(
		`${plan.copyCount} file(s) ready, ${plan.conflicts} conflict(s), ${plan.totalBytes} byte(s) inspected.`
	);
}

export default defineCommand({
	meta: {
		name: 'import',
		description: 'Safely copy selected data from an old home into a fresh 0.14 installation'
	},
	args: {
		from: { type: 'string', required: true, description: 'old OpenPalm home (read only)' },
		apply: { type: 'boolean', description: 'apply the displayed import plan' },
		'dry-run': { type: 'boolean', description: 'display the plan without writing (the default)' },
		json: { type: 'boolean', description: 'print the plan as JSON' },
		'include-provider-auth': {
			type: 'boolean',
			description: 'copy provider authentication from knowledge/secrets/auth.json'
		},
		'include-user-env': {
			type: 'boolean',
			description: 'copy knowledge/env/user.env'
		},
		'include-portal-maps': {
			type: 'boolean',
			description: 'copy validated Discord and Slack identity maps'
		},
		'include-oauth': {
			type: 'boolean',
			description: 'copy validated Guardian OAuth settings and identity maps'
		}
	},
	run({ args }) {
		const state = createLeanState();
		if (classifyLeanInstall(state.homeDir) !== 'setup_incomplete') {
			throw new Error(
				'Import requires a fresh, not-yet-completed 0.14 installation. Run `openpalm install --no-start` with a new OP_HOME first.'
			);
		}
		if (args.apply && args['dry-run']) throw new Error('Choose either --apply or --dry-run.');
		const options = optionsFromArgs(args as Record<string, unknown>);
		if (!args.apply) {
			printPlan(planLeanImport(options), args.json === true);
			return;
		}

		const lock = acquireLeanLock(state.dataDir);
		if (!lock) throw new Error('Another OpenPalm lifecycle operation is in progress.');
		try {
			const plan = applyLeanImport(options);
			ensureLeanRuntime(state);
			printPlan(plan, args.json === true);
			if (!args.json) {
				console.log('Import complete. Imported task definitions are staged outside the active task directory.');
				console.log('Review them with `openpalm task adopt <file>`, then run `openpalm setup`.');
			}
		} finally {
			releaseLeanLock(lock);
		}
	}
});
