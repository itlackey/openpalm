import devtoolsJson from 'vite-plugin-devtools-json';
import { defineConfig, type Plugin } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Vite plugin to shim `Bun` globals used by @openpalm/lib when running
 * under Node.js (SvelteKit build / SSR). Maps Bun.env → process.env and
 * stubs Bun.spawn / Bun.spawnSync so module-level code doesn't crash.
 */
function bunShim(): Plugin {
	const shimCode = [
		'if(typeof globalThis.Bun==="undefined"){',
		'  globalThis.Bun={',
		'    env:typeof process!=="undefined"?process.env:{},',
		'    spawn(){throw new Error("Bun.spawn not available in Node")},',
		'    spawnSync(){throw new Error("Bun.spawnSync not available in Node")}',
		'  };',
		'}'
	].join('\n');

	return {
		name: 'bun-shim',
		// Run before other transforms so the shim is available immediately
		enforce: 'pre',
		transform(code, id) {
			// Only shim server-side modules from @openpalm/lib that reference Bun
			if (id.includes('packages/lib') && code.includes('Bun.')) {
				return { code: shimCode + '\n' + code, map: null };
			}
		}
	};
}

/**
 * Vite plugin to handle `import x from "./file.yaml" with { type: "text" }`
 * which the @openpalm/lib package uses (Bun text imports).
 * Transforms YAML files into ES modules exporting the raw text.
 */
function yamlTextImport(): Plugin {
	return {
		name: 'yaml-text-import',
		transform(_code, id) {
			if (id.endsWith('.yaml') || id.endsWith('.yml')) {
				const content = readFileSync(id, 'utf8');
				return {
					code: `export default ${JSON.stringify(content)};`,
					map: null
				};
			}
		}
	};
}

export default defineConfig({
	plugins: [bunShim(), sveltekit(), devtoolsJson(), yamlTextImport()],
	ssr: {
		// yaml is CJS — Vite 7's ESM module runner can't handle require().
		// Force resolution to the ESM browser build instead.
		noExternal: ['yaml']
	},
	resolve: {
		alias: {
			// yaml's "node" export condition points to CJS dist/index.js which
			// breaks in Vite 7's ESModulesEvaluator. Redirect to the ESM browser build.
			yaml: resolve('../../node_modules/yaml/browser/index.js')
		}
	},
	server: {
		fs: {
			allow: [resolve('../../packages/lib')]
		}
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
