// providers.js — Provider definitions and runtime functions
// Each provider is a plain object with: label, fields, validate(), and the runtime method.

// ─── Helpers ─────────────────────────────────────────────

function checkContentType(response) {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  return { isJson: ct.includes('json'), isAudio: ct.includes('audio') || ct.includes('octet-stream'), raw: ct };
}

async function safeJsonParse(response) {
  const ct = checkContentType(response);
  if (ct.isJson) return response.json();
  const text = await response.text();
  try { return JSON.parse(text); } catch { throw new Error(`Unexpected response (${ct.raw}): ${text.slice(0, 200)}`); }
}

async function handleErrorResponse(response) {
  const clone = response.clone();
  let text;
  try {
    const body = await clone.json();
    const msg = body?.error?.message || body?.detail || JSON.stringify(body);
    throw new Error(msg);
  } catch (e) {
    if (e instanceof Error && e.message) {
      // Re-throw if we already built a message from JSON
      if (!e.message.startsWith('Unexpected token')) throw e;
    }
    text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
}

// Extract text from an OpenCode message.
// Shape: { info: { role }, parts: [{ type: "text", text: "..." }, { type: "step-start" }, ...] }
function extractOpenCodeText(msg) {
  const parts = msg?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n');
}

function recordAudio() {
  return new Promise((resolve, reject) => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          resolve(new Blob(chunks, { type: recorder.mimeType }));
        };
        recorder.onerror = e => { stream.getTracks().forEach(t => t.stop()); reject(e); };
        recorder.start();
        // Expose stop function on a global so the app can call it
        window.__activeRecorder = recorder;
      })
      .catch(reject);
  });
}

function stopRecording() {
  if (window.__activeRecorder && window.__activeRecorder.state === 'recording') {
    window.__activeRecorder.stop();
    window.__activeRecorder = null;
  }
}

// ─── AGENT PROVIDERS ─────────────────────────────────────

