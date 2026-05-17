<script lang="ts">
  import { onMount } from 'svelte';
  onMount(() => {
    const script = document.createElement('script');
    script.src = '/setup/wizard.js';
    document.body.appendChild(script);
    return () => { script.remove(); };
  });
</script>

<svelte:head>
  <title>OpenPalm Setup</title>
  <link rel="stylesheet" href="/setup/wizard.css">
</svelte:head>

<main class="setup-page" aria-label="Setup wizard">
  <div class="wizard-card">

    <div class="wizard-header">
      <div class="hdr-logo">OP</div>
      <h1>OpenPalm <span class="hdr-suffix">Setup</span></h1>
    </div>

    <div class="wizard-body">

      <nav class="prog-bar" aria-label="Wizard steps" id="step-indicators">
        <div class="prog-segments" id="prog-segments"></div>
        <div class="prog-labels" id="prog-labels"></div>
      </nav>

      <section class="step-content" id="step-0" data-testid="step-welcome">
        <div class="welcome-hero" id="welcome-hero">
          <div class="welcome-icon">👋</div>
          <h2>Welcome to OpenPalm</h2>
          <p class="welcome-subtitle">Your self-hosted AI assistant. Pick your providers, choose models, and you're up and running.</p>
          <div class="welcome-pills">
            <span class="pill">Cloud or local</span>
            <span class="pill">Smart defaults</span>
            <span class="pill">Privacy first</span>
          </div>
          <button class="btn btn-primary-lg" id="btn-get-started">Get Started</button>
        </div>
        <div class="identity-form hidden" id="identity-form">
          <h2>About You</h2>
          <p class="step-description">Set up admin credentials and optional identity details.</p>
          <div class="field-group">
            <label for="admin-token">Admin Token</label>
            <input id="admin-token" type="text" autocomplete="off" placeholder="Min 8 characters">
            <p class="field-hint">Protects the admin console. A random token has been generated for you.</p>
          </div>
          <div class="field-group">
            <label for="owner-name">Your Name</label>
            <input id="owner-name" type="text" placeholder="Jane Doe" autocomplete="name" required>
          </div>
          <div class="field-group">
            <label for="owner-email">Email</label>
            <input id="owner-email" type="email" placeholder="jane@example.com" autocomplete="email" required>
          </div>
          <div id="step0-error" class="field-error hidden" role="alert"></div>
          <div class="step-actions">
            <button class="btn btn-primary" id="btn-step0-next">Set Up Providers</button>
          </div>
        </div>
      </section>

      <section class="step-content hidden" id="step-1" data-testid="step-capabilities">
        <h2>Where should your models run?</h2>
        <p class="step-description">Select one or more providers. Click a card to configure it.</p>
        <div class="loading-state hidden" id="conn-detecting">
          <span class="spinner"></span>&nbsp;Detecting local providers...
        </div>
        <div class="provider-grid" id="provider-grid"></div>
        <div class="step-actions" id="step1-actions">
          <button class="btn btn-secondary" id="btn-step1-back">Back</button>
          <span class="nav-info" id="provider-count-info"></span>
          <button class="btn btn-primary" id="btn-step1-next" disabled>Choose Models</button>
        </div>
      </section>

      <section class="step-content hidden" id="step-2" data-testid="step-models">
        <h2>Choose Your Models</h2>
        <p class="step-description">Pre-selected from your providers. Adjust if needed.</p>
        <div id="model-groups"></div>
        <input type="hidden" id="llm-connection" value="">
        <input type="hidden" id="llm-model" value="">
        <input type="hidden" id="llm-small-model" value="">
        <input type="hidden" id="emb-connection" value="">
        <input type="hidden" id="emb-model" value="">
        <input type="hidden" id="emb-dims" value="1536">
        <div id="step2-error" class="field-error hidden" role="alert"></div>
        <div class="step-actions">
          <button class="btn btn-secondary" id="btn-step2-back">Back</button>
          <button class="btn btn-primary" id="btn-step2-next">Voice Setup</button>
        </div>
      </section>

      <section class="step-content hidden" id="step-3" data-testid="step-voice">
        <h2>Voice Capabilities</h2>
        <p class="step-description">Choose how your assistant speaks and listens.</p>
        <div id="voice-groups"></div>
        <div class="step-actions">
          <button class="btn btn-secondary" id="btn-step3-back">Back</button>
          <button class="btn btn-primary" id="btn-step3-next">Options</button>
        </div>
      </section>

      <section class="step-content hidden" id="step-4" data-testid="step-options">
        <h2>Options</h2>
        <p class="step-description">Choose channels, services, and tweak settings before review.</p>
        <div class="options-section">
          <h3 class="options-section-title">Channels</h3>
          <p class="options-section-desc">How you talk to your assistant. Web Chat is always on.</p>
          <div class="toggle-grid" id="channels-grid"></div>
        </div>
        <div class="options-section">
          <h3 class="options-section-title">Services</h3>
          <p class="options-section-desc">Extra capabilities for your stack.</p>
          <div class="toggle-grid" id="services-grid"></div>
        </div>
        <div class="addon-row hidden" id="ollama-addon">
          <div class="addon-toggle-row">
            <label class="addon-toggle-label">
              <input type="checkbox" id="ollama-enabled">
              <span class="addon-label-text">Run Ollama inside the stack</span>
            </label>
            <span class="addon-help">Adds an Ollama container to the compose stack so you do not need a separate install.</span>
          </div>
        </div>
        <div class="options-section">
          <h3 class="options-section-title">Search Reranking</h3>
          <p class="options-section-desc">Optionally rerank search results returned from the akm stash before they reach the assistant.</p>
          <div class="addon-toggle-row">
            <label class="addon-toggle-label">
              <input type="checkbox" id="reranking-enabled">
              <span class="addon-label-text">Enable reranking</span>
            </label>
            <span class="addon-help">Improves recall by reranking search results using an LLM. Uses the chat model by default.</span>
          </div>
          <div class="reranking-options hidden" id="reranking-options">
            <div class="field-group">
              <label for="reranking-mode">Reranking Mode</label>
              <select id="reranking-mode" class="field-select">
                <option value="llm" selected>LLM-based (use chat model)</option>
                <option value="dedicated">Dedicated reranker model</option>
              </select>
            </div>
            <div class="field-group hidden" id="reranking-model-group">
              <label for="reranking-model">Reranking Model</label>
              <input id="reranking-model" type="text" placeholder="e.g. BAAI/bge-reranker-v2-m3">
            </div>
            <div class="field-row">
              <div class="field-group field-group-half">
                <label for="reranking-top-k">Top K (candidates)</label>
                <input id="reranking-top-k" type="number" min="1" max="100" value="20">
              </div>
              <div class="field-group field-group-half">
                <label for="reranking-top-n">Top N (results)</label>
                <input id="reranking-top-n" type="number" min="1" max="50" value="5">
              </div>
            </div>
          </div>
        </div>
        <div id="step4-error" class="field-error hidden" role="alert"></div>
        <div class="step-actions">
          <button class="btn btn-secondary" id="btn-step4-back">Back</button>
          <button class="btn btn-primary" id="btn-step4-next">Review</button>
        </div>
      </section>

      <section class="step-content hidden" id="step-5" data-testid="step-review">
        <h2>Review &amp; Install</h2>
        <p class="step-description">Confirm your settings, then install.</p>
        <div id="review-summary"></div>
        <div class="review-json-toggle" id="review-json-toggle">
          <button class="btn-json-toggle" id="btn-toggle-json" type="button">Show Setup JSON</button>
        </div>
        <div class="review-json hidden" id="review-json">
          <pre id="review-json-pre"></pre>
        </div>
        <div id="install-error" class="install-error hidden" role="alert"></div>
        <div class="step-actions" id="review-actions">
          <button class="btn btn-secondary" id="btn-step5-back">Back</button>
          <button class="btn btn-primary" id="btn-install">Install</button>
        </div>
      </section>

      <section class="step-content hidden" id="step-deploy" data-testid="step-deploy">
        <div class="deploy-header">
          <h2 id="deploy-title">Deploying...</h2>
          <p class="step-description" id="deploy-subtitle">Writing configuration and starting services.</p>
        </div>
        <div class="deploy-progress-summary">
          <div class="deploy-progress-meta">
            <span class="deploy-progress-label" id="deploy-progress-label">Progress</span>
            <span class="deploy-progress-value" id="deploy-progress-value">0%</span>
          </div>
          <div class="deploy-progress-bar">
            <div class="deploy-progress-fill" id="deploy-progress-fill" style="width:0%"></div>
          </div>
          <p class="deploy-progress-note hidden" id="deploy-progress-note"></p>
        </div>
        <div class="deploy-services" id="deploy-services"></div>
        <div class="deploy-failure-card hidden" id="deploy-failure" role="alert">
          <div class="deploy-failure-header">
            <span class="deploy-failure-kicker">Error</span>
            <h3 id="deploy-failure-title">Deployment failed</h3>
          </div>
          <p class="deploy-failure-summary" id="deploy-failure-summary"></p>
          <details class="deploy-error-details">
            <summary>Technical details</summary>
            <pre id="deploy-error-pre"></pre>
          </details>
        </div>
        <aside class="deploy-tips" id="deploy-tips">
          <div class="deploy-tips-header">
            <span class="deploy-tips-kicker">Tips</span>
            <h3>First startup takes a few minutes</h3>
          </div>
          <ul>
            <li>Container images are being downloaded for the first time.</li>
            <li>The admin console will be available once all services are healthy.</li>
            <li>You can close this page; setup will continue in the background.</li>
          </ul>
        </aside>
        <div class="done-state hidden" id="deploy-done">
          <div class="done-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <h2>Setup Complete</h2>
          <p class="done-subtitle">Your OpenPalm stack is up and running.</p>
          <ul class="service-list" id="deploy-service-list"></ul>
          <a href="/chat" class="btn btn-primary">Open Chat</a>
        </div>
        <div class="step-actions hidden" id="deploy-error-actions">
          <button class="btn btn-secondary" id="btn-deploy-back">Back to Review</button>
          <button class="btn btn-primary" id="btn-deploy-retry">Retry</button>
        </div>
      </section>

    </div>
  </div>
</main>

