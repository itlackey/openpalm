/* ================================================================
   OpenPalm Voice — App
   State machine: idle → recording → processing → idle
   Falls back to browser Speech APIs when server STT/TTS unavailable.
   ================================================================ */

;(function () {
  'use strict'

  // --- DOM refs ---
  var recordBtn = document.getElementById('record-btn')
  var log = document.getElementById('log')
  var statusEl = document.getElementById('status')
  var settingsBtn = document.getElementById('settings-btn')
  var settingsDialog = document.getElementById('settings-dialog')
  var settingsForm = document.getElementById('settings-form')
  var announcer = document.getElementById('announcer')
  var inputVoice = document.getElementById('setting-voice')
  var inputHaptic = document.getElementById('setting-haptic')
  var inputWakelock = document.getElementById('setting-wakelock')

  // --- State ---
  var state = 'idle'
  var recorder = null
  var chunks = []
  var wakeLock = null
  var audioCtx = null

  // --- Capabilities (populated on init from /api/health) ---
  var caps = {
    serverStt: false,
    serverTts: false,
    browserStt: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    browserTts: 'speechSynthesis' in window
  }

  // --- Settings ---
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('voice-settings') || '{}')
      inputVoice.value = s.voice || ''
      inputHaptic.checked = s.haptic !== false
      inputWakelock.checked = s.wakelock !== false
    } catch (_) {
      inputHaptic.checked = true
      inputWakelock.checked = true
    }
  }

  function saveSettings() {
    localStorage.setItem('voice-settings', JSON.stringify({
      voice: inputVoice.value,
      haptic: inputHaptic.checked,
      wakelock: inputWakelock.checked
    }))
  }

  function getSetting(key) {
    try {
      var s = JSON.parse(localStorage.getItem('voice-settings') || '{}')
      if (key === 'haptic') return s.haptic !== false
      if (key === 'wakelock') return s.wakelock !== false
      return s[key] || ''
    } catch (_) {
      return key === 'voice' ? '' : true
    }
  }

  // --- Utilities ---
  function escapeHtml(text) {
    var el = document.createElement('span')
    el.textContent = text
    return el.innerHTML
  }

  function announce(msg) {
    announcer.textContent = msg
  }

  function pickMimeType() {
    var types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    for (var i = 0; i < types.length; i++) {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(types[i])) {
        return types[i]
      }
    }
    return ''
  }

  function haptic(pattern) {
    if (getSetting('haptic') && navigator.vibrate) {
      navigator.vibrate(pattern)
    }
  }

  // --- UI Updates ---
  function setState(newState, statusMsg) {
    state = newState
    recordBtn.setAttribute('data-state', newState)
    statusEl.textContent = statusMsg || newState
    statusEl.setAttribute('aria-label', 'Status: ' + (statusMsg || newState))
    announce(statusMsg || newState)

    if (newState === 'idle') {
      recordBtn.setAttribute('aria-label', 'Start recording')
    } else if (newState === 'recording') {
      recordBtn.setAttribute('aria-label', 'Stop recording')
    } else if (newState === 'processing') {
      recordBtn.setAttribute('aria-label', 'Processing, please wait')
    }
  }

  // --- Simple markdown rendering (bold, italic, code, code blocks, lists) ---
  function renderMarkdown(text) {
    var escaped = escapeHtml(text)
    // Code blocks: ```...```
    escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code: `...`
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold: **...**
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic: *...*
    escaped = escaped.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    // Line breaks
    escaped = escaped.replace(/\n/g, '<br>')
    return escaped
  }

  function addLog(level, message) {
    var entry = document.createElement('div')
    entry.className = 'log-entry'
    entry.setAttribute('data-level', level)
    var rendered = (level === 'AI') ? renderMarkdown(message) : escapeHtml(message)
    entry.innerHTML = '<span class="log-label">' + escapeHtml(level) + '</span>' + rendered
    log.appendChild(entry)
    log.scrollTop = log.scrollHeight
  }

  // --- Wake Lock ---
  async function acquireWakeLock() {
    if (!getSetting('wakelock') || !('wakeLock' in navigator)) return
    try {
      wakeLock = await navigator.wakeLock.request('screen')
    } catch (_) {
      // Wake lock not available
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () {})
      wakeLock = null
    }
  }

  // --- Audio Playback ---
  function playBase64Audio(base64) {
    return new Promise(function (resolve, reject) {
      try {
        var binary = atob(base64)
        var bytes = new Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)()
        }
        audioCtx.decodeAudioData(bytes.buffer, function (buffer) {
          var source = audioCtx.createBufferSource()
          source.buffer = buffer
          source.connect(audioCtx.destination)
          source.onended = resolve
          source.start(0)
        }, function (err) {
          reject(err)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  // --- Strip markdown for TTS ---
  function stripMarkdownForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  // --- Browser TTS fallback ---
  function speakWithBrowser(text) {
    return new Promise(function (resolve) {
      if (!caps.browserTts) { resolve(); return }
      var utterance = new SpeechSynthesisUtterance(stripMarkdownForSpeech(text))
      var voice = getSetting('voice')
      if (voice) {
        var voices = speechSynthesis.getVoices()
        var match = voices.find(function (v) {
          return v.name.toLowerCase().indexOf(voice.toLowerCase()) !== -1
        })
        if (match) utterance.voice = match
      }
      utterance.onend = resolve
      utterance.onerror = resolve
      speechSynthesis.speak(utterance)
    })
  }

  // --- Browser STT ---
  function transcribeWithBrowser() {
    return new Promise(function (resolve, reject) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SR) { reject(new Error('Browser speech recognition not supported')); return }
      var recognition = new SR()
      recognition.lang = navigator.language || 'en-US'
      recognition.interimResults = false
      recognition.maxAlternatives = 1
      recognition.onresult = function (event) {
        var text = event.results[0][0].transcript
        resolve(text)
      }
      recognition.onerror = function (event) {
        reject(new Error('Speech recognition error: ' + event.error))
      }
      recognition.onend = function () {
        // If no result was captured, resolve with empty string
        resolve('')
      }
      recognition.start()
    })
  }

  // --- Recording (server STT path) ---
  async function startRecordingAudio() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      var mimeType = pickMimeType()
      recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined)

      recorder.ondataavailable = function (e) {
        if (e.data.size > 0) chunks.push(e.data)
      }

      recorder.start()
      setState('recording', 'recording')
      haptic(50)
      await acquireWakeLock()
    } catch (err) {
      addLog('ERR', 'Microphone access denied: ' + err.message)
      setState('idle', 'ready')
    }
  }

  async function stopRecordingAndSendAudio() {
    setState('processing', 'transcribing')
    haptic([30, 50, 30])
    releaseWakeLock()

    await new Promise(function (resolve) {
      recorder.onstop = function () {
        recorder.stream.getTracks().forEach(function (t) { t.stop() })
        resolve()
      }
      recorder.stop()
    })

    if (chunks.length === 0) {
      addLog('ERR', 'No audio recorded')
      setState('idle', 'ready')
      return
    }

    var detectedMime = pickMimeType()
    var blob = new Blob(chunks, { type: detectedMime || 'audio/webm' })
    chunks = []
    recorder = null

    var ext = detectedMime.indexOf('mp4') !== -1 ? 'm4a' : 'webm'
    var form = new FormData()
    form.append('audio', blob, 'recording.' + ext)
    await sendToServer(form)
  }

  // --- Recording (browser STT path) ---
  async function startBrowserSTT() {
    setState('recording', 'listening')
    haptic(50)
    await acquireWakeLock()

    try {
      var text = await transcribeWithBrowser()
      releaseWakeLock()

      if (!text || !text.trim()) {
        addLog('SYS', 'No speech detected')
        setState('idle', 'ready')
        return
      }

      setState('processing', 'processing')
      haptic([30, 50, 30])

      var form = new FormData()
      form.append('text', text.trim())
      await sendToServer(form)
    } catch (err) {
      releaseWakeLock()
      addLog('ERR', err.message)
      setState('idle', 'ready')
    }
  }

  // --- Send to server and handle response ---
  async function sendToServer(form) {
    try {
      addLog('TX', 'sending...')
      var response = await fetch('/api/pipeline', {
        method: 'POST',
        body: form
      })

      if (!response.ok) {
        var errBody = null
        try { errBody = await response.json() } catch (_) {}
        var errMsg = (errBody && errBody.error) || ('Server error ' + response.status)

        // If server STT failed for any reason, switch to browser STT for future recordings
        if (errBody && (errBody.code === 'stt_not_configured' || errBody.code === 'stt_error')) {
          caps.serverStt = false
          if (caps.browserStt) {
            addLog('SYS', 'Server STT unavailable, switching to browser speech recognition')
            addLog('SYS', 'Tap the microphone again to retry')
          } else {
            addLog('ERR', 'Server STT failed and browser speech recognition not available')
          }
          setState('idle', 'ready')
          return
        }

        addLog('ERR', errMsg)
        setState('idle', 'error')
        return
      }

      var data = await response.json()

      if (data.transcript) {
        addLog('YOU', data.transcript)
      }
      if (data.response) {
        addLog('AI', data.response)
      }

      // Play audio: server TTS if available, otherwise browser TTS
      if (data.audio) {
        try {
          await playBase64Audio(data.audio)
        } catch (err) {
          addLog('SYS', 'Audio decode failed, using browser voice')
          if (data.response) await speakWithBrowser(data.response)
        }
      } else if (data.response && caps.browserTts) {
        await speakWithBrowser(data.response)
      }

      setState('idle', 'ready')
      haptic(30)
    } catch (err) {
      addLog('ERR', 'Request failed: ' + err.message)
      setState('idle', 'offline')
    }
  }

  // --- Toggle recording ---
  function startRecording() {
    if (state !== 'idle') return
    if (caps.serverStt) {
      startRecordingAudio()
    } else if (caps.browserStt) {
      startBrowserSTT()
    } else {
      addLog('ERR', 'No speech recognition available (server STT not configured, browser API not supported)')
    }
  }

  function stopRecording() {
    if (state !== 'recording') return
    if (recorder) {
      stopRecordingAndSendAudio()
    }
    // Browser STT stops on its own (no manual stop needed)
  }

  function toggleRecording() {
    if (state === 'idle') {
      startRecording()
    } else if (state === 'recording') {
      stopRecording()
    }
  }

  // --- Event Handlers ---
  recordBtn.addEventListener('click', toggleRecording)

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault()
      toggleRecording()
    }
  })

  settingsBtn.addEventListener('click', function () {
    loadSettings()
    settingsDialog.showModal()
  })

  settingsForm.addEventListener('submit', function () {
    saveSettings()
  })

  // --- Online / Offline ---
  window.addEventListener('online', function () {
    if (state === 'idle') setState('idle', 'ready')
    addLog('SYS', 'Connection restored')
    checkCapabilities()
  })

  window.addEventListener('offline', function () {
    setState('idle', 'offline')
    addLog('SYS', 'Connection lost')
  })

  // --- Check server capabilities ---
  function checkCapabilities() {
    fetch('/api/health').then(function (res) {
      return res.json()
    }).then(function (data) {
      caps.serverStt = !!(data.stt && data.stt.configured)
      caps.serverTts = !!(data.tts && data.tts.configured)

      var sttSource = caps.serverStt ? 'server (' + data.stt.model + ')' : (caps.browserStt ? 'browser' : 'none')
      var ttsSource = caps.serverTts ? 'server (' + data.tts.model + ')' : (caps.browserTts ? 'browser' : 'none')
      addLog('SYS', 'STT: ' + sttSource + ' | TTS: ' + ttsSource)

      if (!caps.serverStt && !caps.browserStt) {
        addLog('ERR', 'No speech recognition available')
      }
    }).catch(function () {
      addLog('SYS', 'Server unreachable, using browser APIs')
      caps.serverStt = false
      caps.serverTts = false
    })
  }

  // --- Service Worker ---
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {})
  }

  // --- Init ---
  loadSettings()
  setState('idle', navigator.onLine ? 'ready' : 'offline')
  addLog('SYS', 'Voice channel ready. Tap the microphone or press Space to begin.')
  checkCapabilities()
})()
