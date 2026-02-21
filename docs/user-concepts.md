# OpenPalm User Guide — Core Concepts

OpenPalm is built around five ideas: Extensions, Connections, Channels, Automations, and the Gateway. This guide explains what each one does and how you interact with it.

---

## Extensions

Extensions give your assistant new abilities. An extension might teach the assistant a new behavior ("always check memory before answering"), give it a new tool ("search the web"), add a custom slash command, or change how it processes requests.

The admin UI lets you manage **plugins** — npm packages that hook into the OpenCode runtime. To add a plugin, enter its npm package ID and click Install. To remove it, click Uninstall. Skills, agents, commands, and tools can be managed manually by advanced users in the OpenCode config directory.

### Risk levels

Each extension shows a risk badge so you can make informed decisions:

| Risk | What it means |
|---|---|
| **Lowest** | Only influences how the assistant thinks. Cannot run code or access external services. |
| **Low** | Sends a predefined prompt to the assistant. No code execution. |
| **Medium** | Can change which tools the assistant has access to. |
| **Medium-High** | Can run code, make network requests, and interact with services. |
| **Highest** | Can observe and modify everything the assistant does. |

---

## Secrets

Secrets are where you manage the credentials your assistant uses to reach external services.

Each secret has a key name (for example `OPENAI_API_KEY`) and a value. Channel configuration fields can reference a secret directly using `${SECRET_NAME}`.

When you apply stack changes, OpenPalm validates that every `${SECRET_NAME}` reference exists before writing runtime artifacts.

---

## Channels

Channels are the ways you can talk to your assistant outside of the admin panel. You might enable:

- A **Discord** channel so the assistant responds in your Discord server
- A **Telegram** channel for mobile messaging
- A **Voice** channel for speaking to it
- A **Web Chat** channel for embedding in a website

Each channel has its own setup flow — Discord asks for a bot token, Telegram asks for a bot token, voice asks for a speech-to-text endpoint — and once enabled, shows a status indicator.

### Access control

Each channel has an access setting:

- **Private** — Only accessible from your local network
- **Public** — Accessible from the internet

You control this per channel. For example, you might keep Discord public (so the bot is reachable from Discord's servers) while keeping web chat private (only accessible from your home network). Changing the access level is a single toggle.

### Security

Every message sent through a channel passes through the **Gateway** (see below) before it reaches the assistant. This means:

- Messages are authenticated and rate-limited automatically
- Malformed, unsafe, or abusive messages are filtered before the assistant sees them
- You can safely enable public access on a channel without exposing the assistant to raw, unfiltered input

---

## Automations

Automations are recurring tasks you schedule for your assistant. Instead of sending a message yourself, you tell the assistant what to do and when to do it — and it happens automatically.

### Examples

- A **daily morning briefing** that summarizes the news at 9 AM
- A **weekly report** generated every Monday
- A **periodic health check** that runs every few hours

### What you configure

- **Name** — A label for the automation (e.g., "Daily Morning Briefing")
- **Prompt** — What you want the assistant to do (e.g., "Summarize the top 5 tech headlines and post to the #news Discord channel")
- **Schedule** — How often it runs, using a friendly frequency picker (daily, weekly, every N hours, etc.)

### Managing automations

- **Enable / Disable** — Turn an automation on or off without deleting it
- **Edit** — Change the prompt, schedule, or name at any time
- **Run Now** — Trigger the automation immediately, without waiting for the next scheduled time. Useful for testing.
- **Delete** — Remove the automation entirely

Each automation runs independently — it has its own conversation history that doesn't mix with your interactive sessions or other automations.

### Automations vs. Channels

Channels are **reactive**: the assistant responds when you (or someone) sends a message. Automations are **proactive**: the assistant acts on its own schedule without any user trigger.

---

## Gateway

The Gateway works behind the scenes. You don't configure it, and you won't interact with it directly. If it appears in the admin panel at all, it's as a health indicator on the system status page.

### What it does

The Gateway is the security layer that sits between every channel and the assistant. No matter how a message arrives — Discord, Telegram, voice, web chat — it passes through the Gateway first. The Gateway:

1. **Verifies the message is authentic** — rejects anything that wasn't sent by a legitimate channel
2. **Rate-limits** — prevents any single user from overwhelming the assistant
3. **Screens the message** — uses an AI-powered filter to catch malformed input, prompt injection attempts, and unsafe content
4. **Forwards approved messages** to the assistant for processing
5. **Logs everything** — maintains an audit trail of all messages and decisions

### Why it matters to you

The Gateway is what makes it safe to expose channels to the internet, install community extensions, and connect to external services. You don't need to think about it — but it's the reason you can enable public access on a channel and trust that the assistant won't receive raw, unfiltered input from the outside world.

---

## How It All Fits Together

```
  You (the user)
       |
       |  Manage in the Admin UI:
       |
       +---> Extensions -----> Give the assistant new abilities
       |
       +---> Connections -----> Provide credentials for services
       |
       +---> Automations -----> Schedule recurring tasks
       |
       |  Talk to the assistant via:
       |
       +---> Channels ---------> Discord, Chat, Voice, Telegram
                  |
                  v
              Gateway  (security + filtering)
                  |
                  v
            AI Assistant
```

- **Extensions** add capabilities to the assistant.
- **Connections** provide the credentials that extensions and the assistant need to reach external services.
- **Channels** let you and others talk to the assistant from different platforms. Every channel message passes through the **Gateway** for security.
- **Automations** let the assistant act on a schedule without anyone sending a message.
- The **Gateway** protects the assistant behind every channel, ensuring all messages are authenticated, rate-limited, and screened.
