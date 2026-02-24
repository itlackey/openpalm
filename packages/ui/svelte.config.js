import adapter from '@sveltejs/adapter-node';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		version: {
			name: packageJson.version
		},
		alias: {
			'@openpalm/lib/admin': resolve('../../packages/lib/src/admin'),
			'@openpalm/lib/admin/*': resolve('../../packages/lib/src/admin/*'),
			'@openpalm/lib/shared': resolve('../../packages/lib/src/shared'),
			'@openpalm/lib/shared/*': resolve('../../packages/lib/src/shared/*'),
			'@openpalm/lib/assets': resolve('../../packages/lib/assets'),
			'@openpalm/lib/assets/*': resolve('../../packages/lib/assets/*'),
			'@openpalm/lib': resolve('../../packages/lib/src'),
			'@openpalm/lib/*': resolve('../../packages/lib/src/*')
		}
	}
};

export default config;
