# Setup Wizard Walkthrough

A detailed, step-by-step walkthrough of every screen in the OpenPalm setup wizard. Use this alongside the [Setup Guide](setup-guide.md) for a complete picture of what to expect the first time you run OpenPalm.

> **Tip:** The wizard runs at `http://localhost:8100/setup` (or `http://localhost/setup` via Caddy) the first time you start the admin container. If you have already completed setup once, the wizard redirects to the admin console.

---

## Wizard Layout

Every screen shares the same card layout:

```
+--------------------------------------------------+
|         OpenPalm Setup Wizard                     |
|   Configure your OpenPalm stack in a few steps.   |
+--------------------------------------------------+
|                                                    |
|   (1)---(2)---(3)---(4)---(5)---(6)               |
|   Step progress dots                               |
|                                                    |
|   [ Current screen content ]                       |
|                                                    |
|                          [Back]  [Continue]         |
+--------------------------------------------------+
```

The six numbered dots across the top track your progress:

| Dot | Maps to screen(s) |
|-----|-------------------|
| 1 | Welcome |
| 2 | Connections Hub |
| 3 | Connection Type + Connection Details |
| 4 | Required Models |
| 5 | Optional Add-ons |
| 6 | Review and Install |

Completed dots turn green with a checkmark. You can click any completed dot to jump back and edit that step. The dots disappear on the final Deploying screen.

---

## Step 1: Welcome

**What you see:**

```
+--------------------------------------------------+
|                   Welcome                         |
|                                                    |
|  Start with your name and an admin token. Then     |
|  connect your models, choose defaults for chat     |
|  and memory, and let OpenPalm bring the stack      |
|  online for you.                                   |
|                                                    |
|  Your Name                                         |
|  +----------------------------------------------+ |
|  | Jane Doe                                      | |
|  +----------------------------------------------+ |
|  Used as the default Memory user ID.               |
|                                                    |
|  Email (optional)                                  |
|  +----------------------------------------------+ |
|  | jane@example.com                              | |
|  +----------------------------------------------+ |
|  For account identification. Not shared externally. |
|                                                    |
|  Admin Token                                       |
|  +----------------------------------------------+ |
|  | ********                                      | |
|  +----------------------------------------------+ |
|  This token protects your admin console. Keep it   |
|  safe -- you'll need it to log in.                 |
|                                                    |
|                                      [Start]       |
+--------------------------------------------------+
```

**Fields:**

| Field | Required | Notes |
|-------|----------|-------|
| Your Name | Yes | Used to derive the memory user ID (e.g., "Jane Doe" becomes `jane_doe`). |
| Email | No | Stored locally for identification. Never sent externally. |
| Admin Token | Yes | Must be at least 8 characters. This is the password you use to access the admin console. Choose something secure and save it somewhere safe. |

**What to do:** Fill in your name and a strong admin token, then click **Start**.

**Validation rules:**
- Name must not be empty.
- Admin token must not be empty and must be at least 8 characters.

**Common mistakes:**
- Using a short or trivial admin token. This token is the only thing protecting your admin console. Use something strong.
- Forgetting to save the admin token. There is no "forgot password" flow -- you would need to edit `secrets.env` manually.

---

## Step 2: Connections Hub

**What you see (first visit -- no connections yet):**

```
+--------------------------------------------------+
|                  Connections                       |
|                                                    |
|  Connections are reusable model endpoints. Start   |
|  with one, or mix local and remote providers if    |
|  you want the best of both.                        |
|                                                    |
|  +----------------------------------------------+ |
|  |           No connections yet                   | |
|  |                                                | |
|  |  Add a local model server like Ollama or LM    | |
|  |  Studio, or connect a hosted OpenAI-compatible  | |
|  |  provider.                                      | |
|  |                                                | |
|  |       [Add your first connection]              | |
|  +----------------------------------------------+ |
|                                                    |
|  [Back]  [Add connection]  [Continue (disabled)]   |
+--------------------------------------------------+
```

**What you see (after adding connections):**

