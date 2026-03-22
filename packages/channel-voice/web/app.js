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
  var inputContinuous = document.getElementById('setting-continuous')
  var continuousBtn = document.getElementById('continuous-btn')
  var tauriCore = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core : null
  var tauriInvoke = tauriCore && typeof tauriCore.invoke === 'function' ? tauriCore.invoke : null

  // --- State ---
  var state = 'idle'
  var continuous = false
  var recorder = null
  var recorderMimeType = ''
  var chunks = []
  var pcmAudioContext = null
  var pcmSourceNode = null
  var pcmProcessorNode = null
  var pcmGainNode = null
  var pcmSampleRate = 16000
  var pcmChunks = []
  var wakeLock = null
  var audioCtx = null

  // --- Capabilities (populated on init from /api/health) ---
  var caps = {
    serverStt: false,
    serverTts: false,
    nativeStt: false,
    nativeSttProvider: '',
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
      inputContinuous.checked = !!s.continuous
    } catch (_) {
      inputHaptic.checked = true
      inputWakelock.checked = true
      inputContinuous.checked = false
    }
  }

  function saveSettings() {
    localStorage.setItem('voice-settings', JSON.stringify({
      voice: inputVoice.value,
      haptic: inputHaptic.checked,
      wakelock: inputWakelock.checked,
      continuous: inputContinuous.checked
    }))
    setContinuous(inputContinuous.checked)
  }

  function getSetting(key) {
    try {
      var s = JSON.parse(localStorage.getItem('voice-settings') || '{}')
      if (key === 'haptic') return s.haptic !== false
      if (key === 'wakelock') return s.wakelock !== false
      if (key === 'continuous') return !!s.continuous
      return s[key] || ''
    } catch (_) {
      return key === 'voice' ? '' : (key === 'continuous' ? false : true)
    }
  }

  function setContinuous(enabled) {
    continuous = enabled
    continuousBtn.setAttribute('aria-pressed', String(enabled))
    if (enabled && state === 'idle') {
      startRecording()
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

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onloadend = function () {
        var result = typeof reader.result === 'string' ? reader.result : ''
        var comma = result.indexOf(',')
        resolve(comma === -1 ? result : result.slice(comma + 1))
      }
      reader.onerror = function () {
        reject(reader.error || new Error('Failed to read audio blob'))
      }
      reader.readAsDataURL(blob)
    })
  }

  function startPcmCapture(stream) {
    if (!(caps.nativeStt && !caps.serverStt)) return
    if (!window.AudioContext && !window.webkitAudioContext) return

    try {
      var Ctx = window.AudioContext || window.webkitAudioContext
      pcmAudioContext = new Ctx()
      pcmSampleRate = pcmAudioContext.sampleRate || 16000
      pcmChunks = []

      pcmSourceNode = pcmAudioContext.createMediaStreamSource(stream)
      pcmProcessorNode = pcmAudioContext.createScriptProcessor(4096, 1, 1)
      pcmGainNode = pcmAudioContext.createGain()
      pcmGainNode.gain.value = 0

      pcmProcessorNode.onaudioprocess = function (event) {
        if (!event.inputBuffer || event.inputBuffer.numberOfChannels < 1) return
        var input = event.inputBuffer.getChannelData(0)
        var copy = new Float32Array(input.length)
        copy.set(input)
        pcmChunks.push(copy)
      }

      pcmSourceNode.connect(pcmProcessorNode)
      pcmProcessorNode.connect(pcmGainNode)
      pcmGainNode.connect(pcmAudioContext.destination)
      addLog('SYS', 'PCM fallback capture armed (' + pcmSampleRate + 'Hz)')
    } catch (err) {
      addLog('ERR', 'PCM fallback unavailable: ' + err.message)
      stopPcmCapture(false)
    }
  }

  function stopPcmCapture(resetChunks) {
    if (pcmProcessorNode) {
      try { pcmProcessorNode.disconnect() } catch (_) {}
      pcmProcessorNode.onaudioprocess = null
      pcmProcessorNode = null
    }
    if (pcmSourceNode) {
      try { pcmSourceNode.disconnect() } catch (_) {}
      pcmSourceNode = null
    }
    if (pcmGainNode) {
      try { pcmGainNode.disconnect() } catch (_) {}
      pcmGainNode = null
    }
    if (pcmAudioContext) {
      try { pcmAudioContext.close() } catch (_) {}
      pcmAudioContext = null
    }
    if (resetChunks !== false) {
      pcmChunks = []
    }
  }

  function floatTo16BitPCM(view, offset, input) {
    for (var i = 0; i < input.length; i++, offset += 2) {
      var sample = Math.max(-1, Math.min(1, input[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
    }
  }

  function writeString(view, offset, text) {
    for (var i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  function buildWavBlobFromPcm() {
    if (!pcmChunks.length) return null

    var totalLength = 0
    for (var i = 0; i < pcmChunks.length; i++) {
      totalLength += pcmChunks[i].length
    }
    if (!totalLength) return null

    var merged = new Float32Array(totalLength)
    var offset = 0
    for (var j = 0; j < pcmChunks.length; j++) {
      merged.set(pcmChunks[j], offset)
      offset += pcmChunks[j].length
    }

    var bytesPerSample = 2
    var buffer = new ArrayBuffer(44 + merged.length * bytesPerSample)
    var view = new DataView(buffer)
    var sampleRate = pcmSampleRate || 16000
    var dataSize = merged.length * bytesPerSample

    writeString(view, 0, 'RIFF')
    view.setUint32(4, 36 + dataSize, true)
    writeString(view, 8, 'WAVE')
    writeString(view, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * bytesPerSample, true)
    view.setUint16(32, bytesPerSample, true)
    view.setUint16(34, 16, true)
    writeString(view, 36, 'data')
    view.setUint32(40, dataSize, true)
    floatTo16BitPCM(view, 44, merged)

    return new Blob([buffer], { type: 'audio/wav' })
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
      var gotResult = false
      recognition.onresult = function (event) {
        gotResult = true
        var text = event.results[0][0].transcript
        resolve(text)
      }
      recognition.onerror = function (event) {
        // no-speech and aborted are normal in continuous mode — treat as empty
        if (event.error === 'no-speech' || event.error === 'aborted') {
          resolve('')
        } else {
          reject(new Error('Speech recognition error: ' + event.error))
        }
      }
      recognition.onend = function () {
        if (!gotResult) resolve('')
      }
      recognition.start()
    })
  }

  function transcribeWithTauri(blob, mimeType) {
    if (!tauriInvoke) {
      return Promise.reject(new Error('Tauri native STT unavailable'))
    }
    return blobToBase64(blob).then(function (base64Audio) {
      return tauriInvoke('transcribe_audio', {
        base64Audio: base64Audio,
        mimeType: mimeType
      })
    })
  }

  // --- Recording (server/native STT path) ---
  async function startRecordingAudio() {
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      var mimeType = pickMimeType()
      recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined)
      recorderMimeType = recorder.mimeType || mimeType || 'audio/webm'
      startPcmCapture(stream)

      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data)
          addLog('SYS', 'Recorded audio chunk: ' + e.data.size + ' bytes')
        }
      }

      recorder.onerror = function (event) {
        var errorMessage = event && event.error && event.error.message
          ? event.error.message
          : 'unknown recorder error'
        addLog('ERR', 'Audio recorder error: ' + errorMessage)
      }

      recorder.start(250)
      setState('recording', 'recording')
      addLog('SYS', 'Recording started using ' + recorderMimeType)
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

    if (!recorder) {
      addLog('ERR', 'No active recorder')
      stopPcmCapture(true)
      setState('idle', 'ready')
      return
    }

    await new Promise(function (resolve) {
      var activeRecorder = recorder
      activeRecorder.onstop = function () {
        activeRecorder.stream.getTracks().forEach(function (t) { t.stop() })
        resolve()
      }

      if (typeof activeRecorder.requestData === 'function' && activeRecorder.state === 'recording') {
        try {
          activeRecorder.requestData()
        } catch (_) {}
      }

      setTimeout(function () {
        if (activeRecorder.state !== 'inactive') {
          activeRecorder.stop()
        }
      }, 100)
    })

    await new Promise(function (resolve) { setTimeout(resolve, 150) })
    stopPcmCapture(false)

    addLog('SYS', 'Recording stopped with ' + chunks.length + ' chunk(s)')

    if (chunks.length === 0) {
      if (caps.nativeStt && !caps.serverStt) {
        var wavBlob = buildWavBlobFromPcm()
        if (wavBlob && wavBlob.size > 0) {
          addLog('SYS', 'Using PCM fallback audio: ' + wavBlob.size + ' bytes (audio/wav)')
          try {
            var fallbackTranscript = await transcribeWithTauri(wavBlob, 'audio/wav')
            if (!fallbackTranscript || !fallbackTranscript.trim()) {
              if (continuous) {
                setState('idle', 'listening...')
                setTimeout(function () { startRecording() }, 300)
              } else {
                addLog('SYS', 'No speech detected')
                setState('idle', 'ready')
              }
              recorder = null
              pcmChunks = []
              return
            }

            var fallbackForm = new FormData()
            fallbackForm.append('text', fallbackTranscript.trim())
            pcmChunks = []
            recorder = null
            await sendToServer(fallbackForm)
            return
          } catch (fallbackErr) {
            addLog('ERR', 'PCM fallback STT failed: ' + fallbackErr.message)
          }
        }
      }

      addLog('ERR', 'No audio recorded')
      setState('idle', 'ready')
      recorder = null
      pcmChunks = []
      return
    }

    var detectedMime = recorderMimeType || pickMimeType() || 'audio/webm'
    var blob = new Blob(chunks, { type: detectedMime || 'audio/webm' })
    chunks = []
    recorder = null
    recorderMimeType = ''
    pcmChunks = []
    addLog('SYS', 'Preparing audio payload: ' + blob.size + ' bytes (' + detectedMime + ')')

    if (caps.nativeStt && !caps.serverStt) {
      try {
        var transcript = await transcribeWithTauri(blob, detectedMime || 'audio/webm')
        if (!transcript || !transcript.trim()) {
          if (continuous) {
            setState('idle', 'listening...')
            setTimeout(function () { startRecording() }, 300)
          } else {
            addLog('SYS', 'No speech detected')
            setState('idle', 'ready')
          }
          return
        }

        var nativeForm = new FormData()
        nativeForm.append('text', transcript.trim())
        await sendToServer(nativeForm)
        return
      } catch (err) {
        addLog('ERR', 'Desktop STT failed: ' + err.message)
        setState('idle', 'ready')
        return
      }
    }

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
        if (continuous) {
          setState('idle', 'listening...')
          setTimeout(function () { startRecording() }, 300)
        } else {
          addLog('SYS', 'No speech detected')
          setState('idle', 'ready')
        }
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
          if (caps.nativeStt) {
            addLog('SYS', 'Server STT unavailable, switching to desktop speech recognition')
            addLog('SYS', 'Tap the microphone again to retry')
          } else if (caps.browserStt) {
            addLog('SYS', 'Server STT unavailable, switching to browser speech recognition')
            addLog('SYS', 'Tap the microphone again to retry')
          } else {
            addLog('ERR', 'Server STT failed and no local speech recognition is available')
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

      // Auto-restart if continuous listening is on
      if (continuous) {
        setTimeout(function () { startRecording() }, 300)
      }
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
    } else if (caps.nativeStt) {
      startRecordingAudio()
    } else if (caps.browserStt) {
      startBrowserSTT()
    } else {
      addLog('ERR', 'No speech recognition available (server STT not configured, browser API not supported)')
    }
  }

  function stopRecording() {
    if (state !== 'recording') return
    // If user manually stops, also turn off continuous
    if (continuous) setContinuous(false)
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

  continuousBtn.addEventListener('click', function () {
    setContinuous(!continuous)
    // Persist to settings
    try {
      var s = JSON.parse(localStorage.getItem('voice-settings') || '{}')
      s.continuous = continuous
      localStorage.setItem('voice-settings', JSON.stringify(s))
    } catch (_) {}
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
    var serverCheck = fetch('/api/health').then(function (res) {
      return res.json()
    }).then(function (data) {
      caps.serverStt = !!(data.stt && data.stt.configured)
      caps.serverTts = !!(data.tts && data.tts.configured)
    }).catch(function () {
      addLog('SYS', 'Server unreachable, checking local APIs')
      caps.serverStt = false
      caps.serverTts = false
    })

    var nativeCheck = Promise.resolve().then(function () {
      if (!tauriInvoke) return
      return tauriInvoke('health').then(function (data) {
        caps.nativeStt = !!(data && data.sttProvider)
        caps.nativeSttProvider = data && data.sttProvider ? data.sttProvider : ''
      }).catch(function () {
        caps.nativeStt = false
        caps.nativeSttProvider = ''
      })
    })

    Promise.all([serverCheck, nativeCheck]).then(function () {
      var sttSource = caps.serverStt
        ? 'server'
        : (caps.nativeStt
          ? 'desktop (' + caps.nativeSttProvider + ')'
          : (caps.browserStt ? 'browser' : 'none'))
      var ttsSource = caps.serverTts ? 'server' : (caps.browserTts ? 'browser' : 'none')
      addLog('SYS', 'STT: ' + sttSource + ' | TTS: ' + ttsSource)

      if (!caps.serverStt && !caps.nativeStt && !caps.browserStt) {
        addLog('ERR', 'No speech recognition available')
      }
    })
  }

  // --- Service Worker ---
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {})
  }

  // --- Init ---
  loadSettings()
  continuous = getSetting('continuous')
  continuousBtn.setAttribute('aria-pressed', String(continuous))
  setState('idle', navigator.onLine ? 'ready' : 'offline')
  addLog('SYS', 'Voice channel ready. Tap the microphone or press Space to begin.')
  checkCapabilities()
})()
