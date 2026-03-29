# GWS CLI Authentication Methods — Detailed Walkthroughs

## Table of Contents

1. [Interactive Setup (Desktop)](#1-interactive-setup-desktop)
2. [Manual OAuth (Google Cloud Console)](#2-manual-oauth-google-cloud-console)
3. [Browser-Assisted Auth](#3-browser-assisted-auth)
4. [Headless/CI (Export Flow)](#4-headlessci-export-flow)
5. [Service Account](#5-service-account)
6. [Pre-obtained Token](#6-pre-obtained-token)

---

## 1. Interactive Setup (Desktop)

The fastest method for first-time setup. Creates a Google Cloud project, enables APIs, and authenticates in one step. The user provides nothing — gws creates all credential files automatically.

### Prerequisites

- `gcloud` CLI installed and on PATH
- A Google account with permission to create Cloud projects
- Browser access

### Steps

1. Run the setup command:

   ```bash
   gws auth setup
   ```

   This will:
   - Create a new Google Cloud project (or use an existing one)
   - Enable the necessary Workspace APIs
   - Create an OAuth client and download `client_secret.json` automatically
   - Open a browser for user consent
   - Store encrypted `credentials.json` + `.encryption_key` in `~/.config/gws/`

2. For subsequent logins (e.g., token expired):

   ```bash
   gws auth login
   ```

### What gets created

After `gws auth setup`, the config directory contains:

```
~/.config/gws/
  client_secret.json    # OAuth app identity (auto-created by gws auth setup)
  credentials.json      # Encrypted user tokens (auto-created after consent)
  .encryption_key       # AES-256-GCM key for credential encryption
```

All three files must be copied to `vault/user/.gws/` for the container.

### Scope Filtering

Unverified OAuth apps are limited to approximately 25 scopes. If you hit this limit, filter to only the services you need:

```bash
gws auth login -s drive,gmail,sheets
```

### OpenPalm Integration

Copy the entire config directory to the vault:

```bash
cp -r ~/.config/gws/. ~/.openpalm/vault/user/.gws/
```

Or use the setup script which does this automatically:

```bash
scripts/gws-setup.sh    # Choose option 1
```

---

## 2. Manual OAuth (Google Cloud Console)

Use this when you need full control over the OAuth consent screen — for production apps, org-wide deployment, or when `gcloud` is not available.

The user must download a `client_secret.json` from Google Cloud Console. This file identifies the OAuth app but does NOT contain user tokens — those are generated in a later step.

### Steps

1. Go to [Google Cloud Console](https://console.cloud.google.com).

2. Create or select a project.

3. Navigate to **APIs & Services > OAuth consent screen**.

4. Configure the consent screen:
   - Set **User Type** to **External**
   - Fill in the required app information
   - Add the scopes you need (Drive, Gmail, Calendar, etc.)

5. **Add yourself as a test user** (critical step):
   - Go to **OAuth consent screen > Test users**
   - Click **Add users**
   - Enter your Google account email
   - Without this, login will fail with "Access blocked"

6. Create OAuth credentials:
   - Go to **APIs & Services > Credentials**
   - Click **Create Credentials > OAuth client ID**
   - Select **Desktop app** as the application type (NOT "Web application")
   - Click **Create**
   - Click **Download JSON** on the confirmation dialog

   The downloaded file is named something like `client_secret_123456789.apps.googleusercontent.com.json`.

7. Place the file where gws can find it:

   ```bash
   # For host use:
   mkdir -p ~/.config/gws
   cp ~/Downloads/client_secret_*.json ~/.config/gws/client_secret.json

   # For OpenPalm vault (direct):
   mkdir -p ~/.openpalm/vault/user/.gws
   cp ~/Downloads/client_secret_*.json ~/.openpalm/vault/user/.gws/client_secret.json
   ```

8. Run the login (this generates credentials.json):

   ```bash
   gws auth login
   ```

   This opens a browser. The user approves access, and gws stores encrypted credentials alongside the client secret.

### What the user provides vs what gws generates

| File | Source | Purpose |
|------|--------|---------|
| `client_secret.json` | **User downloads** from Cloud Console | Identifies the OAuth app to Google |
| `credentials.json` | **gws generates** after `gws auth login` | Contains the user's refresh + access tokens |
| `.encryption_key` | **gws generates** alongside credentials | Encrypts credentials at rest |

### Common Pitfalls

- **Forgetting to add test user**: The #1 cause of "Access blocked" errors. The consent screen must have your account listed as a test user when the app is in "Testing" mode.
- **Wrong application type**: Must be "Desktop app", not "Web application." Web app requires a redirect URI that gws doesn't use.
- **Missing scopes**: Add the scopes for each Workspace API you plan to use in the consent screen configuration.
- **Renaming the file wrong**: The file MUST be named exactly `client_secret.json` in the gws config directory.

---

## 3. Browser-Assisted Auth

For environments where a browser can be opened (either by a human or an automated agent). Uses an existing `client_secret.json` (from Interactive Setup or Manual OAuth).

### Human Flow

1. Run the login command:

   ```bash
   gws auth login
   ```

2. The CLI prints a URL. Open it in a browser.

3. Select your Google account, review the requested scopes, and click "Allow."

4. The CLI receives the callback and stores encrypted `credentials.json`.

### Agent Flow

An automated agent can handle this if it has browser automation capabilities:

1. Agent runs `gws auth login`
2. Agent captures the printed URL
3. Agent opens the URL (e.g., via Playwright, Puppeteer, or a browser MCP)
4. Agent selects the Google account
5. Agent handles the "Google hasn't verified this app" warning:
   - Click "Advanced"
   - Click "Go to [app name] (unsafe)"
6. Agent approves the requested scopes
7. Callback returns to gws, which stores credentials

### Notes

- Requires `client_secret.json` already in the config dir (from a previous `gws auth setup` or manual download).
- If the app is unverified, the browser will show a warning screen. The user (or agent) must click through "Advanced > Go to [app] (unsafe)" to proceed.
- After initial consent, subsequent logins may skip the consent screen if the token refreshes successfully.

---

## 4. Headless/CI (Export Flow)

For CI/CD pipelines, headless servers, or Docker containers without browser access. Authenticate on a desktop first, then export a plaintext `credentials.json` for the target machine.

This is the recommended approach for OpenPalm containers when the Interactive Setup or Manual OAuth was done on the host.

### Steps

1. On a machine with browser access, authenticate normally:

   ```bash
   gws auth login
   ```

2. Export credentials to a plaintext file:

   ```bash
   gws auth export --unmasked > credentials.json
   ```

   The `--unmasked` flag is required — it exports the full credential data (refresh token, access token, client ID, client secret). Without it, sensitive fields are masked and the file is unusable.

3. Place the exported file in the vault:

   ```bash
   cp credentials.json ~/.openpalm/vault/user/.gws/credentials.json
   chmod 600 ~/.openpalm/vault/user/.gws/credentials.json
   ```

   Or use the export script:

   ```bash
   scripts/gws-export.sh
   ```

4. The container's `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` env var points to `/etc/vault/.gws/credentials.json`, so gws will find it automatically.

### Why export instead of copying the config dir?

The encrypted credentials created by `gws auth login` may depend on the OS keyring or a machine-specific `.encryption_key`. These don't transfer reliably between machines or into containers. The export flow produces a self-contained plaintext file that works anywhere.

If you copy the full `.gws/` directory instead (including `.encryption_key`), that also works — gws can decrypt with the key file. But the export approach is simpler and avoids keyring issues.

### Security Considerations

- The exported `credentials.json` contains full OAuth tokens and client secrets in plaintext. Treat it like a password.
- In OpenPalm, `vault/user/` is the correct location — it's mounted read-write to the assistant at `/etc/vault/`.
- Set file permissions: `chmod 600 credentials.json`
- Rotate credentials regularly — tokens can expire or be revoked.

### CI/CD Example

```yaml
# GitHub Actions example
steps:
  - name: Setup GWS credentials
    run: |
      mkdir -p .gws
      echo "$GWS_CREDENTIALS" > .gws/credentials.json
      export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=.gws/credentials.json
      gws drive files list --params '{"pageSize": 1}'
    env:
      GWS_CREDENTIALS: ${{ secrets.GWS_CREDENTIALS }}
```

---

## 5. Service Account

For server-to-server operations without user context. Best for background jobs, admin operations, and automated pipelines. The user provides a single key file — no browser or login flow needed.

### Prerequisites

- A Google Cloud project with Workspace APIs enabled
- A service account with domain-wide delegation (if accessing user data)

### Steps

1. Create a service account in Google Cloud Console:
   - Go to **IAM & Admin > Service Accounts**
   - Click **Create Service Account**
   - Grant the necessary roles

2. Create and download a key:
   - Click the service account > **Keys** tab
   - Click **Add Key > Create new key > JSON**
   - Download the key file

   This file is the service account's identity. It contains a private key and is the only file you need.

3. (Optional) Enable domain-wide delegation if accessing user data:
   - Go to **Admin Console > Security > API controls > Domain-wide delegation**
   - Add the service account's client ID
   - Add the required OAuth scopes

4. Place the key in the vault:

   ```bash
   cp ~/Downloads/your-project-*.json ~/.openpalm/vault/user/gcloud-credentials.json
   ```

   The compose file maps this to `GOOGLE_APPLICATION_CREDENTIALS: /etc/vault/gcloud-credentials.json`.

### What the user provides

| File | Source | Vault location |
|------|--------|---------------|
| Service account key JSON | **User downloads** from Cloud Console > Service Accounts > Keys | `vault/user/gcloud-credentials.json` |

No other files are needed. No `client_secret.json`, no `credentials.json`, no `.encryption_key`.

### Limitations

- Service accounts do not have their own Drive, Gmail, etc. They need domain-wide delegation to act as a user.
- Without delegation, they can only access resources explicitly shared with the service account's email address.
- Not suitable for personal Google accounts — domain-wide delegation only works with Google Workspace (organization) accounts.

---

## 6. Pre-obtained Token

The simplest method for quick testing when you already have an access token from another tool (like `gcloud`). No files needed — just an environment variable.

### Steps

1. Get a token (e.g., from gcloud):

   ```bash
   export GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token)
   ```

2. Use gws immediately:

   ```bash
   gws drive files list --params '{"pageSize": 3}'
   ```

### For OpenPalm

Add to `vault/user/user.env`:

```bash
GOOGLE_WORKSPACE_CLI_TOKEN=ya29.a0ARrdaM...
```

Then recreate the assistant container. The token will be passed through as an environment variable.

### Limitations

- Access tokens expire after approximately 1 hour.
- No automatic refresh — you must re-export when the token expires.
- The token's scopes depend on how it was obtained. `gcloud` tokens may not include all Workspace scopes.
- Best for quick testing only, not for persistent use.

### Combining with gcloud Scopes

To get a token with specific Workspace scopes:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/gmail.readonly

export GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token)
```

---

## Authentication Precedence

gws checks credentials in this order. The first match wins:

1. **`GOOGLE_WORKSPACE_CLI_TOKEN`** — Raw access token (highest priority, set via user.env)
2. **`GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`** — Path to a credentials JSON (compose hardcodes to `/etc/vault/.gws/credentials.json`)
3. **Encrypted credentials** — In `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (compose hardcodes to `/etc/vault/.gws/`)
4. **Plaintext `credentials.json`** — In default config dir (lowest priority)

**Quirk:** If `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` is set but the file doesn't exist, gws fails immediately — it does NOT fall through to check the config dir. This is why the OpenPalm compose file only sets `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` (pointing to `/etc/vault/.gws/`) and omits `CREDENTIALS_FILE`. All auth methods work through the config dir: encrypted creds from `gws auth login`, plaintext exports placed as `credentials.json` in the dir, or service account keys.