export const agentProviders = {
  openai: {
    label: 'OpenAI-Compatible',
    fields: [
      { key: 'url', label: 'Base URL', placeholder: 'http://localhost:11434/v1', required: true },
      { key: 'apiKey', label: 'API Key', placeholder: 'sk-... (optional for local)', required: false, type: 'password' },
      { key: 'model', label: 'Model', placeholder: 'gpt-4o', required: true },
      { key: 'personaPrompt', label: 'Persona / System Prompt', placeholder: 'You are a helpful assistant.', required: false, type: 'textarea' },
    ],
    validate(settings) {
      const s = settings.agent;
      if (!s.url?.trim()) return 'Base URL is required';
      if (!s.model?.trim()) return 'Model is required';
      return null;
    },
    async reply({ settings, messages, inputText }) {
      const s = settings.agent;
      const baseUrl = s.url.replace(/\/+$/, '');
      const chatMessages = [];
      if (s.personaPrompt?.trim()) {
        chatMessages.push({ role: 'system', content: s.personaPrompt.trim() });
      }
      for (const m of messages) {
        chatMessages.push({ role: m.role, content: m.content });
      }
      chatMessages.push({ role: 'user', content: inputText });

      const headers = { 'Content-Type': 'application/json' };
      if (s.apiKey?.trim()) headers['Authorization'] = `Bearer ${s.apiKey.trim()}`;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: s.model.trim(), messages: chatMessages }),
      });
      if (!res.ok) await handleErrorResponse(res);
      const data = await safeJsonParse(res);
      return data.choices?.[0]?.message?.content || '';
    },
  },

  opencode: {
    label: 'OpenCode',
    fields: [
      { key: 'url', label: 'Server URL', placeholder: 'http://localhost:4096', required: true },
      { key: 'apiKey', label: 'Password (optional)', placeholder: 'OPENCODE_SERVER_PASSWORD', required: false, type: 'password' },
      { key: 'model', label: 'Model Override', placeholder: 'opencode/gpt-5-nano', required: false },
      { key: 'personaPrompt', label: 'System Prompt Override', required: false, type: 'textarea' },
    ],
    // Session ID is stored per page lifecycle; _abort allows cancellation
    _sessionId: null,
    _abort: null,
    validate(settings) {
      const s = settings.agent;
      if (!s.url?.trim()) return 'Server URL is required';
      return null;
    },
    async reply({ settings, messages, inputText }) {
      const s = settings.agent;
      const baseUrl = s.url.replace(/\/+$/, '');

      // Auth headers (HTTP Basic: username defaults to "opencode")
      const headers = { 'Content-Type': 'application/json' };
      if (s.apiKey?.trim()) {
        headers['Authorization'] = 'Basic ' + btoa('opencode:' + s.apiKey.trim());
      }

      // Create session if we don't have one
      if (!this._sessionId) {
        const createRes = await fetch(`${baseUrl}/session`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'Voice Chat' }),
        });
        if (!createRes.ok) await handleErrorResponse(createRes);
        const session = await safeJsonParse(createRes);
        if (!session.id) throw new Error('OpenCode POST /session did not return an id');
        this._sessionId = session.id;
      }

      // Build request body — use default agent (no agent override)
      const body = {
        parts: [{ type: 'text', text: inputText }],
      };
      if (s.personaPrompt?.trim()) {
        body.system = s.personaPrompt.trim();
      }

      // Model override (format: "providerID/modelID") — validate against server
      if (s.model?.trim()) {
        const parts = s.model.trim().split('/');
        if (parts.length >= 2) {
          // Check if provider exists before sending model override
          if (!this._providers) {
            try {
              const pr = await fetch(`${baseUrl}/config/providers`, { headers });
              if (pr.ok) {
                const pd = await pr.json();
                const list = pd.providers || pd;
                this._providers = Array.isArray(list) ? list.map(p => p.id) : Object.keys(list);
              }
            } catch {}
          }
          const provId = parts[0];
          if (!this._providers || this._providers.includes(provId)) {
            body.model = { providerID: provId, modelID: parts.slice(1).join('/') };
          }
          // If provider not found, skip model override — use server default
        }
      }

      // Send message — POST blocks until agent completes and returns JSON
      this._abort = new AbortController();
      try {
        const text = await this._sendMessage(baseUrl, headers, body);
        if (text) return text;

        // Empty response — session may be stuck. Create a fresh one and retry once.
        this._sessionId = null;
        const retrySession = await fetch(`${baseUrl}/session`, {
          method: 'POST', headers, body: JSON.stringify({ title: 'Voice Chat' }),
          signal: this._abort.signal,
        });
        if (!retrySession.ok) await handleErrorResponse(retrySession);
        const s2 = await safeJsonParse(retrySession);
        if (!s2.id) throw new Error('OpenCode retry: no session id');
        this._sessionId = s2.id;

        const text2 = await this._sendMessage(baseUrl, headers, body);
        if (text2) return text2;
        throw new Error('OpenCode returned empty response. Check that your model is available — run /connect in OpenCode to add providers.');
      } finally {
        this._abort = null;
      }
    },
    async _sendMessage(baseUrl, headers, body) {
      const res = await fetch(`${baseUrl}/session/${this._sessionId}/message`, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: this._abort.signal,
      });
      if (!res.ok) await handleErrorResponse(res);
      const raw = await res.text();
      if (!raw.trim()) return ''; // empty body
      const data = JSON.parse(raw);
      return extractOpenCodeText(data);
    },
  },

  openpalm: {
    label: 'OpenPalm',
    fields: [
      { key: 'url', label: 'Endpoint URL', placeholder: 'Not yet specified', required: true },
      { key: 'apiKey', label: 'API Key', required: false, type: 'password' },
      { key: 'model', label: 'Model', required: false },
      { key: 'personaPrompt', label: 'Persona / System Prompt', required: false, type: 'textarea' },
    ],
    validate() { return 'OpenPalm API contract not yet confirmed — cannot use this provider'; },
    async reply() { throw new Error('OpenPalm provider is not yet implemented'); },
  },
};

// ─── STT PROVIDERS ───────────────────────────────────────

