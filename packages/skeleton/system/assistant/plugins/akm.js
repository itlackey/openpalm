// Image-baked dependency: this local wrapper prevents OpenCode from installing
// the plugin from npm during container startup.
import { AkmPlugin as upstreamPlugin } from '/opt/openpalm/tools/node_modules/akm-opencode/dist/index.js';
import { createMemoryCapture, memorySource, trustedMemoryAgent } from '../lib/memory.js';

export const AkmPlugin = async (context) => {
	const hooks = await upstreamPlugin(context);
	const capture = createMemoryCapture();
	return {
		...hooks,
		'chat.message': async (input, output) => {
			// Do not send credential-bearing user text to the plugin's telemetry.
			if (!trustedMemoryAgent(input.agent)) return;
			await hooks['chat.message']?.(input, {
				...output,
				parts: (output.parts ?? []).map((part) =>
					part.type === 'text' ? { ...part, text: memorySource(part.text) } : part
				)
			});
		},
		event: async (input) => {
			await hooks.event?.(input);
			if (input.event?.type === 'session.idle') {
				void capture(input.event.properties?.sessionID);
			}
		}
	};
};
