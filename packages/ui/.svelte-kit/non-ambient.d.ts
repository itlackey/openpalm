
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/" | "/automations" | "/automations/delete" | "/automations/history" | "/automations/trigger" | "/automations/update" | "/channels" | "/command" | "/containers" | "/containers/restart" | "/containers/service-logs" | "/containers/stop" | "/containers/update" | "/containers/up" | "/events" | "/health" | "/installed" | "/meta" | "/opencode" | "/opencode/[...path]" | "/secrets" | "/secrets/delete" | "/secrets/raw" | "/setup" | "/setup/access-scope" | "/setup/channels" | "/setup/complete" | "/setup/core-readiness" | "/setup/core-readiness/retry" | "/setup/health-check" | "/setup/service-instances" | "/setup/status" | "/setup/step" | "/snippets" | "/stack" | "/stack/apply" | "/stack/drift" | "/stack/spec" | "/state";
		RouteParams(): {
			"/opencode/[...path]": { path: string }
		};
		LayoutParams(): {
			"/": { path?: string };
			"/automations": Record<string, never>;
			"/automations/delete": Record<string, never>;
			"/automations/history": Record<string, never>;
			"/automations/trigger": Record<string, never>;
			"/automations/update": Record<string, never>;
			"/channels": Record<string, never>;
			"/command": Record<string, never>;
			"/containers": Record<string, never>;
			"/containers/restart": Record<string, never>;
			"/containers/service-logs": Record<string, never>;
			"/containers/stop": Record<string, never>;
			"/containers/update": Record<string, never>;
			"/containers/up": Record<string, never>;
			"/events": Record<string, never>;
			"/health": Record<string, never>;
			"/installed": Record<string, never>;
			"/meta": Record<string, never>;
			"/opencode": { path?: string };
			"/opencode/[...path]": { path: string };
			"/secrets": Record<string, never>;
			"/secrets/delete": Record<string, never>;
			"/secrets/raw": Record<string, never>;
			"/setup": Record<string, never>;
			"/setup/access-scope": Record<string, never>;
			"/setup/channels": Record<string, never>;
			"/setup/complete": Record<string, never>;
			"/setup/core-readiness": Record<string, never>;
			"/setup/core-readiness/retry": Record<string, never>;
			"/setup/health-check": Record<string, never>;
			"/setup/service-instances": Record<string, never>;
			"/setup/status": Record<string, never>;
			"/setup/step": Record<string, never>;
			"/snippets": Record<string, never>;
			"/stack": Record<string, never>;
			"/stack/apply": Record<string, never>;
			"/stack/drift": Record<string, never>;
			"/stack/spec": Record<string, never>;
			"/state": Record<string, never>
		};
		Pathname(): "/" | "/automations" | "/automations/delete" | "/automations/history" | "/automations/trigger" | "/automations/update" | "/channels" | "/command" | "/containers" | "/containers/restart" | "/containers/service-logs" | "/containers/stop" | "/containers/update" | "/containers/up" | "/events" | "/health" | "/installed" | "/meta" | `/opencode/${string}` & {} | "/secrets" | "/secrets/delete" | "/secrets/raw" | "/setup/access-scope" | "/setup/channels" | "/setup/complete" | "/setup/core-readiness" | "/setup/core-readiness/retry" | "/setup/health-check" | "/setup/service-instances" | "/setup/status" | "/setup/step" | "/snippets" | "/stack/apply" | "/stack/drift" | "/stack/spec" | "/state";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/logo.png" | "/robots.txt" | string & {};
	}
}