```
+--------------------------------------------------+
|                  Connections                       |
|                                                    |
|  +----------------------------------------------+ |
|  | Ollama   [Local] [Tested]                     | |
|  | http://localhost:11434                         | |
|  |                      [Edit] [Duplicate] [Remove]|
|  +----------------------------------------------+ |
|  | OpenAI   [Remote] [Tested]                    | |
|  | https://api.openai.com                        | |
|  |                      [Edit] [Duplicate] [Remove]|
|  +----------------------------------------------+ |
|                                                    |
|  [Back]  [Add connection]  [Continue]              |
+--------------------------------------------------+
```

Each saved connection shows:
- **Name** (or provider name if no custom name was set)
- **Type badge**: "Local" or "Remote"
- **Tested badge**: Green checkmark if the connection was tested successfully
- **Base URL** in monospace
- **Actions**: Edit, Duplicate, Remove

**What to do:** Click **Add your first connection** (or **Add connection**) to go to the Connection Type screen. You need at least one connection before you can continue.

**Tips:**
- You can add multiple connections. For example, use Ollama for chat and OpenAI for embeddings.
- Duplicate lets you create a variant of an existing connection (e.g., same provider but different API key or base URL).
- The Continue button stays disabled until you have at least one connection.

---

## Step 3a: Connection Type

**What you see:**

```
+--------------------------------------------------+
|              Add a connection                      |
|                                                    |
|  Where are your models hosted?                     |
|                                                    |
|  +----------------------------------------------+ |
|  | [Cloud icon]                                   | |
|  | Remote OpenAI-compatible         [Hosted]      | |
|  | Best for OpenAI, Groq, Together, gateways,     | |
|  | and work proxies. Usually requires an API key   | |
|  | and starts with a provider default URL.          | |
|  | Recommended if you already use a hosted API     | |
|  | provider.                                    >  | |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  | [Server icon]                                  | |
|  | Local OpenAI-compatible        [On-Device]     | |
|  | Best for Ollama, LM Studio, and Docker Model   | |
|  | Runner. We will try to detect what is already   | |
|  | running on this machine first.                  | |
|  | Recommended for most self-hosted OpenPalm       | |
|  | setups.                                      >  | |
|  +----------------------------------------------+ |
|                                                    |
|  [Back]                                            |
+--------------------------------------------------+
```

**Two options:**

| Option | Best for | Needs API key? |
|--------|----------|---------------|
| **Remote OpenAI-compatible** | OpenAI, Groq, Together, Mistral, DeepSeek, xAI, Anthropic, hosted proxies | Usually yes |
| **Local OpenAI-compatible** | Ollama, LM Studio, Docker Model Runner | Usually no |

**What to do:** Click one of the two cards. The wizard advances to the Connection Details screen with defaults set for your choice.

**What happens behind the scenes:**
- **Remote**: Sets provider to OpenAI and pre-fills `https://api.openai.com` as the base URL.
- **Local**: Sets provider to Ollama, pre-fills `http://localhost:11434`, and immediately begins auto-detecting local providers running on your machine.

---

## Step 3b: Connection Details (Remote)

**What you see when you chose Remote:**

```
+--------------------------------------------------+
|             Connection details                     |
|                                                    |
|  Give this connection a friendly name, confirm     |
|  the endpoint details, and test it before saving.  |
|                                                    |
|  +----------------------------------------------+ |
|  | [Remote]  Remote connection                    | |
|  | Best for hosted providers, gateways, and work  | |
|  | proxies that expose an OpenAI-compatible API.  | |
|  | - Usually requires an API key.                 | |
|  | - We prefill the base URL using the selected   | |
|  |   provider when possible.                      | |
|  | - Good for OpenAI, Groq, Together, Mistral,    | |
|  |   and hosted proxies.                          | |
|  +----------------------------------------------+ |
|                                                    |
|  Connection name                                   |
|  +----------------------------------------------+ |
|  | e.g., "LM Studio local", "Work proxy"         | |
|  +----------------------------------------------+ |
|                                                    |
|  [OpenAI] [Anthropic] [Groq] [Together]           |
|  [Mistral] [DeepSeek] [xAI]                       |
|                                                    |
|  API key                                           |
|  +----------------------------------------------+ |
|  | Paste your API key                            | |
|  +----------------------------------------------+ |
|  Your key stays server-side and will be reused     |
|  whenever this connection is selected.             |
|                                                    |
|  Base URL                                          |
|  +----------------------------------------------+ |
|  | https://api.openai.com                        | |
|  +----------------------------------------------+ |
|  Enter the server base URL without a trailing /v1  |
|  (OpenPalm adds /v1 automatically when needed).   |
|                                                    |
|  [Cancel]  [Test Connection]  [Save connection]    |
+--------------------------------------------------+
```

