import { p as attr, y as attr_class, B as clsx, x as ensure_array_like, q as stringify, t as escape_html, z as derived, C as attr_style } from './root-Cp2-5Fnx.js';
import { v as version } from './environment-DsMNyocV.js';
import { B as BUILTIN_CHANNELS } from './index-CyXiysyI.js';
import { i as inferInputType } from './snippet-types-B-BcGjF6.js';

let adminToken = "";
function getAdminToken() {
  return adminToken;
}
function QuickLinks($$renderer) {
  const assistantUrl = `/services/opencode/`;
  const openmemoryUrl = "http://localhost:3000";
  $$renderer.push(`<div class="grid2" style="margin-bottom:1rem"><a class="link-card"${attr("href", assistantUrl)} target="_blank"><div class="link-icon">✍</div> <div><strong>Open OpenCode</strong> <div class="muted" style="font-size:13px">Web-based AI assistant interface</div></div></a> <a class="link-card"${attr("href", openmemoryUrl)} target="_blank"><div class="link-icon">👁</div> <div><strong>Open Memory Dashboard</strong> <div class="muted" style="font-size:13px">View and manage stored memories</div></div></a></div>`);
}
function AdminAuth($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let tokenInput = getAdminToken();
    $$renderer2.push(`<div class="card"><h3>Admin Password</h3> <p class="muted" style="font-size:13px">Enter your <code>ADMIN_TOKEN</code> from secrets.env to authenticate.</p> <div style="display:flex;gap:0.5rem"><input type="password"${attr("value", tokenInput)} style="flex:1"/> <button>Save</button></div></div>`);
  });
}
function StackEditor($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let catalog = [];
    let configureTypeFilter = "all";
    let secretNames = [];
    let editingItemKey = "";
    let configDraft = {};
    let exposureDraft = "lan";
    let busyItemKey = "";
    const enabledInstalledItems = derived(() => catalog.filter((item) => item.entryKind === "installed" && item.enabled && configureTypeFilter === "all"));
    function itemKey(item) {
      return item.id;
    }
    function isSecretField(field) {
      const upper = field.key.toUpperCase();
      return upper.includes("SECRET") || upper.includes("TOKEN") || upper.endsWith("_KEY") || upper.includes("PASSWORD");
    }
    $$renderer2.push(`<div class="card"><h3>Stack Configuration</h3> <div style="display:flex;gap:0.4rem;margin-bottom:0.6rem;align-items:center"><div style="display:flex;gap:0.4rem"><button${attr_class(clsx(""))}>Configure</button> <button${attr_class(clsx("btn-secondary"))}>Add</button> <button${attr_class(clsx("btn-secondary"))}>Advanced YAML</button></div> <div style="margin-left:auto"><button class="btn-secondary">Reload</button></div></div> `);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<p class="muted" style="font-size:13px">Configure enabled channels and services currently running in your stack.</p> <div style="display:flex;gap:0.5rem;max-width:18rem;margin:0.5rem 0">`);
      $$renderer2.select({ value: configureTypeFilter }, ($$renderer3) => {
        $$renderer3.option({ value: "all" }, ($$renderer4) => {
          $$renderer4.push(`All types`);
        });
        $$renderer3.option({ value: "channel" }, ($$renderer4) => {
          $$renderer4.push(`Channels`);
        });
        $$renderer3.option({ value: "service" }, ($$renderer4) => {
          $$renderer4.push(`Services`);
        });
      });
      $$renderer2.push(`</div> `);
      if (enabledInstalledItems().length === 0) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<div class="muted" style="font-size:13px">No enabled containers match your filter. Use the Add tab to add new containers.</div>`);
      } else {
        $$renderer2.push("<!--[!-->");
        $$renderer2.push(`<div style="display:grid;gap:0.6rem"><!--[-->`);
        const each_array = ensure_array_like(enabledInstalledItems());
        for (let $$index_2 = 0, $$length = each_array.length; $$index_2 < $$length; $$index_2++) {
          let item = each_array[$$index_2];
          const key = itemKey(item);
          $$renderer2.push(`<div${attr_class(`channel-section ${stringify(item.enabled ? "enabled" : "")}`)}><div style="display:flex;justify-content:space-between;gap:0.6rem;align-items:flex-start"><div><div><strong>${escape_html(item.displayName)}</strong> <span class="muted">(${escape_html(item.type)})</span></div> `);
          if (item.description) {
            $$renderer2.push("<!--[-->");
            $$renderer2.push(`<div class="muted" style="font-size:13px">${escape_html(item.description)}</div>`);
          } else {
            $$renderer2.push("<!--[!-->");
          }
          $$renderer2.push(`<!--]--> <div class="muted" style="font-size:12px">Tags: ${escape_html(item.tags.join(", "))}</div></div> <div style="display:flex;gap:0.35rem;flex-wrap:wrap"><button class="btn-secondary btn-sm">Configure</button> <button class="btn-secondary btn-sm"${attr("disabled", busyItemKey === key, true)}>Uninstall</button> `);
          if (item.supportsMultipleInstances) {
            $$renderer2.push("<!--[-->");
            $$renderer2.push(`<button class="btn-secondary btn-sm"${attr("disabled", busyItemKey === key, true)}>Add instance</button>`);
          } else {
            $$renderer2.push("<!--[!-->");
          }
          $$renderer2.push(`<!--]--></div></div> `);
          if (editingItemKey === key) {
            $$renderer2.push("<!--[-->");
            $$renderer2.push(`<div style="margin-top:0.5rem">`);
            if (item.type === "channel") {
              $$renderer2.push("<!--[-->");
              $$renderer2.push(`<label for="exposure-select" style="display:block;font-size:13px;margin-bottom:0.2rem">Exposure</label> `);
              $$renderer2.select(
                {
                  id: "exposure-select",
                  value: exposureDraft,
                  style: "margin-bottom:0.45rem"
                },
                ($$renderer3) => {
                  $$renderer3.option({ value: "host" }, ($$renderer4) => {
                    $$renderer4.push(`host`);
                  });
                  $$renderer3.option({ value: "lan" }, ($$renderer4) => {
                    $$renderer4.push(`lan`);
                  });
                  $$renderer3.option({ value: "public" }, ($$renderer4) => {
                    $$renderer4.push(`public`);
                  });
                }
              );
            } else {
              $$renderer2.push("<!--[!-->");
            }
            $$renderer2.push(`<!--]--> `);
            if (item.fields.length === 0) {
              $$renderer2.push("<!--[-->");
              $$renderer2.push(`<div class="muted" style="font-size:13px">No configuration fields defined.</div>`);
            } else {
              $$renderer2.push("<!--[!-->");
            }
            $$renderer2.push(`<!--]--> <!--[-->`);
            const each_array_1 = ensure_array_like(item.fields);
            for (let $$index_1 = 0, $$length2 = each_array_1.length; $$index_1 < $$length2; $$index_1++) {
              let field = each_array_1[$$index_1];
              $$renderer2.push(`<label${attr("for", `cfg-${stringify(item.name)}-${stringify(field.key)}`)} style="display:block;margin:0.35rem 0 0.2rem;font-size:13px">${escape_html(field.key)}${escape_html(field.required ? " *" : "")}</label> <input${attr("id", `cfg-${stringify(item.name)}-${stringify(field.key)}`)}${attr("type", isSecretField(field) ? "password" : "text")}${attr("value", configDraft[field.key] ?? "")}${attr("placeholder", field.description ?? "")}/> `);
              if (secretNames.length > 0) {
                $$renderer2.push("<!--[-->");
                $$renderer2.push(`<select style="margin-top:0.2rem">`);
                $$renderer2.option({ value: "" }, ($$renderer3) => {
                  $$renderer3.push(`Use plain value`);
                });
                $$renderer2.push(`<!--[-->`);
                const each_array_2 = ensure_array_like(secretNames);
                for (let $$index = 0, $$length3 = each_array_2.length; $$index < $$length3; $$index++) {
                  let secretName = each_array_2[$$index];
                  $$renderer2.option({ value: secretName }, ($$renderer3) => {
                    $$renderer3.push(`Use secret: ${escape_html(secretName)}`);
                  });
                }
                $$renderer2.push(`<!--]--></select>`);
              } else {
                $$renderer2.push("<!--[!-->");
              }
              $$renderer2.push(`<!--]-->`);
            }
            $$renderer2.push(`<!--]--> <div style="display:flex;gap:0.4rem;margin-top:0.55rem"><button${attr("disabled", busyItemKey === key, true)}>Save configuration</button> <button class="btn-secondary">Cancel</button></div></div>`);
          } else {
            $$renderer2.push("<!--[!-->");
          }
          $$renderer2.push(`<!--]--></div>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function SecretsEditor($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let secretsText = "";
    $$renderer2.push(`<div class="card"><h3>Secrets</h3> <p class="muted" style="font-size:13px">Edit the secrets.env file directly. Each line is <code>KEY=value</code>. After saving,
		apply the stack to propagate changes to services.</p> <textarea rows="10" style="width:100%;margin:0.5rem 0" placeholder="Loading...">`);
    const $$body = escape_html(secretsText);
    if ($$body) {
      $$renderer2.push(`${$$body}`);
    }
    $$renderer2.push(`</textarea> <div style="display:flex;gap:0.5rem"><button>Save Secrets</button> <button class="btn-secondary">Reload</button></div> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function HealthStatus($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    $$renderer2.push(`<div class="card"><h3>Health Status</h3> `);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted">Loading...</div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function DriftBanner($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let unhealthy = [];
    if (unhealthy.length > 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="drift-banner svelte-wdjc3p"><strong>Unhealthy containers:</strong> ${escape_html(unhealthy.map((s) => s.name).join(", "))} <button>Reconcile</button> <button>Dismiss</button></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}
let setupState = null;
let wizardOpen = false;
let wizardStep = 0;
function getSetupState() {
  return setupState;
}
function isWizardOpen() {
  return wizardOpen;
}
function getWizardStep() {
  return wizardStep;
}
function WizardSteps($$renderer, $$props) {
  let { steps, current } = $$props;
  $$renderer.push(`<div class="steps"><!--[-->`);
  const each_array = ensure_array_like(steps);
  for (let i = 0, $$length = each_array.length; i < $$length; i++) {
    each_array[i];
    $$renderer.push(`<div${attr_class(`step-dot ${stringify(i < current ? "done" : i === current ? "current" : "")}`)}></div>`);
  }
  $$renderer.push(`<!--]--></div>`);
}
function WelcomeStep($$renderer) {
  $$renderer.push(`<p>Welcome to <strong>OpenPalm v${escape_html(version)}</strong>, your self-hosted AI assistant.</p> <p>This quick setup will get you up and running in a few steps:</p> <ol><li><strong>AI Provider</strong> — connect the model that powers your assistant</li> <li><strong>Admin Password</strong> — secure this dashboard</li> <li><strong>Channels</strong> — choose how to talk to your assistant (chat, Discord, etc.)</li> <li><strong>Access</strong> — decide who on your network can use it</li></ol> <p class="muted" style="font-size:13px">Don't worry about getting it perfect — you can change everything later from the admin dashboard.</p>`);
}
function ProfileStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const setup = derived(getSetupState);
    $$renderer2.push(`<p class="muted">Tell OpenPalm who is running this workspace.</p> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <label style="display:block; margin:0.6rem 0 0.2rem" for="wiz-profile-name">Your name</label> <input id="wiz-profile-name" placeholder="Taylor Palm"${attr("value", setup()?.profile?.name ?? "")} autocomplete="name"/> <label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-email">Email</label> <input id="wiz-profile-email" type="email" placeholder="you@example.com"${attr("value", setup()?.profile?.email ?? "")} autocomplete="email"/> <label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-password">Admin password</label> <input id="wiz-profile-password" type="password" placeholder="Choose a password (min 8 characters)" autocomplete="new-password"/> <label style="display:block; margin:0.8rem 0 0.2rem" for="wiz-profile-password2">Confirm password</label> <input id="wiz-profile-password2" type="password" placeholder="Repeat password" autocomplete="new-password"/>`);
  });
}
function ProvidersStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const state = derived(getSetupState);
    const openmemoryProvider = derived(() => state()?.openmemoryProvider ?? { openaiBaseUrl: "", openaiApiKeyConfigured: false });
    const smallModelProvider = derived(() => state()?.smallModelProvider ?? { endpoint: "", modelId: "", apiKeyConfigured: false });
    const serviceInstances = derived(() => state()?.serviceInstances ?? { openmemory: "", psql: "", qdrant: "" });
    $$renderer2.push(`<p>Connect an AI model so your assistant can respond. You need at least an Anthropic API key.</p> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <div class="sec-box"><div class="sec-title">AI Assistant Model</div> <div class="muted" style="font-size:12px;margin-bottom:0.5rem"><strong>Required.</strong> This is the brain of your assistant. If you don't have a key yet, <a href="https://console.anthropic.com/" target="_blank" rel="noopener">create one at console.anthropic.com</a> (sign up is free, you pay per use).</div> <label for="wiz-anthropic-key" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Anthropic API Key</label> <input id="wiz-anthropic-key" type="password" placeholder="sk-ant-..." value=""/> `);
    if (state()?.anthropicKeyConfigured) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted" style="font-size:12px;margin-top:0.2rem">API key already configured. Leave blank to keep current key.</div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div> <div class="sec-box"><div class="sec-title">Memory System</div> <div class="muted" style="font-size:12px;margin-bottom:0.5rem">Optional but recommended. Lets your assistant remember past conversations. Uses an
		OpenAI-compatible API for embeddings. If you skip this, memory features won't work.</div> <label for="wiz-openmemory-openai-base" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">AI model endpoint for memory</label> <input id="wiz-openmemory-openai-base" placeholder="e.g. https://api.openai.com/v1 (leave blank for default)"${attr("value", openmemoryProvider().openaiBaseUrl || "")}/> <label for="wiz-openmemory-openai-key" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">AI model API key for memory</label> <input id="wiz-openmemory-openai-key" type="password" placeholder="sk-..." value=""/> `);
    if (openmemoryProvider().openaiApiKeyConfigured) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted" style="font-size:12px;margin-top:0.2rem">API key already configured. Leave blank to keep current key.</div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div> <details class="channel-section" style="border:1px solid var(--border);border-radius:8px;padding:0.5rem 0.8rem;margin-top:0.8rem"><summary style="cursor:pointer;font-weight:600;font-size:14px;padding:0.3rem 0;user-select:none">Advanced: Service Connections &amp; Small Model</summary> <div class="sec-box" style="border-color:var(--yellow);background:rgba(234,179,8,0.1);margin-top:0.5rem"><strong>Warning:</strong> Changing these values after setup is complete may affect your data and
		workflows.</div> <label for="wiz-svc-openmemory" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Memory service address</label> <input id="wiz-svc-openmemory" placeholder="Leave blank to use built-in"${attr("value", serviceInstances().openmemory || "")}/> <label for="wiz-svc-psql" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Database connection</label> <input id="wiz-svc-psql" placeholder="Leave blank to use built-in"${attr("value", serviceInstances().psql || "")}/> <label for="wiz-svc-qdrant" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Search service address</label> <input id="wiz-svc-qdrant" placeholder="Leave blank to use built-in"${attr("value", serviceInstances().qdrant || "")}/> <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/> <p style="margin:0.5rem 0"><strong>Small / Fast Model for OpenCode</strong></p> <div class="muted" style="font-size:12px;margin-bottom:0.5rem">Configure a lightweight model for system tasks like summaries and title generation.</div> <label for="wiz-small-model-endpoint" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Small model endpoint (OpenAI-compatible)</label> <input id="wiz-small-model-endpoint" placeholder="http://localhost:11434/v1"${attr("value", smallModelProvider().endpoint || "")}/> <label for="wiz-small-model-key" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Small model API key</label> <input id="wiz-small-model-key" type="password" placeholder="sk-... (leave blank if not required)" value=""/> `);
    if (smallModelProvider().apiKeyConfigured) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted" style="font-size:12px;margin-top:0.2rem">API key already configured. Leave blank to keep current key.</div>`);
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div class="muted" style="font-size:12px;margin-top:0.2rem">Leave blank if your endpoint does not require authentication (e.g. local Ollama).</div>`);
    }
    $$renderer2.push(`<!--]--> <label for="wiz-small-model-id" style="display:block;margin:0.5rem 0 0.2rem;font-size:13px">Small model name</label> <input id="wiz-small-model-id" placeholder="ollama/tinyllama:latest"${attr("value", smallModelProvider().modelId || "")}/></details>`);
  });
}
function SecurityStep($$renderer) {
  $$renderer.push(`<p>Review the security features protecting your assistant.</p> <div class="sec-box"><div class="sec-title">Security Features</div> <ul style="font-size:13px;margin:0.2rem 0"><li>Messages are cryptographically verified</li> <li>Sensitive data is automatically filtered from memory</li> <li>Rate limiting prevents abuse</li> <li>Admin access restricted to your network</li></ul></div>`);
}
function ChannelsStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const state = derived(getSetupState);
    const enabledChannels = derived(() => state()?.enabledChannels ?? []);
    const CHANNELS = Object.entries(BUILTIN_CHANNELS).map(([key, def]) => ({
      id: `channel-${key}`,
      name: def.name,
      desc: def.description,
      fields: def.env.filter((e) => e.name !== def.sharedSecretEnv).map((e) => ({
        key: e.name,
        type: inferInputType(e.name),
        required: e.required,
        helpText: e.description ?? ""
      }))
    }));
    function isChecked(channelId) {
      return enabledChannels().includes(channelId);
    }
    function humanizeKey(key) {
      return key.replace(/^[A-Z]+_/, "").split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
    }
    $$renderer2.push(`<p>Choose how you want to talk to your assistant. Check any channels you want to enable. You can
	skip this and add channels later from the admin dashboard.</p> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <!--[-->`);
    const each_array = ensure_array_like(CHANNELS);
    for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
      let channel = each_array[$$index_1];
      const checked = isChecked(channel.id);
      $$renderer2.push(`<div${attr_class(`channel-section ${stringify(checked ? "enabled" : "")}`)}><label style="display:flex;gap:0.7rem;align-items:start;cursor:pointer"><input type="checkbox" class="wiz-ch"${attr("value", channel.id)}${attr("checked", checked, true)} style="width:auto;margin-top:4px"/> <div><strong>${escape_html(channel.name)}</strong> `);
      if (channel.desc) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<div class="muted" style="font-size:13px">${escape_html(channel.desc)}</div>`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--></div></label> `);
      if (channel.fields.length > 0) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<div class="channel-fields"${attr("id", `ch-fields-${stringify(channel.id)}`)}${attr_style(checked ? "" : "display:none")}><!--[-->`);
        const each_array_1 = ensure_array_like(channel.fields);
        for (let $$index = 0, $$length2 = each_array_1.length; $$index < $$length2; $$index++) {
          let field = each_array_1[$$index];
          $$renderer2.push(`<label${attr("for", `${stringify(channel.id)}-${stringify(field.key)}`)} style="display:block;margin:0.4rem 0 0.2rem;font-size:13px">${escape_html(field.helpText || humanizeKey(field.key))}${escape_html(field.required ? " *" : "")}</label> <input${attr("id", `${stringify(channel.id)}-${stringify(field.key)}`)} class="wiz-ch-field"${attr("data-channel", channel.id)}${attr("data-key", field.key)}${attr("type", field.type)}${attr("placeholder", field.key)} value=""/>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function AccessStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const state = derived(getSetupState);
    const accessScope = derived(() => state()?.accessScope ?? "host");
    $$renderer2.push(`<p>Choose who can access your assistant.</p> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <label class="card" style="display:flex;gap:0.7rem;align-items:start;cursor:pointer"><input type="radio" name="wiz-scope" value="host"${attr("checked", accessScope() === "host", true)} style="width:auto;margin-top:4px"/> <div><strong>Just this computer</strong> <div class="muted" style="font-size:13px">Only accessible from this device. Most secure option.</div></div></label> <label class="card" style="display:flex;gap:0.7rem;align-items:start;cursor:pointer"><input type="radio" name="wiz-scope" value="lan"${attr("checked", accessScope() === "lan", true)} style="width:auto;margin-top:4px"/> <div><strong>Any device on my home network</strong> <div class="muted" style="font-size:13px">Other devices on your local network can access your assistant.</div></div></label>`);
  });
}
function HealthStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    $$renderer2.push(`<p>Checking core service health...</p> `);
    {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted">Loading...</div>`);
    }
    $$renderer2.push(`<!--]-->`);
  });
}
function CompleteStep($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const SERVICE_NAMES = {
      gateway: "Message Router",
      assistant: "AI Assistant",
      openmemory: "Memory",
      admin: "Admin Panel",
      caddy: "Reverse Proxy",
      "openmemory-ui": "Memory UI",
      postgres: "Database",
      qdrant: "Vector DB"
    };
    const PHASE_LABELS = {
      idle: "Waiting...",
      applying: "Applying configuration...",
      starting: "Starting services...",
      checking: "Checking service readiness...",
      ready: "Everything is ready!",
      failed: "Some services need attention."
    };
    let phase = "checking";
    let checks = [];
    let diagnostics = { failedServices: [] };
    let retrying = false;
    let pollCount = 0;
    const phaseLabel = derived(() => PHASE_LABELS[phase]);
    const isReady = derived(() => phase === "ready");
    const isFailed = derived(() => phase === "failed");
    const isInProgress = derived(() => phase === "checking");
    function friendlyName(service) {
      return SERVICE_NAMES[service] ?? service;
    }
    function reasonLabel(check) {
      if (check.state === "ready") return "ready";
      if (check.reason === "missing") return "not found";
      if (check.reason === "not_running") return `stopped (${check.status})`;
      if (check.reason === "unhealthy") return `unhealthy (${check.health ?? "unknown"})`;
      if (check.reason === "http_probe_failed") {
        return check.probeError ? `probe failed: ${check.probeError}` : "probe failed";
      }
      return check.status || "unknown";
    }
    $$renderer2.push(`<p>Finalizing setup and starting your assistant...</p> <div><p class="muted">${escape_html(phaseLabel())}`);
    if (isInProgress() && pollCount > 1) ;
    else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></p> `);
    if (checks.length > 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<ul class="readiness-checks" style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px; list-style:none"><!--[-->`);
      const each_array = ensure_array_like(checks);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let check = each_array[$$index];
        $$renderer2.push(`<li${attr_style(`margin:0.2rem 0; color: ${stringify(check.state === "ready" ? "var(--green, green)" : isInProgress() ? "var(--muted, #888)" : "var(--red, red)")}`)}><span aria-hidden="true">${escape_html(check.state === "ready" ? "✓" : isInProgress() ? "○" : "✗")}</span> <span class="sr-only">${escape_html(check.state === "ready" ? "Ready" : "Not ready")}</span> <strong>${escape_html(friendlyName(check.service))}</strong> — ${escape_html(check.state === "ready" ? "ready" : isInProgress() ? "starting..." : reasonLabel(check))}</li>`);
      }
      $$renderer2.push(`<!--]--></ul>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (isReady()) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<p style="margin:0.5rem 0; color: var(--green, green); font-weight:600">All services are running and healthy.</p> <button>Continue to Admin</button>`);
    } else if (isFailed()) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<div style="margin:0.5rem 0"><p>Some services need attention:</p> <ul style="margin:0.4rem 0; padding-left:1.2rem; font-size:13px"><!--[-->`);
      const each_array_1 = ensure_array_like(diagnostics.failedServices);
      for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
        let check = each_array_1[$$index_1];
        $$renderer2.push(`<li style="color: var(--red, red)"><strong>${escape_html(friendlyName(check.service))}</strong> — ${escape_html(reasonLabel(check))} `);
        if (check.probeUrl) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<span class="muted" style="font-size:12px">(${escape_html(check.probeUrl)})</span>`);
        } else {
          $$renderer2.push("<!--[!-->");
        }
        $$renderer2.push(`<!--]--></li>`);
      }
      $$renderer2.push(`<!--]--></ul> `);
      if (diagnostics.failedServiceLogs && Object.keys(diagnostics.failedServiceLogs).length > 0) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<button class="btn-link" style="font-size:12px; margin:0.3rem 0; cursor:pointer; background:none; border:none; color:var(--link, #0366d6); text-decoration:underline; padding:0">${escape_html("Show")} diagnostics</button> `);
        {
          $$renderer2.push("<!--[!-->");
        }
        $$renderer2.push(`<!--]-->`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--> <p class="muted" style="font-size:13px; margin:0.4rem 0">Check your API keys and Docker status, then retry or run <code>openpalm logs</code> for details.</p> <div style="display:flex; gap:0.5rem; margin-top:0.5rem"><button${attr("disabled", retrying, true)}>${escape_html("Retry Readiness Check")}</button> <button class="btn-secondary">Continue to Admin</button></div></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function SetupWizard($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    const STEPS = [
      "welcome",
      "profile",
      "serviceInstances",
      "security",
      "channels",
      "accessScope",
      "healthCheck",
      "complete"
    ];
    const STEP_TITLES = [
      "Welcome",
      "Profile",
      "AI Providers",
      "Security",
      "Channels",
      "Access",
      "Health Check",
      "Complete"
    ];
    let finishInProgress = false;
    const currentStep = derived(getWizardStep);
    const currentStepName = derived(() => STEPS[currentStep()]);
    const isLastContentStep = derived(() => currentStep() === STEPS.length - 2);
    const isComplete = derived(() => currentStepName() === "complete");
    $$renderer2.push(`<div class="wizard-overlay" role="dialog" aria-modal="true"><div class="wizard"><h2>${escape_html(STEP_TITLES[currentStep()])}</h2> `);
    WizardSteps($$renderer2, { steps: STEPS, current: currentStep() });
    $$renderer2.push(`<!----> <div class="body">`);
    if (currentStepName() === "welcome") {
      $$renderer2.push("<!--[-->");
      WelcomeStep($$renderer2);
    } else if (currentStepName() === "profile") {
      $$renderer2.push("<!--[1-->");
      ProfileStep($$renderer2);
    } else if (currentStepName() === "serviceInstances") {
      $$renderer2.push("<!--[2-->");
      ProvidersStep($$renderer2);
    } else if (currentStepName() === "security") {
      $$renderer2.push("<!--[3-->");
      SecurityStep($$renderer2);
    } else if (currentStepName() === "channels") {
      $$renderer2.push("<!--[4-->");
      ChannelsStep($$renderer2);
    } else if (currentStepName() === "accessScope") {
      $$renderer2.push("<!--[5-->");
      AccessStep($$renderer2);
    } else if (currentStepName() === "healthCheck") {
      $$renderer2.push("<!--[6-->");
      HealthStep($$renderer2);
    } else if (currentStepName() === "complete") {
      $$renderer2.push("<!--[7-->");
      CompleteStep($$renderer2);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (!isComplete()) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="actions">`);
      if (currentStep() > 0) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<button class="btn-secondary">Back</button>`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--> `);
      if (isLastContentStep()) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<button${attr("disabled", finishInProgress, true)}>${escape_html("Finish Setup")}</button>`);
      } else {
        $$renderer2.push("<!--[!-->");
        $$renderer2.push(`<button>Next</button>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div></div>`);
  });
}
function OperationsManager($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let services = [];
    let automations = [];
    let newName = "";
    let newSchedule = "*/15 * * * *";
    let newScript = 'echo "hello from openpalm automation"';
    let busy = false;
    $$renderer2.push(`<div class="card"><h3>Container Management</h3> <p class="muted" style="font-size:13px">Start, stop, restart, update, and inspect logs for stack services. Admin and caddy are excluded.</p> `);
    if (services.length === 0) {
      $$renderer2.push("<!--[-->");
      $$renderer2.push(`<div class="muted" style="font-size:13px">No manageable services found.</div>`);
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<div style="display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:center"><!--[-->`);
      const each_array = ensure_array_like(services);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let service = each_array[$$index];
        $$renderer2.push(`<div><div style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace">${escape_html(service.name)}</div> <div class="muted" style="font-size:12px">${escape_html(service.image)} • ${escape_html(service.status)}</div></div> <div style="display:flex;gap:0.25rem;flex-wrap:wrap;justify-content:flex-end"><button class="btn-secondary btn-sm"${attr("disabled", busy, true)}>Start</button> <button class="btn-secondary btn-sm"${attr("disabled", busy, true)}>Stop</button> <button class="btn-secondary btn-sm"${attr("disabled", busy, true)}>Restart</button> `);
        if (service.updateAvailable) {
          $$renderer2.push("<!--[-->");
          $$renderer2.push(`<button class="btn-secondary btn-sm"${attr("disabled", busy, true)}>Upgrade</button>`);
        } else {
          $$renderer2.push("<!--[!-->");
        }
        $$renderer2.push(`<!--]--> <button class="btn-secondary btn-sm">Logs</button></div>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div> <div class="card"><h3>Automation Management</h3> <p class="muted" style="font-size:13px">Add, remove, enable/disable, run, and inspect logs for automations and cron jobs.</p> <div class="grid2" style="margin-bottom:0.6rem"><input${attr("value", newName)} placeholder="Automation name"/> <input${attr("value", newSchedule)} placeholder="Cron schedule (e.g. */15 * * * *)"/></div> <textarea rows="3" placeholder="Automation script">`);
    const $$body_1 = escape_html(newScript);
    if ($$body_1) {
      $$renderer2.push(`${$$body_1}`);
    }
    $$renderer2.push(`</textarea> <div style="margin-top:0.5rem"><button${attr("disabled", !newName.trim() || !newSchedule.trim() || !newScript.trim(), true)}>Add Automation</button></div> <div style="margin-top:0.8rem;display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:center"><!--[-->`);
    const each_array_1 = ensure_array_like(automations);
    for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
      let automation = each_array_1[$$index_1];
      $$renderer2.push(`<div><div><strong>${escape_html(automation.name)}</strong> ${escape_html(automation.core ? "(core)" : "")}</div> <div class="muted" style="font-size:12px">${escape_html(automation.schedule)} • ${escape_html(automation.enabled ? "enabled" : "disabled")} `);
      if (automation.lastRun) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`• last run ${escape_html(automation.lastRun.status)} at ${escape_html(automation.lastRun.ts)}`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--></div></div> <div style="display:flex;gap:0.25rem;flex-wrap:wrap;justify-content:flex-end"><button class="btn-secondary btn-sm">Run</button> <button class="btn-secondary btn-sm">${escape_html(automation.enabled ? "Disable" : "Enable")}</button> <button class="btn-secondary btn-sm">Logs</button> `);
      if (!automation.core) {
        $$renderer2.push("<!--[-->");
        $$renderer2.push(`<button class="btn-danger btn-sm">Delete</button>`);
      } else {
        $$renderer2.push("<!--[!-->");
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--></div> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let showWizard = derived(isWizardOpen);
    $$renderer2.push(`<h2>Dashboard</h2> `);
    QuickLinks($$renderer2);
    $$renderer2.push(`<!----> `);
    AdminAuth($$renderer2);
    $$renderer2.push(`<!----> `);
    StackEditor($$renderer2);
    $$renderer2.push(`<!----> `);
    SecretsEditor($$renderer2);
    $$renderer2.push(`<!----> `);
    DriftBanner($$renderer2);
    $$renderer2.push(`<!----> `);
    {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]--> <div class="card"><h3>Setup Wizard</h3> <p class="muted" style="font-size:13px">Re-run the initial setup wizard to reconfigure channels, API keys, and access scope.</p> <button class="btn-secondary">Run Setup Wizard</button></div> `);
    HealthStatus($$renderer2);
    $$renderer2.push(`<!----> `);
    OperationsManager($$renderer2);
    $$renderer2.push(`<!----> `);
    if (showWizard()) {
      $$renderer2.push("<!--[-->");
      SetupWizard($$renderer2);
    } else {
      $$renderer2.push("<!--[!-->");
    }
    $$renderer2.push(`<!--]-->`);
  });
}

export { _page as default };
//# sourceMappingURL=_page.svelte-Bhnrpeay.js.map
