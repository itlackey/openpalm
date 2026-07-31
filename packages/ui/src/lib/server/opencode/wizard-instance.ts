/**
 * Shared bookkeeping for the wizard-spawned OpenCode instance.
 *
 * `POST /api/setup/opencode/ensure` spawns a throwaway `opencode serve
 * --port=0` when the real assistant isn't reachable yet (a genuinely fresh
 * host, before the first deploy). Its URL used to live in a module-level
 * variable INSIDE that route file — invisible to every sibling route. Recording
 * it HERE instead lets `/api/setup/opencode/providers`, `/status`, and both
 * OAuth routes resolve requests against it (via `resolveSetupOpencodeTarget` in
 * `setup-target.ts`) instead of hardcoding the deployed-assistant target, which
 * is unreachable until the first deploy completes (W1).
 */

let wizardUrl: string | null = null;

/** The currently-tracked wizard-spawned OpenCode URL, or null when none is running. */
export function getWizardOpencodeUrl(): string | null {
  return wizardUrl;
}

/** Record (or, with null, clear) the wizard-spawned instance's URL. */
export function setWizardOpencodeUrl(url: string | null): void {
  wizardUrl = url;
}