**Provider chip bar:** Click any provider chip to switch. This auto-updates the base URL:

| Provider | Default Base URL |
|----------|-----------------|
| OpenAI | `https://api.openai.com` |
| Anthropic | (no default) |
| Groq | `https://api.groq.com/openai` |
| Together | `https://api.together.xyz` |
| Mistral | `https://api.mistral.ai` |
| DeepSeek | `https://api.deepseek.com` |
| xAI | `https://api.x.ai` |

**Fields:**

| Field | Required | Notes |
|-------|----------|-------|
| Connection name | Yes (auto-filled from provider if left blank) | A friendly name shown throughout the wizard. |
| API key | Yes (for most cloud providers) | Stored server-side in `secrets.env`. Masked in the review screen. |
| Base URL | Auto-filled | Do NOT include `/v1` at the end. The wizard warns you if you do. |

**What to do:**
1. Pick your provider from the chip bar (it pre-fills the URL).
2. Paste your API key.
3. Optionally give the connection a custom name.
4. Click **Test Connection** -- the wizard calls the provider's models endpoint and shows a green success message with the number of models found.
5. Click **Save connection** to return to the Connections Hub.

**Auto-test behavior:** The wizard automatically tests the connection about 800ms after you stop typing in the API key field, so you may see the test happen without clicking the button.

**Common mistakes:**
- Including `/v1` at the end of the Base URL. The wizard shows a yellow warning if it detects this.
- Pasting an expired or incorrect API key. The Test Connection button will show the error.
- Forgetting to name the connection. The wizard auto-names it after the provider, but a custom name helps when you have multiple connections to the same provider.

---

## Step 3b: Connection Details (Local)

**What you see when you chose Local:**

```
+--------------------------------------------------+
|             Connection details                     |
|                                                    |
|  Give this connection a friendly name, confirm     |
|  the endpoint details, and test it before saving.  |
|                                                    |
|  +----------------------------------------------+ |
|  | [Local]  Local connection                      | |
|  | Best for Ollama, LM Studio, and Docker Model  | |
|  | Runner running on this machine or your LAN.   | |
|  | - Usually does not need an API key.            | |
|  | - We try to detect running local providers     | |
|  |   automatically.                               | |
|  | - Use a localhost or LAN address that this     | |
|  |   host can reach.                              | |
|  +----------------------------------------------+ |
|                                                    |
|  [spinner] Detecting local providers...            |
|                                                    |
|  (After detection:)                                |
|  +----------------------------------------------+ |
|  | [green dot] Ollama                             | |
|  | Detected at http://localhost:11434             | |
|  +----------------------------------------------+ |
|                                                    |
|  Connection name                                   |
|  +----------------------------------------------+ |
|  | Ollama                                        | |
|  +----------------------------------------------+ |
|                                                    |
|  Base URL                                          |
|  +----------------------------------------------+ |
|  | http://localhost:11434                         | |
|  +----------------------------------------------+ |
|                                                    |
|  [Connected -- 12 models found.]                   |
|                                                    |
|  [Cancel]  [Test Connection]  [Save connection]    |
+--------------------------------------------------+
```

**Local provider auto-detection:** When you choose "Local", the wizard probes common local endpoints to see what is already running:

