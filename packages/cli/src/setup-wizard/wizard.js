/**
 * OpenPalm Setup Wizard — Entry Point
 *
 * Wires together state, validators, renderers, API calls, and event handlers.
 * This file is concatenated with wizard-state.js, wizard-validators.js, and
 * wizard-renderers.js into a single IIFE by server.ts.
 *
 * API contract:
 *   GET  /api/setup/status           -> { ok, setupComplete }
 *   GET  /api/setup/detect-providers  -> { ok, providers: [{ provider, url, available }] }
 *   POST /api/setup/models/:provider  { apiKey, baseUrl } -> { ok, models: [...] }
 *   POST /api/setup/complete          -> { ok, error? }
 *   GET  /api/setup/deploy-status     -> { ok, setupComplete, deployStatus, deployError }
 */

/* =========================================================================
   OpenCode Provider Discovery
   ========================================================================= */

async function checkOpenCodeAndInit() {
  try {
    var res = await fetch("/api/setup/opencode/status");
    if (res.ok) {
      var data = await res.json();
      if (data.available) {
        opencodeAvailable = true;
        await loadOpenCodeProviders();
      }
    }
  } catch (e) {
    // fall back to hardcoded providers
  }
  renderProviderGrid();
}

async function loadOpenCodeProviders() {
  var res = await fetch("/api/setup/opencode/providers");
  if (!res.ok) return;
  var data = await res.json();
  if (!data.available || !Array.isArray(data.providers)) return;
  opencodeProviders = data.providers;
  opencodeAuth = data.auth || {};

  // Ensure local providers are in the list (they aren't in OpenCode's cloud registry)
  var existingIds = {};
  opencodeProviders.forEach(function (p) { existingIds[p.id] = true; });
  LOCAL_PROVIDERS.forEach(function (lp) {
    if (!existingIds[lp.id]) opencodeProviders.push(lp);
  });

  // Initialize providerState for each provider
  opencodeProviders.forEach(function (ocp) {
    if (!providerState[ocp.id]) {
      providerState[ocp.id] = {
        selected: false, verified: false, verifying: false, error: false,
        apiKey: "", baseUrl: ocp.localUrl || "", models: [], ollamaMode: null,
      };
    }
    // Pre-populate model list from OpenCode provider data
    var modelIds = Object.keys(ocp.models || {});
    if (modelIds.length > 0 && providerState[ocp.id].models.length === 0) {
      providerState[ocp.id].models = modelIds;
    }
  });
}

/* =========================================================================
   OpenCode Auth Flows
   ========================================================================= */

async function connectOpenCodeApiKey(providerId) {
  var st = providerState[providerId];
  if (!st || !st.apiKey) return;

  st.verifying = true;
  st.error = false;
  renderOpenCodeProviderGrid();

  try {
    var res = await fetch("/api/setup/opencode/auth/" + encodeURIComponent(providerId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key: st.apiKey }),
    });
    if (!res.ok) {
      var data = await res.json().catch(function () { return {}; });
      throw new Error(data.message || "Failed to connect (HTTP " + res.status + ")");
    }
    st.verified = true;
    st.error = false;
  } catch (e) {
    st.verified = false;
    st.error = true;
    st.errorMessage = e.message || "Connection failed";
  }

  st.verifying = false;
  renderOpenCodeProviderGrid();
}

async function startOpenCodeOAuth(providerId, methodIndex) {
  var st = providerState[providerId];
  if (!st) return;

  st.verifying = true;
  st.error = false;
  renderOpenCodeProviderGrid();

  try {
    var res = await fetch("/api/setup/opencode/provider/" + encodeURIComponent(providerId) + "/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: methodIndex }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.message || "OAuth failed");

    st.oauthPolling = true;
    st.oauthUrl = data.url || "";
    st.oauthInstructions = data.instructions || "";
    renderOpenCodeProviderGrid();

    // Open auth URL automatically
    if (data.url && data.method === "auto") {
      window.open(data.url, "_blank");
    }

    // Poll for completion
    await pollOpenCodeOAuth(providerId, methodIndex);
  } catch (e) {
    st.verifying = false;
    st.error = true;
    st.errorMessage = e.message || "OAuth failed";
    st.oauthPolling = false;
    renderOpenCodeProviderGrid();
  }
}

async function pollOpenCodeOAuth(providerId, methodIndex) {
  var st = providerState[providerId];
  for (var i = 0; i < 120 && st.oauthPolling; i++) {
    await new Promise(function (r) { setTimeout(r, 5000); });
    if (!st.oauthPolling) break;

    try {
      var res = await fetch("/api/setup/opencode/provider/" + encodeURIComponent(providerId) + "/oauth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: methodIndex }),
      });
      var data = await res.json().catch(function () { return null; });
      if (res.ok && data) {
        // OAuth complete — provider is now authed
        st.verified = true;
        st.error = false;
        st.oauthPolling = false;
        st.verifying = false;
        renderOpenCodeProviderGrid();
        return;
      }
    } catch (e) {
      // retry
    }
  }

  if (st.oauthPolling) {
    st.oauthPolling = false;
    st.verifying = false;
    st.error = true;
    st.errorMessage = "Authorization timed out";
    renderOpenCodeProviderGrid();
  }
}

