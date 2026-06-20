import prettier from 'eslint-config-prettier';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const rootGitignorePath = fileURLToPath(new URL('../../.gitignore', import.meta.url));

export default defineConfig(
	includeIgnoreFile(rootGitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		ignores: ['.svelte-kit/**', 'build/**', 'coverage/**', 'test-results/**']
	},
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			"no-undef": 'off'
		}
	},
	{
		// $effect is banned everywhere in Svelte files. It creates hidden reactive
		// loops, masks reactivity bugs, and can cause effect_update_depth_exceeded
		// crashes. Svelte 5 runes mode also does NOT support afterUpdate — that is
		// a legacy Svelte 4 API that throws at runtime in runes mode files.
		//
		// Canonical replacements by use-case:
		//   DOM setup + cleanup       → onMount(() => { ...; return () => { cleanup }; })
		//   Same-route navigation     → afterNavigate (from $app/navigation)
		//   DOM mutations (streaming) → use: actions with MutationObserver
		//   User-triggered changes    → call directly in the event handler
		//   One-time prop read        → untrack(() => value) at $state initializer
		//   Component re-init on id   → {#key id} in parent forces remount + onMount
		//   Class from reactive state → $derived + class:name binding (never $effect → classList)
		//
		// Zero $effect calls, zero svelte-check warnings/errors — both are required.
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector: "CallExpression[callee.name='$effect']",
					message:
						'$effect is banned. Replacements: onMount (DOM setup/cleanup), afterNavigate (same-route nav), use: actions with MutationObserver (DOM side effects), event handlers (user-triggered state), untrack() (one-time prop reads), {#key id} in parent (re-init on identity change), $derived+class: binding (reactive CSS classes).'
				}
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	}
);
