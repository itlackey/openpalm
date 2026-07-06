import { request, requireOk } from './core.js';

// ── AKM Config ────────────────────────────────────────────────────────────────

export async function fetchAkmConfig(): Promise<{ config: Record<string, unknown> }> {
  const res = await requireOk(await request('GET', '/admin/akm'));
  return (await res.json()) as { config: Record<string, unknown> };
}

export async function saveAkmConfig(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
  const res = await requireOk(await request('PATCH', '/admin/akm', settings));
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
  const res = await requireOk(await request('POST', '/admin/akm/embedding/detect', {}));
  return (await res.json()) as AkmEmbeddingDetection;
}

export async function testAkmEmbedding(settings: {
  endpoint: string;
  model: string;
  provider?: string;
  apiKey?: string;
  dimension?: number;
}): Promise<AkmEmbeddingTestResult> {
  const res = await requireOk(await request('POST', '/admin/akm/embedding/test', settings));
  return (await res.json()) as AkmEmbeddingTestResult;
}

export async function reindexAkm(): Promise<{ ok: boolean; message: string; output?: string }> {
  const res = await requireOk(await request('POST', '/admin/akm/reindex', {}));
  return (await res.json()) as { ok: boolean; message: string; output?: string };
}

export type AssistantSettings = {
  projectName: string;
  lanExposureEnabled: boolean;
  stackEnvPath: string;
  personaPath: string;
  personaContent: string;
};

export async function fetchAssistantSettings(): Promise<AssistantSettings> {
  const res = await requireOk(await request('GET', '/admin/assistant'));
  return (await res.json()) as AssistantSettings;
}

export async function saveAssistantSettings(input: {
  projectName: string;
  lanExposureEnabled: boolean;
  personaContent: string;
}): Promise<{ ok: boolean; projectName: string; projectRenamed: boolean; lanExposureEnabled: boolean; stackEnvPath: string; personaPath: string; personaContent: string }> {
  const res = await requireOk(await request('PUT', '/admin/assistant', input));
  return (await res.json()) as { ok: boolean; projectName: string; projectRenamed: boolean; lanExposureEnabled: boolean; stackEnvPath: string; personaPath: string; personaContent: string };
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
  const res = await requireOk(await request('GET', '/admin/akm/health'));
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
  const res = await requireOk(await request('GET', '/admin/akm/stats'));
  return (await res.json()) as AkmKnowledgeStats;
}

// ── Host AKM sharing ──────────────────────────────────────────────────────────

export type HostAkmSharing = {
  enabled: boolean;
  hostStashPath: string;
  profilesImported?: string[];
};

export async function fetchHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('GET', '/admin/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}

export async function enableHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('PUT', '/admin/akm/host-sharing', {}));
  return (await res.json()) as HostAkmSharing;
}

export async function disableHostAkmSharing(): Promise<HostAkmSharing> {
  const res = await requireOk(await request('DELETE', '/admin/akm/host-sharing'));
  return (await res.json()) as HostAkmSharing;
}
