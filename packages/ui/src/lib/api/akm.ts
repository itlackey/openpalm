import { request, requireOk } from './core.js';
import type { NetworkAccessPreset } from '@openpalm/lib/control-plane/network-preset.js';

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
  lanExposureEnabled: boolean;
  stackEnvPath: string;
  mdns: MdnsSurface;
  /** #563 — active network access preset; null means custom/hand-tuned. */
  networkPreset: NetworkAccessPreset | null;
};

export async function fetchHostStackSettings(): Promise<HostStackSettings> {
  const res = await requireOk(await request('GET', '/api/host/stack'));
  return (await res.json()) as HostStackSettings;
}

export async function saveHostStackSettings(input: {
  projectName: string;
  lanExposureEnabled: boolean;
}): Promise<{
  ok: boolean;
  projectName: string;
  projectRenamed: boolean;
  lanExposureEnabled: boolean;
  stackEnvPath: string;
  mdns: MdnsSurface;
  networkPreset: NetworkAccessPreset | null;
}> {
  const res = await requireOk(await request('PUT', '/api/host/stack', input));
  return (await res.json()) as {
    ok: boolean;
    projectName: string;
    projectRenamed: boolean;
    lanExposureEnabled: boolean;
    stackEnvPath: string;
    mdns: MdnsSurface;
    networkPreset: NetworkAccessPreset | null;
  };
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
  profilesImported?: string[];
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