| Provider | Detection URL |
|----------|--------------|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234` |
| Docker Model Runner | `http://localhost:12434` |

Detected providers appear as clickable buttons with a green status dot. Click one to auto-fill its URL and name.

**If Ollama is not detected:** The wizard shows an "Enable Ollama" section:

```
+----------------------------------------------+
| Ollama not detected                           |
|                                                |
| We can add Ollama to your stack and pull two  |
| small default models (llama3.2:latest +       |
| nomic-embed-text).                            |
|                                                |
| [Enable Ollama]                               |
+----------------------------------------------+
```

Clicking **Enable Ollama** adds an Ollama service to your Docker Compose stack, starts it, and pulls two default models. This can take several minutes. A progress indicator shows the current status. Once complete:
- The connection is automatically marked as tested.
- Default chat and embedding models are pre-selected.
- You return to the Connections Hub automatically.

**If no providers are detected at all:** A manual provider dropdown appears letting you choose Ollama, LM Studio, or Docker Model Runner and type the base URL yourself.

**Common mistakes:**
- Ollama is not running. Start it before running the wizard, or use the Enable Ollama button.
- Using `localhost` when OpenPalm runs in Docker. If the admin container cannot reach `localhost:11434`, use `host.docker.internal:11434` instead (the Enable Ollama path handles this automatically).

---

## Step 4: Required Models

**What you see:**

```
+--------------------------------------------------+
|              Required models                       |
|                                                    |
|  Choose the default chat, small, and embedding     |
|  models OpenPalm should use first. You can change  |
|  them later from the admin UI.                     |
|                                                    |
|  +----------------------------------------------+ |
|  | Chat model (LLM)                              | |
|  | This model is used for responses and tool use  | |
|  | in supported apps.                             | |
|  |                                                | |
|  | Connection                                     | |
|  | [ Ollama                              v ]      | |
|  |                                                | |
|  | Chat model                                     | |
|  | [ llama3.2:latest                     v ]      | |
|  |                                                | |
|  | Small model (for lightweight tasks)            | |
|  | [ llama3.2:latest                     v ]      | |
|  | Memory uses this model by default during       | |
|  | setup.                                         | |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  | Embeddings                                     | |
|  | Used for vector search / memory features.      | |
|  |                                                | |
|  | Connection                                     | |
|  | [ Ollama                              v ]      | |
|  |                                                | |
|  | Embedding model                                | |
|  | [ nomic-embed-text                    v ]      | |
|  | Used for memory vector embeddings. The list     | |
|  | prefers embedding-capable models.               | |
|  | Dimensions auto-detected for this model: 768.  | |
|  |                                                | |
|  | Embedding dimensions                            | |
|  | [ 768                                         ] | |
|  | Only set this if you know your embedder's       | |
|  | output dimensions.                              | |
|  +----------------------------------------------+ |
|                                                    |
|  Add connection (link)                             |
|                                                    |
|  [Back]                              [Continue]    |
+--------------------------------------------------+
```

This screen has two cards:

### Chat Model (LLM) Card

| Field | Purpose |
|-------|---------|
| Connection | Which connection to use for chat. Dropdown of all your saved connections. |
| Chat model | The primary model for AI responses and tool use. Shows a dropdown if models were fetched, or a text input for manual entry. |
| Small model | A lighter model for background tasks like memory extraction. Defaults to the same as the chat model. Memory uses this model by default. |

### Embeddings Card

| Field | Purpose |
|-------|---------|
| Connection | Which connection to use for embeddings (can be the same or different from the chat connection). |
| Embedding model | Model for generating vector embeddings. The dropdown filters to show embedding-capable models first. |
| Embedding dimensions | Auto-detected when possible. Only change this if you know your model uses different dimensions. |

**Smart defaults:** If you have only one connection, the wizard pre-selects it for both LLM and embeddings and picks the most likely chat and embedding models from the available model list.

