import { request, requireOk, readErrorMessage } from './core.js';

// ── Voice addon types (hardware profiles + background bring-up jobs) ────────

export type VoiceAddonProfile = {
  id: string;
  services: string[];
  label?: string;
  requires?: string;
  default?: boolean;
  /** Set by the server when the host can actually run this profile (e.g. NVIDIA drivers detected). */
  available?: boolean;
  /** Human-readable explanation surfaced as a tooltip when `available` is false. */
  reason?: string;
};

export type VoiceAddonStep = { step: string; ok: boolean; detail?: string };

export type VoiceActiveJob = {
  state: 'pulling' | 'starting' | 'healthy' | 'error';
  steps: VoiceAddonStep[];
  error?: string;
  startedAt: number;
  finishedAt?: number;
  profile?: string;
};

export type VoiceAddonInfo = {
  profiles: VoiceAddonProfile[];
  selectedProfile: string | null;
  /** Present while a background pull/start is in flight or has just completed. */
  activeJob?: VoiceActiveJob;
};

// ── Addon Management ──────────────────────────────────────────────────────────

export type AddonEntry = { name: string; enabled: boolean; available: boolean };

export type AddonList = {
  addons: AddonEntry[];
  /** Voice hardware profiles + selection + in-flight bring-up job. */
  voice?: VoiceAddonInfo;
};

export async function fetchAddons(): Promise<AddonList> {
  const res = await requireOk(await request('GET', '/api/host/addons'));
  return (await res.json()) as AddonList;
}

export type AddonToggleResult = {
  ok: boolean;
  /** HTTP status the server returned (200 / 202 / 502). */
  status: number;
  enabled?: boolean;
  changed?: boolean;
  /** Present for voice enables: bring-up steps, background-pull status, error. */
  voiceAddon?: {
    steps: VoiceAddonStep[];
    status?: 'pulling';
    warming?: boolean;
    message?: string;
    error?: string;
  };
};

export async function toggleAddon(
  name: string,
  enabled: boolean,
  opts?: { profile?: string }
): Promise<AddonToggleResult> {
  const body: Record<string, unknown> = { enabled };
  if (opts?.profile) body.profile = opts.profile;
  const res = await request('POST', `/api/host/addons/${encodeURIComponent(name)}`, body);
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid password.'), { status: 401 });
  }
  // Voice enables reply 202 (image pulling in the background — poll
  // fetchAddons() for the activeJob) or 502 (bring-up failed) with a
  // structured voiceAddon payload; plain toggles reply 200.
  if (res.status === 200 || res.status === 202 || res.status === 502) {
    const parsed = (await res.json()) as Omit<AddonToggleResult, 'status'>;
    return { ...parsed, status: res.status };
  }
  throw new Error(await readErrorMessage(res));
}

/** Persist / apply a voice hardware-profile change. When the addon is
 * enabled this re-engages the container on the new profile (may reply 202
 * for a background image pull); when disabled it just records the choice. */
export async function saveVoiceProfile(profile: string): Promise<AddonToggleResult> {
  const res = await request('POST', '/api/host/addons/voice', { profile });
  if (res.status === 401) {
    throw Object.assign(new Error('Invalid password.'), { status: 401 });
  }
  if (res.status === 200 || res.status === 202 || res.status === 502) {
    const parsed = (await res.json()) as Omit<AddonToggleResult, 'status'>;
    return { ...parsed, status: res.status };
  }
  throw new Error(await readErrorMessage(res));
}

export type AddonCredentialField = {
  key: string;
  sensitive: boolean;
  /** Renders as a checkbox instead of a text input; value is the literal string "true"/"false". */
  boolean: boolean;
  description: string;
  default: string;
  set: boolean;
  value: string;
};

export async function fetchAddonCredentials(name: string): Promise<AddonCredentialField[]> {
  const res = await requireOk(await request('GET', `/api/host/addons/${encodeURIComponent(name)}/credentials`));
  const data = (await res.json()) as { fields: AddonCredentialField[] };
  return data.fields;
}

export async function saveAddonCredentials(
  name: string,
  values: Record<string, string>
): Promise<{ ok: boolean; updated: string[] }> {
  const res = await requireOk(
    await request('POST', `/api/host/addons/${encodeURIComponent(name)}/credentials`, { values })
  );
  return (await res.json()) as { ok: boolean; updated: string[] };
}
