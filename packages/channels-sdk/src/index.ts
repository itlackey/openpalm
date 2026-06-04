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

// ── Conversation queue ───────────────────────────────────────────────────
export { ConversationQueue } from "./conversation-queue.ts";

// ── Crypto ───────────────────────────────────────────────────────────────
export {
  constantTimeEqual,
  signPayload,
  verifySignature,
  signRequest,
  verifyRequest,
  type RequestSignatureFields,
} from "./crypto.ts";

// ── Logger ───────────────────────────────────────────────────────────────
export { createLogger, type LogLevel } from "./logger.ts";

// ── Secret files ─────────────────────────────────────────────────────────
export { SecretFileError, readOptionalSecretFile, readRequiredSecretFile } from "./secret-file.ts";

// ── Utilities ────────────────────────────────────────────────────────────
export { asRecord, extractChatText, splitMessage } from "./utils.ts";

// ── Permission helpers ───────────────────────────────────────────────────
export { parseIdList, type PermissionResult } from "./permissions.ts";

// ── Assistant client ─────────────────────────────────────────────────────
export { type AssistantClientOptions } from "./assistant-client.ts";

// ── Content screening (guardian content-validation pre-filter) ───────────
export {
  screenContent,
  type ContentScreenResult,
  type ContentSignal,
} from "./content-screen.ts";

// ── OpenCode proxy allowlist (pure default-deny path matcher) ─────────────
export {
  OC_ALLOWLIST,
  matchAllowlist,
  type AllowlistRoute,
  type AllowlistMatch,
} from "./oc-allowlist.ts";

// ── Guardian-signed native OpenCode client (rich-UX /oc proxy) ────────────
export {
  OcClient,
  generateMessageId,
  type OcClientOptions,
  type OcSession,
} from "./oc-client.ts";

// ── Shared pure OpenCode event interpreters (rich-UX renderers) ───────────
export {
  asRaw,
  statusName,
  TURN_IDLE_STATUSES,
  partSnapshotType,
  extractTextDelta,
  isTurnEnd,
  extractToolUpdate,
  extractPermissionAsk,
  extractQuestionAsk,
  isSessionError,
  type RawEvent,
  type ToolUpdate,
  type PermissionAsk,
  type QuestionAsk,
  type QuestionInfo,
  type QuestionOption,
} from "./oc-events.ts";
