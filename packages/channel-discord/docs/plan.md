# Discord Channel Implementation Plan

This note captures what the OpenPalm Discord channel does in
`feat/discord-channel-upgrades`, what nearby Discord/OpenCode ecosystems do well,
and which package-level upgrades are worth prioritizing next.

## Current OpenPalm baseline

The Discord channel package already provides a solid first-party bridge for core
OpenPalm conversations:

- Gateway-based Discord bot connection using `discord.js`, plus the HTTP
  interactions endpoint and legacy webhook endpoint.
- Built-in slash commands: `/ask`, `/queue`, `/health`, `/help`, `/clear`, plus
  optional custom slash commands from `DISCORD_CUSTOM_COMMANDS`.
- Mention-driven conversations that open a Discord thread and keep replying in
  that tracked thread without requiring repeated mentions.
- Thread-scoped session keys for mention/thread conversations and channel-plus-user
  session keys for slash-command conversations outside a thread.
- Real `/clear` support that asks guardian to drop the active conversation scope.
- Per-conversation queueing for slash commands and active tracked threads.
- Deferred slash command replies, typing indicators for thread conversations, and
  automatic chunking for long answers.
- Permission controls through guild, role, user allowlists, and a user blocklist.
- Backend session reuse through guardian's session cache, keyed by the channel's
  conversation metadata.

Important current constraints visible in code today:

- Queueing is intentionally lightweight and in-memory; queue state is not exposed
  through dedicated status commands yet.
- Clear requests drop queued work for the current session scope, but they do not
  attempt to cancel an already-running assistant turn.
- Attachment-aware prompts, richer status commands, and project-routing commands
  are still missing.

## Ecosystem inspirations and gaps

OpenCode-side strengths relevant to Discord integration:

- Memory-backed context and tool hooks make long-running conversations more useful
  than a stateless bot.
- Dynamic context pruning and session continuation suggest that Discord should be
  able to expose clearer session boundaries and recovery behavior.
- Notifications, skills discovery, command discovery, and worktree/session
  orchestration point toward richer Discord-side controls than a single `/ask`.

Discord/OpenCode-adjacent bridge patterns worth borrowing:

- Kimaki-style thread-scoped sessions and channel routing are a better fit for
  Discord's native conversation model than a single user-wide session.
- GolemBot- and Bean Channel-style command discoverability, status feedback, and
  queue transparency reduce confusion when requests take a long time.
- Common bridge features like multi-project routing, attachment-aware prompts,
  richer session controls, and stronger thread lifecycle handling are still gaps in
  OpenPalm's package.

OpenPalm-specific gap summary:

- The package now has solid conversation scoping, clear semantics, and lightweight
  queueing, but it still lacks richer status and discovery commands.
- OpenPalm-native capabilities like skill discovery, memory-aware status, and
  project routing are not exposed yet.
- Long-running work can be queued, but users still cannot inspect queue state,
  cancel a running turn, or retry a failed one from Discord.

## High-value features implemented in this branch now

The current branch materially improves the package in these ways:

- Uses Discord Gateway handling with `discord.js` instead of relying only on the
  older webhook-style flow.
- Supports real thread-first conversations for message mentions, which maps better
  to Discord than replying inline forever in busy channels.
- Keeps thread replies going without requiring a mention on every turn.
- Maps thread conversations to thread-scoped guardian sessions instead of a single
  user-wide Discord session.
- Implements real `/clear` behavior through guardian session clearing.
- Adds lightweight queued follow-ups through `/queue` and automatic queueing for
  active tracked threads.
- Registers built-in slash commands alongside validated custom commands.
- Uses deferred slash responses and typing indicators so Discord users get timely
  feedback during OpenPalm processing.

These are the right near-term upgrades for OpenPalm because they improve Discord
usability without requiring changes to the rest of the stack.

## Recommended next features for this package

Prioritize the following package-scoped work next:

1. Better OpenPalm-native command surface
   - Add commands that expose OpenPalm value specifically: active session status,
      project or environment routing, available skills/commands discovery, and a
      compact help/status command for Discord.

2. Attachment-aware prompts
   - Start with text attachments and image/file metadata forwarding where the
      assistant can use them safely.
   - Keep this grounded in OpenPalm's guardian/channel contract rather than adding
      Discord-only storage behavior.

3. Queue/status controls
   - Add commands to inspect queued follow-ups for the current conversation.
   - Consider explicit cancel or flush actions for queued work without forcing a
      full session clear.

4. Better thread lifecycle handling
   - Add clearer behavior for archived threads, renamed threads, and stale active
      thread tracking after reconnects.

## Larger features to defer until later

Useful, but broader than the current package upgrade scope:

- Voice interactions or live audio bridging.
- Full multi-project/worktree orchestration from Discord, unless OpenPalm first
  defines a stable routing model across admin, guardian, and assistant layers.
- Rich notification subscriptions from arbitrary OpenPalm events.
- Moderator/admin controls that belong in OpenPalm admin APIs rather than inside
  the Discord package.

## Recommendation summary

For OpenPalm, the highest-leverage next step is to align Discord thread behavior,
guardian session identity, and `/clear` semantics. Once those three pieces are
coherent, queue controls, richer discovery commands, and attachment handling become
much easier to explain and trust.
