/**
 * @openpalm/channels-sdk — Public API for building OpenPalm channel adapters.
 *
 * Community developers: extend BaseChannel and implement handleRequest().
 */

// ── Base class and types ─────────────────────────────────────────────────
export { BaseChannel, type HandleResult } from "./channel-base.ts";

// ── Protocol types ───────────────────────────────────────────────────────
export {
  ERROR_CODES,
  validatePayload,
  type ErrorCode,
  type ChannelPayload,
  type ChannelMessageInput,
  type ValidationResult,
  type GuardianSuccessResponse,
  type GuardianErrorResponse,
} from "./channel.ts";

// ── SDK helpers ──────────────────────────────────────────────────────────
export { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";

// ── Crypto ───────────────────────────────────────────────────────────────
export { signPayload, verifySignature } from "./crypto.ts";

// ── Logger ───────────────────────────────────────────────────────────────
export { createLogger, type LogLevel } from "./logger.ts";

// ── Utilities ────────────────────────────────────────────────────────────
export { constantTimeEqual, asRecord, extractChatText, splitMessage } from "./utils.ts";

// ── Assistant client ─────────────────────────────────────────────────────
export { askAssistant, type AssistantClientOptions } from "./assistant-client.ts";