**Auto-detection of embedding dimensions:** When you select a known embedding model (e.g., `nomic-embed-text` on Ollama or `text-embedding-3-small` on OpenAI), the wizard auto-fills the correct dimensions and shows a hint like "Dimensions auto-detected for this model: 768."

**The "Add connection" link** at the bottom lets you add another connection without going back. This is useful if you want to use one provider for chat and another for embeddings.

**Validation before continuing:**
- A chat connection must be selected.
- An embedding connection must be selected.
- A chat model must be specified.
- An embedding model must be specified.

**Common mistakes:**
- Leaving the embedding model empty. The wizard validates this before letting you continue.
- Setting wrong embedding dimensions. If the wizard auto-detects dimensions, trust the auto-detected value. Mismatched dimensions will cause memory features to fail.
- Using a chat model as the embedding model (or vice versa). The dropdown filters help, but if typing manually, make sure you pick an embedding-specific model like `nomic-embed-text` or `text-embedding-3-small`.

---

## Step 5: Optional Add-ons

**What you see:**

```
+--------------------------------------------------+
|             Optional add-ons                       |
|                                                    |
|  Enable only what you want right now. Leaving      |
|  everything off is perfectly fine.                  |
|                                                    |
|  +----------------------------------------------+ |
|  | [ ] Enable reranking                           | |
|  |  Improves search result relevance by           | |
|  |  re-ordering retrieved items.                  | |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  | [ ] Enable text-to-speech                      | |
|  |  Turns responses into audio.                   | |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  | [ ] Enable speech-to-text                      | |
|  |  Transcribes audio into text.                  | |
|  +----------------------------------------------+ |
|                                                    |
|  [Back]                              [Continue]    |
+--------------------------------------------------+
```

Each add-on is a collapsible section. Checking the box expands configuration fields for that add-on.

### Reranking (when enabled)

| Field | Purpose |
|-------|---------|
| Reranker type | "Use an LLM to rerank" or "Use a dedicated reranker" (radio buttons) |
| Connection | Which connection provides the reranking model |
| Model | The reranking model (e.g., `rerank-2`) |
| Top N results | How many results to keep after reranking (default: 5) |

### Text-to-Speech (when enabled)

| Field | Purpose |
|-------|---------|
| Connection | Which connection provides TTS |
| Model (optional) | TTS model (e.g., `tts-1`) |
| Voice (optional) | Voice name (e.g., `alloy`) |
| Output format (optional) | Audio format (e.g., `mp3`) |

### Speech-to-Text (when enabled)

| Field | Purpose |
|-------|---------|
| Connection | Which connection provides STT |
| Model (optional) | STT model (e.g., `whisper-1`) |
| Language (optional) | Language code (e.g., `en`) |

**What to do:** Toggle on any add-ons you want, fill in the fields, and click **Continue**. Or leave everything off and click **Continue** -- all add-ons are optional and can be configured later from the admin UI.

**Tip:** Most users skip this step on first setup. You can always enable add-ons later through the admin Connections page.

---

## Step 6: Review and Install

**What you see:**

```
+--------------------------------------------------+
|            Review your setup                       |
|                                                    |
|  Confirm connections and model selections. You     |
|  can edit anything before saving.                  |
|                                                    |
|  Account                                  [Edit]   |
|  -----------------------------------------         |
|  Name          Jane Doe                            |
|  Email         jane@example.com                    |
|  Admin Token   Set                                 |
|                                                    |
|  Connections                              [Edit]   |
|  -----------------------------------------         |
|  Provider      Local -- Ollama                     |
|  Base URL      http://ollama:11434                 |
|  Ollama        Enabled (in-stack)                  |
|                                                    |
|  Required models                          [Edit]   |
|  -----------------------------------------         |
|  Chat Model    llama3.2:latest (Ollama)            |
|  Small Model   llama3.2:latest (Ollama)            |
|  Embedding     nomic-embed-text (Ollama)           |
|    Model                                           |
|  Memory Model  llama3.2:latest (Ollama)            |
|  Embedding     768                                 |
|    Dimensions                                      |
|  Memory        jane_doe                            |
|    User ID                                         |
|                                                    |
|  Optional add-ons                         [Edit]   |
|  -----------------------------------------         |
|  None configured                                   |
|                                                    |
|  Config Exports                                    |
|  -----------------------------------------         |
|  OpenCode config    [Download opencode.json]       |
|  Mem0 config        [Download mem0-config.json]    |
|                                                    |
|  [Back]                                  [Save]    |
+--------------------------------------------------+
```

