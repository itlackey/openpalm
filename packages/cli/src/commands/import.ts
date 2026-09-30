import { defineCommand } from 'citty';

import {
	acquireStackLock,
	applyImport,
	classifyInstall,
	createOpenPalmState,
	ensureRuntime,
	planImport,
	releaseStackLock,
	type ImportOptions,
	type ImportPlan
} from '@openpalm/lib';

function optionsFromArgs(args: Record<string, unknown>): ImportOptions {
	return {
		sourceHome: String(args.from ?? ''),
		destinationHome: createOpenPalmState().homeDir,
		includeProviderAuth: args['include-provider-auth'] === true,
		includeUserEnv: args['include-user-env'] === true,
		includePortalMaps: args['include-portal-maps'] === true,
		includeOAuth: args['include-oauth'] === true
	};
}

const DETAIL_LIMIT = 10;
const WARNING_GROUP_LIMIT = 8;

function displayText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: prevent untrusted file names from controlling terminal output.
	return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
}

export function printImportPlan(plan: ImportPlan, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	console.log(`Import source: ${displayText(plan.sourceHome)}`);
	console.log(`Fresh 0.14 destination: ${displayText(plan.destinationHome)}`);
	const totals = new Map<string, Map<string, number>>();
	const conflicts: ImportPlan['entries'] = [];
	for (const entry of plan.entries) {
		const actions = totals.get(entry.category) ?? new Map<string, number>();
		actions.set(entry.action, (actions.get(entry.action) ?? 0) + 1);
		totals.set(entry.category, actions);
		if (entry.action === 'conflict') conflicts.push(entry);
	}
	for (const [category, actions] of totals) {
		console.log(
			`${category}: ${[...actions].map(([action, count]) => `${count} ${action}`).join(', ')}`
		);
	}
	if (conflicts.length > 0) {
		console.warn(`Resolve ${conflicts.length} destination conflict(s) before applying:`);
		for (const entry of conflicts.slice(0, DETAIL_LIMIT)) {
			console.warn(
				`conflict: ${displayText(entry.relativeSource)} -> ${displayText(entry.relativeDestination)}`
			);
		}
		if (conflicts.length > DETAIL_LIMIT) {
			console.warn(
				`${conflicts.length - DETAIL_LIMIT} more conflict(s); use --json for every path.`
			);
		}
	}
	const warnings = new Map<string, { count: number; example: string }>();
	for (const warning of plan.warnings) {
		// Path-based warnings share a prefix; distinct guidance remains its own group.
		const separator = warning.indexOf(':');
		const kind = separator > 0 ? warning.slice(0, separator) : warning;
		const group = warnings.get(kind) ?? { count: 0, example: warning };
		group.count += 1;
		warnings.set(kind, group);
	}
	if (plan.warnings.length > 0) {
		console.warn(`${plan.warnings.length} warning(s) in ${warnings.size} group(s):`);
		// Preserve security/configuration guidance ahead of repetitive filesystem noise.
		const groups = [...warnings].sort(([left], [right]) => {
			const priority = (kind: string): number =>
				/provider|credential|secret|auth|config|task/i.test(kind) ? 1 : 0;
			return priority(right) - priority(left);
		});
		for (const [kind, group] of groups.slice(0, WARNING_GROUP_LIMIT)) {
			console.warn(`warning (${group.count}): ${displayText(kind)}`);
			if (group.example !== kind) console.warn(`  Example: ${displayText(group.example)}`);
		}
		if (groups.length > WARNING_GROUP_LIMIT) {
			console.warn(
				`${groups.length - WARNING_GROUP_LIMIT} more warning group(s); use --json for full details.`
			);
		}
	}
	console.log(
		`${plan.copyCount} file(s) ready, ${plan.conflicts} conflict(s), ${plan.totalBytes} byte(s) inspected.`
	);
	if (totals.has('task')) {
		console.log(
			'Imported tasks are staged in knowledge/imported-tasks, not scheduled. Review their contents, then use `openpalm task adopt <file>` to adopt a supported task in paused state.'
		);
	}
	console.log(
		'Use --dry-run --json for the complete file plan and warnings; --apply copies only the selected data.'
	);
}

export default defineCommand({
	meta: {
		name: 'import',
		description: 'Safely copy selected data from an old home into a fresh 0.14 installation'
	},
	args: {
		from: { type: 'string', required: true, description: 'old OpenPalm home (read only)' },
		apply: { type: 'boolean', description: 'apply a freshly validated import plan' },
		'dry-run': { type: 'boolean', description: 'display the plan without writing (the default)' },
		json: { type: 'boolean', description: 'print the plan as JSON' },
		'include-provider-auth': {
			type: 'boolean',
			description: 'copy provider authentication and safe referenced files from knowledge/secrets'
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
		const state = createOpenPalmState();
		if (classifyInstall(state.homeDir) !== 'setup_incomplete') {
			throw new Error(
				'Import requires a fresh, not-yet-completed 0.14 installation. Run `openpalm install --no-start` with a new OP_HOME first.'
			);
		}
		if (args.apply && args['dry-run']) throw new Error('Choose either --apply or --dry-run.');
		const options = optionsFromArgs(args as Record<string, unknown>);
		if (!args.apply) {
			printImportPlan(planImport(options), args.json === true);
			return;
		}

		const lock = acquireStackLock(state.dataDir);
		if (!lock) throw new Error('Another OpenPalm lifecycle operation is in progress.');
		try {
			const plan = applyImport(options);
			ensureRuntime(state);
			printImportPlan(plan, args.json === true);
			if (!args.json) {
				console.log(
					'Import complete. Imported task definitions are staged outside the active task directory.'
				);
				console.log('Review task contents before adoption, then run `openpalm setup`.');
			}
		} finally {
			releaseStackLock(lock);
		}
	}
});
