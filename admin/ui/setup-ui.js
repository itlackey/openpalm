(() => {
  let setupState = null;
  const STEPS = ["welcome", "accessScope", "serviceInstances", "healthCheck", "security", "channels", "extensions", "complete"];
  const STEP_TITLES = ["Welcome", "Access Scope", "Existing Service Instances", "Service Health", "Security Review", "Channels", "Extensions", "Complete Setup"];
  let wizardStep = 0;
  let accessScope = "host";
  let serviceInstances = { openmemory: "", psql: "", qdrant: "" };
  let openmemoryProvider = { openaiBaseUrl: "", openaiApiKeyConfigured: false };
  let enabledChannels = [];
  let api;
  let esc;
  let riskBadge;
  let showPage;
  let getAdminToken;
  let setAdminToken;

  function ensureStyles() {
    if (document.getElementById("setup-ui-style")) return;
    const style = document.createElement("style");
    style.id = "setup-ui-style";
    style.textContent = `
      .wizard-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100}
      .wizard{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2rem;max-width:640px;width:95%}
      .wizard h2{margin:0 0 .3rem}
      .wizard .steps{display:flex;gap:.5rem;margin:1rem 0}
      .wizard .step-dot{width:12px;height:12px;border-radius:50%;background:var(--border)}
      .wizard .step-dot.done{background:var(--green)}
      .wizard .step-dot.current{background:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.3)}
      .wizard .body{min-height:180px;margin:1rem 0}
      .wizard .actions{display:flex;gap:.5rem;justify-content:flex-end}
    `;
    document.head.appendChild(style);
  }

  async function checkSetup() {
    const r = await api("/admin/setup/status");
    if (!r.ok) return;
    setupState = r.data;
    accessScope = setupState.accessScope || "host";
    serviceInstances = setupState.serviceInstances || { openmemory: "", psql: "", qdrant: "" };
    openmemoryProvider = setupState.openmemoryProvider || { openaiBaseUrl: "", openaiApiKeyConfigured: false };
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
  }

  function wizardBody() {
    const adminToken = getAdminToken();
    switch (STEPS[wizardStep]) {
      case "welcome":
        return '<p>Welcome to <strong>OpenPalm</strong>, your self-hosted AI assistant platform.</p>'
          + '<p>This wizard will walk you through initial configuration:</p>'
          + '<ul><li>Verify core services are running</li><li>Review security settings</li><li>Choose channels to enable</li><li>Install starter extensions</li></ul>'
          + '<p class="muted" style="font-size:13px">During setup, choose whether access should be restricted to this host only or available across your LAN.</p>';
      case "healthCheck":
        return '<p>Checking core service health...</p><div id="wiz-health">Loading...</div>';
      case "accessScope":
        return '<p>Choose who can access this stack during normal operation.</p>'
          + '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">'
          + '<input type="radio" name="wiz-scope" value="host" ' + (accessScope === "host" ? "checked" : "") + ' style="width:auto;margin-top:4px" />'
          + '<div><strong>Host machine only</strong><div class="muted" style="font-size:13px">Tightest mode. Caddy and published service ports are restricted to localhost.</div></div>'
          + '</label>'
          + '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">'
          + '<input type="radio" name="wiz-scope" value="lan" ' + (accessScope === "lan" ? "checked" : "") + ' style="width:auto;margin-top:4px" />'
          + '<div><strong>LAN machines</strong><div class="muted" style="font-size:13px">Allow trusted machines on your local network to reach exposed stack endpoints.</div></div>'
          + '</label>';
      case "serviceInstances":
        return '<p>Optionally connect to existing service instances instead of bundled defaults.</p>'
          + '<div class="sec-box" style="border-color:var(--yellow);background:rgba(234,179,8,.1)"><strong>Warning:</strong> Changing these values after completing setup can break existing data access and workflows.</div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">OpenMemory base URL</label>'
          + '<input id="wiz-svc-openmemory" placeholder="http://openmemory:3000" value="' + esc(serviceInstances.openmemory || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Postgres connection URL</label>'
          + '<input id="wiz-svc-psql" placeholder="postgresql://user:pass@host:5432/db" value="' + esc(serviceInstances.psql || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Qdrant URL</label>'
          + '<input id="wiz-svc-qdrant" placeholder="http://qdrant:6333" value="' + esc(serviceInstances.qdrant || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">OpenAI-compatible endpoint for OpenMemory</label>'
          + '<input id="wiz-openmemory-openai-base" placeholder="https://api.openai.com/v1" value="' + esc(openmemoryProvider.openaiBaseUrl || "") + '" />'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">OpenAI-compatible API key for OpenMemory</label>'
          + '<input id="wiz-openmemory-openai-key" type="password" placeholder="sk-..." value="" />'
          + '<div class="muted" style="font-size:12px;margin-top:.2rem">' + (openmemoryProvider.openaiApiKeyConfigured ? "API key already configured. Leave blank to keep current key." : "Leave blank if OpenMemory should not use OpenAI-compatible model calls.") + '</div>';
      case "security":
        return '<p>OpenPalm uses defense in depth with multiple security layers:</p>'
          + '<div class="sec-box"><div class="sec-title">Authentication</div><div style="font-size:13px">Enter the admin password from your .env file to manage the platform.</div></div>'
          + '<label style="display:block;margin:.5rem 0 .2rem;font-size:13px">Admin Password (from .env)</label>'
          + '<input type="password" id="wiz-admin" value="' + esc(adminToken) + '" />'
          + '<div class="sec-box" style="margin-top:.7rem"><div class="sec-title">Other Protections Active</div>'
          + '<ul style="font-size:13px;margin:.2rem 0"><li>HMAC channel signatures</li><li>Tool firewall (safe/medium/high risk tiers)</li><li>Secret detection on memory writes</li><li>Rate limiting (120 req/min per user)</li><li>LAN-only admin access via Caddy</li></ul></div>';
      case "channels":
        return '<p>Choose which channels to enable. Channels are adapters; all messages pass through the gateway for security.</p>' + channelCheckboxes();
      case "extensions":
        return '<p>Recommended starter extensions:</p>' + starterExtensions();
      case "complete":
        return '<p>Finalizing setup and waiting for containers to come online...</p><div id="wiz-complete-status">Loading...</div>';
    }
    return "";
  }

  function channelCheckboxes() {
    const chs = [
      { id: "channel-chat", name: "Chat (HTTP)", desc: "Web chat widget / custom frontend" },
      { id: "channel-discord", name: "Discord", desc: "Discord bot (requires DISCORD_BOT_TOKEN in .env)" },
      { id: "channel-voice", name: "Voice", desc: "Speech-to-text adapter" },
      { id: "channel-telegram", name: "Telegram", desc: "Telegram bot (requires TELEGRAM_BOT_TOKEN in .env)" }
    ];
    let h = "";
    for (const c of chs) {
      h += '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">';
      h += '<input type="checkbox" class="wiz-ch" value="' + c.id + '" ' + (enabledChannels.includes(c.id) ? "checked" : "") + ' style="width:auto;margin-top:4px" />';
      h += '<div><strong>' + c.name + '</strong><div class="muted" style="font-size:13px">' + c.desc + '</div></div>';
      h += "</label>";
    }
    return h;
  }

  function starterExtensions() {
    const starters = [
      { id: "plugin-policy-telemetry", name: "Policy & Telemetry", risk: "low", desc: "Built-in: blocks secrets, logs tool calls" },
      { id: "skill-recall-first", name: "Recall First", risk: "low", desc: "Always check memory before answering" },
      { id: "skill-memory-policy", name: "Memory Policy", risk: "low", desc: "Governs when and how to store memory" },
      { id: "skill-action-gating", name: "Action Gating", risk: "low", desc: "Require approval for risky actions" }
    ];
    let h = "";
    for (const s of starters) {
      h += '<label class="card" style="display:flex;gap:.7rem;align-items:start;cursor:pointer">';
      h += '<input type="checkbox" class="wiz-ext" value="' + s.id + '" checked style="width:auto;margin-top:4px" />';
      h += '<div><strong>' + s.name + '</strong> ' + riskBadge(s.risk);
      h += '<div class="muted" style="font-size:13px">' + s.desc + '</div></div>';
      h += "</label>";
    }
    return h;
  }

  async function wizHealthCheck() {
    const r = await api("/admin/setup/health-check");
    const el = document.getElementById("wiz-health");
    if (!el) return;
    if (!r.ok) { el.textContent = "Could not reach admin API."; return; }
    let h = "";
    for (const [name, info] of Object.entries(r.data.services)) {
      h += '<div style="margin:.3rem 0"><span class="dot ' + (info.ok ? "dot-ok" : "dot-err") + '"></span><strong>' + esc(name) + '</strong> — ' + (info.ok ? "Healthy" : esc(info.error || "Unreachable")) + '</div>';
    }
    el.innerHTML = h;
  }

  async function wizardNext() {
    if (STEPS[wizardStep] === "accessScope") {
      const selected = document.querySelector('input[name="wiz-scope"]:checked');
      const scope = selected ? selected.value : "host";
      const scopeResult = await api("/admin/setup/access-scope", { method: "POST", body: JSON.stringify({ scope }) });
      if (!scopeResult.ok) {
        alert("Could not apply access scope.");
        return;
      }
      accessScope = scope;
    }
    if (STEPS[wizardStep] === "security") {
      const a = document.getElementById("wiz-admin");
      if (a) setAdminToken(a.value);
    }
    if (STEPS[wizardStep] === "serviceInstances") {
      const openmemory = document.getElementById("wiz-svc-openmemory")?.value || "";
      const psql = document.getElementById("wiz-svc-psql")?.value || "";
      const qdrant = document.getElementById("wiz-svc-qdrant")?.value || "";
      const openaiBaseUrl = document.getElementById("wiz-openmemory-openai-base")?.value || "";
      const openaiApiKey = document.getElementById("wiz-openmemory-openai-key")?.value || "";
      const servicePayload = { openmemory, psql, qdrant, openaiBaseUrl };
      if (openaiApiKey.trim()) servicePayload.openaiApiKey = openaiApiKey.trim();
      const serviceResult = await api("/admin/setup/service-instances", {
        method: "POST",
        body: JSON.stringify(servicePayload)
      });
      if (!serviceResult.ok) {
        alert("Could not save service instance settings.");
        return;
      }
      serviceInstances = serviceResult.data?.state?.serviceInstances || { openmemory, psql, qdrant };
      openmemoryProvider = serviceResult.data?.openmemoryProvider || openmemoryProvider;
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
    const chs = Array.from(document.querySelectorAll(".wiz-ch:checked")).map((c) => c.value);
    const channelsResult = await api("/admin/setup/channels", { method: "POST", body: JSON.stringify({ channels: chs }) });
    if (!channelsResult.ok) {
      alert("Could not save channel selection.");
      return;
    }
    enabledChannels = channelsResult.data?.state?.enabledChannels || [];

    const boxes = document.querySelectorAll(".wiz-ext:checked");
    for (const b of boxes) {
      await api("/admin/gallery/install", { method: "POST", body: JSON.stringify({ galleryId: b.value }) });
    }
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
          el.innerHTML = '<p>All core containers are online.</p><button onclick="window.openPalmSetup.continueToAdmin()">Continue to Admin</button>';
          return;
        }
      }
      el.innerHTML = '<p class="muted">Waiting for containers... (' + (i + 1) + ')</p>';
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    el.innerHTML = '<p class="muted">Some containers are still starting. You can continue and monitor Services.</p><button class="secondary" onclick="window.openPalmSetup.continueToAdmin()">Continue to Admin</button>';
  }

  function continueToAdmin() {
    document.getElementById("setup-overlay")?.classList.add("hidden");
    showPage("gallery");
  }

  function init(deps) {
    api = deps.api;
    esc = deps.esc;
    riskBadge = deps.riskBadge;
    showPage = deps.showPage;
    getAdminToken = deps.getAdminToken;
    setAdminToken = deps.setAdminToken;
    ensureStyles();
  }

  window.openPalmSetup = { init, checkSetup, runSetup, wizardNext, wizardPrev, finishSetup, continueToAdmin };
})();
