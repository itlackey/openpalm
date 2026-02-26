# OpenPalm User Guide — Core Concepts

OpenPalm is built around five ideas: Extensions, Secrets, Channels, Services, and the Gateway. This guide explains what each one does and how you interact with it.

---

## Extensions

Extensions give your assistant new abilities. An extension might teach the assistant a new behavior ("always check memory before answering"), give it a new tool ("search the web"), add a custom slash command, or change how it processes requests.

The Admin API lets you manage **plugins** -- npm packages that hook into the OpenCode runtime. You can install or uninstall plugins via CLI or API. Skills, agents, commands, and tools can be managed manually by advanced users in the OpenCode config directory.

Each extension sub-type defines what it can and cannot do:

| Extension | What it means |
|---|---|
| **Skill** | Only influences how the assistant thinks. Cannot run code or access external services. |
| **Command** | Sends a predefined prompt to the assistant. No code execution. |
| **Agent** | Can change which tools the assistant has access to. |
| **Tool** | Can run code, make network requests, and interact with services. |
| **Plugin** | Can observe and modify everything the assistant does. |

---

## Secrets

Secrets are where you manage the credentials your assistant uses to reach external services.

Each secret has a key name (for example `OPENAI_API_KEY`) and a value. Channel configuration fields can reference a secret directly using `${SECRET_NAME}`.

When you apply stack changes, OpenPalm validates that every `${SECRET_NAME}` reference exists before writing runtime artifacts.

---

## Channels

Channels are the ways you can talk to your assistant outside of the admin panel. The MVP includes:

- A **Web Chat** channel for embedding in a website

Each channel has its own setup flow and once enabled, shows a status indicator.

### Access control

Each channel has an access setting:

- **Private** — Only accessible from your local network
- **Public** — Accessible from the internet

You control this per channel. Changing the access level is a single toggle.

### Security

Every message sent through a channel passes through the **Gateway** (see below) before it reaches the assistant. This means:

- Messages are authenticated and rate-limited automatically
- Malformed, unsafe, or abusive messages are filtered before the assistant sees them
- You can safely enable public access on a channel without exposing the assistant to raw, unfiltered input

---

## Services

Services are add-on containers that extend what your assistant can do internally. Unlike channels, services are not exposed to the internet or your local network — they run inside the private container network and are only reachable by the assistant and admin.

A service might add a search backend, a code execution sandbox, a custom database, or any other internal capability your assistant can call as a tool.

Services have no access control setting. They are always private by design.

---

## Gateway

The Gateway works behind the scenes. You don't configure it, and you won't interact with it directly. If it appears in the admin panel at all, it's as a health indicator on the system status page.

### What it does

The Gateway is the security layer that sits between every channel and the assistant. No matter how a message arrives — web chat or any future channel — it passes through the Gateway first. The Gateway:

1. **Verifies the message is authentic** — rejects anything that wasn't sent by a legitimate channel
2. **Rate-limits** — prevents any single user from overwhelming the assistant
3. **Screens the message** — uses an AI-powered filter to catch malformed input, prompt injection attempts, and unsafe content
4. **Forwards approved messages** to the assistant for processing
5. **Logs everything** — maintains an audit trail of all messages and decisions

### Why it matters to you

The Gateway is what makes it safe to expose channels to the internet and connect to external services. You don't need to think about it -- but it's the reason you can enable public access on a channel and trust that the assistant won't receive raw, unfiltered input from the outside world.

---

## How It All Fits Together

```
  You (the user)
       |
       |  Manage via CLI / Admin API:
       |
       +---> Extensions -----> Give the assistant new abilities
       |
       +---> Secrets ----------> Provide credentials for services
       |
       +---> Services ---------> Internal-only backend containers
       |
       |  Talk to the assistant via:
       |
       +---> Channels ---------> Chat
                  |
                  v
              Gateway  (security + filtering)
                  |
                  v
            AI Assistant <---> Services (internal network only)
```

- **Extensions** add capabilities to the assistant.
- **Secrets** provide the credentials that extensions and the assistant need to reach external services.
- **Services** are internal containers the assistant can reach directly — never exposed externally.
- **Channels** let you and others talk to the assistant from different platforms. Every channel message passes through the **Gateway** for security.
- The **Gateway** protects the assistant behind every channel, ensuring all messages are authenticated, rate-limited, and screened.