/* =========================================================================
   Provider Verification (Fallback Mode)
   ========================================================================= */

async function verifyProvider(id) {
  var p = PROVIDERS.find(function (x) { return x.id === id; });
  if (!p) return;
  var st = providerState[id];

  // For ollama instack mode, just mark verified
  if (id === "ollama" && st.ollamaMode === "instack") {
    st.verified = true;
    st.error = false;
    renderProviderGrid();
    return;
  }

  // Bump generation so any in-flight verify for this provider is ignored
  var gen = (verifyGeneration[id] || 0) + 1;
  verifyGeneration[id] = gen;

  st.verifying = true;
  st.error = false;
  renderProviderGrid();

  var baseUrl = st.baseUrl || p.baseUrl;
  var apiKey = st.apiKey || "";

  try {
    var result = await apiFetchModels(id, baseUrl, apiKey);
    // Discard if a newer verify was started while we were waiting
    if (verifyGeneration[id] !== gen) return;
    st.verified = true;
    st.error = false;
    st.models = result.models || [];
  } catch (e) {
    if (verifyGeneration[id] !== gen) return;
    st.verified = false;
    st.error = true;
    st.errorMessage = e.message || "";
    st.models = [];
  }

  st.verifying = false;
  renderProviderGrid();
}

/* =========================================================================
   API Calls
   ========================================================================= */

async function detectProviders() {
  show($("conn-detecting"));
  try {
    var res = await fetch("/api/setup/detect-providers");
    if (res.ok) {
      var data = await res.json();
      detectedProviders = data.providers || [];

      detectedProviders.forEach(function (dp) {
        if (!dp.available) return;
        var st = providerState[dp.provider];
        if (st) {
          st.baseUrl = dp.url;
          if (!opencodeAvailable) {
            // Fallback mode: auto-select
            if (!st.selected) {
              st.selected = true;
              if (dp.provider === "ollama") st.ollamaMode = "running";
            }
          }
          // Always fetch models for detected providers (both modes need them)
          verifyProvider(dp.provider);
        }
      });
    }
  } catch (e) {
    detectedProviders = [];
  }
  hide($("conn-detecting"));
  renderProviderGrid();
}

async function apiFetchModels(provider, baseUrl, apiKey) {
  var url = "/api/setup/models/" + encodeURIComponent(provider);
  var res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: apiKey || "", baseUrl: baseUrl || "" }),
  });
  var data = await res.json();
  if (!res.ok || data.status === "recoverable_error") {
    throw new Error(data.error || "Failed to fetch models (HTTP " + res.status + ")");
  }
  return data;
}

/* =========================================================================
   Payload Building
   ========================================================================= */

function buildChannelsConfig() {
  var result = {};
  CHANNELS.forEach(function (ch) {
    var sel = channelSelection[ch.id];
    if (ch.locked) {
      result[ch.id] = true;
    } else if (typeof sel === "object" && sel !== null) {
      if (sel.enabled) {
        // Include credentials (copy enabled + credential fields)
        var entry = { enabled: true };
        if (ch.credentials) {
          ch.credentials.forEach(function (cred) {
            if (sel[cred.key]) entry[cred.key] = sel[cred.key];
          });
        }
        result[ch.id] = entry;
      }
    } else if (sel) {
      result[ch.id] = true;
    }
  });
  return result;
}

