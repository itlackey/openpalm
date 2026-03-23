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

  var PROVIDER_GROUPS = [
    { id: "recommended", label: "Recommended", desc: "Best options to get started quickly" },
    { id: "local", label: "Local", desc: "Run models on your own hardware" },
    { id: "cloud", label: "Cloud", desc: "Hosted inference providers" },
    { id: "advanced", label: "Advanced", desc: "Additional providers" },
  ];

  var PROVIDERS = [
    // Recommended — best first-run experience
    { id: "ollama", name: "Ollama", kind: "local", group: "recommended", order: 1, icon: "\uD83E\uDD99", desc: "Run open models on your hardware", needsKey: false, placeholder: "", baseUrl: "http://localhost:11434", llmModel: "llama3.2", embModel: "nomic-embed-text", embDims: 768, canDetect: true },
    { id: "huggingface", name: "Hugging Face", kind: "cloud", group: "recommended", order: 2, icon: "\uD83E\uDD17", desc: "10,000+ open models via Inference Providers", needsKey: true, placeholder: "hf_...", baseUrl: "https://router.huggingface.co/v1", llmModel: "Qwen/Qwen3-32B", embModel: "intfloat/multilingual-e5-large", embDims: 1024, keyPrefix: "hf_" },

    { id: "openai", name: "OpenAI", kind: "cloud", group: "recommended", order: 3, icon: "\u25D0", desc: "GPT and o-series reasoning models", needsKey: true, placeholder: "sk-...", baseUrl: "https://api.openai.com", llmModel: "gpt-4o", embModel: "text-embedding-3-small", embDims: 1536 },
    { id: "google", name: "Google", kind: "cloud", group: "recommended", order: 4, icon: "\u25C6", desc: "Gemini models with large context", needsKey: true, placeholder: "AIza...", baseUrl: "https://generativelanguage.googleapis.com", llmModel: "gemini-2.5-flash", embModel: "", embDims: 0, keyPrefix: "AI" },

    // Local — self-hosted model runtimes
    { id: "model-runner", name: "Docker Model Runner", kind: "local", group: "local", order: 1, icon: "\uD83D\uDC33", desc: "Docker-managed model runtime", needsKey: false, placeholder: "", baseUrl: "http://localhost:12434", llmModel: "ai/llama3.2", embModel: "ai/mxbai-embed-large-v1", embDims: 1024, canDetect: true },
    { id: "lmstudio", name: "LM Studio", kind: "local", group: "local", order: 2, icon: "\uD83D\uDD2C", desc: "Desktop app for local inference", needsKey: false, placeholder: "", baseUrl: "http://localhost:1234", llmModel: "loaded-model", embModel: "", embDims: 0, canDetect: true },

    // Cloud — hosted inference APIs
    { id: "groq", name: "Groq", kind: "cloud", group: "cloud", order: 1, icon: "\u26A1", desc: "Ultra-fast inference", needsKey: true, placeholder: "gsk_...", baseUrl: "https://api.groq.com/openai", llmModel: "llama-3.3-70b-versatile", embModel: "", embDims: 0 },
    { id: "mistral", name: "Mistral", kind: "cloud", group: "cloud", order: 2, icon: "\u25C6", desc: "Mistral & Codestral models", needsKey: true, placeholder: "...", baseUrl: "https://api.mistral.ai", llmModel: "mistral-large-latest", embModel: "mistral-embed", embDims: 1024 },
    { id: "together", name: "Together AI", kind: "cloud", group: "cloud", order: 3, icon: "\u2726", desc: "Open models at scale", needsKey: true, placeholder: "...", baseUrl: "https://api.together.xyz", llmModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", embModel: "", embDims: 0 },

    // Advanced — niche or specialized providers
    { id: "deepseek", name: "DeepSeek", kind: "cloud", group: "advanced", order: 1, icon: "\u25CE", desc: "DeepSeek chat & reasoning", needsKey: true, placeholder: "sk-...", baseUrl: "https://api.deepseek.com", llmModel: "deepseek-chat", embModel: "", embDims: 0 },
    { id: "xai", name: "xAI (Grok)", kind: "cloud", group: "advanced", order: 2, icon: "\u2726", desc: "Grok models", needsKey: true, placeholder: "xai-...", baseUrl: "https://api.x.ai", llmModel: "grok-2", embModel: "", embDims: 0 },
    { id: "openai-compatible", name: "Custom (OpenAI-compatible)", kind: "cloud", group: "advanced", order: 3, icon: "\uD83D\uDD27", desc: "Any endpoint that speaks the OpenAI API", needsKey: false, needsUrl: true, optionalKey: true, placeholder: "API key (optional)", baseUrl: "", llmModel: "", embModel: "", embDims: 0 },
  ];

  /** Known embedding dimensions for auto-fill */
  var KNOWN_EMB_DIMS = {
    "text-embedding-3-small": 1536, "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536, "nomic-embed-text": 768,
    "mxbai-embed-large": 1024, "mxbai-embed-large-v1": 1024,
    "ai/mxbai-embed-large-v1": 1024, "mistral-embed": 1024,
    "all-minilm": 384, "snowflake-arctic-embed": 1024,
    "intfloat/multilingual-e5-large": 1024,
  };

  var STEP_LABELS = ["Welcome", "Providers", "Models", "Voice", "Options", "Review"];
  var TOTAL_STEPS = 6;

  /** OpenCode provider discovery state */
  var opencodeAvailable = false;
  /** OpenCode providers: [{ id, name, env[], models{}, authMethods[] }] */
  var opencodeProviders = [];
  /** OpenCode auth map: { providerId: [{type, label}] } */
  var opencodeAuth = {};
  /** Provider filter query for OpenCode mode */
  var ocFilterQuery = "";

  /* =========================================================================
     Voice / TTS / STT Options
     ========================================================================= */

  var TTS_OPTIONS = [
    { id: "kokoro", name: "Kokoro TTS", type: "local", recommended: true, desc: "High-quality local TTS \u2014 runs on CPU" },
    { id: "piper", name: "Piper TTS", type: "local", desc: "Ultra-lightweight \u2014 great for low-power hardware" },
    { id: "openai-tts", name: "OpenAI TTS", type: "cloud", desc: "Cloud voices. Uses your OpenAI API key" },
    { id: "browser-tts", name: "Browser Built-in", type: "builtin", desc: "Native speech synthesis. No setup needed" },
    { id: "skip-tts", name: "Skip \u2014 text only", type: "skip", desc: "Add TTS later from the dashboard" },
  ];

  var STT_OPTIONS = [
    { id: "whisper-local", name: "Whisper (local)", type: "local", recommended: true, desc: "Whisper in Docker. Accurate, private" },
    { id: "openai-stt", name: "OpenAI Whisper", type: "cloud", desc: "Cloud Whisper API. Uses OpenAI key" },
    { id: "browser-stt", name: "Browser Built-in", type: "builtin", desc: "Web Speech API. No setup" },
    { id: "skip-stt", name: "Skip \u2014 text only", type: "skip", desc: "Add STT later from the dashboard" },
  ];

  /* =========================================================================
     Channel & Service Constants
     ========================================================================= */

  var CHANNELS = [
    { id: "chat", name: "Web Chat", icon: "\uD83D\uDCAC", desc: "Browser-based chat \u2014 always available", locked: true },
    { id: "api", name: "API", icon: "\uD83D\uDD0C", desc: "OpenAI-compatible REST API endpoint" },
    {
      id: "discord", name: "Discord", icon: "\uD83C\uDFAE", desc: "Connect to a Discord server",
      credentials: [
        { key: "botToken", label: "Bot Token", placeholder: "Paste Discord bot token", required: true },
        { key: "applicationId", label: "Application ID", placeholder: "Discord application ID", secret: false },
      ]
    },
    {
      id: "slack", name: "Slack", icon: "\uD83D\uDCBC", desc: "Access via Slack bot",
      credentials: [
        { key: "slackBotToken", label: "Bot Token", placeholder: "xoxb-...", required: true },
        { key: "slackAppToken", label: "App Token", placeholder: "xapp-...", required: true },
      ]
    },
  ];

  var SERVICES = [
    { id: "admin", name: "Admin Dashboard", icon: "\u2699\uFE0F", desc: "Web-based admin UI for managing your stack", recommended: true },
    { id: "openviking", name: "OpenViking", icon: "\u2694\uFE0F", desc: "Agentic task execution engine" },
  ];

  /* =========================================================================
     DOM Helpers
     ========================================================================= */

  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.classList.remove("hidden"); }
  function hide(el) { if (el) el.classList.add("hidden"); }
  function showError(el, msg) { if (el) { el.textContent = msg; show(el); } }
  function hideError(el) { if (el) { el.textContent = ""; hide(el); } }

  /* =========================================================================
     Wizard State
     ========================================================================= */

  var currentStep = 0;
  var maxVisitedStep = 0;
  var welcomeHeroDismissed = false;

  /** Provider selection state: { providerId: { selected, verified, verifying, error, apiKey, baseUrl, models[], ollamaMode } } */
  var providerState = {};

  /** Expanded provider card (only one at a time) */
  var expandedProvider = null;

  /** Provider detection results */
  var detectedProviders = [];

  /** Model selection: { llm: {connId, model}, embedding: {connId, model, dims}, small: {connId, model} } */
  var modelSelection = {};

  /** Voice selection state */
  var voiceSelection = { tts: null, stt: null };

  /** Channel selection state (chat always on) */
  var channelSelection = {
    chat: true,
    discord: { enabled: false, botToken: "", applicationId: "" },
    slack: { enabled: false, slackBotToken: "", slackAppToken: "" },
  };

  /** Services selection state (admin default on) */
  var serviceSelection = { admin: true };

  /** Deploy polling timer */
  var deployTimer = null;

  /** Whether install is in progress */
  var installing = false;

  // Initialize provider states
  PROVIDERS.forEach(function (p) {
    providerState[p.id] = {
      selected: false,
      verified: false,
      verifying: false,
      error: false,
      apiKey: "",
      baseUrl: p.baseUrl || "",
      models: [],
      ollamaMode: null, // null | "running" | "instack"
    };
  });

  /* =========================================================================
     Token Generation
     ========================================================================= */

  function generateToken() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function generateId() {
    return Math.random().toString(36).slice(2, 10);
  }

  /* =========================================================================
     Step Navigation
     ========================================================================= */

  function goToStep(n) {
    if (n < 0 || n > TOTAL_STEPS - 1) return;
    for (var i = 0; i < TOTAL_STEPS; i++) {
      var sec = $("step-" + i);
      if (sec) { if (i === n) show(sec); else hide(sec); }
    }
    hide($("step-deploy"));

    currentStep = n;
    if (n > maxVisitedStep) maxVisitedStep = n;
    renderProgressBar();

    if (n === 0) initStep0();
    if (n === 1) initStep1();
    if (n === 2) initStep2();
    if (n === 3) initStep3();
    if (n === 4) initStep4();
    if (n === 5) initStep5();
  }

  function showDeployScreen() {
    for (var i = 0; i < TOTAL_STEPS; i++) hide($("step-" + i));
    show($("step-deploy"));
    hide($("step-indicators"));
  }

  function renderProgressBar() {
    show($("step-indicators"));
    var segHTML = "";
    var lblHTML = "";
    for (var i = 0; i < TOTAL_STEPS; i++) {
      segHTML += '<div class="prog-seg ' + (i <= currentStep ? "on" : "") + '"></div>';
      var cls = "prog-lbl";
      if (i <= currentStep) cls += " on";
      if (i === currentStep) cls += " active";
      lblHTML += '<span class="' + cls + '" data-prog-step="' + i + '">' + STEP_LABELS[i] + '</span>';
    }
    $("prog-segments").innerHTML = segHTML;
    $("prog-labels").innerHTML = lblHTML;

    // Bind label clicks
    var labels = document.querySelectorAll("[data-prog-step]");
    labels.forEach(function (lbl) {
      lbl.addEventListener("click", function () {
        var step = parseInt(lbl.dataset.progStep, 10);
        if (isNaN(step) || step > maxVisitedStep) return;
        if (step > currentStep) {
          if (step >= 1 && !validateStep0()) return;
          if (step >= 2 && getVerifiedCount() === 0) return;
          if (step >= 3 && !validateStep2()) return;
          // Step 3 (voice) has no hard validation gate
          if (step >= 5 && !validateStep4()) return;
        }
        goToStep(step);
      });
    });
  }

  /* =========================================================================
     Step 0: Welcome & Identity
     ========================================================================= */

  function initStep0() {
    var tokenInput = $("admin-token");
    if (tokenInput && !tokenInput.value) {
      tokenInput.value = generateToken();
    }
    // Show hero or form based on state
    if (!welcomeHeroDismissed) {
      show($("welcome-hero"));
      hide($("identity-form"));
    } else {
      hide($("welcome-hero"));
      show($("identity-form"));
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
    var name = ($("owner-name").value || "").trim();
    if (!name) {
      showError(errEl, "Your name is required.");
      return false;
    }
    var email = ($("owner-email").value || "").trim();
    if (!email) {
      showError(errEl, "Email is required.");
      return false;
    }
    return true;
  }

  /* =========================================================================
     Step 1: Provider Card Grid
     ========================================================================= */

  function initStep1() {
    renderProviderGrid();
  }

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

  /** Local runtimes that aren't in OpenCode's cloud registry but run on the host */
  var LOCAL_PROVIDERS = [
    { id: "ollama", name: "Ollama", env: [], models: {}, localUrl: "http://localhost:11434" },
    { id: "model-runner", name: "Docker Model Runner", env: [], models: {}, localUrl: "http://localhost:12434" },
    { id: "lmstudio", name: "LM Studio", env: [], models: {}, localUrl: "http://localhost:1234" },
  ];

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

  /* ── OpenCode Provider Grid (replaces hardcoded grid when available) ── */

  function renderOpenCodeProviderGrid() {
    var grid = $("provider-grid");
    var query = ocFilterQuery.toLowerCase().trim();

    // Filter providers by search query
    var filtered = opencodeProviders;
    if (query) {
      filtered = opencodeProviders.filter(function (p) {
        return p.name.toLowerCase().indexOf(query) >= 0 || p.id.toLowerCase().indexOf(query) >= 0;
      });
    }

    // Sort: connected first, then by name
    filtered.sort(function (a, b) {
      var aConn = providerState[a.id] && providerState[a.id].verified ? 1 : 0;
      var bConn = providerState[b.id] && providerState[b.id].verified ? 1 : 0;
      if (aConn !== bConn) return bConn - aConn;
      return a.name.localeCompare(b.name);
    });

    var html = '';

    // Search filter
    html += '<div class="model-filter-row" style="margin-bottom:12px">';
    html += '<input type="text" class="model-filter-input" id="oc-provider-filter" placeholder="Search ' + opencodeProviders.length + ' providers\u2026" value="' + esc(ocFilterQuery) + '" autocomplete="off">';
    html += '</div>';

    // Provider cards
    filtered.forEach(function (ocp) {
      var st = providerState[ocp.id] || {};
      // Use providerState models (populated by verifyProvider) if available, otherwise OpenCode's model map
      var modelCount = (st.models && st.models.length > 0) ? st.models.length : Object.keys(ocp.models || {}).length;
      var authMethods = opencodeAuth[ocp.id] || [];
      var envVars = ocp.env || [];
      var isExpanded = expandedProvider === ocp.id;

      var cls = "pcard";
      if (st.verified) cls += " selected verified";
      else if (isExpanded) cls += " selected";
      if (isExpanded) cls += " wide";

      html += '<div class="' + cls + '" data-provider="' + esc(ocp.id) + '">';

      // Header
      html += '<div class="pcard-header" data-toggle-provider="' + esc(ocp.id) + '">';
      html += '<div class="pcard-info">';
      html += '<div class="pcard-name">' + esc(ocp.name);
      if (st.verified) html += ' <span class="vs vs-ok">\u2713</span>';
      else if (st.verifying) html += ' <span class="vs vs-wait">\u27F3</span>';
      else if (st.error) html += ' <span class="vs vs-err">\u2717</span>';
      html += '</div>';
      html += '<div class="pcard-desc">' + modelCount + ' model' + (modelCount !== 1 ? 's' : '');
      if (authMethods.length > 0) html += ' \u00B7 ' + authMethods.length + ' auth method' + (authMethods.length !== 1 ? 's' : '');
      html += '</div>';
      html += '</div>';
      html += '<div class="pcard-check">' + (st.verified ? '\u2713' : '') + '</div>';
      html += '</div>';

      // Expanded auth panel
      if (isExpanded) {
        html += renderOpenCodeAuth(ocp, authMethods, envVars);
      }

      html += '</div>';
    });

    if (filtered.length === 0 && query) {
      html += '<div style="text-align:center;padding:24px;color:var(--color-text-secondary)">No providers match "' + esc(query) + '"</div>';
    }

    grid.innerHTML = html;

    // Update nav
    var vc = getVerifiedCount();
    var info = $("provider-count-info");
    if (vc > 0) {
      info.innerHTML = '<b>' + vc + '</b> provider' + (vc > 1 ? 's' : '') + ' ready';
    } else {
      info.textContent = 'Connect at least one';
    }
    $("btn-step1-next").disabled = vc === 0;

    // Bind events
    bindOpenCodeProviderEvents();
  }

  function renderOpenCodeAuth(ocp, authMethods, envVars) {
    var st = providerState[ocp.id] || {};
    var html = '<div class="pcard-auth">';

    if (st.verified) {
      html += '<div class="auth-feedback auth-feedback-ok">Connected</div>';
      html += '</div>';
      return html;
    }

    if (st.error) {
      var errMsg = st.errorMessage || 'Connection failed';
      html += '<div class="auth-feedback auth-feedback-err">' + esc(errMsg) + '</div>';
    }

    // Show auth methods if available
    if (authMethods.length > 0) {
      authMethods.forEach(function (method, idx) {
        if (method.type === "api") {
          html += '<div class="auth-row" style="margin-bottom:6px">';
          html += '<input type="password" placeholder="API key" value="' + esc(st.apiKey || '') + '" data-auth-key="' + esc(ocp.id) + '" onclick="event.stopPropagation()">';
          html += '<button class="auth-btn auth-btn-verify" data-oc-auth-api="' + esc(ocp.id) + '" onclick="event.stopPropagation()" ' + (st.verifying ? 'disabled' : '') + '>';
          html += st.verifying ? 'Connecting...' : esc(method.label);
          html += '</button></div>';
        } else if (method.type === "oauth") {
          html += '<div class="auth-row" style="margin-bottom:6px">';
          html += '<button class="auth-btn auth-btn-detect" data-oc-auth-oauth="' + esc(ocp.id) + ':' + idx + '" onclick="event.stopPropagation()" style="width:100%" ' + (st.verifying ? 'disabled' : '') + '>';
          html += st.verifying ? 'Waiting...' : esc(method.label);
          html += '</button></div>';
        }
      });
    } else if (envVars.length > 0) {
      // No auth methods — show env var API key input
      html += '<div class="auth-row">';
      html += '<input type="password" placeholder="' + esc(envVars[0]) + '" value="' + esc(st.apiKey || '') + '" data-auth-key="' + esc(ocp.id) + '" onclick="event.stopPropagation()">';
      html += '<button class="auth-btn auth-btn-verify" data-oc-auth-api="' + esc(ocp.id) + '" onclick="event.stopPropagation()" ' + (st.verifying ? 'disabled' : '') + '>';
      html += st.verifying ? 'Connecting...' : 'Connect';
      html += '</button></div>';
    } else {
      html += '<div style="padding:4px 0;color:var(--color-text-secondary);font-size:var(--text-xs)">No authentication required</div>';
      html += '<button class="auth-btn auth-btn-detect" data-oc-auth-none="' + esc(ocp.id) + '" onclick="event.stopPropagation()">Mark as ready</button>';
    }

    // OAuth polling status
    if (st.oauthPolling) {
      html += '<div style="text-align:center;padding:8px">';
      if (st.oauthUrl) {
        html += '<p style="margin-bottom:6px"><a href="' + esc(st.oauthUrl) + '" target="_blank" rel="noopener" style="color:var(--color-accent)">Open authorization page \u2192</a></p>';
      }
      if (st.oauthInstructions) {
        html += '<p style="margin-bottom:6px;white-space:pre-wrap;font-size:var(--text-xs)">' + esc(st.oauthInstructions) + '</p>';
      }
      html += '<p><span class="spinner"></span> Waiting for authorization...</p>';
      html += '<button class="auth-btn" data-oc-auth-cancel="' + esc(ocp.id) + '" onclick="event.stopPropagation()" style="margin-top:6px">Cancel</button>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function bindOpenCodeProviderEvents() {
    // Filter input
    var filterInput = $("oc-provider-filter");
    if (filterInput) {
      filterInput.addEventListener("input", function () {
        ocFilterQuery = filterInput.value;
        renderOpenCodeProviderGrid();
        // Re-focus the filter input after re-render
        var newInput = $("oc-provider-filter");
        if (newInput) { newInput.focus(); newInput.selectionStart = newInput.selectionEnd = newInput.value.length; }
      });
    }

    // Card header toggle
    document.querySelectorAll("[data-toggle-provider]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.toggleProvider;
        expandedProvider = expandedProvider === id ? null : id;
        renderOpenCodeProviderGrid();
      });
    });

    // Check icon: deselect
    document.querySelectorAll(".pcard-check").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var card = el.closest("[data-provider]");
        if (!card) return;
        var id = card.dataset.provider;
        var st = providerState[id];
        if (st && st.verified) {
          st.verified = false;
          st.error = false;
          st.apiKey = "";
          if (expandedProvider === id) expandedProvider = null;
          renderOpenCodeProviderGrid();
        }
      });
    });

    // API key inputs
    document.querySelectorAll("[data-auth-key]").forEach(function (el) {
      el.addEventListener("input", function () {
        var id = el.dataset.authKey;
        if (providerState[id]) providerState[id].apiKey = el.value;
      });
    });

    // API key auth buttons
    document.querySelectorAll("[data-oc-auth-api]").forEach(function (el) {
      el.addEventListener("click", function () {
        connectOpenCodeApiKey(el.dataset.ocAuthApi);
      });
    });

    // OAuth buttons
    document.querySelectorAll("[data-oc-auth-oauth]").forEach(function (el) {
      el.addEventListener("click", function () {
        var parts = el.dataset.ocAuthOauth.split(":");
        startOpenCodeOAuth(parts[0], parseInt(parts[1], 10));
      });
    });

    // Cancel OAuth polling
    document.querySelectorAll("[data-oc-auth-cancel]").forEach(function (el) {
      el.addEventListener("click", function () {
        var st = providerState[el.dataset.ocAuthCancel];
        if (st) { st.oauthPolling = false; st.verifying = false; }
        renderOpenCodeProviderGrid();
      });
    });

    // No-auth "mark ready" button
    document.querySelectorAll("[data-oc-auth-none]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.ocAuthNone;
        var st = providerState[id];
        if (st) { st.verified = true; st.error = false; }
        renderOpenCodeProviderGrid();
      });
    });
  }

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

  function getVerifiedCount() {
    var count = 0;
    var ids = opencodeAvailable
      ? opencodeProviders.map(function (p) { return p.id; })
      : PROVIDERS.map(function (p) { return p.id; });
    ids.forEach(function (id) {
      if (providerState[id] && providerState[id].verified) count++;
    });
    return count;
  }

  function renderProviderGrid() {
    if (opencodeAvailable) { renderOpenCodeProviderGrid(); return; }
    renderFallbackProviderGrid();
  }

  function renderFallbackProviderGrid() {
    var grid = $("provider-grid");
    var html = "";

    PROVIDER_GROUPS.forEach(function (g) {
      var members = PROVIDERS.filter(function (p) { return p.group === g.id; })
        .sort(function (a, b) { return a.order - b.order; });
      if (members.length === 0) return;

      html += '<div class="provider-group">';
      html += '<div class="provider-group-header">';
      html += '<h3 class="provider-group-label">' + esc(g.label) + '</h3>';
      html += '<span class="provider-group-desc">' + esc(g.desc) + '</span>';
      html += '</div>';
      html += '<div class="provider-group-cards">';
      members.forEach(function (p) { html += renderProviderCard(p); });
      html += '</div></div>';
    });

    grid.innerHTML = html;

    // Update nav info
    var vc = getVerifiedCount();
    var info = $("provider-count-info");
    if (vc > 0) {
      info.innerHTML = '<b>' + vc + '</b> provider' + (vc > 1 ? 's' : '') + ' ready';
    } else {
      info.textContent = 'Connect at least one';
    }
    $("btn-step1-next").disabled = vc === 0;

    bindProviderEvents();
  }

  function renderProviderCard(p) {
    var st = providerState[p.id];
    var isExpanded = expandedProvider === p.id && st.selected;
    var cls = "pcard";
    if (st.selected) cls += " selected";
    if (st.verified) cls += " verified";
    if (isExpanded) cls += " wide";

    var badgeCls = p.kind === "cloud" ? "badge-cloud" : p.kind === "local" ? "badge-local" : "badge-hybrid";
    var vi = "";
    if (st.verified) vi = '<span class="vs vs-ok">\u2713</span>';
    else if (st.verifying) vi = '<span class="vs vs-wait">\u27F3</span>';
    else if (st.error) vi = '<span class="vs vs-err">\u2717</span>';

    var html = '<div class="' + cls + '" data-provider="' + p.id + '">';
    html += '<div class="pcard-header" data-toggle-provider="' + p.id + '">';
    html += '<div class="pcard-icon">' + esc(p.icon) + '</div>';
    html += '<div class="pcard-info">';
    html += '<div class="pcard-name">' + esc(p.name) + ' <span class="badge ' + badgeCls + '">' + p.kind + '</span>' + vi + '</div>';
    html += '<div class="pcard-desc">' + esc(p.desc) + '</div>';
    html += '</div>';
    html += '<div class="pcard-check">' + (st.selected ? '\u2713' : '') + '</div>';
    html += '</div>';

    if (isExpanded) {
      html += renderProviderAuth(p);
    }

    html += '</div>';
    return html;
  }

  function renderProviderAuth(p) {
    var st = providerState[p.id];
    var html = '<div class="pcard-auth">';

    if (p.id === "ollama") {
      // Ollama: show mode selector first
      if (!st.ollamaMode) {
        html += '<div class="ollama-mode-prompt">';
        html += '<p>Is Ollama already running on this machine?</p>';
        html += '<div class="ollama-mode-buttons">';
        html += '<button class="ollama-mode-btn ollama-mode-btn-detect" data-ollama-mode="running">Yes, detect it</button>';
        html += '<button class="ollama-mode-btn ollama-mode-btn-stack" data-ollama-mode="instack">No, add to stack</button>';
        html += '</div></div>';
      } else if (st.ollamaMode === "running") {
        html += '<div class="auth-row">';
        html += '<input type="url" placeholder="' + esc(p.baseUrl) + '" value="' + esc(st.baseUrl || p.baseUrl) + '" data-auth-url="' + p.id + '">';
        html += '<button class="auth-btn ' + (st.verified ? 'auth-btn-detected' : 'auth-btn-detect') + '" data-auth-verify="' + p.id + '" ' + (st.verifying ? 'disabled' : '') + '>';
        html += st.verifying ? 'Detecting...' : st.verified ? 'Connected \u2713' : 'Detect';
        html += '</button></div>';
      } else {
        // instack mode
        if (st.verified) {
          html += '<div class="auth-feedback auth-feedback-ok">Ollama will be added to your Docker stack with default models.</div>';
        } else {
          html += '<div class="ollama-mode-prompt">';
          html += '<p>Ollama runs as a container in your stack with recommended models pre-configured.</p>';
          html += '<button class="auth-btn auth-btn-detect" data-auth-verify="' + p.id + '" style="margin-top:4px">Enable Ollama</button>';
          html += '</div>';
        }
      }
    } else if (p.needsUrl) {
      // Custom provider: URL (required) + optional API key
      html += '<div class="auth-row">';
      html += '<input type="url" placeholder="https://your-server.example/v1" value="' + esc(st.baseUrl || '') + '" data-auth-url="' + p.id + '">';
      html += '</div>';
      if (p.optionalKey) {
        html += '<div class="auth-row" style="margin-top:6px">';
        html += '<input type="password" placeholder="' + esc(p.placeholder || 'API key (optional)') + '" value="' + esc(st.apiKey) + '" data-auth-key="' + p.id + '">';
        html += '</div>';
      }
      html += '<div class="auth-row" style="margin-top:6px">';
      html += '<button class="auth-btn ' + (st.verified ? 'auth-btn-verified' : 'auth-btn-verify') + '" data-auth-verify="' + p.id + '" ' + (st.verifying ? 'disabled' : '') + '>';
      html += st.verifying ? 'Checking...' : st.verified ? 'Connected \u2713' : 'Connect';
      html += '</button></div>';
    } else if (p.needsKey) {
      // Cloud provider: API key + verify
      html += '<div class="auth-row">';
      html += '<input type="password" placeholder="' + esc(p.placeholder || 'API key') + '" value="' + esc(st.apiKey) + '" data-auth-key="' + p.id + '">';
      html += '<button class="auth-btn ' + (st.verified ? 'auth-btn-verified' : 'auth-btn-verify') + '" data-auth-verify="' + p.id + '" ' + (st.verifying ? 'disabled' : '') + '>';
      html += st.verifying ? 'Checking...' : st.verified ? 'Verified \u2713' : 'Verify';
      html += '</button></div>';
    } else {
      // Local provider with URL
      html += '<div class="auth-row">';
      html += '<input type="url" placeholder="' + esc(p.baseUrl || 'http://localhost:8080') + '" value="' + esc(st.baseUrl || p.baseUrl || '') + '" data-auth-url="' + p.id + '">';
      html += '<button class="auth-btn ' + (st.verified ? 'auth-btn-detected' : 'auth-btn-detect') + '" data-auth-verify="' + p.id + '" ' + (st.verifying ? 'disabled' : '') + '>';
      html += st.verifying ? 'Detecting...' : st.verified ? 'Connected \u2713' : 'Detect';
      html += '</button></div>';
    }

    // Feedback messages
    if (st.verified && p.id !== "ollama") {
      html += '<div class="auth-feedback auth-feedback-ok">Credentials verified</div>';
    } else if (st.error) {
      var errMsg = st.errorMessage ? esc(st.errorMessage) : 'check your ' + (p.needsKey ? 'credentials' : 'endpoint');
      html += '<div class="auth-feedback auth-feedback-err">Verification failed -- ' + errMsg + '</div>';
    }

    html += '</div>';
    return html;
  }

  function bindProviderEvents() {
    // Card header toggle (select/expand)
    document.querySelectorAll("[data-toggle-provider]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        var id = el.dataset.toggleProvider;
        var st = providerState[id];
        if (st.selected) {
          // Already selected: toggle expand
          expandedProvider = expandedProvider === id ? null : id;
        } else {
          // Select and expand
          st.selected = true;
          expandedProvider = id;
          // Auto-fill from detection
          var detected = detectedProviders.find(function (d) { return d.provider === id && d.available; });
          if (detected) {
            st.baseUrl = detected.url;
          }
        }
        renderProviderGrid();
      });
    });

    // Check icon: deselect provider
    document.querySelectorAll(".pcard-check").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var card = el.closest("[data-provider]");
        if (!card) return;
        var id = card.dataset.provider;
        var st = providerState[id];
        if (st.selected) {
          st.selected = false;
          st.verified = false;
          st.verifying = false;
          st.error = false;
          st.apiKey = "";
          st.models = [];
          if (id === "ollama") st.ollamaMode = null;
          if (expandedProvider === id) expandedProvider = null;
          renderProviderGrid();
        }
      });
    });

    // Auth inputs (don't re-render on typing)
    document.querySelectorAll("[data-auth-key]").forEach(function (el) {
      el.addEventListener("input", function () {
        providerState[el.dataset.authKey].apiKey = el.value;
      });
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });

    document.querySelectorAll("[data-auth-url]").forEach(function (el) {
      el.addEventListener("input", function () {
        providerState[el.dataset.authUrl].baseUrl = el.value;
      });
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });

    // Verify buttons
    document.querySelectorAll("[data-auth-verify]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        verifyProvider(el.dataset.authVerify);
      });
    });

    // Ollama mode buttons
    document.querySelectorAll("[data-ollama-mode]").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var mode = el.dataset.ollamaMode;
        providerState.ollama.ollamaMode = mode;
        renderProviderGrid();
      });
    });

  }

  /** Monotonic counter to discard stale verification results */
  var verifyGeneration = {};

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
     Step 2: Model Assignment (Radio Options)
     ========================================================================= */

  function initStep2() {
    buildModelOptions();
  }

  function getVerifiedProviders() {
    if (opencodeAvailable) {
      return opencodeProviders
        .filter(function (p) { return providerState[p.id] && providerState[p.id].verified; })
        .map(function (p) {
          // Normalize to the shape the rest of the wizard expects
          var st = providerState[p.id];
          return {
            id: p.id,
            name: p.name || p.id,
            kind: "cloud",
            icon: "",
            baseUrl: st.baseUrl || "",
            llmModel: "",
            embModel: "",
            embDims: 0,
          };
        });
    }
    return PROVIDERS.filter(function (p) { return providerState[p.id].verified; });
  }

  function getAllModels() {
    var result = [];
    getVerifiedProviders().forEach(function (p) {
      var st = providerState[p.id];
      st.models.forEach(function (m) {
        result.push({ id: m, provider: p.id, providerName: p.name, baseUrl: st.baseUrl || p.baseUrl, apiKey: st.apiKey });
      });
    });
    return result;
  }

  var MAX_VISIBLE_MODELS = 6;

  function buildModelOptions() {
    var allModels = getAllModels();
    var verifiedProviders = getVerifiedProviders();
    var groupsEl = $("model-groups");

    // Define model roles
    var roles = [
      { id: "llm", label: "Chat Model (LLM)", tag: "required", desc: "Conversations, reasoning, and code" },
      { id: "embedding", label: "Embedding Model", tag: "optional", desc: "Memory search and recall" },
      { id: "small", label: "Small Model", tag: "optional", desc: "Lightweight tasks like memory extraction" },
    ];

    var html = "";

    roles.forEach(function (role) {
      // Build options for this role from each verified provider's models
      var options = [];
      verifiedProviders.forEach(function (p) {
        var st = providerState[p.id];
        var defaultModel = role.id === "embedding" ? p.embModel : p.llmModel;
        var models = st.models.length > 0 ? st.models : [];

        // Add the default model as top pick if in the list
        if (defaultModel && models.indexOf(defaultModel) >= 0) {
          options.push({
            id: defaultModel,
            connId: p.id,
            providerName: p.name,
            baseUrl: st.baseUrl || p.baseUrl,
            isDefault: true,
            dims: role.id === "embedding" ? (KNOWN_EMB_DIMS[defaultModel] || KNOWN_EMB_DIMS[defaultModel.replace(/:.*$/, "")] || p.embDims || 0) : 0,
          });
        }

        // Add other models
        models.forEach(function (m) {
          if (m === defaultModel) return; // Already added above
          var dims = 0;
          if (role.id === "embedding") {
            dims = KNOWN_EMB_DIMS[m] || KNOWN_EMB_DIMS[m.replace(/:.*$/, "")] || 0;
          }
          options.push({
            id: m,
            connId: p.id,
            providerName: p.name,
            baseUrl: st.baseUrl || p.baseUrl,
            isDefault: false,
            dims: dims,
          });
        });
      });

      // For embedding role, filter to models with known dims, plus provider defaults
      if (role.id === "embedding") {
        var embOptions = options.filter(function (o) {
          return o.isDefault || o.dims > 0;
        });
        if (embOptions.length > 0) options = embOptions;
      }

      // Small model: same as LLM options but with "(same as chat)" default
      if (role.id === "small" && options.length === 0) {
        // Use llm options
        var llmProvider = verifiedProviders[0];
        if (llmProvider) {
          providerState[llmProvider.id].models.forEach(function (m) {
            options.push({
              id: m,
              connId: llmProvider.id,
              providerName: llmProvider.name,
              baseUrl: providerState[llmProvider.id].baseUrl || llmProvider.baseUrl,
              isDefault: false,
              dims: 0,
            });
          });
        }
      }

      if (options.length === 0 && role.id !== "small") return;

      // Auto-select default
      if (!modelSelection[role.id] && options.length > 0) {
        var defaultOpt = options.find(function (o) { return o.isDefault; }) || options[0];
        if (defaultOpt) {
          modelSelection[role.id] = { connId: defaultOpt.connId, model: defaultOpt.id, dims: defaultOpt.dims };
        }
      }

      html += '<div class="model-group">';
      html += '<div class="model-group-header">';
      html += '<span class="model-group-title">' + role.label + '</span>';
      html += '<span class="model-group-tag ' + (role.tag === "required" ? "model-group-tag-required" : "model-group-tag-optional") + '">' + role.tag + '</span>';
      html += '</div>';
      html += '<div class="model-group-desc">' + role.desc + '</div>';

      if (role.id === "small") {
        // Add a "same as chat" option
        var smallSel = modelSelection.small;
        var noneOn = !smallSel || !smallSel.model;
        html += '<div class="model-opt ' + (noneOn ? 'on' : '') + '" data-model-select="small:">';
        html += '<div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>';
        html += '<div style="flex:1"><div class="model-opt-name">(same as chat model)</div>';
        html += '<div class="model-opt-meta">No separate small model</div></div>';
        html += '<span class="model-opt-badge model-opt-badge-auto">Default</span>';
        html += '</div>';
      }

      var hasOverflow = options.length > MAX_VISIBLE_MODELS;
      var filterId = "model-filter-" + role.id;

      // Search filter for long model lists
      if (hasOverflow) {
        html += '<div class="model-filter-row">';
        html += '<input type="text" class="model-filter-input" id="' + filterId + '" placeholder="Search ' + options.length + ' models\u2026" autocomplete="off">';
        html += '</div>';
      }

      options.forEach(function (opt, idx) {
        var sel = modelSelection[role.id];
        var isOn = sel && sel.model === opt.id && sel.connId === opt.connId;
        var meta = "via " + opt.providerName;
        if (opt.dims > 0) meta += " \u00B7 " + opt.dims + "d";

        // Hide items beyond MAX_VISIBLE_MODELS unless selected — filter will reveal them
        var isHidden = hasOverflow && idx >= MAX_VISIBLE_MODELS && !isOn;

        html += '<div class="model-opt ' + (isOn ? 'on' : '') + (isHidden ? ' model-opt-filtered' : '') + '" data-model-select="' + role.id + ':' + opt.connId + ':' + esc(opt.id) + ':' + opt.dims + '" data-model-name="' + esc(opt.id.toLowerCase()) + '">';
        html += '<div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>';
        html += '<div style="flex:1;min-width:0"><div class="model-opt-name">' + esc(opt.id) + '</div>';
        html += '<div class="model-opt-meta">' + esc(meta) + '</div></div>';
        if (idx === 0 && opt.isDefault) {
          html += '<span class="model-opt-badge model-opt-badge-top">Top Pick</span>';
        }
        html += '</div>';
      });

      html += '</div>';
    });

    groupsEl.innerHTML = html;

    // Sync hidden fields for backward compat
    syncHiddenModelFields();

    // Bind model filter inputs
    document.querySelectorAll(".model-filter-input").forEach(function (input) {
      input.addEventListener("input", function () {
        var query = input.value.toLowerCase().trim();
        var group = input.closest(".model-group");
        if (!group) return;
        var opts = group.querySelectorAll("[data-model-name]");
        var shown = 0;
        opts.forEach(function (el, idx) {
          var name = el.dataset.modelName || "";
          if (query) {
            // When filtering, show all matches
            var match = name.indexOf(query) >= 0;
            el.classList.toggle("model-opt-filtered", !match);
            if (match) shown++;
          } else {
            // No query — show top MAX_VISIBLE_MODELS + selected
            var isOn = el.classList.contains("on");
            el.classList.toggle("model-opt-filtered", idx >= MAX_VISIBLE_MODELS && !isOn);
            shown++;
          }
        });
      });
    });

    // Bind model option clicks
    document.querySelectorAll("[data-model-select]").forEach(function (el) {
      el.addEventListener("click", function () {
        var parts = el.dataset.modelSelect.split(":");
        var role = parts[0];
        if (parts.length < 2 || !parts[1]) {
          // "same as chat" for small model
          delete modelSelection[role];
        } else {
          var connId = parts[1];
          var modelId = parts.slice(2, -1).join(":"); // Model id may contain colons
          var dims = parseInt(parts[parts.length - 1], 10) || 0;
          modelSelection[role] = { connId: connId, model: modelId, dims: dims };
        }
        buildModelOptions();
      });
    });
  }

  function syncHiddenModelFields() {
    var llm = modelSelection.llm;
    var emb = modelSelection.embedding;
    var small = modelSelection.small;

    if (llm) {
      $("llm-connection").value = llm.connId;
      $("llm-model").value = llm.model;
    }
    if (emb) {
      $("emb-connection").value = emb.connId;
      $("emb-model").value = emb.model;
      $("emb-dims").value = emb.dims || 1536;
    }
    $("llm-small-model").value = small ? small.model : "";
  }

  function validateStep2() {
    var errEl = $("step2-error");
    hideError(errEl);

    var llm = modelSelection.llm;
    var emb = modelSelection.embedding;

    if (!llm || !llm.model) {
      showError(errEl, "Select a chat model.");
      return false;
    }
    if (!emb || !emb.model) {
      showError(errEl, "Select an embedding model.");
      return false;
    }
    return true;
  }

  /* =========================================================================
     Step 3: Voice (TTS / STT)
     ========================================================================= */

  function getVoiceDefaults() {
    var hasOpenAI = PROVIDERS.some(function (p) {
      return p.id === "openai" && providerState[p.id].verified;
    });
    if (hasOpenAI) return { tts: "openai-tts", stt: "openai-stt" };
    return { tts: "browser-tts", stt: "browser-stt" };
  }

  function activeTts() { return voiceSelection.tts || getVoiceDefaults().tts; }
  function activeStt() { return voiceSelection.stt || getVoiceDefaults().stt; }

  function initStep3() {
    renderVoiceStep();
  }

  function renderVoiceStep() {
    var container = $("voice-groups");
    var curTts = activeTts();
    var curStt = activeStt();
    var hasOpenAI = PROVIDERS.some(function (p) {
      return p.id === "openai" && providerState[p.id].verified;
    });

    var hint = hasOpenAI
      ? "OpenAI selected as voice defaults. Kokoro and Whisper recommended for better quality."
      : "Browser voice works out of the box. Kokoro and Whisper recommended for higher quality.";

    var html = '<p class="voice-hint">' + esc(hint) + '</p>';

    // TTS group
    html += '<div class="model-group">';
    html += '<div class="model-group-header">';
    html += '<span class="model-group-title">Text-to-Speech</span>';
    html += '<span class="model-group-tag model-group-tag-optional">Optional</span>';
    html += '</div>';
    html += '<div class="model-group-desc">How your assistant speaks</div>';

    TTS_OPTIONS.forEach(function (o) {
      var isOn = curTts === o.id;
      var defs = getVoiceDefaults();
      var badge = "";
      if (o.recommended) badge = '<span class="model-opt-badge model-opt-badge-top">Recommended</span>';
      else if (defs.tts === o.id && !voiceSelection.tts) badge = '<span class="model-opt-badge model-opt-badge-auto">Auto</span>';

      html += '<div class="model-opt ' + (isOn ? "on" : "") + '" data-voice-select="tts:' + o.id + '">';
      html += '<div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>';
      html += '<div style="flex:1;min-width:0"><div class="model-opt-name">' + esc(o.name) + '</div>';
      html += '<div class="model-opt-meta">' + esc(o.desc) + '</div></div>';
      html += badge;
      html += '</div>';
    });
    html += '</div>';

    // STT group
    html += '<div class="model-group">';
    html += '<div class="model-group-header">';
    html += '<span class="model-group-title">Speech-to-Text</span>';
    html += '<span class="model-group-tag model-group-tag-optional">Optional</span>';
    html += '</div>';
    html += '<div class="model-group-desc">How your assistant hears you</div>';

    STT_OPTIONS.forEach(function (o) {
      var isOn = curStt === o.id;
      var defs = getVoiceDefaults();
      var badge = "";
      if (o.recommended) badge = '<span class="model-opt-badge model-opt-badge-top">Recommended</span>';
      else if (defs.stt === o.id && !voiceSelection.stt) badge = '<span class="model-opt-badge model-opt-badge-auto">Auto</span>';

      html += '<div class="model-opt ' + (isOn ? "on" : "") + '" data-voice-select="stt:' + o.id + '">';
      html += '<div class="model-opt-dot"><div class="model-opt-dot-inner"></div></div>';
      html += '<div style="flex:1;min-width:0"><div class="model-opt-name">' + esc(o.name) + '</div>';
      html += '<div class="model-opt-meta">' + esc(o.desc) + '</div></div>';
      html += badge;
      html += '</div>';
    });
    html += '</div>';

    container.innerHTML = html;

    // Bind voice option clicks
    document.querySelectorAll("[data-voice-select]").forEach(function (el) {
      el.addEventListener("click", function () {
        var parts = el.dataset.voiceSelect.split(":");
        var kind = parts[0]; // "tts" or "stt"
        var id = parts[1];
        if (kind === "tts") voiceSelection.tts = id;
        if (kind === "stt") voiceSelection.stt = id;
        renderVoiceStep();
      });
    });
  }

  /* =========================================================================
     Step 4: Options (Channels + Services + Memory)
     ========================================================================= */

  function initStep4() {
    // Show Ollama toggle if any verified provider is Ollama
    var hasOllama = PROVIDERS.some(function (p) {
      return p.id === "ollama" && providerState[p.id].verified;
    });
    var addon = $("ollama-addon");
    if (hasOllama) {
      show(addon);
      // Pre-check if ollamaMode is instack
      var ollamaCb = $("ollama-enabled");
      if (providerState.ollama.ollamaMode === "instack") {
        ollamaCb.checked = true;
      }
    } else {
      hide(addon);
    }

    // Memory user ID default — derived from owner name
    var memInput = $("memory-user-id");
    if (!memInput.value) {
      var name = ($("owner-name").value || "").trim();
      memInput.value = name ? name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "") : "default_user";
    }

    // Render channels and services
    renderChannels();
    renderServices();
  }

  /** Helper: check if a channel is enabled (handles both boolean and object state) */
  function isChannelEnabled(ch) {
    if (ch.locked) return true;
    var sel = channelSelection[ch.id];
    if (typeof sel === "object" && sel !== null) return sel.enabled;
    return !!sel;
  }

  function renderChannels() {
    var container = $("channels-grid");
    var html = "";

    CHANNELS.forEach(function (ch) {
      var isOn = isChannelEnabled(ch);
      var cls = "toggle-card" + (isOn ? " on" : "") + (ch.locked ? " locked" : "");
      if (ch.credentials && isOn) cls += " wide";

      html += '<div class="' + cls + '" data-channel="' + ch.id + '">';
      html += '<div class="toggle-card-header" data-channel-toggle="' + ch.id + '">';
      html += '<div class="toggle-card-icon">' + esc(ch.icon) + '</div>';
      html += '<div class="toggle-card-info">';
      html += '<div class="toggle-card-name">' + esc(ch.name) + (ch.locked ? ' <span class="badge badge-local">Always on</span>' : '') + '</div>';
      html += '<div class="toggle-card-desc">' + esc(ch.desc) + '</div>';
      html += '</div>';
      html += '<div class="toggle-card-switch">';
      if (ch.locked) {
        html += '<div class="toggle-track on locked"><div class="toggle-thumb"></div></div>';
      } else {
        html += '<div class="toggle-track ' + (isOn ? "on" : "") + '"><div class="toggle-thumb"></div></div>';
      }
      html += '</div>';
      html += '</div>';

      // Credential fields (expanded when channel with credentials is toggled ON)
      if (ch.credentials && isOn) {
        html += renderChannelCredentials(ch);
      }

      html += '</div>';
    });

    container.innerHTML = html;

    // Bind toggle clicks on header
    document.querySelectorAll("[data-channel-toggle]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.channelToggle;
        var ch = CHANNELS.find(function (c) { return c.id === id; });
        if (ch && ch.locked) return; // Cannot toggle locked channels
        var sel = channelSelection[id];
        if (typeof sel === "object" && sel !== null) {
          sel.enabled = !sel.enabled;
        } else {
          channelSelection[id] = !sel;
        }
        renderChannels();
      });
    });

    // Bind credential inputs (don't re-render on typing)
    document.querySelectorAll("[data-channel-cred]").forEach(function (el) {
      el.addEventListener("input", function () {
        var sep = el.dataset.channelCred.indexOf(":");
        var chId = el.dataset.channelCred.slice(0, sep);
        var credKey = el.dataset.channelCred.slice(sep + 1);
        var sel = channelSelection[chId];
        if (typeof sel === "object" && sel !== null) {
          sel[credKey] = el.value;
        }
      });
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    });
  }

  function renderChannelCredentials(ch) {
    var sel = channelSelection[ch.id];
    var html = '<div class="pcard-auth">';

    ch.credentials.forEach(function (cred) {
      var val = (typeof sel === "object" && sel !== null) ? (sel[cred.key] || "") : "";
      var inputType = cred.secret === false ? "text" : "password";
      html += '<div class="auth-row">';
      html += '<label class="channel-cred-label">' + esc(cred.label) + (cred.required ? ' <span class="channel-cred-required">*</span>' : '') + '</label>';
      html += '<input type="' + inputType + '" placeholder="' + esc(cred.placeholder || '') + '" value="' + esc(val) + '" data-channel-cred="' + ch.id + ':' + cred.key + '">';
      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  function renderServices() {
    var container = $("services-grid");
    var html = "";

    SERVICES.forEach(function (svc) {
      var isOn = serviceSelection[svc.id];
      var cls = "toggle-card" + (isOn ? " on" : "");

      html += '<div class="' + cls + '" data-service="' + svc.id + '">';
      html += '<div class="toggle-card-header">';
      html += '<div class="toggle-card-icon">' + esc(svc.icon) + '</div>';
      html += '<div class="toggle-card-info">';
      html += '<div class="toggle-card-name">' + esc(svc.name) + (svc.recommended ? ' <span class="badge badge-cloud">Recommended</span>' : '') + '</div>';
      html += '<div class="toggle-card-desc">' + esc(svc.desc) + '</div>';
      html += '</div>';
      html += '<div class="toggle-card-switch">';
      html += '<div class="toggle-track ' + (isOn ? "on" : "") + '"><div class="toggle-thumb"></div></div>';
      html += '</div>';
      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    // Bind toggle clicks
    document.querySelectorAll("[data-service]").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.dataset.service;
        serviceSelection[id] = !serviceSelection[id];
        renderServices();
      });
    });
  }

  function validateStep4() {
    var errEl = $("step4-error");
    hideError(errEl);

    var errors = [];
    CHANNELS.forEach(function (ch) {
      if (!ch.credentials) return;
      if (!isChannelEnabled(ch)) return;
      var sel = channelSelection[ch.id];
      if (typeof sel !== "object" || sel === null) return;
      ch.credentials.forEach(function (cred) {
        if (cred.required && !(sel[cred.key] || "").trim()) {
          errors.push(ch.name + ": " + cred.label + " is required.");
        }
      });
    });

    if (errors.length > 0) {
      showError(errEl, errors.join(" "));
      return false;
    }
    return true;
  }

  /* =========================================================================
     Step 5: Review & Install
     ========================================================================= */

  function initStep5() {
    renderReview();
    // TODO: Remove renderReviewLegacy() once e2e tests (setup-wizard.test.ts)
    // are updated to use the new #review-summary selectors instead of #review-grid.
    renderReviewLegacy();
  }

  function renderReview() {
    var container = $("review-summary");
    var html = "";

    // Account section
    var adminToken = ($("admin-token").value || "").trim();
    var ownerName = ($("owner-name").value || "").trim();
    var ownerEmail = ($("owner-email").value || "").trim();

    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Account</span><button class="review-edit-btn" type="button" data-review-edit="0">Edit</button></div>';
    html += '<div class="review-row"><span class="review-row-label">Admin Token</span><span class="review-row-value">' + maskToken(adminToken) + '</span></div>';
    if (ownerName) html += '<div class="review-row"><span class="review-row-label">Name</span><span class="review-row-value">' + esc(ownerName) + '</span></div>';
    if (ownerEmail) html += '<div class="review-row"><span class="review-row-label">Email</span><span class="review-row-value">' + esc(ownerEmail) + '</span></div>';
    html += '</div>';

    // Providers section
    var vp = getVerifiedProviders();
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Providers</span><button class="review-edit-btn" type="button" data-review-edit="1">Edit</button></div>';
    vp.forEach(function (p) {
      html += '<div class="review-row"><span class="review-row-label">' + esc(p.icon) + ' ' + esc(p.name) + '</span><span class="review-row-value review-row-value-ok">Connected \u2713</span></div>';
    });
    html += '</div>';

    // Models section
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Models</span><button class="review-edit-btn" type="button" data-review-edit="2">Edit</button></div>';
    var llm = modelSelection.llm;
    var emb = modelSelection.embedding;
    var small = modelSelection.small;
    if (llm) {
      var llmProv = PROVIDERS.find(function (p) { return p.id === llm.connId; });
      html += '<div class="review-row"><span class="review-row-label">Chat Model</span><span class="review-row-value">' + esc(llm.model) + (llmProv ? ' (' + esc(llmProv.name) + ')' : '') + '</span></div>';
    }
    if (small && small.model) {
      var smallProv = PROVIDERS.find(function (p) { return p.id === small.connId; });
      html += '<div class="review-row"><span class="review-row-label">Small Model</span><span class="review-row-value">' + esc(small.model) + (smallProv ? ' (' + esc(smallProv.name) + ')' : '') + '</span></div>';
    }
    if (emb) {
      var embProv = PROVIDERS.find(function (p) { return p.id === emb.connId; });
      html += '<div class="review-row"><span class="review-row-label">Embedding Model</span><span class="review-row-value">' + esc(emb.model) + (embProv ? ' (' + esc(embProv.name) + ')' : '') + '</span></div>';
      html += '<div class="review-row"><span class="review-row-label">Embedding Dims</span><span class="review-row-value">' + (emb.dims || 1536) + '</span></div>';
    }
    html += '</div>';

    // Voice section
    var ttsOpt = TTS_OPTIONS.find(function (o) { return o.id === activeTts(); });
    var sttOpt = STT_OPTIONS.find(function (o) { return o.id === activeStt(); });
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Voice</span><button class="review-edit-btn" type="button" data-review-edit="3">Edit</button></div>';
    html += '<div class="review-row"><span class="review-row-label">Text-to-Speech</span><span class="review-row-value">' + (ttsOpt ? esc(ttsOpt.name) : "Disabled") + '</span></div>';
    html += '<div class="review-row"><span class="review-row-label">Speech-to-Text</span><span class="review-row-value">' + (sttOpt ? esc(sttOpt.name) : "Disabled") + '</span></div>';
    html += '</div>';

    // Channels section
    var activeChannels = CHANNELS.filter(function (ch) { return isChannelEnabled(ch); });
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Channels</span><button class="review-edit-btn" type="button" data-review-edit="4">Edit</button></div>';
    activeChannels.forEach(function (ch) {
      html += '<div class="review-row"><span class="review-row-label">' + esc(ch.icon) + ' ' + esc(ch.name) + '</span><span class="review-row-value review-row-value-ok">Enabled \u2713</span></div>';
      // Show masked credentials if present
      if (ch.credentials) {
        var sel = channelSelection[ch.id];
        if (typeof sel === "object" && sel !== null && sel.enabled) {
          ch.credentials.forEach(function (cred) {
            var val = sel[cred.key] || "";
            if (val) {
              html += '<div class="review-row"><span class="review-row-label" style="padding-left:24px">' + esc(cred.label) + '</span><span class="review-row-value">' + maskToken(val) + '</span></div>';
            }
          });
        }
      }
    });
    html += '</div>';

    // Services section
    var activeServices = SERVICES.filter(function (svc) { return serviceSelection[svc.id]; });
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Services</span><button class="review-edit-btn" type="button" data-review-edit="4">Edit</button></div>';
    if (activeServices.length > 0) {
      activeServices.forEach(function (svc) {
        html += '<div class="review-row"><span class="review-row-label">' + esc(svc.icon) + ' ' + esc(svc.name) + '</span><span class="review-row-value review-row-value-ok">Enabled \u2713</span></div>';
      });
    } else {
      html += '<div class="review-row"><span class="review-row-label">No extra services</span><span class="review-row-value">Core only</span></div>';
    }
    html += '</div>';

    // Options section
    var ollamaEnabled = $("ollama-enabled") && $("ollama-enabled").checked;
    var memUserId = ($("memory-user-id").value || "").trim() || "default_user";
    html += '<div class="review-card">';
    html += '<div class="review-card-title"><span>Options</span><button class="review-edit-btn" type="button" data-review-edit="4">Edit</button></div>';
    if (ollamaEnabled) {
      html += '<div class="review-row"><span class="review-row-label">Ollama In-Stack</span><span class="review-row-value">Enabled</span></div>';
    }
    html += '<div class="review-row"><span class="review-row-label">Memory User ID</span><span class="review-row-value">' + esc(memUserId) + '</span></div>';
    html += '</div>';

    container.innerHTML = html;

    // Build JSON for review
    var jsonObj = buildPayload();
    $("review-json-pre").textContent = JSON.stringify(jsonObj, null, 2);

    // Bind edit buttons
    document.querySelectorAll("[data-review-edit]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        goToStep(parseInt(btn.dataset.reviewEdit, 10));
      });
    });
  }

  function renderReviewLegacy() {
    // Keep the old review-grid populated for test backward compat
    var grid = $("review-grid");
    grid.innerHTML = "";

    grid.appendChild(reviewHeader("Account", 0));
    grid.appendChild(reviewItem("Admin Token", maskToken($("admin-token").value)));
    var ownerName = ($("owner-name").value || "").trim();
    if (ownerName) grid.appendChild(reviewItem("Name", ownerName));
    var ownerEmail = ($("owner-email").value || "").trim();
    if (ownerEmail) grid.appendChild(reviewItem("Email", ownerEmail));

    grid.appendChild(reviewHeader("Connections", 1));
    getVerifiedProviders().forEach(function (p) {
      var st = providerState[p.id];
      grid.appendChild(reviewItem(p.name, p.kind + " -- " + (st.baseUrl || p.baseUrl), true));
    });

    grid.appendChild(reviewHeader("Models", 2));
    var llm = modelSelection.llm;
    var small = modelSelection.small;
    var emb = modelSelection.embedding;
    var llmProv = llm ? PROVIDERS.find(function (pp) { return pp.id === llm.connId; }) : null;
    var embProv = emb ? PROVIDERS.find(function (pp) { return pp.id === emb.connId; }) : null;
    if (llm) grid.appendChild(reviewItem("Chat Model", llm.model + " (" + (llmProv ? llmProv.name : "?") + ")", true));
    if (small && small.model) grid.appendChild(reviewItem("Small Model", small.model + " (" + (llmProv ? llmProv.name : "?") + ")", true));
    if (emb) {
      grid.appendChild(reviewItem("Embedding Model", emb.model + " (" + (embProv ? embProv.name : "?") + ")", true));
      grid.appendChild(reviewItem("Embedding Dims", String(emb.dims || 1536), true));
    }

    grid.appendChild(reviewHeader("Voice", 3));
    var ttsOpt = TTS_OPTIONS.find(function (o) { return o.id === activeTts(); });
    var sttOpt = STT_OPTIONS.find(function (o) { return o.id === activeStt(); });
    grid.appendChild(reviewItem("TTS", ttsOpt ? ttsOpt.name : "Disabled"));
    grid.appendChild(reviewItem("STT", sttOpt ? sttOpt.name : "Disabled"));

    grid.appendChild(reviewHeader("Channels", 4));
    CHANNELS.forEach(function (ch) {
      if (isChannelEnabled(ch)) {
        grid.appendChild(reviewItem(ch.name, "Enabled"));
        // Show masked credentials in legacy review
        if (ch.credentials) {
          var sel = channelSelection[ch.id];
          if (typeof sel === "object" && sel !== null && sel.enabled) {
            ch.credentials.forEach(function (cred) {
              var val = sel[cred.key] || "";
              if (val) {
                grid.appendChild(reviewItem("  " + cred.label, maskToken(val)));
              }
            });
          }
        }
      }
    });

    grid.appendChild(reviewHeader("Services", 4));
    SERVICES.forEach(function (svc) {
      if (serviceSelection[svc.id]) {
        grid.appendChild(reviewItem(svc.name, "Enabled"));
      }
    });

    grid.appendChild(reviewHeader("Options", 4));
    var ollamaEnabled = $("ollama-enabled") && $("ollama-enabled").checked;
    if (ollamaEnabled) grid.appendChild(reviewItem("Ollama In-Stack", "Enabled"));
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

  var deployPollErrors = 0;

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

      var info = document.createElement("div");
      info.className = "deploy-service-info";
      info.innerHTML =
        '<span class="deploy-service-name">' + esc(svc.service || svc.label || "") + "</span>" +
        '<span class="deploy-service-status">' + esc(svc.label || svc.status) + "</span>";
      row.appendChild(info);

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

    var services = data.deployStatus || [];
    var deployed = services.length > 0;

    $("deploy-title").textContent = "Setup Complete";
    $("deploy-progress-value").textContent = deployed ? "100%" : "";
    $("deploy-progress-fill").style.width = deployed ? "100%" : "0%";

    var subtitle = $("deploy-done").querySelector(".done-subtitle");
    var consoleLink = $("deploy-done").querySelector(".btn-primary");
    var list = $("deploy-service-list");
    list.innerHTML = "";

    if (deployed) {
      if (subtitle) subtitle.textContent = "Your OpenPalm stack is up and running.";
      if (consoleLink) show(consoleLink);
      services.forEach(function (svc) {
        var li = document.createElement("li");
        li.textContent = svc.service || svc.label || "";
        list.appendChild(li);
      });
    } else {
      // --no-start mode: config saved but services not started
      if (subtitle) subtitle.textContent = "Configuration saved. Run 'openpalm start' to start services.";
      if (consoleLink) hide(consoleLink);
    }
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
})();