The review screen is divided into sections, each with an **Edit** button that jumps back to the relevant wizard step:

| Section | Edit jumps to |
|---------|--------------|
| Account | Step 1 (Welcome) |
| Connections | Step 2 (Connections Hub) |
| Required models | Step 4 (Required Models) |
| Optional add-ons | Step 5 (Optional Add-ons) |

### What is shown

- **Account**: Your name, email (if provided), and whether the admin token is set.
- **Connections**: Each connection with its type (Local/Cloud), provider name, API key (masked as `sk-...last4`), and base URL.
- **Ollama**: Shows "Enabled (in-stack)" if you used the Enable Ollama feature.
- **Required models**: Chat model, small model, embedding model, memory model (defaults to the small model), embedding dimensions, and memory user ID.
- **Optional add-ons**: Shows configuration for each enabled add-on, or "None configured" if all are off.

### Config Exports

Two download buttons let you export generated configuration files before installing:
- **Download opencode.json** -- OpenCode configuration with your model selections
- **Download mem0-config.json** -- Memory service configuration

These are useful for backup or for manual configuration outside the wizard.

### Installing

Click **Save** to begin installation. The wizard:
1. Sends all your configuration to the admin API (`POST /admin/setup`).
2. Generates and writes configuration files (`secrets.env`, `stack.env`, connection profiles, OpenCode config, memory config).
3. Assembles the Docker Compose stack.
4. Transitions to the Deploying screen.

**Common mistakes:**
- Not reviewing the embedding dimensions. If they are wrong, memory features will not work correctly after setup.
- Clicking Save with an unreachable provider. The wizard does not re-test connections at this point -- make sure your providers are still running.

---

## Step 7: Deploying

**What you see during deployment:**

```
+--------------------------------------------------+
|          Setting Up Your Stack                     |
|                                                    |
|  Pulling container images...                       |
|                                                    |
|  Overall progress                          45%     |
|  [==================                          ]    |
|  Pulling caddy image...                            |
|                                                    |
|  [check] Admin         Running                     |
|  [==========================================] 100% |
|                                                    |
|  [check] Caddy         Image ready                 |
|  [============================            ]  70%   |
|                                                    |
|  [spinner] Guardian     Pulling image...           |
|  [=============                           ]  30%   |
|                                                    |
|  [spinner] Assistant    Pulling image...           |
|  [========                                ]  20%   |
|                                                    |
|  [spinner] Memory       Pulling image...           |
|  [=====                                   ]  15%   |
|                                                    |
|  Tips while you wait                               |
|  What is happening right now?                      |
|  - First startup is the slowest because container  |
|    images still need to download.                  |
|  - You can keep this tab open while the stack      |
|    comes online.                                   |
|  - If a provider is local, make sure it is still   |
|    running on this machine.                        |
+--------------------------------------------------+
```

The deploying screen does not show the step dots. It has three phases:

### Phase 1: Pulling

The wizard polls `GET /admin/setup/deploy-status` every 2 seconds. Each service shows:
- A **spinner** while its image is being pulled
- A **checkmark** once the image is ready
- A progress bar filling from left to right

**Phase message**: "Pulling container images..."

### Phase 2: Starting

After all images are pulled, services start up:

**Phase message**: "Starting services..."

Each service's progress bar completes and status changes to "Running" as its container comes online.

### Phase 3: Ready

