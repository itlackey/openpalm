/**
 * Target resolution for the `/api/setup/opencode/*` namespace ONLY (W1).
 *
 * Provider-catalog, status, and OAuth calls made from the setup WIZARD must
 * not blindly resolve to the deployed assistant's target
 * (`getAssistantOpencodeTarget()` — effectively 127.0.0.1:3810): on a
 * genuinely fresh host nothing listens there until the first deploy
 * completes. `POST /api/setup/opencode/ensure` spawns a throwaway `opencode
 * serve` instance for exactly that gap and records its URL in
 * `wizard-instance.ts`; this module is what lets the sibling setup routes
 * consult it instead of each re-deriving their own fallback.
 *
 * Preference order: the deployed assistant, when it is ACTUALLY reachable
 * right now (so a rerun against a healthy stack — or this same wizard after
 * its own first deploy finishes — keeps using the real thing, with its real
 * credentials) — otherwise the wizard-spawned instance, if `ensure` has one
 * running. Reachability is checked fresh on every call (a cheap loopback
 * request, short timeout) rather than cached: which of the two answers is
 * correct changes exactly once per wizard session (at first deploy), and
 * caching the wrong side of that transition is worse than one extra local
 * fetch per call.
 */
import { assistantAuthHeaders } from '../basic-auth.js';
import { getAssistantOpencodeTarget } from '../opencode-target.js';
import { getWizardOpencodeUrl } from './wizard-instance.js';

export interface SetupOpencodeTarget {
  url: string;
  username?: string;
  password?: string;
}

async function isReachable(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const res = await fetch(`${url}/provider`, { headers, signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the OpenCode target the setup wizard should talk to right now, or
 * `null` when neither the deployed assistant nor a wizard-spawned instance is
 * reachable.
 */
export async function resolveSetupOpencodeTarget(): Promise<SetupOpencodeTarget | null> {
  const assistant = getAssistantOpencodeTarget();
  if (await isReachable(assistant.url, assistantAuthHeaders(assistant))) {
    return { url: assistant.url, username: assistant.username, password: assistant.password };
  }

  const wizardUrl = getWizardOpencodeUrl();
  // The wizard-spawned instance is a bare `opencode serve` with no auth wired
  // up — never send it the assistant's credential.
  if (wizardUrl && await isReachable(wizardUrl)) {
    return { url: wizardUrl };
  }

  return null;
}
