import { json } from '$lib/server/json';
import { BUILTIN_CHANNELS } from '@openpalm/lib/assets/channels/index';
import { CoreSecretRequirements } from '$lib/server/init';
import type { EnvVarFieldType } from '@openpalm/lib/shared/snippet-types';
import type { RequestHandler } from './$types';

/** Map EnvVarDef field type to an HTML input type attribute. */
function envTypeToInputType(envType: EnvVarFieldType): string {
	switch (envType) {
		case 'secret':
			return 'password';
		case 'number':
			return 'number';
		case 'email':
			return 'email';
		case 'url':
			return 'url';
		default:
			return 'text';
	}
}

export const GET: RequestHandler = async () => {
	const channelServiceNames: Record<string, { label: string; description: string }> = {};
	for (const [key, def] of Object.entries(BUILTIN_CHANNELS)) {
		channelServiceNames[`channel-${key}`] = {
			label: `${def.name} Channel`,
			description: `${def.name} adapter for OpenPalm`
		};
	}

	return json(200, {
		serviceNames: {
			gateway: {
				label: 'Message Router',
				description: 'Routes messages between channels and your assistant'
			},
			assistant: { label: 'AI Assistant', description: 'The core assistant engine' },
			openmemory: {
				label: 'Memory',
				description: 'Stores conversation history and context'
			},
			'openmemory-ui': {
				label: 'Memory Dashboard',
				description: 'Visual interface for memory data'
			},
			admin: { label: 'Admin Panel', description: 'This management interface' },
			...channelServiceNames,
			caddy: { label: 'Web Server', description: 'Handles secure connections' }
		},
		channelFields: Object.fromEntries(
			Object.entries(BUILTIN_CHANNELS).map(([key, def]) => [
				`channel-${key}`,
				(def.env ?? [])
					.filter((e) => e.name !== def.sharedSecretEnv)
					.map((e) => ({
						key: e.name,
						label: e.label,
						type: envTypeToInputType(e.type),
						required: e.required,
						helpText: e.description ?? ''
					}))
			])
		),
		builtInChannels: BUILTIN_CHANNELS,
		requiredCoreSecrets: CoreSecretRequirements
	});
};
