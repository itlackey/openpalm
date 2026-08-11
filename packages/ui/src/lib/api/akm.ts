import { request, requireOk } from './core.js';
import type { AccessToggles } from '@openpalm/lib/control-plane/access-toggles.js';
import type { AccessStatusActual } from '@openpalm/lib/control-plane/access-status.js';

// ── AKM Config ────────────────────────────────────────────────────────────────

export async function fetchAkmConfig(): Promise<{ config: Record<string, unknown> }> {
  const res = await requireOk(await request('GET', '/api/assistant/akm'));
  return (await res.json()) as { config: Record<string, unknown> };
}

export async function saveAkmConfig(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PATCH', '/api/assistant/akm', settings));
  return (await res.json()) as { ok: boolean };
}

export type AkmEmbeddingDetection = {
  ok: true;
  endpoint: string;
  model: string;
  provider: string;
  dimension: number;
  message: string;
};

export type AkmEmbeddingTestResult = {
  ok: true;
  dimension: number;
  message: string;
  provider?: string;
};

export async function detectAkmEmbedding(): Promise<AkmEmbeddingDetection> {
  const res = await requireOk(await request('POST', '/api/host/akm/embedding/detect', {}));
  return (await res.json()) as AkmEmbeddingDetection;
}

export async function testAkmEmbedding(settings: {
  endpoint: string;
  model: string;
  provider?: string;
  apiKey?: string;
  dimension?: number;
}): Promise<AkmEmbeddingTestResult> {
  const res = await requireOk(await request('POST', '/api/host/akm/embedding/test', settings));
  return (await res.json()) as AkmEmbeddingTestResult;
}

export async function reindexAkm(): Promise<{ ok: boolean; message: string; output?: string }> {
  const res = await requireOk(await request('POST', '/api/host/akm/reindex', {}));
  return (await res.json()) as { ok: boolean; message: string; output?: string };
}

// ── Host stack settings + assistant persona (the old /admin/assistant split
// into /api/host/stack and /api/assistant/persona — plan Phase 4 step 2) ──────

export type MdnsSurface = {
  assistant: { name: string; port: number; advertised: boolean };
  guardian: { name: string; port: number; advertised: boolean };
};

export type HostStackSettings = {
  projectName: string;
  access: AccessToggles;
  stackEnvPath: string;
  mdns: MdnsSurface;
};

export async function fetchHostStackSettings(): Promise<HostStackSettings> {
  const res = await requireOk(await request('GET', '/api/host/stack'));
  return (await res.json()) as HostStackSettings;
}

/**
 * Saving access settings APPLIES them: the server recreates the affected
 * containers so Compose republishes the ports, then advertises over mDNS.
 * `recreated` and `autoEnabledAddons` report what that took, so the UI can say
 * what happened instead of telling the operator to restart something (which
 * would not have worked — `compose restart` cannot republish a port).
 */
export type SaveHostStackResult = {
  ok: boolean;
  projectName: string;
  projectRenamed: boolean;
  access: AccessToggles;
  stackEnvPath: string;
  mdns: MdnsSurface;
  recreated?: string[];
  autoEnabledAddons?: string[];
};

export async function saveHostStackSettings(input: {
  projectName: string;
  access: AccessToggles;
}): Promise<SaveHostStackResult> {
  const res = await requireOk(await request('PUT', '/api/host/stack', input));
  return (await res.json()) as SaveHostStackResult;
}

/**
 * "What URL do I open on my phone, and does it work?" (Phase 2 of the
 * LAN-access review). Pairs the STORED toggles (`intent`, identical to
 * `HostStackSettings.access`) against what Docker and a live self-probe
 * actually observe, so drift between the two is visible instead of assumed
 * away — see `GET /api/host/access-status`'s doc comment for the full
 * rationale on each field.
 */
export type AccessStatus = {
  intent: AccessToggles;
  actual: AccessStatusActual;
  /** The `OP_UI_PORT` every URL below and the reachability probe target. */
  port: number;
  /** `<project>.local` first, then every non-loopback IPv4 address. */
  urls: string[];
  /** `not_published` = loopback-only bind: nothing is published on the LAN to
   *  probe — the default healthy posture, not a failed probe. */
  reachable: { status: 'absent' | 'match' | 'mismatch' | 'not_published'; ok: boolean };
};

