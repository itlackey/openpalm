import devtoolsJson from 'vite-plugin-devtools-json';
import { defineConfig, type Plugin } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import { resolve, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
// Resolve the yaml ESM browser build via package location, not hardcoded ../../node_modules.
// This works in both the monorepo (hoisted node_modules) and Docker (local node_modules).
const yamlBrowserPath = join(dirname(_require.resolve('yaml/package.json')), 'browser/index.js');

/**
 * Vite plugin to shim `Bun` globals used by @openpalm/lib when running
 * under Node.js (SvelteKit build / SSR). Maps Bun.env → process.env,
 * Bun.YAML → npm yaml package, and stubs Bun.spawn / Bun.spawnSync
 * so module-level code doesn't crash.
 */
function bunShim(): Plugin {
	const baseShimCode = [
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
		transform(code: string, id: string) {
			// Only shim server-side (SSR) modules from @openpalm/lib that reference Bun.
			// Client-side code should never import from packages/lib directly.
			if (!id.includes('packages/lib') || !code.includes('Bun.')) return;

			if (code.includes('Bun.YAML')) {
				// Module needs Bun.YAML — import the npm yaml package as a polyfill
				const yamlShimCode = [
					'import{parse as __bun_yaml_parse,stringify as __bun_yaml_stringify}from"yaml";',
					'if(typeof globalThis.Bun==="undefined"){',
					'  globalThis.Bun={',
					'    env:typeof process!=="undefined"?process.env:{},',
					'    YAML:{parse:__bun_yaml_parse,stringify:(v,r,s)=>__bun_yaml_stringify(v,typeof s==="number"?{indent:s}:undefined)},',
					'    spawn(){throw new Error("Bun.spawn not available in Node")},',
					'    spawnSync(){throw new Error("Bun.spawnSync not available in Node")}',
					'  };',
					'}else if(!globalThis.Bun.YAML){',
					'  globalThis.Bun.YAML={parse:__bun_yaml_parse,stringify:(v,r,s)=>__bun_yaml_stringify(v,typeof s==="number"?{indent:s}:undefined)};',
					'}'
				].join('\n');
				return { code: yamlShimCode + '\n' + code, map: null };
			}

			return { code: baseShimCode + '\n' + code, map: null };
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
		transform(_code: string, id: string) {
			if (id.endsWith('.yaml') || id.endsWith('.yml')) {
				try {
					const content = readFileSync(id, 'utf8');
					return {
						code: `export default ${JSON.stringify(content)};`,
						map: null
					};
				} catch (err) {
					throw new Error(`Failed to read YAML file: ${id}: ${err}`);
				}
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
			yaml: yamlBrowserPath
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
					include: ['src/**/*.svelte.{test,spec,browser}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec,browser}.{js,ts}']
				}
			}
		]
	}
});
