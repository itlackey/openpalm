/**
 * OpenPalm shared channel protocol types and payload validation.
 *
 * Used by the guardian to validate inbound requests and by channel adapters
 * to build correctly-shaped payloads before signing and forwarding.
 */

// ── Error codes ──────────────────────────────────────────────────────────

export const ERROR_CODES = {
  INVALID_JSON: "invalid_json",
  INVALID_PAYLOAD: "invalid_payload",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  CHANNEL_NOT_CONFIGURED: "channel_not_configured",
  INVALID_SIGNATURE: "invalid_signature",
  REPLAY_DETECTED: "replay_detected",
  RATE_LIMITED: "rate_limited",
  ASSISTANT_UNAVAILABLE: "assistant_unavailable",
  NOT_FOUND: "not_found",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// ── Wire types ───────────────────────────────────────────────────────────

/** Signed wire format sent to the guardian. */
export type ChannelPayload = {
  userId: string;
  channel: string;
  text: string;
  nonce: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};

/** Input before nonce/timestamp are auto-generated. */
export type ChannelMessageInput = Omit<ChannelPayload, "nonce" | "timestamp">;

// ── Response types ───────────────────────────────────────────────────────

export type GuardianSuccessResponse = {
  requestId: string;
  sessionId: string;
  answer: string;
  userId: string;
};

export type GuardianErrorResponse = {
  error: ErrorCode;
  requestId?: string;
};

// ── Validation ───────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true; payload: ChannelPayload }
  | { ok: false; error: ErrorCode };

/**
 * Validates that an unknown value conforms to the ChannelPayload shape.
 * Used by the guardian to validate inbound requests before processing.
 */
export function validatePayload(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }
  const o = body as Record<string, unknown>;
  const valid =
    typeof o.userId === "string" && !!o.userId.trim() &&
    typeof o.channel === "string" && !!o.channel.trim() &&
    typeof o.text === "string" && !!o.text.trim() &&
    typeof o.nonce === "string" && !!o.nonce.trim() &&
    typeof o.timestamp === "number";
  if (!valid) {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }

  // Field length bounds to prevent abuse
  if ((o.userId as string).length > 256) {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }
  if ((o.channel as string).length > 64) {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }
  if ((o.nonce as string).length > 128) {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }
  if ((o.text as string).length > 10_000) {
    return { ok: false, error: ERROR_CODES.INVALID_PAYLOAD };
  }

  return { ok: true, payload: o as unknown as ChannelPayload };
}