function buildPayload() {
  var adminToken = ($("admin-token").value || "").trim();
  var ownerName = ($("owner-name").value || "").trim();
  var ownerEmail = ($("owner-email").value || "").trim();
  var memoryUserId = ($("memory-user-id").value || "").trim() || (ownerName ? ownerName.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") : "") || "default_user";
  var ollamaEnabled = $("ollama-enabled") ? $("ollama-enabled").checked : false;

  var llm = modelSelection.llm;
  var emb = modelSelection.embedding;
  var small = modelSelection.small;

  // Build connections: only include providers needed for system capabilities
  // (LLM, embedding, SLM). Other provider keys were already written to
  // auth.json via OpenCode during Step 1 verification.
  var capabilityProviderIds = {};
  if (llm) capabilityProviderIds[llm.connId] = true;
  if (emb) capabilityProviderIds[emb.connId] = true;
  if (small && small.model) capabilityProviderIds[small.connId] = true;

  var connections = getVerifiedProviders()
    .filter(function (p) { return capabilityProviderIds[p.id]; })
    .map(function (p) {
      var st = providerState[p.id];
      return {
        id: p.id,
        name: p.name,
        provider: p.id,
        baseUrl: st.baseUrl || p.baseUrl,
        apiKey: st.apiKey || "",
      };
    });

  // Resolve LLM and embeddings connection providers
  var llmConnId = llm ? llm.connId : "";
  var embConnId = emb ? emb.connId : "";
  var llmConn = connections.find(function (c) { return c.id === llmConnId; });
  var embConn = connections.find(function (c) { return c.id === embConnId; });
  var llmProvider = llmConn ? llmConn.provider : "";
  var embProvider = embConn ? embConn.provider : "";

  // Build addons from channels and services
  var addons = {};
  if (ollamaEnabled) addons.ollama = true;
  if (serviceSelection.admin) addons.admin = true;
  if (serviceSelection.openviking) addons.openviking = true;

  // Add channel addons and extract channel credentials
  var channelCredentials = {};
  var channelsConfig = buildChannelsConfig();
  for (var chId in channelsConfig) {
    var chVal = channelsConfig[chId];
    if (chVal === true) {
      addons[chId] = true;
    } else if (typeof chVal === "object" && chVal !== null) {
      addons[chId] = true;
      // Extract credentials (all fields except 'enabled')
      var creds = {};
      for (var key in chVal) {
        if (key !== "enabled" && chVal[key]) {
          creds[key] = typeof chVal[key] === "boolean" ? String(chVal[key]) : chVal[key];
        }
      }
      if (Object.keys(creds).length > 0) {
        channelCredentials[chId] = creds;
      }
    }
  }

  // Build SetupSpec payload
  var payload = {
    spec: {
      version: 2,
      capabilities: {
        llm: llmProvider + "/" + (llm ? llm.model : ""),
        embeddings: {
          provider: embProvider,
          model: emb ? emb.model : "",
          dims: emb ? (emb.dims || 1536) : 1536,
        },
        memory: {
          userId: memoryUserId,
          customInstructions: "",
        },
      },
      addons: addons,
    },
    security: { adminToken: adminToken },
    connections: connections,
  };

  // Add optional slm capability (uses its own provider, not the LLM provider)
  if (small && small.model) {
    payload.spec.capabilities.slm = small.connId + "/" + small.model;
  }

  // Add owner if provided
  if (ownerName || ownerEmail) {
    payload.owner = { name: ownerName || undefined, email: ownerEmail || undefined };
  }

  // Add channel credentials if any
  if (Object.keys(channelCredentials).length > 0) {
    payload.channelCredentials = channelCredentials;
  }

  return payload;
}

/* =========================================================================
   Install & Deploy
   ========================================================================= */

async function handleInstall() {
  if (installing) return;

  var errEl = $("install-error");
  hideError(errEl);

  var payload = buildPayload();

  installing = true;
  var installBtn = $("btn-install");
  installBtn.disabled = true;
  installBtn.innerHTML = '<span class="spinner"></span> Installing...';

  try {
    var res = await fetch("/api/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await res.json();

    if (!res.ok || !data.ok) {
      showError(errEl, data.error || data.message || "Install failed.");
      installing = false;
      installBtn.disabled = false;
      installBtn.textContent = "Install";
      return;
    }

    showDeployScreen();
    startDeployPolling();
  } catch (e) {
    showError(errEl, "Network error: " + (e.message || "unable to reach server."));
    installing = false;
    installBtn.disabled = false;
    installBtn.textContent = "Install";
  }
}

function startDeployPolling() {
  stopDeployPolling();
  pollDeployStatus();
  deployTimer = setInterval(pollDeployStatus, 2500);
}

function stopDeployPolling() {
  if (deployTimer) { clearInterval(deployTimer); deployTimer = null; }
}

async function pollDeployStatus() {
  try {
    var res = await fetch("/api/setup/deploy-status");
    if (!res.ok) return;
    var data = await res.json();
    deployPollErrors = 0;

    updateDeployUI(data);

    if (data.deployError) {
      stopDeployPolling();
      showDeployError(data.deployError);
    } else if (data.setupComplete && data.deployStatus && data.deployStatus.length > 0) {
      var allRunning = data.deployStatus.every(function (s) { return s.status === "running"; });
      if (allRunning) {
        stopDeployPolling();
        showDeployDone(data);
      }
    } else if (data.setupComplete && (!data.deployStatus || data.deployStatus.length === 0)) {
      // Setup complete but no deployment started (--no-start mode)
      stopDeployPolling();
      showDeployDone({ deployStatus: [] });
    }
  } catch (e) {
    deployPollErrors++;
    if (deployPollErrors >= 3) {
      // Server is gone — setup completed without deployment (--no-start)
      stopDeployPolling();
      showDeployDone({ deployStatus: [] });
    }
  }
}

/* =========================================================================
   Event Binding (Entry Point)
   ========================================================================= */

document.addEventListener("DOMContentLoaded", function () {
  // Generate initial admin token
  initStep0();

  // Check setup status first
  fetch("/api/setup/status")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.setupComplete) {
        window.location.href = "/";
      }
    })
    .catch(function () { /* ignore */ });

  // Start provider discovery + local detection early (don't wait for step 1)
  checkOpenCodeAndInit().then(function () {
    detectProviders();
  });

  // ── Step 0: Welcome ──
  $("btn-get-started").addEventListener("click", function () {
    welcomeHeroDismissed = true;
    hide($("welcome-hero"));
    show($("identity-form"));
  });

  $("btn-step0-next").addEventListener("click", function () {
    if (validateStep0()) goToStep(1);
  });

  // ── Step 1: Providers ──
  $("btn-step1-back").addEventListener("click", function () { goToStep(0); });
  $("btn-step1-next").addEventListener("click", function () {
    if (getVerifiedCount() > 0) goToStep(2);
  });

  // ── Step 2: Models ──
  $("btn-step2-back").addEventListener("click", function () { goToStep(1); });
  $("btn-step2-next").addEventListener("click", function () {
    if (validateStep2()) goToStep(3);
  });

  // ── Step 3: Voice ──
  $("btn-step3-back").addEventListener("click", function () { goToStep(2); });
  $("btn-step3-next").addEventListener("click", function () { goToStep(4); });

  // ── Step 4: Options ──
  $("btn-step4-back").addEventListener("click", function () { goToStep(3); });
  $("btn-step4-next").addEventListener("click", function () {
    if (validateStep4()) goToStep(5);
  });

  // ── Step 5: Review ──
  $("btn-step5-back").addEventListener("click", function () { goToStep(4); });
  $("btn-install").addEventListener("click", function () { handleInstall(); });

  // ── JSON toggle ──
  $("btn-toggle-json").addEventListener("click", function () {
    var jsonEl = $("review-json");
    var btn = $("btn-toggle-json");
    if (jsonEl.classList.contains("hidden")) {
      show(jsonEl);
      btn.textContent = "Hide Setup JSON";
    } else {
      hide(jsonEl);
      btn.textContent = "Show Setup JSON";
    }
  });

  // ── Deploy error actions ──
  $("btn-deploy-back").addEventListener("click", function () {
    installing = false;
    goToStep(5);
  });
  $("btn-deploy-retry").addEventListener("click", function () {
    installing = false;
    hide($("deploy-failure"));
    hide($("deploy-error-actions"));
    show($("deploy-tips"));
    $("deploy-progress-value").classList.remove("deploy-progress-value--error");
    $("deploy-progress-value").textContent = "0%";
    $("deploy-progress-fill").style.width = "0%";
    handleInstall();
  });

  // Start on step 0
  renderProgressBar();
});
