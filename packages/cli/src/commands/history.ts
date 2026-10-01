import { defineCommand } from 'citty';
import { readFileSync, lstatSync } from 'node:fs';
import {
	exportHistory,
	restoreHistory,
	resolveOpenPalmHome,
	requireInstall,
	validateHistoryDirectories
} from '@openpalm/lib';

export default defineCommand({
	meta: {
		name: 'history',
		description:
			'Privately export or recover native OpenCode conversations, without legacy authority'
	},
	subCommands: {
		export: defineCommand({
			args: {
				from: { type: 'string', required: true, description: 'exact old instance home' },
				image: {
					type: 'string',
					required: true,
					description: 'installed trusted Assistant image used by that instance'
				},
				to: {
					type: 'string',
					required: true,
					description: 'new private archive directory outside both homes'
				},
				runtime: {
					type: 'string',
					description: 'explicit resolved OpenCode data directory when it is externally stored'
				}
			},
			async run({ args }) {
				const result = await exportHistory({
					sourceHome: String(args.from),
					image: String(args.image),
					destination: String(args.to),
					...(args.runtime ? { runtime: String(args.runtime) } : {})
				});
				console.log(
					`${result.sessions} native session(s) privately preserved at ${result.archive}.`
				);
				console.log(
					'This is native history only, not a full runtime backup. Review history.json and map every old project directory before restore.'
				);
			}
		}),
		restore: defineCommand({
			args: {
				from: {
					type: 'string',
					required: true,
					description: 'private native-history archive directory'
				},
				'directory-map': {
					type: 'string',
					required: true,
					description:
						'reviewed JSON map from each old directory to /work or an existing /work subdirectory'
				},
				apply: {
					type: 'boolean',
					description: 'restore after offline native preflight; preview is the default'
				},
				'same-instance': {
					type: 'boolean',
					description:
						'confirm same-owner continuation of the selected instance, not an unrelated history merge'
				}
			},
			async run({ args }) {
				const homeDir = resolveOpenPalmHome();
				requireInstall(homeDir);
				const mapFile = String(args['directory-map']);
				const stat = lstatSync(mapFile);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
					throw new Error('Directory map must be a regular JSON file no larger than 1 MiB.');
				const directories = validateHistoryDirectories(
					JSON.parse(readFileSync(mapFile, 'utf8')) as unknown
				);
				const receipt = await restoreHistory({
					homeDir,
					archive: String(args.from),
					directories,
					apply: args.apply === true,
					sameInstance: args['same-instance'] === true
				});
				console.log(
					`${receipt.applied ? 'Recovered and verified' : 'Native preflight verified'}: ${receipt.sessions} sessions, ${receipt.messages} messages, ${receipt.parts} parts.`
				);
				console.log(`Private receipt and recovery files: ${receipt.receipt}`);
				console.log(
					'Native history only: portal handles, external work, snapshots and dependencies need separate acceptance.'
				);
				if (receipt.applied)
					console.log(
						'Start this instance and verify session visibility and content in its intended native client.'
					);
			}
		})
	}
});
