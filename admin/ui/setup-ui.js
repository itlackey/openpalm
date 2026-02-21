(() => {
  let setupState = null;
  const STEPS = ["welcome", "serviceInstances", "security", "channels", "accessScope", "healthCheck", "complete"];
  const STEP_TITLES = ["Welcome", "AI Providers", "Security", "Channels", "Access", "Health Check", "Complete"];
  let wizardStep = 0;
  let accessScope = "host";
  let serviceInstances = { openmemory: "", psql: "", qdrant: "" };
  let openmemoryProvider = { openaiBaseUrl: "", openaiApiKeyConfigured: false };
  let smallModelProvider = { endpoint: "", modelId: "", apiKeyConfigured: false };
  let enabledChannels = [];
  let channelConfigs = {};
  let channelFields = {};
  let api;
  let esc;
  let showPage;
  let getAdminToken;
  let setAdminToken;

  function ensureStyles() {
    if (document.getElementById("setup-ui-style")) return;
    const style = document.createElement("style");
    style.id = "setup-ui-style";
    style.textContent = `
      .wizard-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100}
      .wizard{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;max-width:640px;width:95%;max-height:90vh;overflow-y:auto}
      .wizard h2{margin:0 0 .3rem}
      .wizard .steps{display:flex;gap:.5rem;margin:1rem 0}
      .wizard .step-dot{width:28px;height:28px;min-width:28px;border-radius:50%;background:var(--border)}
      .wizard .step-dot.done{background:var(--green)}
      .wizard .step-dot.current{background:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.3)}
      .wizard .body{min-height:180px;margin:1rem 0}
      .wizard .actions{display:flex;gap:.5rem;justify-content:flex-end}
      .wizard .wiz-error{background:rgba(239,68,68,.1);border:1px solid var(--red,#ef4444);color:var(--red,#ef4444);border-radius:8px;padding:.6rem 1rem;margin:.5rem 0;font-size:13px;display:none}
      .wizard .wiz-error.visible{display:block}
      .wizard details.advanced-section{margin-top:.8rem;border:1px solid var(--border);border-radius:8px;padding:.5rem .8rem}
      .wizard details.advanced-section summary{cursor:pointer;font-weight:600;font-size:14px;padding:.3rem 0;user-select:none}
      .wizard .channel-section{border:1px solid var(--border);border-radius:8px;padding:.8rem;margin:.5rem 0}
      .wizard .channel-section.enabled{border-color:var(--accent)}
      .wizard .channel-fields{margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border)}
    `;
    document.head.appendChild(style);
  }

  async function checkSetup() {
    const meta = await api("/admin/meta");
    if (meta.ok && meta.data && meta.data.channelFields) {
      channelFields = meta.data.channelFields;
    }
    const r = await api("/admin/setup/status");
    if (!r.ok) return;
    setupState = r.data;
    accessScope = setupState.accessScope || "host";
    serviceInstances = setupState.serviceInstances || { openmemory: "", psql: "", qdrant: "" };
    openmemoryProvider = setupState.openmemoryProvider || { openaiBaseUrl: "", openaiApiKeyConfigured: false };
    smallModelProvider = setupState.smallModelProvider || { endpoint: "", modelId: "", apiKeyConfigured: false };
    enabledChannels = Array.isArray(setupState.enabledChannels) ? setupState.enabledChannels : [];
    if (!setupState.completed) runSetup();
  }

  function runSetup() {
    wizardStep = 0;
    document.getElementById("setup-overlay")?.classList.remove("hidden");
    renderWizard();
  }

  function renderWizard() {
    const ov = document.getElementById("setup-overlay");
    if (!ov) return;
    let h = '<div class="wizard">';
    h += '<h2>' + STEP_TITLES[wizardStep] + '</h2>';
    h += '<div class="steps">';
    for (let i = 0; i < STEPS.length; i++) {
      const cls = i < wizardStep ? "done" : i === wizardStep ? "current" : "";
      h += '<div class="step-dot ' + cls + '"></div>';
    }
    h += '</div><div class="body">';
    h += wizardBody();
    h += '</div><div class="actions">';
    if (wizardStep > 0 && STEPS[wizardStep] !== "complete") h += '<button class="secondary" onclick="window.openPalmSetup.wizardPrev()">Back</button>';
    if (wizardStep < STEPS.length - 2) h += '<button onclick="window.openPalmSetup.wizardNext()">Next</button>';
    else if (wizardStep === STEPS.length - 2) h += '<button onclick="window.openPalmSetup.finishSetup()">Finish Setup</button>';
    h += '</div></div>';
    ov.innerHTML = h;
    if (window.trapFocus) window.trapFocus(ov);
  }

  function wizardBody() {
    const adminToken = getAdminToken();
    switch (STEPS[wizardStep]) {
      case "welcome":
        return '<p>Welcome to <strong>OpenPalm</strong>, your self-hosted AI assistant platform.</p>'
          + '<p>This wizard will walk you through initial configuration:</p>'
          + '<ul><li>Connect your AI providers</li><li>Set up admin security</li><li>Choose your channels</li><li>Configure network access</li></ul>'
          + '<p class="muted" style="font-size:13px">You can re-run this wizard any time from the admin dashboard.</p>';
      case "serviceInstances":
        return '<p>Configure API keys for your AI providers. Your assistant needs at least one AI model to function.</p>'
          + '<div id="wiz-step-error" class="wiz-error"></div>'
          + '<div class="sec-box"><div class="sec-title">AI Assistant Model</div>'
          + '<div class="muted" style="font-size:12px;margin-bottom:.5rem">Required. Your assistant uses this API key to communicate. Get one from <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>.</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Anthropic API Key</label>'
          + '<input id="wiz-anthropic-key" type="password" placeholder="sk-ant-..." value="" />'
          + '<div class="muted" style="font-size:12px;margin-top:.2rem">' + (setupState && setupState.anthropicKeyConfigured ? "API key already configured. Leave blank to keep current key." : "") + '</div>'
          + '</div>'
          + '<div class="sec-box"><div class="sec-title">Memory System</div>'
          + '<div class="muted" style="font-size:12px;margin-bottom:.5rem">Required for memory features. Uses an OpenAI-compatible endpoint to store and recall information.</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">AI model endpoint for memory</label>'
          + '<input id="wiz-openmemory-openai-base" placeholder="e.g. https://api.openai.com/v1 (leave blank for default)" value="' + esc(openmemoryProvider.openaiBaseUrl || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">AI model API key for memory</label>'
          + '<input id="wiz-openmemory-openai-key" type="password" placeholder="sk-..." value="" />'
          + '<div class="muted" style="font-size:12px;margin-top:.2rem">' + (openmemoryProvider.openaiApiKeyConfigured ? "API key already configured. Leave blank to keep current key." : "") + '</div>'
          + '</div>'
          + '<details class="advanced-section">'
          + '<summary>Advanced: Service Connections &amp; Small Model</summary>'
          + '<div class="sec-box" style="border-color:var(--yellow);background:rgba(234,179,8,.1);margin-top:.5rem"><strong>Warning:</strong> Changing these values after setup is complete may affect your data and workflows.</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Memory service address</label>'
          + '<input id="wiz-svc-openmemory" placeholder="Leave blank to use built-in" value="' + esc(serviceInstances.openmemory || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Database connection</label>'
          + '<input id="wiz-svc-psql" placeholder="Leave blank to use built-in" value="' + esc(serviceInstances.psql || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Search service address</label>'
          + '<input id="wiz-svc-qdrant" placeholder="Leave blank to use built-in" value="' + esc(serviceInstances.qdrant || "") + '" />'
          + '<hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)" />'
          + '<p style="margin:.5rem 0"><strong>Small / Fast Model for OpenCode</strong></p>'
          + '<div class="muted" style="font-size:12px;margin-bottom:.5rem">Configure a lightweight model for system tasks like summaries and title generation.</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Small model endpoint (OpenAI-compatible)</label>'
          + '<input id="wiz-small-model-endpoint" placeholder="http://localhost:11434/v1" value="' + esc(smallModelProvider.endpoint || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Small model API key</label>'
          + '<input id="wiz-small-model-key" type="password" placeholder="sk-... (leave blank if not required)" value="" />'
          + '<div class="muted" style="font-size:12px;margin-top:.2rem">' + (smallModelProvider.apiKeyConfigured ? "API key already configured. Leave blank to keep current key." : "Leave blank if your endpoint does not require authentication (e.g. local Ollama).") + '</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Small model name</label>'
          + '<input id="wiz-small-model-id" placeholder="ollama/tinyllama:latest" value="' + esc(smallModelProvider.modelId || "") + '" />'
          + '</details>';
      case "security":
        return '<p>Set your admin password to protect this management interface.</p>'
          + '<div id="wiz-step-error" class="wiz-error"></div>'
          + '<div class="sec-box"><div class="sec-title">Admin Password</div>'
          + '<div style="font-size:13px;margin-bottom:.5rem">Your admin token was auto-generated during installation. Find it in your <code>secrets.env</code> file (look for <code>ADMIN_TOKEN</code>). Enter it here to authenticate.</div>'
          + '<input type="password" id="wiz-admin" value="' + esc(adminToken) + '" placeholder="Paste your ADMIN_TOKEN here" />'
          + '</div>'
          + '<div class="sec-box" style="margin-top:.7rem"><div class="sec-title">Security Features</div>'
          + '<ul style="font-size:13px;margin:.2rem 0"><li>Messages are cryptographically verified</li><li>Sensitive data is automatically filtered from memory</li><li>Rate limiting prevents abuse</li><li>Admin access restricted to your network</li></ul></div>';
      case "channels":
        return '<p>Choose how you want to talk to your assistant. Enable a channel and provide its credentials.</p>'
          + '<div id="wiz-step-error" class="wiz-error"></div>'
          + channelSections();
      case "accessScope":
        return '<p>Choose who can access your assistant.</p>'
          + '<div id="wiz-step-error" class="wiz-error"></div>'
          + '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">'
          + '<input type="radio" name="wiz-scope" value="host" ' + (accessScope === "host" ? "checked" : "") + ' style="width:auto;margin-top:4px" />'
          + '<div><strong>Just this computer</strong><div class="muted" style="font-size:13px">Only accessible from this device. Most secure option.</div></div>'
          + '</label>'
          + '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">'
          + '<input type="radio" name="wiz-scope" value="lan" ' + (accessScope === "lan" ? "checked" : "") + ' style="width:auto;margin-top:4px" />'
          + '<div><strong>Any device on my home network</strong><div class="muted" style="font-size:13px">Other devices on your local network can access your assistant.</div></div>'
          + '</label>';
      case "healthCheck":
        return '<p>Checking core service health...</p><div id="wiz-health">Loading...</div><div id="wiz-step-error" class="error-text" style="display:none"></div>';
      case "complete":
        return '<p>Finalizing setup and starting your assistant...</p><div id="wiz-complete-status">Loading...</div>';
    }
    return "";
  }

  function channelSections() {
    const chs = [
      { id: "channel-chat", name: "Chat", desc: "Chat with your assistant through the built-in web interface", fieldKey: "channel-chat" },
      { id: "channel-discord", name: "Discord", desc: "Connect your assistant to a Discord server", fieldKey: "channel-discord" },
      { id: "channel-voice", name: "Voice", desc: "Talk to your assistant using voice", fieldKey: "channel-voice" },
      { id: "channel-telegram", name: "Telegram", desc: "Connect your assistant to Telegram", fieldKey: "channel-telegram" },
    ];
    let h = "";
    for (const c of chs) {
      const checked = enabledChannels.includes(c.id);
      const fields = channelFields[c.fieldKey] || [];
      const savedConfig = channelConfigs[c.id] || {};
      h += '<div class="channel-section' + (checked ? " enabled" : "") + '">';
      h += '<label style="display:flex;gap:.7rem;align-items:start;cursor:pointer">';
      h += '<input type="checkbox" class="wiz-ch" value="' + c.id + '" ' + (checked ? "checked" : "") + ' style="width:auto;margin-top:4px" onchange="window.openPalmSetup.toggleChannelSection(this)" />';
      h += '<div><strong>' + c.name + '</strong><div class="muted" style="font-size:13px">' + c.desc + '</div></div>';
      h += "</label>";
      if (fields.length > 0) {
        h += '<div class="channel-fields" id="ch-fields-' + c.id + '" style="' + (checked ? "" : "display:none") + '">';
        for (var fi = 0; fi < fields.length; fi++) {
          var f = fields[fi];
          var val = savedConfig[f.key] || "";
          h += '<label style="display:block;margin:.4rem 0 .2rem;font-size:13px">' + esc(f.label) + (f.required ? ' *' : '') + '</label>';
          h += '<input class="wiz-ch-field" data-channel="' + c.id + '" data-key="' + esc(f.key) + '" type="' + f.type + '" placeholder="' + esc(f.helpText || "") + '" value="' + esc(val) + '" />';
        }
        h += '</div>';
      }
      h += '</div>';
    }
    return h;
  }

  function toggleChannelSection(checkbox) {
    var section = checkbox.closest(".channel-section");
    var fields = section.querySelector(".channel-fields");
    if (checkbox.checked) {
      section.classList.add("enabled");
      if (fields) fields.style.display = "";
    } else {
      section.classList.remove("enabled");
      if (fields) fields.style.display = "none";
    }
  }

  function showStepError(msg) {
    const el = document.getElementById("wiz-step-error");
    if (el) {
      el.textContent = msg;
      el.classList.add("visible");
    }
  }

  function clearStepError() {
    const el = document.getElementById("wiz-step-error");
    if (el) {
      el.textContent = "";
      el.classList.remove("visible");
    }
  }

  async function wizHealthCheck() {
    const r = await api("/admin/setup/health-check");
    const el = document.getElementById("wiz-health");
    if (!el) return;
    if (!r.ok) { el.textContent = "Could not reach admin API."; return; }
    let h = "";
    const svcNames = window.SERVICE_NAMES || {};
    for (const [name, info] of Object.entries(r.data.services)) {
      const friendly = (svcNames[name] && svcNames[name].label) ? svcNames[name].label : esc(name);
      h += '<div style="margin:.3rem 0"><span class="dot ' + (info.ok ? "dot-ok" : "dot-err") + '"></span><span class="sr-only">' + (info.ok ? "Healthy" : "Error") + '</span><strong>' + friendly + '</strong> — ' + (info.ok ? "Healthy" : esc(info.error || "Unreachable")) + '</div>';
    }
    el.innerHTML = h;
  }

  function collectChannelConfigs() {
    var configs = {};
    var fields = document.querySelectorAll(".wiz-ch-field");
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var channel = f.getAttribute("data-channel");
      var key = f.getAttribute("data-key");
      if (!channel || !key) continue;
      if (!configs[channel]) configs[channel] = {};
      configs[channel][key] = f.value;
    }
    return configs;
  }

  async function wizardNext() {
    clearStepError();

    if (STEPS[wizardStep] === "serviceInstances") {
      const openmemory = document.getElementById("wiz-svc-openmemory")?.value || "";
      const psql = document.getElementById("wiz-svc-psql")?.value || "";
      const qdrant = document.getElementById("wiz-svc-qdrant")?.value || "";
      const openaiBaseUrl = document.getElementById("wiz-openmemory-openai-base")?.value || "";
      const openaiApiKey = document.getElementById("wiz-openmemory-openai-key")?.value || "";
      const anthropicApiKey = document.getElementById("wiz-anthropic-key")?.value || "";
      const smallModelEndpoint = document.getElementById("wiz-small-model-endpoint")?.value || "";
      const smallModelApiKey = document.getElementById("wiz-small-model-key")?.value || "";
      const smallModelId = document.getElementById("wiz-small-model-id")?.value || "";
      const servicePayload = { openmemory, psql, qdrant, openaiBaseUrl, smallModelEndpoint, smallModelId };
      if (openaiApiKey.trim()) servicePayload.openaiApiKey = openaiApiKey.trim();
      if (anthropicApiKey.trim()) servicePayload.anthropicApiKey = anthropicApiKey.trim();
      if (smallModelApiKey.trim()) servicePayload.smallModelApiKey = smallModelApiKey.trim();
      const serviceResult = await api("/admin/setup/service-instances", {
        method: "POST",
        body: JSON.stringify(servicePayload)
      });
      if (!serviceResult.ok) {
        showStepError("Could not save service settings. Please try again.");
        return;
      }
      serviceInstances = serviceResult.data?.state?.serviceInstances || { openmemory, psql, qdrant };
      openmemoryProvider = serviceResult.data?.openmemoryProvider || openmemoryProvider;
      smallModelProvider = serviceResult.data?.smallModelProvider || smallModelProvider;
    }
    if (STEPS[wizardStep] === "security") {
      const a = document.getElementById("wiz-admin");
      if (a) setAdminToken(a.value);
    }
    if (STEPS[wizardStep] === "channels") {
      enabledChannels = Array.from(document.querySelectorAll(".wiz-ch:checked")).map((c) => c.value);
      channelConfigs = collectChannelConfigs();
    }
    if (STEPS[wizardStep] === "accessScope") {
      const selected = document.querySelector('input[name="wiz-scope"]:checked');
      const scope = selected ? selected.value : "host";
      const scopeResult = await api("/admin/setup/access-scope", { method: "POST", body: JSON.stringify({ scope }) });
      if (!scopeResult.ok) {
        showStepError("Could not save your access preference. Please try again.");
        return;
      }
      accessScope = scope;
    }
    await api("/admin/setup/step", { method: "POST", body: JSON.stringify({ step: STEPS[wizardStep] }) });
    wizardStep++;
    renderWizard();
    if (STEPS[wizardStep] === "healthCheck") setTimeout(wizHealthCheck, 100);
  }

  function wizardPrev() {
    wizardStep--;
    renderWizard();
    if (STEPS[wizardStep] === "healthCheck") setTimeout(wizHealthCheck, 100);
  }

  async function finishSetup() {
    clearStepError();

    // Save channel selections and configs to the backend
    await api("/admin/setup/channels", {
      method: "POST",
      body: JSON.stringify({ channels: enabledChannels, channelConfigs: channelConfigs })
    });

    for (const channel of enabledChannels) {
      await api("/admin/containers/up", { method: "POST", body: JSON.stringify({ service: channel }) });
    }
    await api("/admin/setup/step", { method: "POST", body: JSON.stringify({ step: STEPS[wizardStep] }) });
    await api("/admin/setup/complete", { method: "POST" });
    wizardStep = STEPS.length - 1;
    renderWizard();
    pollUntilReady();
  }

  async function pollUntilReady() {
    const el = document.getElementById("wiz-complete-status");
    if (!el) return;
    for (let i = 0; i < 120; i++) {
      const r = await api("/admin/setup/health-check");
      if (r.ok) {
        const services = Object.values(r.data.services || {});
        const allOk = services.every((s) => s && s.ok);
        if (allOk) {
          el.innerHTML = '<p>Everything is ready!</p><button onclick="window.openPalmSetup.continueToAdmin()">Continue to Admin</button>';
          return;
        }
      }
      el.innerHTML = '<p class="muted">Starting services... (' + (i + 1) + ')</p>';
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    el.innerHTML = '<p class="muted">Some services are still starting. You can continue anyway.</p><button class="secondary" onclick="window.openPalmSetup.continueToAdmin()">Continue to Admin</button>';
  }

  function continueToAdmin() {
    var ov = document.getElementById("setup-overlay");
    if (window.releaseFocus && ov) window.releaseFocus(ov);
    if (ov) ov.classList.add("hidden");
    showPage("dashboard");
  }

  function init(deps) {
    api = deps.api;
    esc = deps.esc;
    showPage = deps.showPage;
    getAdminToken = deps.getAdminToken;
    setAdminToken = deps.setAdminToken;
    ensureStyles();
  }

  window.openPalmSetup = { init, checkSetup, runSetup, wizardNext, wizardPrev, finishSetup, continueToAdmin, toggleChannelSection };
})();