export async function fetchAccessStatus(): Promise<AccessStatus> {
  const res = await requireOk(await request('GET', '/api/host/access-status'));
  return (await res.json()) as AccessStatus;
}

/**
 * The generated OpenCode Basic-auth key `assistantDirect`'s own copy
 * promises is "shown in the dashboard" (`ACCESS_TOGGLE_DESCRIPTIONS.assistantDirect`
 * in `@openpalm/lib`). `available` is false whenever the toggle is off — at
 * that point OpenCode requires no auth, so there is nothing meaningful to
 * show. GET /api/host/assistant-key sends `Cache-Control: no-store`; the
 * value must never be persisted or logged by a caller.
 */
export type AssistantKey =
  | { available: false }
  | { available: true; username: string; password: string };

export async function fetchAssistantKey(): Promise<AssistantKey> {
  const res = await requireOk(await request('GET', '/api/host/assistant-key'));
  return (await res.json()) as AssistantKey;
}

export type AssistantPersona = {
  personaPath: string;
  personaContent: string;
};

export async function fetchAssistantPersona(): Promise<AssistantPersona> {
  const res = await requireOk(await request('GET', '/api/assistant/persona'));
  return (await res.json()) as AssistantPersona;
}

export async function saveAssistantPersona(input: {
  personaContent: string;
}): Promise<{ ok: boolean; personaPath: string; personaContent: string }> {
  const res = await requireOk(await request('PUT', '/api/assistant/persona', input));
  return (await res.json()) as { ok: boolean; personaPath: string; personaContent: string };
}

// ── AKM Health (dashboard metrics) ────────────────────────────────────────────

export type AkmHealth =
  | { available: false; reason?: string }
  | {
      available: true;
      status: 'ok' | 'warn' | 'fail' | 'unknown';
      ok: boolean | null;
      checks: { pass: number; warn: number; fail: number };
      metrics: Record<string, number> | null;
      index: {
        entryCount?: number;
        lastBuiltAt?: string;
        hasEmbeddings?: boolean;
        vecAvailable?: boolean;
      } | null;
    };

export async function fetchAkmHealth(): Promise<AkmHealth> {
  const res = await requireOk(await request('GET', '/api/host/akm/health'));
  return (await res.json()) as AkmHealth;
}

export type AkmKnowledgeStats =
  | { available: false; reason?: string }
  | {
      available: true;
      version: string | null;
      health: {
        status: 'pass' | 'warn' | 'unknown';
        advisories: string[];
      };
      index: {
        entryCount: number | null;
        lastBuiltAt: string | null;
        hasEmbeddings: boolean | null;
        vecAvailable: boolean | null;
      };
      assetCounts: {
        memory: number | null;
        skill: number | null;
        lesson: number | null;
      };
      improve: {
        invoked: number | null;
        completed: number | null;
        skipped: number | null;
        reflectOk: number | null;
        reflectCooldown: number | null;
        consolidation: {
          promoted: number | null;
          merged: number | null;
          deleted: number | null;
        };
      };
      proposals: {
        pending: number;
        items: Array<{
          ref: string | null;
          generator: string | null;
          createdAt: string | null;
          status: string | null;
        }>;
      };
    };

export async function fetchAkmKnowledgeStats(): Promise<AkmKnowledgeStats> {
  const res = await requireOk(await request('GET', '/api/host/akm/stats'));
  return (await res.json()) as AkmKnowledgeStats;
}

// ── Host AKM sharing ──────────────────────────────────────────────────────────

export type HostAkmSharing = {
  enabled: boolean;
  hostStashPath: string;
};

export async function fetchHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('GET', '/api/host/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}

export async function enableHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('PUT', '/api/host/akm/host-sharing', {}));
  return (await res.json()) as HostAkmSharing;
}

export async function disableHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('DELETE', '/api/host/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}