export const sttProviders = {
  browser: {
    label: 'Browser (Web Speech API)',
    mode: 'browser',
    fields: [
      { key: 'language', label: 'Language', placeholder: 'en-US', required: false },
    ],
    validate() {
      if (typeof window !== 'undefined' && !('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        return 'Browser does not support Speech Recognition';
      }
      return null;
    },
    transcribe({ settings, onInterim }) {
      return new Promise((resolve, reject) => {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SR();
        recognition.lang = settings.stt.language?.trim() || 'en-US';
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        let finalTranscript = '';
        recognition.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
            } else {
              interim += event.results[i][0].transcript;
            }
          }
          if (onInterim) onInterim(finalTranscript + interim);
        };
        recognition.onend = () => resolve(finalTranscript);
        recognition.onerror = (e) => {
          if (e.error === 'no-speech') return resolve('');
          reject(new Error(`Speech recognition error: ${e.error}`));
        };
        recognition.start();
        // Expose so the app can abort
        window.__activeRecognition = recognition;
      });
    },
  },

  tauri: {
    label: 'Tauri Bridge',
    mode: 'bridge',
    fields: [],
    validate() {
      if (typeof window === 'undefined' || !window.__TAURI__) return 'Not running inside Tauri';
      return null;
    },
    async transcribe() {
      const { invoke } = window.__TAURI__.core;
      const result = await invoke('voice_stt_transcribe');
      return result?.text || '';
    },
  },

  openai: {
    label: 'OpenAI-Compatible (Whisper)',
    mode: 'http',
    fields: [
      { key: 'url', label: 'Base URL', placeholder: 'https://api.openai.com/v1', required: true },
      { key: 'apiKey', label: 'API Key', required: false, type: 'password' },
      { key: 'model', label: 'Model', placeholder: 'whisper-1', required: true },
      { key: 'language', label: 'Language', placeholder: 'en (optional)', required: false },
    ],
    validate(settings) {
      const s = settings.stt;
      if (!s.url?.trim()) return 'Base URL is required';
      if (!s.model?.trim()) return 'Model is required';
      return null;
    },
    async transcribe({ settings, audioBlob }) {
      const s = settings.stt;
      const baseUrl = s.url.replace(/\/+$/, '');
      const formData = new FormData();
      formData.append('file', audioBlob, 'audio.webm');
      formData.append('model', s.model.trim());
      if (s.language?.trim()) formData.append('language', s.language.trim());

      const headers = {};
      if (s.apiKey?.trim()) headers['Authorization'] = `Bearer ${s.apiKey.trim()}`;

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: formData,
      });
      if (!res.ok) await handleErrorResponse(res);
      const data = await safeJsonParse(res);
      return data.text || '';
    },
  },

  elevenlabs: {
    label: 'ElevenLabs (Scribe)',
    mode: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, type: 'password' },
      { key: 'model', label: 'Model', placeholder: 'scribe_v2', required: false },
      { key: 'language', label: 'Language Code', placeholder: 'en (optional)', required: false },
    ],
    validate(settings) {
      const s = settings.stt;
      if (!s.apiKey?.trim()) return 'API Key is required for ElevenLabs';
      return null;
    },
    async transcribe({ settings, audioBlob }) {
      const s = settings.stt;
      const formData = new FormData();
      formData.append('model_id', s.model?.trim() || 'scribe_v2');
      formData.append('file', audioBlob, 'recording.webm');
      if (s.language?.trim()) formData.append('language_code', s.language.trim());

      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': s.apiKey.trim() },
        body: formData,
      });
      if (!res.ok) await handleErrorResponse(res);
      const data = await safeJsonParse(res);
      return data.text || '';
    },
  },

  deepgram: {
    label: 'Deepgram (Nova)',
    mode: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, type: 'password' },
      { key: 'model', label: 'Model', placeholder: 'nova-3', required: false },
      { key: 'language', label: 'Language', placeholder: 'en', required: false },
    ],
    validate(settings) {
      const s = settings.stt;
      if (!s.apiKey?.trim()) return 'API Key is required for Deepgram';
      return null;
    },
    async transcribe({ settings, audioBlob }) {
      const s = settings.stt;
      const model = s.model?.trim() || 'nova-3';
      const lang = s.language?.trim() || 'en';
      const params = new URLSearchParams({ model, language: lang, smart_format: 'true' });

      const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${s.apiKey.trim()}`,
          'Content-Type': audioBlob.type || 'audio/webm',
        },
        body: audioBlob,
      });
      if (!res.ok) await handleErrorResponse(res);
      const data = await safeJsonParse(res);
      return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    },
  },
};

// ─── TTS PROVIDERS ───────────────────────────────────────

export const ttsProviders = {
  browser: {
    label: 'Browser (Speech Synthesis)',
    mode: 'browser',
    fields: [
      { key: 'voice', label: 'Voice Name', placeholder: '(browser default)', required: false },
    ],
    validate() {
      if (typeof window !== 'undefined' && !('speechSynthesis' in window)) {
        return 'Browser does not support Speech Synthesis';
      }
      return null;
    },
    speak({ settings, text }) {
      return new Promise((resolve, reject) => {
        const synth = window.speechSynthesis;
        const utter = new SpeechSynthesisUtterance(text);
        const voiceName = settings.tts.voice?.trim();
        if (voiceName) {
          const voices = synth.getVoices();
          const match = voices.find(v => v.name.toLowerCase().includes(voiceName.toLowerCase()));
          if (match) utter.voice = match;
        }
        utter.onend = () => resolve();
        utter.onerror = (e) => reject(new Error(`TTS error: ${e.error}`));
        synth.speak(utter);
        // Expose so the app can cancel
        window.__activeTTS = { type: 'browser', synth };
      });
    },
  },

  tauri: {
    label: 'Tauri Bridge',
    mode: 'bridge',
    fields: [
      { key: 'voice', label: 'Voice', placeholder: '(optional)', required: false },
    ],
    validate() {
      if (typeof window === 'undefined' || !window.__TAURI__) return 'Not running inside Tauri';
      return null;
    },
    async speak({ settings, text }) {
      const { invoke } = window.__TAURI__.core;
      await invoke('voice_tts_speak', { text, voice: settings.tts.voice || undefined });
    },
  },

  openai: {
    label: 'OpenAI-Compatible',
    mode: 'http',
    fields: [
      { key: 'url', label: 'Base URL', placeholder: 'https://api.openai.com/v1', required: true },
      { key: 'apiKey', label: 'API Key', required: false, type: 'password' },
      { key: 'model', label: 'Model', placeholder: 'tts-1', required: true },
      { key: 'voice', label: 'Voice', placeholder: 'alloy', required: true },
    ],
    validate(settings) {
      const s = settings.tts;
      if (!s.url?.trim()) return 'Base URL is required';
      if (!s.model?.trim()) return 'Model is required';
      if (!s.voice?.trim()) return 'Voice is required';
      return null;
    },
    async speak({ settings, text }) {
      const s = settings.tts;
      const baseUrl = s.url.replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (s.apiKey?.trim()) headers['Authorization'] = `Bearer ${s.apiKey.trim()}`;

      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: s.model.trim(), input: text, voice: s.voice.trim() }),
      });
      if (!res.ok) await handleErrorResponse(res);

      const ct = checkContentType(res);
      if (ct.isJson) {
        const data = await res.json();
        throw new Error(data?.error?.message || 'Expected audio response but got JSON');
      }
      const audioBlob = await res.blob();
      return playAudioBlob(audioBlob);
    },
  },

  elevenlabs: {
    label: 'ElevenLabs',
    mode: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, type: 'password' },
      { key: 'voice', label: 'Voice ID', placeholder: 'e.g. 21m00Tcm4TlvDq8ikWAM', required: true },
      { key: 'model', label: 'Model', placeholder: 'eleven_multilingual_v2', required: false },
    ],
    validate(settings) {
      const s = settings.tts;
      if (!s.apiKey?.trim()) return 'API Key is required for ElevenLabs';
      if (!s.voice?.trim()) return 'Voice ID is required';
      return null;
    },
    async speak({ settings, text }) {
      const s = settings.tts;
      const model = s.model?.trim() || 'eleven_multilingual_v2';

      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voice.trim())}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': s.apiKey.trim(),
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
        }),
      });
      if (!res.ok) await handleErrorResponse(res);
      const audioBlob = await res.blob();
      return playAudioBlob(audioBlob);
    },
  },

  deepgram: {
    label: 'Deepgram (Aura)',
    mode: 'http',
    fields: [
      { key: 'apiKey', label: 'API Key', required: true, type: 'password' },
      { key: 'model', label: 'Voice Model', placeholder: 'aura-2-thalia-en', required: false },
    ],
    validate(settings) {
      const s = settings.tts;
      if (!s.apiKey?.trim()) return 'API Key is required for Deepgram';
      return null;
    },
    async speak({ settings, text }) {
      const s = settings.tts;
      const model = s.model?.trim() || 'aura-2-thalia-en';

      const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${s.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) await handleErrorResponse(res);
      const audioBlob = await res.blob();
      return playAudioBlob(audioBlob);
    },
  },
};

// ─── Audio playback helper ───────────────────────────────

function playAudioBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Audio playback failed')); };
    audio.play().catch(reject);
    window.__activeTTS = { type: 'audio', audio };
  });
}

// ─── Audio recording for HTTP STT providers ──────────────

export { recordAudio, stopRecording };

// ─── Cancel any active TTS ───────────────────────────────

export function cancelTTS() {
  const active = window.__activeTTS;
  if (!active) return;
  if (active.type === 'browser') {
    active.synth.cancel();
  } else if (active.type === 'audio') {
    active.audio.pause();
    active.audio.currentTime = 0;
  }
  window.__activeTTS = null;
}

// ─── Cancel active STT ───────────────────────────────────

export function cancelSTT() {
  if (window.__activeRecognition) {
    window.__activeRecognition.abort();
    window.__activeRecognition = null;
  }
  stopRecording();
}

// Cancel an in-flight OpenCode agent request
export function cancelAgentRequest() {
  if (agentProviders.opencode._abort) {
    agentProviders.opencode._abort.abort();
    agentProviders.opencode._abort = null;
  }
}
