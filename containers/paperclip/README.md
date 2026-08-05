# Paperclip Image

This image packages the pinned upstream `paperclipai` npm release without an
OpenPalm adapter, wrapper entrypoint, or runtime installation. Paperclip uses
its upstream embedded database and stores its complete instance under
`/paperclip`.

## Why this image is built rather than pulled

Every other third-party service in the stack pulls a pinned upstream image
(`ollama/ollama@sha256:…`, `tailscale/tailscale`), and first-party code is what
OpenPalm normally builds. This image is a deliberate exception, for one reason:
upstream publishes container images only as `latest` and `sha-<commit>` tags —
there is no semver tag to pin. Repackaging the semver-versioned npm release
gives an immutable, reproducible, `OP_PAPERCLIP_VERSION`-pinned artifact, which
is better supply-chain hygiene than tracking an opaque moving tag.

The cost of that choice is real and worth stating: OpenPalm now owns this
image's base-layer patching, CVE surface, and — the part that bit us once
already — **runtime completeness**. Upstream's own runtime image bakes the agent
CLIs; an earlier revision of this Dockerfile did not, which produced a service
that passed its healthcheck and failed every agent run. The `for bin in …`
guard in the Dockerfile exists so that specific failure can never ship again.

If upstream begins publishing semver-tagged images, prefer switching to a
digest-pinned upstream pull and deleting this Dockerfile and its publish
workflow.

## What is baked, and why

| Component | Why |
|---|---|
| `paperclipai@${PAPERCLIP_VERSION}` | The application itself. |
| `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`, `@google/gemini-cli` | Paperclip's built-in local adapters spawn `claude` / `codex` / `opencode` / `gemini` **by bare name**. Without them, agent runs fail while `/api/health` still returns 200. |
| `ripgrep`, `python3`, `openssh-client`, `wget`, `git`, `curl` | Mirrors upstream's runtime image; agent sessions shell out to these routinely. |

`opencode-ai` is pinned to the **same version as the assistant and guardian
images** (`containers/{assistant,guardian}/tools/package.json`). AGENTS.md
requires those pins stay in lockstep — this image is now the third one. Bump all
three together; `paperclip-image-contract.test.ts` fails if they drift.

## Version bumps

`PAPERCLIP_UPSTREAM_VERSION` in
`packages/lib/src/control-plane/paperclip.ts` is the single source of truth. The
Dockerfile `ARG`, the Compose default, and the addon env schema all repeat it
because none of them can import TypeScript; the image-contract test fails if any
one is left behind.
