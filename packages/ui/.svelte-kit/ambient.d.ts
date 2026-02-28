
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * Environment variables [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env`. Like [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), this module cannot be imported into client-side code. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * _Unlike_ [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), the values exported from this module are statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * ```ts
 * import { API_KEY } from '$env/static/private';
 * ```
 * 
 * Note that all environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * 
 * ```
 * MY_FEATURE_FLAG=""
 * ```
 * 
 * You can override `.env` values from the command line like so:
 * 
 * ```sh
 * MY_FEATURE_FLAG="enabled" npm run dev
 * ```
 */
declare module '$env/static/private' {
	export const ANTHROPIC_API_KEY: string;
	export const BUN_INSTALL: string;
	export const CHROME_DESKTOP: string;
	export const CLUTTER_IM_MODULE: string;
	export const DATABASIN_ANTHROPIC_KEY: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const DC_ELEVENLABS_API_KEY: string;
	export const DEBUGINFOD_URLS: string;
	export const DESKTOP_SESSION: string;
	export const DISPLAY: string;
	export const DOTNET_BUNDLE_EXTRACT_BASE_DIR: string;
	export const EMBEDDING_API_ENDPOINT: string;
	export const EMBEDDING_API_KEY: string;
	export const EMBEDDING_MODEL: string;
	export const FC_FONTATIONS: string;
	export const GDK_BACKEND: string;
	export const GH_GITEA_TOKEN: string;
	export const GH_MCP_PAT: string;
	export const GITEA_TOKEN: string;
	export const GITEA_URL: string;
	export const GITHUB_OAUTH_CLIENT: string;
	export const GITHUB_OAUTH_SECRET: string;
	export const GPG_AGENT_INFO: string;
	export const GROQ_API_KEY: string;
	export const GTK2_RC_FILES: string;
	export const GTK3_MODULES: string;
	export const GTK_IM_MODULE: string;
	export const GTK_MODULES: string;
	export const GTK_RC_FILES: string;
	export const GU_OPENPALM_TOKEN: string;
	export const HOME: string;
	export const ICEAUTHORITY: string;
	export const IM_CONFIG_PHASE: string;
	export const INVOCATION_ID: string;
	export const JOURNAL_STREAM: string;
	export const KCRASH_DUMP_ONLY: string;
	export const KDE_APPLICATIONS_AS_SCOPE: string;
	export const KDE_FORK_SLAVES: string;
	export const KDE_FULL_SESSION: string;
	export const KDE_SESSION_UID: string;
	export const KDE_SESSION_VERSION: string;
	export const KRANG_GH_TOKEN: string;
	export const LANG: string;
	export const LC_ADDRESS: string;
	export const LC_IDENTIFICATION: string;
	export const LC_MEASUREMENT: string;
	export const LC_MONETARY: string;
	export const LC_NAME: string;
	export const LC_NUMERIC: string;
	export const LC_PAPER: string;
	export const LC_TELEPHONE: string;
	export const LC_TIME: string;
	export const LESSCLOSE: string;
	export const LESSOPEN: string;
	export const LIBVIRT_DEFAULT_URI: string;
	export const LITE_LLM_API_KEY: string;
	export const LOGNAME: string;
	export const MANAGERPID: string;
	export const MEM0_ENABLED: string;
	export const MEM0_URL: string;
	export const MEM0_USER_ID: string;
	export const MISTRAL_API_KEY: string;
	export const MISTRAL_API_URL: string;
	export const MOZ_USE_XINPUT2: string;
	export const NVM_BIN: string;
	export const NVM_DIR: string;
	export const NVM_INC: string;
	export const OLLAMA_DEBUG: string;
	export const OLLAMA_HOST: string;
	export const OLLAMA_MODELS: string;
	export const OPENAI_API_KEY: string;
	export const OPENCODE_DISABLE_CLAUDE_CODE: string;
	export const PAM_KWALLET5_LOGIN: string;
	export const PATH: string;
	export const PWD: string;
	export const QT_ACCESSIBILITY: string;
	export const QT_AUTO_SCREEN_SCALE_FACTOR: string;
	export const QT_EXCLUDE_GENERIC_BEARER: string;
	export const QT_IM_MODULE: string;
	export const QT_SCREEN_SCALE_FACTORS: string;
	export const SESSION_MANAGER: string;
	export const SHELL: string;
	export const SHLVL: string;
	export const SSH_AGENT_PID: string;
	export const SSH_AUTH_SOCK: string;
	export const STT_API_KEY: string;
	export const STT_API_URL: string;
	export const SYSTEMD_EXEC_PID: string;
	export const TERMINAL_KEY: string;
	export const TTS_API_KEY: string;
	export const TTS_API_URL: string;
	export const TTS_VOICE: string;
	export const USER: string;
	export const VSCODE_CODE_CACHE_PATH: string;
	export const VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
	export const VSCODE_CWD: string;
	export const VSCODE_ESM_ENTRYPOINT: string;
	export const VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
	export const VSCODE_IPC_HOOK: string;
	export const VSCODE_NLS_CONFIG: string;
	export const VSCODE_PID: string;
	export const XAUTHORITY: string;
	export const XDG_CONFIG_DIRS: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const XDG_DATA_DIRS: string;
	export const XDG_MENU_PREFIX: string;
	export const XDG_RUNTIME_DIR: string;
	export const XDG_SEAT: string;
	export const XDG_SEAT_PATH: string;
	export const XDG_SESSION_CLASS: string;
	export const XDG_SESSION_DESKTOP: string;
	export const XDG_SESSION_ID: string;
	export const XDG_SESSION_PATH: string;
	export const XDG_SESSION_TYPE: string;
	export const XDG_VTNR: string;
	export const XMODIFIERS: string;
	export const ZEN_API_KEY: string;
	export const _: string;
	export const ELECTRON_RUN_AS_NODE: string;
	export const APPLICATION_INSIGHTS_NO_STATSBEAT: string;
	export const DEBUG: string;
	export const VSCODE_L10N_BUNDLE_LOCATION: string;
	export const VITEST_VSCODE_LOG: string;
	export const VITEST_VSCODE: string;
	export const TEST: string;
	export const VITEST_WS_ADDRESS: string;
	export const VITEST: string;
	export const NODE_ENV: string;
	export const FORCE_COLOR: string;
	export const PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS: string;
	export const PROD: string;
	export const DEV: string;
	export const BASE_URL: string;
	export const MODE: string;
}

/**
 * Similar to [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private), except that it only includes environment variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Values are replaced statically at build time.
 * 
 * ```ts
 * import { PUBLIC_BASE_URL } from '$env/static/public';
 * ```
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to runtime environment variables, as defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * This module cannot be imported into client-side code.
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * console.log(env.DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` always includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 */
declare module '$env/dynamic/private' {
	export const env: {
		ANTHROPIC_API_KEY: string;
		BUN_INSTALL: string;
		CHROME_DESKTOP: string;
		CLUTTER_IM_MODULE: string;
		DATABASIN_ANTHROPIC_KEY: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		DC_ELEVENLABS_API_KEY: string;
		DEBUGINFOD_URLS: string;
		DESKTOP_SESSION: string;
		DISPLAY: string;
		DOTNET_BUNDLE_EXTRACT_BASE_DIR: string;
		EMBEDDING_API_ENDPOINT: string;
		EMBEDDING_API_KEY: string;
		EMBEDDING_MODEL: string;
		FC_FONTATIONS: string;
		GDK_BACKEND: string;
		GH_GITEA_TOKEN: string;
		GH_MCP_PAT: string;
		GITEA_TOKEN: string;
		GITEA_URL: string;
		GITHUB_OAUTH_CLIENT: string;
		GITHUB_OAUTH_SECRET: string;
		GPG_AGENT_INFO: string;
		GROQ_API_KEY: string;
		GTK2_RC_FILES: string;
		GTK3_MODULES: string;
		GTK_IM_MODULE: string;
		GTK_MODULES: string;
		GTK_RC_FILES: string;
		GU_OPENPALM_TOKEN: string;
		HOME: string;
		ICEAUTHORITY: string;
		IM_CONFIG_PHASE: string;
		INVOCATION_ID: string;
		JOURNAL_STREAM: string;
		KCRASH_DUMP_ONLY: string;
		KDE_APPLICATIONS_AS_SCOPE: string;
		KDE_FORK_SLAVES: string;
		KDE_FULL_SESSION: string;
		KDE_SESSION_UID: string;
		KDE_SESSION_VERSION: string;
		KRANG_GH_TOKEN: string;
		LANG: string;
		LC_ADDRESS: string;
		LC_IDENTIFICATION: string;
		LC_MEASUREMENT: string;
		LC_MONETARY: string;
		LC_NAME: string;
		LC_NUMERIC: string;
		LC_PAPER: string;
		LC_TELEPHONE: string;
		LC_TIME: string;
		LESSCLOSE: string;
		LESSOPEN: string;
		LIBVIRT_DEFAULT_URI: string;
		LITE_LLM_API_KEY: string;
		LOGNAME: string;
		MANAGERPID: string;
		MEM0_ENABLED: string;
		MEM0_URL: string;
		MEM0_USER_ID: string;
		MISTRAL_API_KEY: string;
		MISTRAL_API_URL: string;
		MOZ_USE_XINPUT2: string;
		NVM_BIN: string;
		NVM_DIR: string;
		NVM_INC: string;
		OLLAMA_DEBUG: string;
		OLLAMA_HOST: string;
		OLLAMA_MODELS: string;
		OPENAI_API_KEY: string;
		OPENCODE_DISABLE_CLAUDE_CODE: string;
		PAM_KWALLET5_LOGIN: string;
		PATH: string;
		PWD: string;
		QT_ACCESSIBILITY: string;
		QT_AUTO_SCREEN_SCALE_FACTOR: string;
		QT_EXCLUDE_GENERIC_BEARER: string;
		QT_IM_MODULE: string;
		QT_SCREEN_SCALE_FACTORS: string;
		SESSION_MANAGER: string;
		SHELL: string;
		SHLVL: string;
		SSH_AGENT_PID: string;
		SSH_AUTH_SOCK: string;
		STT_API_KEY: string;
		STT_API_URL: string;
		SYSTEMD_EXEC_PID: string;
		TERMINAL_KEY: string;
		TTS_API_KEY: string;
		TTS_API_URL: string;
		TTS_VOICE: string;
		USER: string;
		VSCODE_CODE_CACHE_PATH: string;
		VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
		VSCODE_CWD: string;
		VSCODE_ESM_ENTRYPOINT: string;
		VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
		VSCODE_IPC_HOOK: string;
		VSCODE_NLS_CONFIG: string;
		VSCODE_PID: string;
		XAUTHORITY: string;
		XDG_CONFIG_DIRS: string;
		XDG_CURRENT_DESKTOP: string;
		XDG_DATA_DIRS: string;
		XDG_MENU_PREFIX: string;
		XDG_RUNTIME_DIR: string;
		XDG_SEAT: string;
		XDG_SEAT_PATH: string;
		XDG_SESSION_CLASS: string;
		XDG_SESSION_DESKTOP: string;
		XDG_SESSION_ID: string;
		XDG_SESSION_PATH: string;
		XDG_SESSION_TYPE: string;
		XDG_VTNR: string;
		XMODIFIERS: string;
		ZEN_API_KEY: string;
		_: string;
		ELECTRON_RUN_AS_NODE: string;
		APPLICATION_INSIGHTS_NO_STATSBEAT: string;
		DEBUG: string;
		VSCODE_L10N_BUNDLE_LOCATION: string;
		VITEST_VSCODE_LOG: string;
		VITEST_VSCODE: string;
		TEST: string;
		VITEST_WS_ADDRESS: string;
		VITEST: string;
		NODE_ENV: string;
		FORCE_COLOR: string;
		PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS: string;
		PROD: string;
		DEV: string;
		BASE_URL: string;
		MODE: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * Similar to [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), but only includes variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Note that public dynamic environment variables must all be sent from the server to the client, causing larger network requests — when possible, use `$env/static/public` instead.
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.PUBLIC_DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
