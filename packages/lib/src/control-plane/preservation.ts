import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { assertSafePortablePath } from './provider-files.js';

export type PreservationItem = {
	category: string;
	disposition: 'selected' | 'review-required' | 'excluded';
	paths: string[];
	note: string;
};

/** Discovery only: never follow a link, read a transcript, or activate old runtime intent. */
export function inspectUnrestoredData(home: string, warnings: string[] = []): PreservationItem[] {
	const items: PreservationItem[] = [];
	const runtime = join(home, 'data');
	try {
		const stat = lstatSync(runtime);
		if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(runtime).length > 0) {
			items.push({
				category: 'Native history and runtime artifacts',
				disposition: 'review-required',
				paths: ['data'],
				note: 'Not restored by portable import. Preserve native conversations, snapshots, tools and referenced artifacts separately; caches and logs need not be activated.'
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	// Inspect only these known roots, with no recursion through runtime data.
	const reported = new Set<string>();
	const link = (relativePath: string) => {
		if (reported.has(relativePath)) return;
		reported.add(relativePath);
		items.push({
			category: 'Linked runtime source',
			disposition: 'review-required',
			paths: [relativePath],
			note: `Link only, not its contents: ${readlinkSync(join(home, relativePath))}. Inventory and privately back up the exact resolved source separately; do not recursively follow links.`
		});
	};
	for (const root of ['data', 'data/assistant', 'data/opencode']) {
		try {
			let current = '';
			let linked = false;
			for (const component of root.split('/')) {
				current = current ? `${current}/${component}` : component;
				if (lstatSync(join(home, current)).isSymbolicLink()) {
					link(current);
					linked = true;
					break;
				}
			}
			if (linked) continue;
			assertSafePortablePath(home, root);
			const path = join(home, root);
			if (!lstatSync(path).isDirectory()) continue;
			for (const name of readdirSync(path)) {
				const child = join(path, name);
				if (!lstatSync(child).isSymbolicLink()) continue;
				link(`${root}/${name}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
	}
	const linked = warnings.filter((warning) =>
		/Skipped (symlink|non-directory import root):/.test(warning)
	);
	if (linked.length) {
		items.push({
			category: 'Linked portable files',
			disposition: 'review-required',
			paths: linked.map((warning) => warning.slice(warning.indexOf(':') + 1).trim()),
			note: 'Links were not followed. Preserve each required physical source separately; linked worktrees and submodules need a usability check.'
		});
	}
	items.push({
		category: 'External work, mounts and portal continuity',
		disposition: 'excluded',
		paths: [],
		note: 'Not discovered by a folder import. Inventory Docker bind sources/named volumes and external repositories separately. Native history does not restore old Guardian or chat-portal handles.'
	});
	return items;
}

export const PORTABLE_BACKUP_EXCLUSIONS = [
	'Native OpenCode conversations and databases',
	'Runtime snapshots, tool output and other data/ artifacts',
	'External bind sources, named volumes and symlink targets',
	'Guardian/portal handles, credentials and runtime authority',
	'Unselected secrets and custom executable configuration'
];
