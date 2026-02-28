const manifest = (() => {
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
			__memo(() => import('./chunks/0-AgmuSqb_.js')),
			__memo(() => import('./chunks/1-C22UIiZo.js')),
			__memo(() => import('./chunks/2-D0cSrwRC.js'))
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
				endpoint: __memo(() => import('./chunks/_server.ts-BB9bJZZ9.js'))
			},
			{
				id: "/automations/delete",
				pattern: /^\/automations\/delete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-NANxnfmT.js'))
			},
			{
				id: "/automations/history",
				pattern: /^\/automations\/history\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Bu4YLfAY.js'))
			},
			{
				id: "/automations/trigger",
				pattern: /^\/automations\/trigger\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-t0sDYP89.js'))
			},
			{
				id: "/automations/update",
				pattern: /^\/automations\/update\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CaVK1nai.js'))
			},
			{
				id: "/channels",
				pattern: /^\/channels\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-v-2lyyTU.js'))
			},
			{
				id: "/command",
				pattern: /^\/command\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-rvzETxxT.js'))
			},
			{
				id: "/containers",
				pattern: /^\/containers\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-6CQJIfsx.js'))
			},
			{
				id: "/containers/restart",
				pattern: /^\/containers\/restart\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Dm15nhc1.js'))
			},
			{
				id: "/containers/service-logs",
				pattern: /^\/containers\/service-logs\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BJWQEYk6.js'))
			},
			{
				id: "/containers/stop",
				pattern: /^\/containers\/stop\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DBCO1m0v.js'))
			},
			{
				id: "/containers/update",
				pattern: /^\/containers\/update\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-ieC4VYq-.js'))
			},
			{
				id: "/containers/up",
				pattern: /^\/containers\/up\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DwbqYx7Z.js'))
			},
			{
				id: "/events",
				pattern: /^\/events\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DAGjX6iy.js'))
			},
			{
				id: "/health",
				pattern: /^\/health\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CNTNyUHk.js'))
			},
			{
				id: "/installed",
				pattern: /^\/installed\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-B29JkwMk.js'))
			},
			{
				id: "/meta",
				pattern: /^\/meta\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CNZKBFpm.js'))
			},
			{
				id: "/opencode/[...path]",
				pattern: /^\/opencode(?:\/([^]*))?\/?$/,
				params: [{"name":"path","optional":false,"rest":true,"chained":true}],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DT8NCrgT.js'))
			},
			{
				id: "/secrets",
				pattern: /^\/secrets\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Bhx7y2Fh.js'))
			},
			{
				id: "/secrets/delete",
				pattern: /^\/secrets\/delete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-D7kgasuo.js'))
			},
			{
				id: "/secrets/raw",
				pattern: /^\/secrets\/raw\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BYunF8FS.js'))
			},
			{
				id: "/setup/access-scope",
				pattern: /^\/setup\/access-scope\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DH4JgJ69.js'))
			},
			{
				id: "/setup/channels",
				pattern: /^\/setup\/channels\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-6n6zwzRj.js'))
			},
			{
				id: "/setup/complete",
				pattern: /^\/setup\/complete\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-B3897sWt.js'))
			},
			{
				id: "/setup/core-readiness",
				pattern: /^\/setup\/core-readiness\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BFkMtlwL.js'))
			},
			{
				id: "/setup/core-readiness/retry",
				pattern: /^\/setup\/core-readiness\/retry\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DSRgUYgL.js'))
			},
			{
				id: "/setup/health-check",
				pattern: /^\/setup\/health-check\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CxBIeS76.js'))
			},
			{
				id: "/setup/service-instances",
				pattern: /^\/setup\/service-instances\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-B6wRnfXV.js'))
			},
			{
				id: "/setup/status",
				pattern: /^\/setup\/status\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-9pdOUUSf.js'))
			},
			{
				id: "/setup/step",
				pattern: /^\/setup\/step\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-Dl7JKFF9.js'))
			},
			{
				id: "/snippets",
				pattern: /^\/snippets\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-FkbXrNde.js'))
			},
			{
				id: "/stack/apply",
				pattern: /^\/stack\/apply\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-CaXdn1sb.js'))
			},
			{
				id: "/stack/drift",
				pattern: /^\/stack\/drift\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-BsvNA95O.js'))
			},
			{
				id: "/stack/spec",
				pattern: /^\/stack\/spec\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-DvsZbZdM.js'))
			},
			{
				id: "/state",
				pattern: /^\/state\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./chunks/_server.ts-C4F519xC.js'))
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

const prerendered = new Set([]);

const base = "";

export { base, manifest, prerendered };
//# sourceMappingURL=manifest.js.map
