/**
 * Shared helpers for SvelteKit API server routes.
 */
import type { RequestEvent } from "@sveltejs/kit";
import { timingSafeEqual } from "node:crypto";
import { getState } from "./state.js";
import { normalizeCaller } from "./lifecycle.js";
import { isSetupComplete } from './setup-status.js';
import {
  CONNECTION_KINDS,
  type CallerType,
  type CanonicalConnectionProfile,
  type CapabilityAssignments,
} from "./types.js";

export function safeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!a || !b) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Standard JSON response with request ID header */
export function jsonResponse(
  status: number,
  body: unknown,
  requestId = ""
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {})
    }
  });
}

/** Standard error envelope */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  details: Record<string, unknown> = {},
  requestId = ""
): Response {
  return jsonResponse(
    status,
    { error, message, details, requestId },
    requestId
  );
}

/** Extract or generate request ID */
export function getRequestId(event: RequestEvent): string {
  return event.request.headers.get("x-request-id") || crypto.randomUUID();
}

/** Check admin token — returns error Response or null if OK */
export function requireAdmin(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  const token = event.request.headers.get("x-admin-token");
  if (!safeTokenCompare(token ?? "", state.adminToken)) {
    return errorResponse(
      401,
      "unauthorized",
      "Missing or invalid x-admin-token",
      {},
      requestId
    );
  }
  return null;
}

/**
 * Check admin auth with setup-token fallback.
 * - Pre-setup: accepts setup token OR admin token header value.
 * - Post-setup: accepts admin token only.
 */
export function requireAdminOrSetupToken(event: RequestEvent, requestId: string): Response | null {
  const state = getState();
  const token = event.request.headers.get('x-admin-token') ?? '';
  const setupComplete = isSetupComplete(state.stateDir, state.configDir);

  const validSetupToken = !setupComplete && safeTokenCompare(token, state.setupToken);
  const validAdminToken = safeTokenCompare(token, state.adminToken);
  if (!validSetupToken && !validAdminToken) {
    return errorResponse(401, 'unauthorized', 'Missing or invalid x-admin-token', {}, requestId);
  }
  return null;
}

/** Extract actor from request — derived from auth state, not caller-controlled */
export function getActor(event: RequestEvent): string {
  const token = event.request.headers.get("x-admin-token");
  if (token) return "admin";
  return "unauthenticated";
}

/** Extract caller type from request */
export function getCallerType(event: RequestEvent): CallerType {
  return normalizeCaller(event.request.headers.get("x-requested-by"));
}

/** Parse JSON body safely — returns null on parse failure */
export async function parseJsonBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function isConnectionKind(value: unknown): value is CanonicalConnectionProfile["kind"] {
  return typeof value === "string" && CONNECTION_KINDS.includes(value as CanonicalConnectionProfile["kind"]);
}

/** Parse and narrow a canonical connection profile payload. */
export function parseCanonicalConnectionProfile(input: unknown): ParseResult<CanonicalConnectionProfile> {
  if (!isRecord(input)) {
    return { ok: false, message: "connection profile must be an object" };
  }
  if (!isConnectionKind(input.kind)) {
    return { ok: false, message: "connection profile kind is invalid" };
  }

  const id = asNonEmptyString(input.id);
  if (!id) return { ok: false, message: "connection profile id is required" };

  const name = asNonEmptyString(input.name);
  if (!name) return { ok: false, message: "connection profile name is required" };

  const provider = asNonEmptyString(input.provider);
  if (!provider) return { ok: false, message: "connection profile provider is required" };

  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : "";

  const auth = input.auth;
  if (!isRecord(auth)) {
    return { ok: false, message: "connection profile auth is required" };
  }

  const mode = auth.mode;
  if (mode !== "api_key" && mode !== "none") {
    return { ok: false, message: "connection profile auth mode must be api_key or none" };
  }

  const apiKeySecretRef = asOptionalString(auth.apiKeySecretRef);
  if (mode === "api_key" && !asNonEmptyString(apiKeySecretRef)) {
    return {
      ok: false,
      message: "connection profile auth apiKeySecretRef is required when mode is api_key",
    };
  }

  const profile: CanonicalConnectionProfile = {
    id,
    name,
    kind: input.kind,
    provider,
    baseUrl,
    auth: {
      mode,
      ...(apiKeySecretRef ? { apiKeySecretRef } : {}),
    },
  };

  return { ok: true, value: profile };
}

