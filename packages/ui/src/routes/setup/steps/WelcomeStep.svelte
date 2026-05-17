<script lang="ts">
  interface Props {
    adminToken: string;
    ownerName: string;
    ownerEmail: string;
    welcomeHeroDismissed: boolean;
    errorMessage: string;
    onadmintoken: (v: string) => void;
    onownername: (v: string) => void;
    onowneremail: (v: string) => void;
    ondismisshero: () => void;
    onnext: () => void;
  }
  let {
    adminToken,
    ownerName,
    ownerEmail,
    welcomeHeroDismissed,
    errorMessage,
    onadmintoken,
    onownername,
    onowneremail,
    ondismisshero,
    onnext,
  }: Props = $props();
</script>

{#if !welcomeHeroDismissed}
  <div class="welcome-hero" id="welcome-hero">
    <div class="welcome-icon">👋</div>
    <h2>Welcome to OpenPalm</h2>
    <p class="welcome-subtitle">Your self-hosted AI assistant. Pick your providers, choose models, and you're up and running.</p>
    <div class="welcome-pills">
      <span class="pill">Cloud or local</span>
      <span class="pill">Smart defaults</span>
      <span class="pill">Privacy first</span>
    </div>
    <button class="btn btn-primary-lg" id="btn-get-started" onclick={ondismisshero}>Get Started</button>
  </div>
{:else}
  <div class="identity-form" id="identity-form">
    <h2>About You</h2>
    <p class="step-description">Set up admin credentials and optional identity details.</p>
    <div class="field-group">
      <label for="admin-token">Admin Token</label>
      <input id="admin-token" type="text" autocomplete="off" placeholder="Min 8 characters"
        value={adminToken} oninput={(e) => onadmintoken((e.currentTarget as HTMLInputElement).value)}>
      <p class="field-hint">Protects the admin console. A random token has been generated for you.</p>
    </div>
    <div class="field-group">
      <label for="owner-name">Your Name</label>
      <input id="owner-name" type="text" placeholder="Jane Doe" autocomplete="name" required
        value={ownerName} oninput={(e) => onownername((e.currentTarget as HTMLInputElement).value)}>
    </div>
    <div class="field-group">
      <label for="owner-email">Email</label>
      <input id="owner-email" type="email" placeholder="jane@example.com" autocomplete="email" required
        value={ownerEmail} oninput={(e) => onowneremail((e.currentTarget as HTMLInputElement).value)}>
    </div>
    {#if errorMessage}
      <div class="field-error" id="step0-error" role="alert">{errorMessage}</div>
    {/if}
    <div class="step-actions">
      <button class="btn btn-primary" id="btn-step0-next" onclick={onnext}>Set Up Providers</button>
    </div>
  </div>
{/if}
