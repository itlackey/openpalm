import { defineCommand } from 'citty';

import { createBackup, requireInstall, resolveOpenPalmHome } from '@openpalm/lib';

export default defineCommand({
	meta: { name: 'backup', description: 'Create a portable, allowlisted OpenPalm backup directory' },
	args: {
		to: { type: 'string', required: true, description: 'new or empty destination directory' },
		includeProviderAuth: { type: 'boolean', description: 'include OpenCode provider credentials' },
		includeUserEnv: { type: 'boolean', description: 'include knowledge/env/user.env' },
		includePortalMaps: { type: 'boolean', description: 'include Discord and Slack user mappings' },
		includeOAuth: { type: 'boolean', description: 'include Guardian OAuth configuration and maps' },
		json: { type: 'boolean', description: 'print the backup manifest as JSON' }
	},
	async run({ args }) {
		const homeDir = resolveOpenPalmHome();
		requireInstall(homeDir);
		const manifest = await createBackup({
			sourceHome: homeDir,
			destination: String(args.to),
			includeProviderAuth: args.includeProviderAuth === true,
			includeUserEnv: args.includeUserEnv === true,
			includePortalMaps: args.includePortalMaps === true,
			includeOAuth: args.includeOAuth === true
		});
		if (args.json) console.log(JSON.stringify(manifest, null, 2));
		else {
			console.log(`Portable backup created at ${args.to}`);
			console.log(`${manifest.files.length} file(s), ${manifest.totalBytes} byte(s).`);
			console.log('Scope: portable files only. NOT a full runtime or rollback backup.');
			for (const category of manifest.excludedCategories) console.log(`Not included: ${category}`);
			for (const warning of manifest.warnings) console.warn(`warning: ${warning}`);
			console.log('Restore into a fresh install with `openpalm import --from <backup>` options.');
		}
	}
});