```
+--------------------------------------------------+
|          Setting Up Your Stack                     |
|                                                    |
|  All services are up and running.                  |
|                                                    |
|  Overall progress                         100%     |
|  [==========================================]      |
|                                                    |
|  [check] Admin         Running                     |
|  [check] Caddy         Running                     |
|  [check] Guardian      Running                     |
|  [check] Assistant     Running                     |
|  [check] Memory        Running                     |
|                                                    |
|  Tips while you wait                               |
|  - Your core services are online and ready for     |
|    the console.                                    |
|  - You can revisit Connections later to swap        |
|    models or add more providers.                   |
|                                                    |
|                         [Go to Console]            |
+--------------------------------------------------+
```

When all services are running, the **Go to Console** button appears. Click it to open the admin dashboard at `http://localhost/`.

### Error State

If deployment fails, the wizard shows a diagnostic summary:

```
+--------------------------------------------------+
|          Setting Up Your Stack                     |
|                                                    |
|  OpenPalm could not finish starting.               |
|                                                    |
|  Overall progress              Needs attention     |
|  [====================                        ]    |
|                                                    |
|  +----------------------------------------------+ |
|  | Setup needs attention                         | |
|  |                                                | |
|  | OpenPalm could not finish starting the stack  | |
|  |                                                | |
|  | Error response from daemon: ...               | |
|  |                                                | |
|  | - Go back to Review to adjust settings, then  | |
|  |   try again.                                  | |
|  | - Open Technical details if you need the raw  | |
|  |   Docker error for troubleshooting.           | |
|  +----------------------------------------------+ |
|                                                    |
|  [> Technical details]                             |
|      (expandable raw error output)                 |
|                                                    |
|  [Back to Review]              [Try Again]         |
+--------------------------------------------------+
```

The error card includes:
- A human-readable summary of what went wrong
- Recovery steps tailored to the type of error
- A collapsible "Technical details" section with the full Docker error output

**Recovery options:**
- **Back to Review**: Returns to Step 6 so you can edit settings.
- **Try Again**: Resubmits the current configuration for another deployment attempt.

**Common deployment errors:**

| Error | Likely cause | Fix |
|-------|-------------|-----|
| "Docker is not available" | Docker daemon stopped | Start Docker, then Try Again |
| "Error mounting..." | Stale mount paths from previous failed run | Reset dev environment or clear STATE_HOME |
| Network/timeout errors | Slow internet or unreachable registry | Wait and Try Again, or check network |

---

## After the Wizard

Once you click **Go to Console**, you are taken to the admin dashboard. From there:

- **Connections page**: Edit connections, add new providers, re-test endpoints
- **Memory page**: View and manage memory entries
- **Channels page**: Install channels from the registry (Discord, API, etc.)
- **Containers page**: Monitor service status, restart services

If you ever need to re-run the wizard from scratch, delete the setup state file:

```bash
# Default path:
rm ~/.local/share/openpalm/admin/setup-state.json

# Dev environment:
rm .dev/data/admin/setup-state.json
```

Then restart the admin container and navigate to `/setup`.

---

## Quick Reference: Wizard Flow Summary

```
  [1. Welcome]
       |
       | Enter name, email, admin token
       v
  [2. Connections Hub]  <---------+
       |                          |
       | Add connection           | (Add another)
       v                          |
  [3a. Connection Type]           |
       |                          |
       | Choose Remote or Local   |
       v                          |
  [3b. Connection Details]        |
       |                          |
       | Configure, test, save ---+
       v
  [4. Required Models]
       |
       | Pick chat + embedding models
       v
  [5. Optional Add-ons]
       |
       | Toggle reranking, TTS, STT
       v
  [6. Review & Install]
       |
       | Confirm and click Save
       v
  [7. Deploying]
       |
       | Wait for images + containers
       v
  [Admin Console]
```

---

## See Also

- [Setup Guide](setup-guide.md) -- Installation, updating, troubleshooting
- [Manual Setup](manual-setup.md) -- Step-by-step host configuration without scripts
- [Managing OpenPalm](managing-openpalm.md) -- Day-to-day administration
- [Troubleshooting](troubleshooting.md) -- Common problems and solutions
