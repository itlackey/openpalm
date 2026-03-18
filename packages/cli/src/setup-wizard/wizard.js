/**
 * OpenPalm Setup Wizard — Vanilla JS
 *
 * Self-contained wizard logic for the CLI-hosted setup flow.
 * No frameworks, no build step. Works with the pre-rendered HTML in index.html.
 *
 * API contract:
 *   GET  /api/setup/status           -> { ok, setupComplete }
 *   GET  /api/setup/detect-providers  -> { ok, providers: [{ provider, url, available }] }
 *   POST /api/setup/models/:provider  { apiKey, baseUrl } -> { ok, models: [...] }
 *   POST /api/setup/complete          -> { ok, error? }
 *   GET  /api/setup/deploy-status     -> { ok, setupComplete, deployStatus, deployError }
 */
(function () {
  "use strict";

  /* =========================================================================
     Provider Constants & Defaults
     ========================================================================= */

  const PROVIDER_DEFAULTS = {
    openai:          { baseUrl: "https://api.openai.com",       llmModel: "gpt-4o",                                   embModel: "text-embedding-3-small",  embDims: 1536 },
    anthropic:       { baseUrl: "https://api.anthropic.com",    llmModel: "claude-sonnet-4-20250514",                  embModel: "",                        embDims: 0 },
    groq:            { baseUrl: "https://api.groq.com/openai",  llmModel: "llama-3.3-70b-versatile",                   embModel: "",                        embDims: 0 },
    together:        { baseUrl: "https://api.together.xyz",     llmModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",   embModel: "",                        embDims: 0 },
    mistral:         { baseUrl: "https://api.mistral.ai",       llmModel: "mistral-large-latest",                      embModel: "mistral-embed",           embDims: 1024 },
    deepseek:        { baseUrl: "https://api.deepseek.com",     llmModel: "deepseek-chat",                             embModel: "",                        embDims: 0 },
    xai:             { baseUrl: "https://api.x.ai",             llmModel: "grok-2",                                    embModel: "",                        embDims: 0 },
    ollama:          { baseUrl: "http://localhost:11434",        llmModel: "llama3.2",                                  embModel: "nomic-embed-text",        embDims: 768 },
    "model-runner":  { baseUrl: "http://localhost:12434",        llmModel: "ai/llama3.2",                               embModel: "ai/mxbai-embed-large-v1", embDims: 1024 },
    lmstudio:        { baseUrl: "http://localhost:1234",         llmModel: "loaded-model",                              embModel: "",                        embDims: 0 },
  };

  const PROVIDER_LABELS = {
    openai: "OpenAI", anthropic: "Anthropic", groq: "Groq",
    together: "Together AI", mistral: "Mistral", deepseek: "DeepSeek",
    xai: "xAI (Grok)", ollama: "Ollama", "model-runner": "Docker Model Runner",
    lmstudio: "LM Studio", "ollama-instack": "Ollama (in-stack)",
  };

  var CLOUD_PROVIDERS = ["openai", "anthropic", "groq", "together", "mistral", "deepseek", "xai"];
  var LOCAL_PROVIDERS  = ["ollama", "model-runner", "lmstudio"];

  /** Known embedding dimensions for auto-fill */
  var KNOWN_EMB_DIMS = {
    "text-embedding-3-small": 1536, "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536, "nomic-embed-text": 768,
    "mxbai-embed-large": 1024, "mxbai-embed-large-v1": 1024,
    "ai/mxbai-embed-large-v1": 1024, "mistral-embed": 1024,
    "all-minilm": 384, "snowflake-arctic-embed": 1024,
  };

  /* =========================================================================
     DOM Helpers
     ========================================================================= */

  function $(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return document.querySelectorAll(sel); }
  function show(el) { if (el) el.classList.remove("hidden"); }
  function hide(el) { if (el) el.classList.add("hidden"); }
  function showError(el, msg) { if (el) { el.textContent = msg; show(el); } }
  function hideError(el) { if (el) { el.textContent = ""; hide(el); } }

  /* =========================================================================
     Wizard State
     ========================================================================= */

  var currentStep = 0;
  var maxVisitedStep = 0;

  /** @type {Array<{id:string, name:string, provider:string, baseUrl:string, apiKey:string, kind:string, models:string[]}>} */
  var connections = [];

  /** Provider detection results from /api/setup/detect-providers */
  var detectedProviders = [];

  /** Model lists fetched per connection id */
  var modelCache = {};

  /** Currently editing connection index (-1 = not editing) */
  var editingIdx = -1;

  /** Sub-view state for step 1: "hub" | "chooser" | "form" */
  var connView = "hub";

  /** Draft connection kind while adding: "cloud" | "local" */
  var draftKind = "cloud";

  /** Draft connection provider while in form */
  var draftProvider = "openai";

  /** Deploy polling timer */
  var deployTimer = null;

  /** Whether install is in progress */
  var installing = false;

  /* =========================================================================
     Token Generation
     ========================================================================= */

  function generateToken() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  /* =========================================================================
     Step Navigation
     ========================================================================= */

  var TOTAL_STEPS = 5; // 0..4

  function goToStep(n) {
    if (n < 0 || n > TOTAL_STEPS - 1) return;
    // Hide all step sections
    for (var i = 0; i < TOTAL_STEPS; i++) {
      var sec = $("step-" + i);
      if (sec) { if (i === n) show(sec); else hide(sec); }
    }
    hide($("step-deploy"));

    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;
    updateStepIndicators();

    // Step-specific init
    if (n === 1) initStep1();
    if (n === 2) initStep2();
    if (n === 3) initStep3();
    if (n === 4) initStep4();
  }

  function showDeployScreen() {
    for (var i = 0; i < TOTAL_STEPS; i++) hide($("step-" + i));
    show($("step-deploy"));
    hide($("step-indicators"));
  }

  function updateStepIndicators() {
    show($("step-indicators"));
    var dots = qsa(".step-dot");
    var lines = qsa(".step-line");
    dots.forEach(function (dot, i) {
      dot.classList.remove("active", "completed");
      dot.removeAttribute("aria-current");
      if (i === currentStep) {
        dot.classList.add("active");
        dot.setAttribute("aria-current", "step");
        dot.innerHTML = String(i + 1);
      } else if (i < maxVisitedStep || (i <= maxVisitedStep && i < currentStep)) {
        dot.classList.add("completed");
        dot.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        dot.disabled = false;
      } else {
        dot.innerHTML = String(i + 1);
        dot.disabled = (i > maxVisitedStep);
      }
    });
    lines.forEach(function (line, i) {
      if (i < maxVisitedStep) line.classList.add("active");
      else line.classList.remove("active");
    });
  }

  /* =========================================================================
     Step 0: Welcome & Admin Token
     ========================================================================= */

  function initStep0() {
    var tokenInput = $("admin-token");
    if (tokenInput && !tokenInput.value) {
      tokenInput.value = generateToken();
    }
  }

  function validateStep0() {
    var errEl = $("step0-error");
    hideError(errEl);
    var token = ($("admin-token").value || "").trim();
    if (token.length < 8) {
      showError(errEl, "Admin token must be at least 8 characters.");
      return false;
    }
    return true;
  }

  /* =========================================================================
     Step 1: Connection Setup
     ========================================================================= */

  function initStep1() {
    renderConnHub();
    setConnView("hub");
    // Auto-detect on first visit
    if (detectedProviders.length === 0 && connections.length === 0) {
      detectProviders();
    }
  }

  function setConnView(view) {
    connView = view;
    var hubList = $("conn-hub-list");
    var hubEmpty = $("conn-hub-empty");
    var chooser = $("conn-type-chooser");
    var form = $("conn-detail-form");
    var actions = $("step1-actions");

    hide(hubList); hide(hubEmpty); hide(chooser); hide(form); hide(actions);

    if (view === "hub") {
      if (connections.length > 0) { show(hubList); } else { show(hubEmpty); }
      show(actions);
      $("btn-step1-next").disabled = connections.length === 0;
    } else if (view === "chooser") {
      show(chooser);
    } else if (view === "form") {
      show(form);
    }
  }

  function renderConnHub() {
    var list = $("conn-hub-list");
    list.innerHTML = "";
    connections.forEach(function (conn, i) {
      var li = document.createElement("li");
      li.className = "hub-row";
      li.innerHTML =
        '<div class="hub-row-info">' +
          '<span class="hub-row-name">' + esc(conn.name || conn.provider) + "</span>" +
          '<span class="hub-row-badge">' + (conn.kind === "local" ? "Local" : "Cloud") + "</span>" +
          '<span class="hub-row-url">' + esc(conn.baseUrl) + "</span>" +
        "</div>" +
        '<div class="hub-row-actions">' +
          '<button class="hub-action" data-action="edit" data-idx="' + i + '">Edit</button>' +
          '<button class="hub-action hub-action--danger" data-action="remove" data-idx="' + i + '">Remove</button>' +
        "</div>";
      list.appendChild(li);
    });
  }

  function openAddConnection() {
    editingIdx = -1;
    setConnView("chooser");
  }

  function openConnectionForm(kind) {
    draftKind = kind;
    if (editingIdx >= 0) {
      var conn = connections[editingIdx];
      draftProvider = conn.provider;
      draftKind = conn.kind;
    } else {
      draftProvider = kind === "cloud" ? "openai" : "ollama";
    }
    renderConnectionForm();
    setConnView("form");
  }

  function renderConnectionForm() {
    var modeCard = $("conn-mode-card");
    var badge = $("conn-mode-badge");
    var title = $("conn-mode-title");
    var cloudPicks = $("cloud-provider-picks");
    var localList = $("local-provider-list");
    var apikeyGroup = $("conn-apikey-group");

    // Mode card styling
    modeCard.className = "connection-mode-card connection-mode-card--" + draftKind;
    if (draftKind === "cloud") {
      badge.textContent = "Cloud";
      title.textContent = "Remote provider";
      show(cloudPicks);
      hide(localList);
      show(apikeyGroup);
    } else {
      badge.textContent = "Local";
      title.textContent = "Local provider";
      hide(cloudPicks);
      show(localList);
      hide(apikeyGroup);
    }

    // Cloud provider chips
    cloudPicks.innerHTML = "";
    CLOUD_PROVIDERS.forEach(function (p) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "provider-chip" + (p === draftProvider ? " selected" : "");
      chip.textContent = PROVIDER_LABELS[p] || p;
      chip.addEventListener("click", function () {
        draftProvider = p;
        applyProviderDefaults();
        renderConnectionForm();
      });
      cloudPicks.appendChild(chip);
    });

    // Local detected providers
    localList.innerHTML = "";
    var localDetected = detectedProviders.filter(function (d) { return d.available; });
    if (localDetected.length > 0) {
      localDetected.forEach(function (dp) {
        var opt = document.createElement("button");
        opt.type = "button";
        opt.className = "provider-option" + (dp.provider === draftProvider ? " selected" : "");
        opt.innerHTML =
          '<span class="provider-option-status"><span class="status-dot--ok"></span></span>' +
          '<span class="provider-option-label">' + esc(PROVIDER_LABELS[dp.provider] || dp.provider) + "</span>" +
          '<span class="provider-option-hint">Detected at ' + esc(dp.url) + "</span>";
        opt.addEventListener("click", function () {
          draftProvider = dp.provider;
          $("conn-base-url").value = dp.url;
          $("conn-name").value = PROVIDER_LABELS[dp.provider] || dp.provider;
          renderConnectionForm();
        });
        localList.appendChild(opt);
      });
    } else {
      // Fallback: let user pick local provider
      LOCAL_PROVIDERS.forEach(function (p) {
        var opt = document.createElement("button");
        opt.type = "button";
        opt.className = "provider-option" + (p === draftProvider ? " selected" : "");
        opt.innerHTML =
          '<span class="provider-option-label">' + esc(PROVIDER_LABELS[p] || p) + "</span>";
        opt.addEventListener("click", function () {
          draftProvider = p;
          applyProviderDefaults();
          renderConnectionForm();
        });
        localList.appendChild(opt);
      });
    }

    // Fill defaults if new connection
    if (editingIdx < 0) {
      applyProviderDefaults();
    } else {
      var c = connections[editingIdx];
      $("conn-name").value = c.name;
      $("conn-base-url").value = c.baseUrl;
      $("conn-api-key").value = c.apiKey;
    }

    // Reset test status
    hide($("conn-test-success"));
    hideError($("conn-detail-error"));
  }

  function applyProviderDefaults() {
    var def = PROVIDER_DEFAULTS[draftProvider];
    if (!def) return;
    var nameInput = $("conn-name");
    var urlInput = $("conn-base-url");
    if (!nameInput.value || isDefaultName(nameInput.value)) {
      nameInput.value = PROVIDER_LABELS[draftProvider] || draftProvider;
    }
    urlInput.value = def.baseUrl;
    $("conn-api-key").value = "";
  }

  function isDefaultName(name) {
    for (var key in PROVIDER_LABELS) {
      if (PROVIDER_LABELS[key] === name) return true;
    }
    return false;
  }

  function saveConnection() {
    var errEl = $("conn-detail-error");
    hideError(errEl);

    var name = ($("conn-name").value || "").trim();
    var baseUrl = ($("conn-base-url").value || "").trim();
    var apiKey = ($("conn-api-key").value || "").trim();

    if (!name) { showError(errEl, "Connection name is required."); return; }
    if (!baseUrl) { showError(errEl, "Base URL is required."); return; }
    if (draftKind === "cloud" && !apiKey && draftProvider !== "anthropic") {
      showError(errEl, "API key is required for cloud providers.");
      return;
    }

    var conn = {
      id: editingIdx >= 0 ? connections[editingIdx].id : generateId(),
      name: name,
      provider: draftProvider,
      baseUrl: baseUrl,
      apiKey: apiKey,
      kind: draftKind,
      models: editingIdx >= 0 ? connections[editingIdx].models : [],
    };

    if (editingIdx >= 0) {
      connections[editingIdx] = conn;
    } else {
      connections.push(conn);
      // Transfer draft model cache to the saved connection
      if (modelCache["_draft"]) {
        conn.models = modelCache["_draft"];
        modelCache[conn.id] = modelCache["_draft"];
        delete modelCache["_draft"];
      }
    }

    editingIdx = -1;
    renderConnHub();
    setConnView("hub");
  }

  function removeConnection(idx) {
    connections.splice(idx, 1);
    renderConnHub();
    setConnView("hub");
  }

  function editConnectionAt(idx) {
    editingIdx = idx;
    var conn = connections[idx];
    draftKind = conn.kind;
    draftProvider = conn.provider;
    renderConnectionForm();
    setConnView("form");
  }

  /** Test connection by fetching models */
  async function testConnection() {
    var errEl = $("conn-detail-error");
    hideError(errEl);
    hide($("conn-test-success"));

    var baseUrl = ($("conn-base-url").value || "").trim();
    var apiKey = ($("conn-api-key").value || "").trim();
    if (!baseUrl) { showError(errEl, "Base URL is required."); return; }

    var btn = $("btn-conn-test");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';

    try {
      var models = await apiFetchModels(draftProvider, baseUrl, apiKey);
      if (models && models.length > 0) {
        show($("conn-test-success"));
        $("conn-test-msg").textContent = "Connected -- " + models.length + " model" + (models.length !== 1 ? "s" : "") + " found.";
        // Store models for this draft
        if (editingIdx >= 0) {
          connections[editingIdx].models = models;
        } else {
          // Will store when saved
          modelCache["_draft"] = models;
        }
      } else {
        show($("conn-test-success"));
        $("conn-test-msg").textContent = "Connected (no models listed).";
      }
    } catch (e) {
      showError(errEl, "Connection failed: " + (e.message || "unknown error"));
    }

    btn.disabled = false;
    btn.textContent = "Test";
  }

  function generateId() {
    return Math.random().toString(36).slice(2, 10);
  }

  /* =========================================================================
     Step 2: Model Assignment
     ========================================================================= */

  function initStep2() {
    populateConnectionSelects();
  }

  function populateConnectionSelects() {
    var llmSel = $("llm-connection");
    var embSel = $("emb-connection");
    var prevLlm = llmSel.value;
    var prevEmb = embSel.value;

    // Rebuild options
    llmSel.innerHTML = '<option value="" disabled>Select a connection</option>';
    embSel.innerHTML = '<option value="" disabled>Select a connection</option>';

    connections.forEach(function (conn) {
      var o1 = document.createElement("option");
      o1.value = conn.id;
      o1.textContent = conn.name || conn.provider;
      llmSel.appendChild(o1);

      var o2 = document.createElement("option");
      o2.value = conn.id;
      o2.textContent = conn.name || conn.provider;
      embSel.appendChild(o2);
    });

    // Restore or auto-select
    if (prevLlm && connections.some(function (c) { return c.id === prevLlm; })) {
      llmSel.value = prevLlm;
    } else if (connections.length > 0) {
      llmSel.value = connections[0].id;
    }

    if (prevEmb && connections.some(function (c) { return c.id === prevEmb; })) {
      embSel.value = prevEmb;
    } else if (connections.length > 0) {
      embSel.value = connections[0].id;
    }

    // Fetch models for selected connections
    if (llmSel.value) loadModelsForConnection(llmSel.value, "llm");
    if (embSel.value) loadModelsForConnection(embSel.value, "emb");
  }

  async function loadModelsForConnection(connId, target) {
    var conn = connections.find(function (c) { return c.id === connId; });
    if (!conn) return;

    var modelSel = $(target + "-model");
    var smallSel = target === "llm" ? $("llm-small-model") : null;

    // Try cached models first
    var models = conn.models && conn.models.length > 0
      ? conn.models
      : (modelCache[connId] || null);

    if (!models) {
      modelSel.innerHTML = '<option value="">Fetching models...</option>';
      if (smallSel) smallSel.innerHTML = '<option value="">(loading...)</option>';
      try {
        models = await apiFetchModels(conn.provider, conn.baseUrl, conn.apiKey);
        conn.models = models;
        modelCache[connId] = models;
      } catch (e) {
        models = [];
      }
    }

    var def = PROVIDER_DEFAULTS[conn.provider] || {};
    var prevVal = modelSel.value;

    if (models.length > 0) {
      // Restore select if it was replaced with a text input
      modelSel = restoreToSelect(target + "-model");
      if (smallSel) smallSel = restoreToSelect("llm-small-model");

      modelSel.innerHTML = "";
      models.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        modelSel.appendChild(o);
      });

      // Select best default
      var preferred;
      if (target === "llm") {
        preferred = def.llmModel;
      } else {
        preferred = def.embModel;
      }
      if (preferred && models.indexOf(preferred) >= 0) {
        modelSel.value = preferred;
      } else if (prevVal && models.indexOf(prevVal) >= 0) {
        modelSel.value = prevVal;
      }

      // Also fill small model
      if (smallSel) {
        smallSel.innerHTML = '<option value="">(same as chat model)</option>';
        models.forEach(function (m) {
          var o = document.createElement("option");
          o.value = m;
          o.textContent = m;
          smallSel.appendChild(o);
        });
      }

      // Auto-fill embedding dims
      if (target === "emb") {
        autoFillEmbDims(modelSel.value);
      }
    } else {
      // No models found -- allow manual entry
      modelSel.innerHTML = "";
      var manualOpt = document.createElement("option");
      manualOpt.value = "";
      manualOpt.textContent = "(enter model name below)";
      modelSel.appendChild(manualOpt);

      // Replace with text input if needed
      replaceWithTextInput(modelSel, target + "-model", target === "emb" ? (def.embModel || "") : (def.llmModel || ""));
      if (smallSel && target === "llm") {
        replaceWithTextInput(smallSel, "llm-small-model", "");
      }
    }
  }

  function replaceWithTextInput(selectEl, id, defaultVal) {
    var parent = selectEl.parentNode;
    var input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = defaultVal;
    input.placeholder = "Enter model name";
    parent.replaceChild(input, selectEl);

    if (id === "emb-model") {
      input.addEventListener("input", function () { autoFillEmbDims(input.value); });
    }
  }

  /** Replace a text input back with a select element if it was previously swapped. */
  function restoreToSelect(id) {
    var el = $(id);
    if (!el || el.tagName === "SELECT") return el;
    var parent = el.parentNode;
    var sel = document.createElement("select");
    sel.id = id;
    parent.replaceChild(sel, el);
    if (id === "emb-model") {
      sel.addEventListener("change", function () { autoFillEmbDims(sel.value); });
    }
    return sel;
  }

  function autoFillEmbDims(modelName) {
    if (!modelName) return;
    var name = modelName.replace(/:.*$/, ""); // strip tag
    var dims = KNOWN_EMB_DIMS[modelName] || KNOWN_EMB_DIMS[name];
    if (dims) {
      $("emb-dims").value = dims;
    }
  }

  function validateStep2() {
    var errEl = $("step2-error");
    hideError(errEl);

    var llmConn = $("llm-connection").value;
    var llmModel = ($("llm-model").value || "").trim();
    var embConn = $("emb-connection").value;
    var embModel = ($("emb-model").value || "").trim();

    if (!llmConn) { showError(errEl, "Select a chat connection."); return false; }
    if (!llmModel) { showError(errEl, "Chat model is required."); return false; }
    if (!embConn) { showError(errEl, "Select an embedding connection."); return false; }
    if (!embModel) { showError(errEl, "Embedding model is required."); return false; }
    return true;
  }

  /* =========================================================================
     Step 3: Options
     ========================================================================= */

  function initStep3() {
    // Show Ollama toggle if any connection uses Ollama
    var hasOllama = connections.some(function (c) {
      return c.provider === "ollama" || c.provider === "ollama-instack";
    });
    var addon = $("ollama-addon");
    if (hasOllama) show(addon); else hide(addon);

    // Memory user ID default
    var memInput = $("memory-user-id");
    if (!memInput.value) {
      var email = ($("owner-email").value || "").trim();
      memInput.value = email || "default_user";
    }
  }

  /* =========================================================================
     Step 4: Review & Install
     ========================================================================= */

  function initStep4() {
    renderReview();
  }

  function renderReview() {
    var grid = $("review-grid");
    grid.innerHTML = "";

    // Account section
    grid.appendChild(reviewHeader("Account", 0));
    grid.appendChild(reviewItem("Admin Token", maskToken($("admin-token").value)));
    var ownerName = ($("owner-name").value || "").trim();
    if (ownerName) grid.appendChild(reviewItem("Name", ownerName));
    var ownerEmail = ($("owner-email").value || "").trim();
    if (ownerEmail) grid.appendChild(reviewItem("Email", ownerEmail));

    // Connections section
    grid.appendChild(reviewHeader("Connections", 1));
    connections.forEach(function (conn) {
      grid.appendChild(reviewItem(conn.name || conn.provider, conn.kind + " -- " + conn.baseUrl, true));
    });

    // Models section
    grid.appendChild(reviewHeader("Models", 2));
    var llmConnId = $("llm-connection").value;
    var llmConn = connections.find(function (c) { return c.id === llmConnId; });
    var llmModel = ($("llm-model").value || "").trim();
    var smallModel = ($("llm-small-model").value || "").trim();
    var embConnId = $("emb-connection").value;
    var embConn = connections.find(function (c) { return c.id === embConnId; });
    var embModel = ($("emb-model").value || "").trim();
    var embDims = ($("emb-dims").value || "1536").trim();

    grid.appendChild(reviewItem("Chat Model", llmModel + " (" + (llmConn ? llmConn.name : "?") + ")", true));
    if (smallModel) {
      grid.appendChild(reviewItem("Small Model", smallModel + " (" + (llmConn ? llmConn.name : "?") + ")", true));
    }
    grid.appendChild(reviewItem("Embedding Model", embModel + " (" + (embConn ? embConn.name : "?") + ")", true));
    grid.appendChild(reviewItem("Embedding Dims", embDims, true));

    // Options section
    grid.appendChild(reviewHeader("Options", 3));
    var ollamaEnabled = $("ollama-enabled") && $("ollama-enabled").checked;
    if (ollamaEnabled) {
      grid.appendChild(reviewItem("Ollama In-Stack", "Enabled"));
    }
    grid.appendChild(reviewItem("Memory User ID", $("memory-user-id").value || "default_user"));
  }

  function reviewHeader(label, editStep) {
    var div = document.createElement("div");
    div.className = "review-section-header";
    var span = document.createElement("span");
    span.textContent = label;
    div.appendChild(span);
    var btn = document.createElement("button");
    btn.className = "review-edit-btn";
    btn.type = "button";
    btn.textContent = "Edit";
    btn.addEventListener("click", function () { goToStep(editStep); });
    div.appendChild(btn);
    return div;
  }

  function reviewItem(label, value, mono) {
    var div = document.createElement("div");
    div.className = "review-item";
    var lbl = document.createElement("span");
    lbl.className = "review-label";
    lbl.textContent = label;
    div.appendChild(lbl);
    var val = document.createElement("span");
    val.className = "review-value" + (mono ? " mono" : "");
    val.textContent = value;
    div.appendChild(val);
    return div;
  }

  function maskToken(token) {
    if (!token || token.length < 8) return "(not set)";
    return token.slice(0, 4) + "..." + token.slice(-4);
  }

  /* =========================================================================
     Install & Deploy
     ========================================================================= */

  async function handleInstall() {
    if (installing) return;

    var errEl = $("install-error");
    hideError(errEl);

    var adminToken = ($("admin-token").value || "").trim();
    var ownerName = ($("owner-name").value || "").trim();
    var ownerEmail = ($("owner-email").value || "").trim();
    var memoryUserId = ($("memory-user-id").value || "").trim() || ownerEmail || "default_user";
    var ollamaEnabled = $("ollama-enabled") ? $("ollama-enabled").checked : false;

    var llmConnId = $("llm-connection").value;
    var llmModel = ($("llm-model").value || "").trim();
    var smallModel = ($("llm-small-model").value || "").trim();
    var embConnId = $("emb-connection").value;
    var embModel = ($("emb-model").value || "").trim();
    var embDims = parseInt($("emb-dims").value, 10) || 1536;

    var payload = {
      adminToken: adminToken,
      ownerName: ownerName || undefined,
      ownerEmail: ownerEmail || undefined,
      memoryUserId: memoryUserId,
      ollamaEnabled: ollamaEnabled,
      connections: connections.map(function (c) {
        return {
          id: c.id,
          name: c.name,
          provider: c.provider,
          baseUrl: c.baseUrl,
          apiKey: c.apiKey,
        };
      }),
      assignments: {
        llm: {
          connectionId: llmConnId,
          model: llmModel,
          smallModel: smallModel || undefined,
        },
        embeddings: {
          connectionId: embConnId,
          model: embModel,
          embeddingDims: embDims,
        },
      },
    };

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

      // Success -- go to deploy screen
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

      updateDeployUI(data);

      if (data.deployError) {
        stopDeployPolling();
        showDeployError(data.deployError);
      } else if (data.setupComplete && data.deployStatus && data.deployStatus.length > 0) {
        stopDeployPolling();
        showDeployDone(data);
      }
    } catch (e) {
      // silently retry
    }
  }

  function updateDeployUI(data) {
    var services = data.deployStatus || [];
    var total = services.length;
    var running = 0;
    var ready = 0;

    var container = $("deploy-services");
    container.innerHTML = "";

    services.forEach(function (svc) {
      if (svc.status === "running") running++;
      if (svc.status === "running" || svc.status === "ready") ready++;

      var row = document.createElement("div");
      row.className = "deploy-service-row";

      // Indicator
      var indicator = document.createElement("div");
      indicator.className = "deploy-service-indicator";
      if (svc.status === "running") {
        indicator.innerHTML = '<span class="deploy-check"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
      } else if (svc.status === "error") {
        indicator.innerHTML = '<span class="deploy-warning"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg></span>';
      } else {
        indicator.innerHTML = '<span class="deploy-spinner"><span class="spinner"></span></span>';
      }
      row.appendChild(indicator);

      // Info
      var info = document.createElement("div");
      info.className = "deploy-service-info";
      info.innerHTML =
        '<span class="deploy-service-name">' + esc(svc.service || svc.label || "") + "</span>" +
        '<span class="deploy-service-status">' + esc(svc.label || svc.status) + "</span>";
      row.appendChild(info);

      // Bar
      var bar = document.createElement("div");
      bar.className = "deploy-service-bar";
      var fill = document.createElement("div");
      fill.className = "deploy-bar-fill";
      if (svc.status === "running") fill.classList.add("complete");
      else if (svc.status === "ready") fill.classList.add("ready");
      else if (svc.status === "error") fill.classList.add("stopped");
      else fill.classList.add("indeterminate");
      bar.appendChild(fill);
      row.appendChild(bar);

      container.appendChild(row);
    });

    // Progress
    var pct = total > 0 ? Math.round((running / total) * 100) : 0;
    $("deploy-progress-value").textContent = pct + "%";
    $("deploy-progress-fill").style.width = pct + "%";

    if (pct > 0 && pct < 100) {
      $("deploy-title").textContent = "Starting Services...";
      $("deploy-subtitle").textContent = running + " of " + total + " services running.";
    } else if (ready > 0 && running === 0) {
      $("deploy-title").textContent = "Pulling Images...";
      $("deploy-subtitle").textContent = "Downloading container images.";
    }
  }

  function showDeployDone(data) {
    hide($("deploy-tips"));
    hide($("deploy-failure"));
    hide($("deploy-error-actions"));
    show($("deploy-done"));

    $("deploy-title").textContent = "Setup Complete";
    $("deploy-subtitle").textContent = "All services are up and running.";
    $("deploy-progress-value").textContent = "100%";
    $("deploy-progress-fill").style.width = "100%";

    // Service list
    var list = $("deploy-service-list");
    list.innerHTML = "";
    (data.deployStatus || []).forEach(function (svc) {
      var li = document.createElement("li");
      li.textContent = svc.service || svc.label || "";
      list.appendChild(li);
    });
  }

  function showDeployError(error) {
    hide($("deploy-tips"));
    hide($("deploy-done"));
    show($("deploy-failure"));
    show($("deploy-error-actions"));

    $("deploy-title").textContent = "Deployment Issue";
    $("deploy-subtitle").textContent = "Setup could not finish starting the stack.";
    $("deploy-failure-summary").textContent = typeof error === "string" ? error : "Deployment failed.";
    $("deploy-error-pre").textContent = typeof error === "string" ? error : JSON.stringify(error, null, 2);

    var bar = $("deploy-progress-bar");
    if (bar) bar.parentElement.querySelector(".deploy-progress-bar").classList.add("deploy-progress-bar--error");
    $("deploy-progress-value").textContent = "Error";
    $("deploy-progress-value").classList.add("deploy-progress-value--error");
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
      }
    } catch (e) {
      detectedProviders = [];
    }
    hide($("conn-detecting"));
  }

  async function apiFetchModels(provider, baseUrl, apiKey) {
    var url = "/api/setup/models/" + encodeURIComponent(provider);
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey || "", baseUrl: baseUrl || "" }),
    });
    if (!res.ok) throw new Error("Failed to fetch models (HTTP " + res.status + ")");
    var data = await res.json();
    return data.models || [];
  }

  /* =========================================================================
     Utility
     ========================================================================= */

  function esc(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str || ""));
    return div.innerHTML;
  }

  /* =========================================================================
     Event Binding
     ========================================================================= */

  document.addEventListener("DOMContentLoaded", function () {
    // Generate initial admin token
    initStep0();

    // Check setup status first
    fetch("/api/setup/status")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.setupComplete) {
          // Already set up -- redirect
          window.location.href = "/";
        }
      })
      .catch(function () { /* ignore */ });

    // ── Step indicator clicks ──
    qsa(".step-dot").forEach(function (dot) {
      dot.addEventListener("click", function () {
        var step = parseInt(dot.dataset.step, 10);
        if (isNaN(step) || step > maxVisitedStep) return;
        // Going forward requires valid prior steps
        if (step > currentStep) {
          if (step >= 1 && !validateStep0()) return;
          if (step >= 2 && connections.length === 0) return;
          if (step >= 3 && !validateStep2()) return;
        }
        goToStep(step);
      });
    });

    // ── Step 0: Welcome ──
    $("btn-step0-next").addEventListener("click", function () {
      if (validateStep0()) goToStep(1);
    });

    // ── Step 1: Connections ──
    $("btn-step1-back").addEventListener("click", function () { goToStep(0); });
    $("btn-step1-add").addEventListener("click", function () { openAddConnection(); });
    $("btn-step1-next").addEventListener("click", function () {
      if (connections.length > 0) goToStep(2);
    });

    // Connection type chooser
    $("btn-add-cloud").addEventListener("click", function () { openConnectionForm("cloud"); });
    $("btn-add-local").addEventListener("click", function () { openConnectionForm("local"); });

    // Connection detail form
    $("btn-conn-cancel").addEventListener("click", function () {
      editingIdx = -1;
      renderConnHub();
      setConnView("hub");
    });
    $("btn-conn-test").addEventListener("click", function () { testConnection(); });
    $("btn-conn-save").addEventListener("click", function () { saveConnection(); });

    // Hub list delegation (edit/remove)
    $("conn-hub-list").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var idx = parseInt(btn.dataset.idx, 10);
      if (btn.dataset.action === "edit") editConnectionAt(idx);
      if (btn.dataset.action === "remove") removeConnection(idx);
    });

    // ── Step 2: Models ──
    $("btn-step2-back").addEventListener("click", function () { goToStep(1); });
    $("btn-step2-next").addEventListener("click", function () {
      if (validateStep2()) goToStep(3);
    });
    $("btn-models-add-conn").addEventListener("click", function () {
      goToStep(1);
      openAddConnection();
    });

    $("llm-connection").addEventListener("change", function () {
      loadModelsForConnection(this.value, "llm");
    });
    $("emb-connection").addEventListener("change", function () {
      loadModelsForConnection(this.value, "emb");
    });
    $("emb-model").addEventListener("change", function () {
      autoFillEmbDims(this.value);
    });

    // ── Step 3: Options ──
    $("btn-step3-back").addEventListener("click", function () { goToStep(2); });
    $("btn-step3-next").addEventListener("click", function () { goToStep(4); });

    // ── Step 4: Review ──
    $("btn-step4-back").addEventListener("click", function () { goToStep(3); });
    $("btn-install").addEventListener("click", function () { handleInstall(); });

    // ── Deploy error actions ──
    $("btn-deploy-back").addEventListener("click", function () {
      installing = false;
      goToStep(4);
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
    updateStepIndicators();
  });
})();
