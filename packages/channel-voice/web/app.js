// app.js — State, rendering, event handlers, settings persistence, voice chat orchestration

import {
  agentProviders, sttProviders, ttsProviders,
  recordAudio, stopRecording, cancelTTS, cancelSTT, cancelAgentRequest,
} from './providers.js';

// ─── Default Settings ────────────────────────────────────

const DEFAULT_SETTINGS = {
  agent: { provider: 'openai', url: '', apiKey: '', model: '', personaPrompt: '' },
  stt:   { provider: 'browser', url: '', apiKey: '', model: '', language: '' },
  tts:   { provider: 'browser', url: '', apiKey: '', model: '', voice: '' },
  app:   { continuousListening: false, showConversation: true },
};

// ─── App State ───────────────────────────────────────────

const state = {
  status: 'idle',        // idle | listening | transcribing | thinking | speaking | error
  isListening: false,
  isSpeaking: false,
  conversationVisible: true,
  messages: [],          // { role: 'user'|'assistant', content: string }
  interimText: '',
};

// ─── Settings Persistence ────────────────────────────────

function loadSettings() {
  try {
    const raw = localStorage.getItem('voicechat_settings');
    if (raw) {
      const saved = JSON.parse(raw);
      // Merge with defaults to ensure all keys exist
      return {
        agent: { ...DEFAULT_SETTINGS.agent, ...saved.agent },
        stt:   { ...DEFAULT_SETTINGS.stt,   ...saved.stt },
        tts:   { ...DEFAULT_SETTINGS.tts,   ...saved.tts },
        app:   { ...DEFAULT_SETTINGS.app,   ...saved.app },
      };
    }
  } catch {}
  return structuredClone(DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  localStorage.setItem('voicechat_settings', JSON.stringify(settings));
}

let settings = loadSettings();

// ─── DOM References ──────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const app            = $('#app');
const statusText     = $('#statusText');
const providerSummary = $('#providerSummary');
const conversation   = $('#conversation');
const conversationInner = $('#conversationInner');
const emptyState     = $('#emptyState');

// Buttons
const btnSettings    = $('#btnSettings');
const btnNewConvo    = $('#btnNewConvo');
const btnToggleConvo = $('#btnToggleConvo');
const btnContinuous  = $('#btnContinuous');
const btnMic         = $('#btnMic');
const btnCancel      = $('#btnCancel');

// Modal
const modalOverlay   = $('#modalOverlay');
const btnCloseSettings = $('#btnCloseSettings');
const btnCancelSettings = $('#btnCancelSettings');
const btnSaveSettings = $('#btnSaveSettings');

// Settings dropdowns
const agentProviderSelect = $('#agentProvider');
const sttProviderSelect   = $('#sttProvider');
const ttsProviderSelect   = $('#ttsProvider');

// Dynamic field containers
const agentFieldsDiv = $('#agentFields');
const sttFieldsDiv   = $('#sttFields');
const ttsFieldsDiv   = $('#ttsFields');

// Error displays
const agentError = $('#agentError');
const sttError   = $('#sttError');
const ttsError   = $('#ttsError');

// ─── Rendering ───────────────────────────────────────────

function setStatus(status, text) {
  state.status = status;
  app.setAttribute('data-status', status);
  statusText.textContent = text || capitalize(status);
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function updateProviderSummary() {
  const agentLabel = agentProviders[settings.agent.provider]?.label || settings.agent.provider;
  const sttLabel = sttProviders[settings.stt.provider]?.label || settings.stt.provider;
  const ttsLabel = ttsProviders[settings.tts.provider]?.label || settings.tts.provider;
  providerSummary.textContent = `${agentLabel}`;
}

function renderConversation() {
  // Remove all messages (keep empty state)
  const existing = conversationInner.querySelectorAll('.message');
  existing.forEach(el => el.remove());

  if (state.messages.length === 0 && !state.interimText) {
    emptyState.style.display = '';
    return;
  }
  emptyState.style.display = 'none';

  for (const msg of state.messages) {
    const div = document.createElement('div');
    div.className = `message message-${msg.role === 'user' ? 'user' : msg.role === 'error' ? 'error' : 'assistant'}`;
    div.textContent = msg.content;
    conversationInner.appendChild(div);
  }

  // Show interim text
  if (state.interimText) {
    const div = document.createElement('div');
    div.className = 'message message-interim';
    div.textContent = state.interimText;
    conversationInner.appendChild(div);
  }

  // Scroll to bottom
  conversation.scrollTop = conversation.scrollHeight;
}

function updateUI() {
  // Conversation visibility
  if (state.conversationVisible) {
    conversation.classList.remove('hidden');
    btnToggleConvo.classList.add('active');
  } else {
    conversation.classList.add('hidden');
    btnToggleConvo.classList.remove('active');
  }

  // Continuous listening
  if (settings.app.continuousListening) {
    btnContinuous.classList.add('active');
  } else {
    btnContinuous.classList.remove('active');
  }

  // Mic button disabled during processing (but not during listening)
  const processing = ['transcribing', 'thinking', 'speaking'].includes(state.status);
  btnMic.disabled = processing;

  // Show cancel button during processing states
  btnCancel.hidden = !processing;
}

// ─── Settings Modal ──────────────────────────────────────

let tempSettings = null;

function openSettings() {
  tempSettings = structuredClone(settings);
  populateProviderDropdowns();
  renderProviderFields();
  clearErrors();
  modalOverlay.hidden = false;
}

function closeSettings() {
  modalOverlay.hidden = true;
  tempSettings = null;
}

function populateProviderDropdowns() {
  // Agent
  agentProviderSelect.innerHTML = '';
  for (const [key, p] of Object.entries(agentProviders)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    if (key === tempSettings.agent.provider) opt.selected = true;
    agentProviderSelect.appendChild(opt);
  }

  // STT
  sttProviderSelect.innerHTML = '';
  for (const [key, p] of Object.entries(sttProviders)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    if (key === tempSettings.stt.provider) opt.selected = true;
    sttProviderSelect.appendChild(opt);
  }

  // TTS
  ttsProviderSelect.innerHTML = '';
  for (const [key, p] of Object.entries(ttsProviders)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.label;
    if (key === tempSettings.tts.provider) opt.selected = true;
    ttsProviderSelect.appendChild(opt);
  }
}

function renderProviderFields() {
  renderFieldsFor('agent', agentProviders, tempSettings.agent, agentFieldsDiv);
  renderFieldsFor('stt', sttProviders, tempSettings.stt, sttFieldsDiv);
  renderFieldsFor('tts', ttsProviders, tempSettings.tts, ttsFieldsDiv);
}

function renderFieldsFor(section, providers, sectionSettings, container) {
  container.innerHTML = '';
  const provider = providers[sectionSettings.provider];
  if (!provider) return;

  for (const field of provider.fields) {
    const div = document.createElement('div');
    div.className = 'field';

    const label = document.createElement('label');
    label.textContent = field.label + (field.required ? ' *' : '');
    label.setAttribute('for', `${section}_${field.key}`);
    div.appendChild(label);

    if (field.type === 'textarea') {
      const textarea = document.createElement('textarea');
      textarea.id = `${section}_${field.key}`;
      textarea.placeholder = field.placeholder || '';
      textarea.value = sectionSettings[field.key] || '';
      textarea.addEventListener('input', () => {
        sectionSettings[field.key] = textarea.value;
      });
      div.appendChild(textarea);
    } else {
      const input = document.createElement('input');
      input.id = `${section}_${field.key}`;
      input.type = field.type || 'text';
      input.placeholder = field.placeholder || '';
      input.value = sectionSettings[field.key] || '';
      input.addEventListener('input', () => {
        sectionSettings[field.key] = input.value;
      });
      div.appendChild(input);
    }

    container.appendChild(div);
  }
}

function clearErrors() {
  agentError.textContent = '';
  sttError.textContent = '';
  ttsError.textContent = '';
}

function trySaveSettings() {
  clearErrors();
  let valid = true;

  // Validate agent (required)
  const agentProvider = agentProviders[tempSettings.agent.provider];
  if (agentProvider) {
    const err = agentProvider.validate(tempSettings);
    if (err) { agentError.textContent = err; valid = false; }
  } else {
    agentError.textContent = 'Invalid agent provider';
    valid = false;
  }

  // Validate STT
  const sttProvider = sttProviders[tempSettings.stt.provider];
  if (sttProvider) {
    const err = sttProvider.validate(tempSettings);
    if (err) { sttError.textContent = err; valid = false; }
  }

  // Validate TTS
  const ttsProvider = ttsProviders[tempSettings.tts.provider];
  if (ttsProvider) {
    const err = ttsProvider.validate(tempSettings);
    if (err) { ttsError.textContent = err; valid = false; }
  }

  if (!valid) return;

  settings = structuredClone(tempSettings);
  settings.app = { ...settings.app }; // keep app settings from temp
  saveSettings(settings);
  updateProviderSummary();
  closeSettings();
}

// Settings provider change handlers
agentProviderSelect.addEventListener('change', () => {
  if (!tempSettings) return;
  tempSettings.agent.provider = agentProviderSelect.value;
  renderFieldsFor('agent', agentProviders, tempSettings.agent, agentFieldsDiv);
  agentError.textContent = '';
});
sttProviderSelect.addEventListener('change', () => {
  if (!tempSettings) return;
  tempSettings.stt.provider = sttProviderSelect.value;
  renderFieldsFor('stt', sttProviders, tempSettings.stt, sttFieldsDiv);
  sttError.textContent = '';
});
ttsProviderSelect.addEventListener('change', () => {
  if (!tempSettings) return;
  tempSettings.tts.provider = ttsProviderSelect.value;
  renderFieldsFor('tts', ttsProviders, tempSettings.tts, ttsFieldsDiv);
  ttsError.textContent = '';
});

// ─── Voice Chat Orchestration ────────────────────────────

async function startVoiceTurn() {
  if (state.status !== 'idle') return;

  const agentProvider = agentProviders[settings.agent.provider];
  if (!agentProvider || agentProvider.validate(settings)) {
    setStatus('error', 'Agent not configured');
    addErrorMessage('Please configure the agent in Settings first.');
    setTimeout(() => setStatus('idle', 'Ready'), 3000);
    return;
  }

  try {
    // 1. Capture speech
    setStatus('listening', 'Listening...');
    state.isListening = true;
    state.interimText = '';
    updateUI();

    const sttProvider = sttProviders[settings.stt.provider];
    let transcript = '';

    if (sttProvider.mode === 'browser') {
      // Browser STT — no network, direct recognition
      transcript = await sttProvider.transcribe({
        settings,
        onInterim: (text) => {
          state.interimText = text;
          renderConversation();
        },
      });
    } else if (sttProvider.mode === 'http') {
      // HTTP STT — record audio first, then upload
      const audioPromise = recordAudio();

      // Wait for user to stop (they click mic again, handled by stopListening)
      // For now, we need a way to wait. The mic button click will call stopRecording().
      // We resolve when recording stops.
      const audioBlob = await audioPromise;

      setStatus('transcribing', 'Transcribing...');
      transcript = await sttProvider.transcribe({ settings, audioBlob });
    } else if (sttProvider.mode === 'bridge') {
      // Tauri bridge
      transcript = await sttProvider.transcribe({ settings });
    }

    state.isListening = false;
    state.interimText = '';

    if (!transcript?.trim()) {
      setStatus('idle', 'Ready');
      updateUI();
      renderConversation();
      return;
    }

    // 2. Add user message
    state.messages.push({ role: 'user', content: transcript.trim() });
    renderConversation();

    // 3. Send to agent
    setStatus('thinking', 'Thinking...');
    updateUI();

    const reply = await agentProvider.reply({
      settings,
      messages: state.messages.slice(0, -1).filter(m => m.role !== 'error'),
      inputText: transcript.trim(),
    });

    // 4. Add assistant message
    state.messages.push({ role: 'assistant', content: reply });
    renderConversation();

    // 5. Speak the reply
    if (reply.trim()) {
      setStatus('speaking', 'Speaking...');
      state.isSpeaking = true;
      updateUI();

      const ttsProvider = ttsProviders[settings.tts.provider];
      await ttsProvider.speak({ settings, text: reply });

      state.isSpeaking = false;
    }

    // 6. Return to idle
    setStatus('idle', 'Ready');
    updateUI();

    // 7. Continuous listening
    if (settings.app.continuousListening) {
      // Small delay to avoid capturing echo
      await new Promise(r => setTimeout(r, 300));
      startVoiceTurn();
    }

  } catch (err) {
    // AbortError means user cancelled — not a real error
    if (err.name === 'AbortError') return;
    console.error('Voice turn error:', err);
    cancelTTS();
    cancelSTT();
    state.isListening = false;
    state.isSpeaking = false;
    state.interimText = '';
    setStatus('error', 'Error');
    addErrorMessage(err.message || 'Something went wrong');
    renderConversation();
    updateUI();
    setTimeout(() => {
      if (state.status === 'error') setStatus('idle', 'Ready');
    }, 4000);
  }
}

function stopListening() {
  // For browser STT
  if (window.__activeRecognition) {
    window.__activeRecognition.stop();
    window.__activeRecognition = null;
  }
  // For HTTP STT (MediaRecorder)
  stopRecording();
  state.isListening = false;
}

function addErrorMessage(text) {
  state.messages.push({ role: 'error', content: text });
}

// ─── Event Handlers ──────────────────────────────────────

btnSettings.addEventListener('click', openSettings);
btnCloseSettings.addEventListener('click', closeSettings);
btnCancelSettings.addEventListener('click', closeSettings);
btnSaveSettings.addEventListener('click', trySaveSettings);

// Close modal on Escape only
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.hidden) closeSettings();
});

