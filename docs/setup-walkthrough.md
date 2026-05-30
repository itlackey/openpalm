# Setup Wizard Walkthrough

This walkthrough matches the current setup wizard. **The same wizard ships inside the Electron desktop app and is served by `openpalm install` for CLI users** — the screenshots below apply to both.

The wizard is served locally (default port 3880 for the desktop app, random localhost port for CLI). Re-run it any time from the admin overview → **Update Settings**, or by opening `/setup?rerun=1`.

---

## Step Map

The progress bar has 7 steps:

1. **System Check** — verifies Docker and Compose are installed and running; offers install links if missing
2. Welcome
3. Providers
4. Models
5. Voice
6. Options
7. Review

After Review, the wizard switches to a **Deploy** screen that shows image pull/start progress (phased: writing config → pulling images → starting → ready).

---

## Step 1: Welcome

The wizard auto-generates a secure admin password during setup. No name or
email fields are required.

Notes:

- A secure random password is generated automatically and displayed for you to copy.
- Save it before continuing — this is the password you will use to log in to the admin UI.
- The first screen includes a welcome hero; click **Get Started** to reveal the setup form.

---

## Step 2: Providers

You select one or more model providers and connect them.

Behavior depends on provider discovery mode:

- **OpenCode available:** provider list and auth methods are loaded dynamically from OpenCode.
- **Fallback mode:** built-in provider catalog is used.

Supported connection types include:

- API-key providers (for example OpenAI/Groq/Mistral/etc.)
- OAuth providers (when exposed by OpenCode)
- Local providers (for example Ollama/LM Studio/Model Runner)
- Custom OpenAI-compatible endpoint

You must have at least one verified provider to continue.

---

## Step 3: Models

You assign model roles from connected providers:

- Chat model (LLM, required)
- Embedding model (required)
- Small model (optional; defaults to chat model)

The wizard auto-picks defaults when possible and auto-fills known embedding dimensions for common embed models.

---

## Step 4: Voice

You choose TTS/STT options.

Examples include local and cloud options (depending on what is available). Voice is optional and can be adjusted later.

---

## Step 5: Options

You configure stack options before install:

- **Channels** (chat is always on)
- **Services** (for example admin)
- Optional in-stack Ollama toggle when relevant

---

## Step 6: Review

You review the full setup and can toggle a JSON preview.

Install action:

- Click **Install** to submit setup to `/api/setup/complete`.
- Setup writes managed runtime/config files under `~/.openpalm/`.

Important env behavior:

- Provider API keys and runtime capability values are written to `~/.openpalm/config/stack/stack.env`.
- `~/.openpalm/knowledge/vaults/user.env` remains an optional user-extension file.

---

## Deploy Screen

After install starts, the wizard shows deployment progress from `/api/setup/deploy-status`.

Typical core services shown are compose-derived (for example):

- assistant (includes the automation scheduler co-process)
- guardian
- plus enabled addons

Notes:

- There is no Caddy service in the current shipped core compose stack.
- On success, the wizard shows **Setup Complete** and links to `http://localhost:4096` (assistant/OpenCode console in the current implementation).
- On failure, an error card appears with retry/back-to-review actions and technical details.

---

## Troubleshooting During Setup

- If provider discovery is unavailable, the wizard falls back to built-in providers.
- If Docker is unavailable, install can complete config generation but deployment fails until Docker is running.
- If provider auth fails, expand the provider card and re-run connect/auth.

---

## Related Docs

- [Setup Guide](setup-guide.md)
- [Manual Compose Runbook](operations/manual-compose-runbook.md)
- [Manual Compose Runbook](operations/manual-compose-runbook.md)
- [Managing OpenPalm](managing-openpalm.md)