/** Parse and narrow capability assignments payload. */
export function parseCapabilityAssignments(input: unknown): ParseResult<CapabilityAssignments> {
  if (!isRecord(input)) {
    return { ok: false, message: "assignments must be an object" };
  }

  const llm = input.llm;
  const embeddings = input.embeddings;
  if (!isRecord(llm)) {
    return { ok: false, message: "assignments.llm is required" };
  }
  if (!isRecord(embeddings)) {
    return { ok: false, message: "assignments.embeddings is required" };
  }

  const llmConnectionId = asNonEmptyString(llm.connectionId);
  const llmModel = asNonEmptyString(llm.model);
  const embeddingsConnectionId = asNonEmptyString(embeddings.connectionId);
  const embeddingsModel = asNonEmptyString(embeddings.model);

  if (!llmConnectionId || !llmModel) {
    return { ok: false, message: "assignments.llm requires connectionId and model" };
  }
  if (!embeddingsConnectionId || !embeddingsModel) {
    return { ok: false, message: "assignments.embeddings requires connectionId and model" };
  }

  const embeddingDims = asPositiveInteger(embeddings.embeddingDims);
  if (embeddings.embeddingDims !== undefined && embeddingDims === undefined) {
    return { ok: false, message: "assignments.embeddings.embeddingDims must be a positive integer" };
  }

  const reranking = input.reranking;
  if (reranking !== undefined && !isRecord(reranking)) {
    return { ok: false, message: "assignments.reranking must be an object when provided" };
  }

  const tts = input.tts;
  if (tts !== undefined && !isRecord(tts)) {
    return { ok: false, message: "assignments.tts must be an object when provided" };
  }

  const stt = input.stt;
  if (stt !== undefined && !isRecord(stt)) {
    return { ok: false, message: "assignments.stt must be an object when provided" };
  }

  return {
    ok: true,
    value: {
      llm: {
        connectionId: llmConnectionId,
        model: llmModel,
        ...(asOptionalString(llm.smallModel) ? { smallModel: asOptionalString(llm.smallModel) } : {}),
      },
      embeddings: {
        connectionId: embeddingsConnectionId,
        model: embeddingsModel,
        ...(embeddingDims ? { embeddingDims } : {}),
      },
      ...(reranking && typeof reranking.enabled === "boolean"
        ? {
            reranking: {
              enabled: reranking.enabled,
              ...(asOptionalString(reranking.connectionId)
                ? { connectionId: asOptionalString(reranking.connectionId) }
                : {}),
              ...(reranking.mode === "llm" || reranking.mode === "dedicated"
                ? { mode: reranking.mode }
                : {}),
              ...(asOptionalString(reranking.model) ? { model: asOptionalString(reranking.model) } : {}),
              ...(asPositiveInteger(reranking.topK) ? { topK: asPositiveInteger(reranking.topK) } : {}),
              ...(asPositiveInteger(reranking.topN) ? { topN: asPositiveInteger(reranking.topN) } : {}),
            },
          }
        : {}),
      ...(tts && typeof tts.enabled === "boolean"
        ? {
            tts: {
              enabled: tts.enabled,
              ...(asOptionalString(tts.connectionId) ? { connectionId: asOptionalString(tts.connectionId) } : {}),
              ...(asOptionalString(tts.model) ? { model: asOptionalString(tts.model) } : {}),
              ...(asOptionalString(tts.voice) ? { voice: asOptionalString(tts.voice) } : {}),
              ...(asOptionalString(tts.format) ? { format: asOptionalString(tts.format) } : {}),
            },
          }
        : {}),
      ...(stt && typeof stt.enabled === "boolean"
        ? {
            stt: {
              enabled: stt.enabled,
              ...(asOptionalString(stt.connectionId) ? { connectionId: asOptionalString(stt.connectionId) } : {}),
              ...(asOptionalString(stt.model) ? { model: asOptionalString(stt.model) } : {}),
              ...(asOptionalString(stt.language) ? { language: asOptionalString(stt.language) } : {}),
            },
          }
        : {}),
    },
  };
}