btnNewConvo.addEventListener('click', () => {
  state.messages = [];
  state.interimText = '';
  // Reset OpenCode session so a new one is created on next turn
  if (agentProviders.opencode._sessionId) {
    agentProviders.opencode._sessionId = null;
  }
  renderConversation();
});

btnToggleConvo.addEventListener('click', () => {
  state.conversationVisible = !state.conversationVisible;
  settings.app.showConversation = state.conversationVisible;
  saveSettings(settings);
  updateUI();
});

btnContinuous.addEventListener('click', () => {
  settings.app.continuousListening = !settings.app.continuousListening;
  saveSettings(settings);
  updateUI();
});

btnMic.addEventListener('click', () => {
  if (state.isListening) {
    stopListening();
  } else {
    startVoiceTurn();
  }
});

btnCancel.addEventListener('click', () => {
  cancelAgentRequest();
  cancelTTS();
  cancelSTT();
  state.isListening = false;
  state.isSpeaking = false;
  state.interimText = '';
  setStatus('idle', 'Cancelled');
  updateUI();
  renderConversation();
  setTimeout(() => {
    if (state.status === 'idle') setStatus('idle', 'Ready');
  }, 1500);
});

// ─── Init ────────────────────────────────────────────────

function init() {
  state.conversationVisible = settings.app.showConversation;
  setStatus('idle', 'Ready');
  updateProviderSummary();
  updateUI();
  renderConversation();

  // Pre-load voices for browser TTS
  if ('speechSynthesis' in window) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => speechSynthesis.getVoices());
  }
}

init();
