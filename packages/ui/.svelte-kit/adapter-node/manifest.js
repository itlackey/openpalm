export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["logo.png","robots.txt"]),
	mimeTypes: {".png":"image/png",".txt":"text/plain"},
	_: {
		client: {start:"_app/immutable/entry/start.9_kpdXML.js",app:"_app/immutable/entry/app.JthuYbFP.js",imports:["_app/immutable/entry/start.9_kpdXML.js","_app/immutable/chunks/BIPdtRdT.js","_app/immutable/chunks/D7cZ0k1v.js","_app/immutable/chunks/DwlCIXL_.js","_app/immutable/entry/app.JthuYbFP.js","_app/immutable/chunks/D7cZ0k1v.js","_app/immutable/chunks/C5K1a9yk.js","_app/immutable/chunks/BggzYTts.js","_app/immutable/chunks/WGxAPpTC.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/automations",
				pattern: /^\/automations\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/automations/_server.ts.js'))
			},
			{
				id: "/automations/delete",
				pattern: /^\/automations\/delete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/automations/delete/_server.ts.js'))
			},
			{
				id: "/automations/history",
				pattern: /^\/automations\/history\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/automations/history/_server.ts.js'))
			},
			{
				id: "/automations/trigger",
				pattern: /^\/automations\/trigger\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/automations/trigger/_server.ts.js'))
			},
			{
				id: "/automations/update",
				pattern: /^\/automations\/update\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/automations/update/_server.ts.js'))
			},
			{
				id: "/channels",
				pattern: /^\/channels\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/channels/_server.ts.js'))
			},
			{
				id: "/command",
				pattern: /^\/command\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/command/_server.ts.js'))
			},
			{
				id: "/containers",
				pattern: /^\/containers\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/_server.ts.js'))
			},
			{
				id: "/containers/restart",
				pattern: /^\/containers\/restart\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/restart/_server.ts.js'))
			},
			{
				id: "/containers/service-logs",
				pattern: /^\/containers\/service-logs\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/service-logs/_server.ts.js'))
			},
			{
				id: "/containers/stop",
				pattern: /^\/containers\/stop\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/stop/_server.ts.js'))
			},
			{
				id: "/containers/update",
				pattern: /^\/containers\/update\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/update/_server.ts.js'))
			},
			{
				id: "/containers/up",
				pattern: /^\/containers\/up\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/containers/up/_server.ts.js'))
			},
			{
				id: "/events",
				pattern: /^\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/events/_server.ts.js'))
			},
			{
				id: "/health",
				pattern: /^\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/health/_server.ts.js'))
			},
			{
				id: "/installed",
				pattern: /^\/installed\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/installed/_server.ts.js'))
			},
			{
				id: "/meta",
				pattern: /^\/meta\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/meta/_server.ts.js'))
			},
			{
				id: "/opencode/[...path]",
				pattern: /^\/opencode(?:\/([^]*))?\/?$/,
				params: [{"name":"path","optional":false,"rest":true,"chained":true}],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/opencode/_...path_/_server.ts.js'))
			},
			{
				id: "/secrets",
				pattern: /^\/secrets\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/secrets/_server.ts.js'))
			},
			{
				id: "/secrets/delete",
				pattern: /^\/secrets\/delete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/secrets/delete/_server.ts.js'))
			},
			{
				id: "/secrets/raw",
				pattern: /^\/secrets\/raw\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/secrets/raw/_server.ts.js'))
			},
			{
				id: "/setup/access-scope",
				pattern: /^\/setup\/access-scope\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/access-scope/_server.ts.js'))
			},
			{
				id: "/setup/channels",
				pattern: /^\/setup\/channels\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/channels/_server.ts.js'))
			},
			{
				id: "/setup/complete",
				pattern: /^\/setup\/complete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/complete/_server.ts.js'))
			},
			{
				id: "/setup/core-readiness",
				pattern: /^\/setup\/core-readiness\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/core-readiness/_server.ts.js'))
			},
			{
				id: "/setup/core-readiness/retry",
				pattern: /^\/setup\/core-readiness\/retry\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/core-readiness/retry/_server.ts.js'))
			},
			{
				id: "/setup/health-check",
				pattern: /^\/setup\/health-check\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/health-check/_server.ts.js'))
			},
			{
				id: "/setup/service-instances",
				pattern: /^\/setup\/service-instances\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/service-instances/_server.ts.js'))
			},
			{
				id: "/setup/status",
				pattern: /^\/setup\/status\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/status/_server.ts.js'))
			},
			{
				id: "/setup/step",
				pattern: /^\/setup\/step\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/setup/step/_server.ts.js'))
			},
			{
				id: "/snippets",
				pattern: /^\/snippets\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/snippets/_server.ts.js'))
			},
			{
				id: "/stack/apply",
				pattern: /^\/stack\/apply\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/stack/apply/_server.ts.js'))
			},
			{
				id: "/stack/drift",
				pattern: /^\/stack\/drift\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/stack/drift/_server.ts.js'))
			},
			{
				id: "/stack/spec",
				pattern: /^\/stack\/spec\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/stack/spec/_server.ts.js'))
			},
			{
				id: "/state",
				pattern: /^\/state\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/state/_server.ts.js'))
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

export const prerendered = new Set([]);

export const base = "";