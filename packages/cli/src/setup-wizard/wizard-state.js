/**
 * Wizard State — Constants, state variables, DOM helpers, navigation.
 *
 * This file is concatenated into the wizard IIFE by server.ts.
 * All declarations here are local to the enclosing IIFE scope.
 */

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
   Utility
   ========================================================================= */

function esc(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str || ""));
  return div.innerHTML;
}

function generateToken() {
  var arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function generateId() {
  return Math.random().toString(36).slice(2, 10);
}

function maskToken(token) {
  if (!token || token.length < 8) return "(not set)";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

/* =========================================================================
   Wizard State Variables
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

/** OpenCode provider discovery state */
var opencodeAvailable = false;
/** OpenCode providers: [{ id, name, env[], models{}, authMethods[] }] */
var opencodeProviders = [];
/** OpenCode auth map: { providerId: [{type, label}] } */
var opencodeAuth = {};
/** Provider filter query for OpenCode mode */
var ocFilterQuery = "";

/** Local runtimes and custom providers that aren't in OpenCode's cloud registry */
var LOCAL_PROVIDERS = [
  { id: "ollama", name: "Ollama", env: [], models: {}, localUrl: "http://localhost:11434" },
  { id: "model-runner", name: "Docker Model Runner", env: [], models: {}, localUrl: "http://localhost:12434" },
  { id: "lmstudio", name: "LM Studio", env: [], models: {}, localUrl: "http://localhost:1234" },
  { id: "openai-compatible", name: "Custom (OpenAI-compatible)", env: [], models: {}, localUrl: "" },
];

/** Max visible models before filter is shown */
var MAX_VISIBLE_MODELS = 6;

/** Monotonic counter to discard stale verification results */
var verifyGeneration = {};

/** Deploy poll error counter */
var deployPollErrors = 0;

/** Last successfully fetched deploy status (used as fallback when server stops) */
var lastDeployData = null;

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
   Shared helpers used across modules
   ========================================================================= */

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

/** Helper: check if a channel is enabled (handles both boolean and object state) */
function isChannelEnabled(ch) {
  if (ch.locked) return true;
  var sel = channelSelection[ch.id];
  if (typeof sel === "object" && sel !== null) return sel.enabled;
  return !!sel;
}

function getVoiceDefaults() {
  var hasOpenAI = PROVIDERS.some(function (p) {
    return p.id === "openai" && providerState[p.id].verified;
  });
  if (hasOpenAI) return { tts: "openai-tts", stt: "openai-stt" };
  return { tts: "browser-tts", stt: "browser-stt" };
}

function activeTts() { return voiceSelection.tts || getVoiceDefaults().tts; }
function activeStt() { return voiceSelection.stt || getVoiceDefaults().stt; }
