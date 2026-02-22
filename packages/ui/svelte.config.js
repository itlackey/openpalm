import adapter from '@sveltejs/adapter-node';
import { resolve } from 'node:path';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		alias: {
			'@openpalm/lib': resolve('../../packages/lib'),
			'@openpalm/lib/*': resolve('../../packages/lib/*')
		}
	}
};

export default config;
