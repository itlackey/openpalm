import { shell } from 'electron';
import { checkDocker, checkDockerCompose } from '@openpalm/lib';
import { readAssetText } from './assets.js';
import type { SplashWindow } from './splash.js';

// The desktop app drives the assistant via Docker Compose (the UI server's admin
// routes shell out to `docker compose`). Without a running Docker daemon the
// first thing a brand-new user would otherwise hit is an opaque `503
// docker_unavailable` ~60s into the splash spinner (deployment-review P0 #493).
// Run the SAME checks the CLI's requireDocker() uses (lib's checkDocker /
// checkDockerCompose — never duplicate the logic) BEFORE starting the UI, and
// replace the spinner with a friendly, actionable screen if Docker is absent.

export const GET_DOCKER_URL = 'https://docs.docker.com/get-docker/';

export type DockerPreflightResult = { ok: true } | { ok: false; title: string; message: string };

// Fallback used only if assets/docker-error.html can't be read (packaging
// regression). Interpolation tokens match the asset file.
const DOCKER_ERROR_FALLBACK_HTML =
  '<!doctype html><meta charset="utf-8"><body style="background:#0f172a;color:#f1f5f9;font-family:sans-serif;text-align:center;padding:28px"><h3>__TITLE__</h3><p>__MESSAGE__</p><button onclick="window.openpalm&&window.openpalm.openDockerInstall()">Install Docker</button> <button onclick="window.openpalm&&window.openpalm.retryDockerPreflight()">Retry</button></body>';

/**
 * Mirror the CLI's `requireDocker()` (install.ts) using lib's shared Docker
 * probes. Returns a friendly title/message on failure so the harness can render
 * it; never throws.
 */
export async function dockerPreflight(): Promise<DockerPreflightResult> {
  const docker = await checkDocker();
  if (!docker.ok) {
    return {
      ok: false,
      title: 'OpenPalm needs Docker Desktop',
      message:
        'OpenPalm runs your assistant in Docker, but Docker isn’t running. ' +
        'Install Docker Desktop (or start it if it’s already installed), then retry.',
    };
  }
  const compose = await checkDockerCompose();
  if (!compose.ok) {
    return {
      ok: false,
      title: 'Docker Compose v2 is required',
      message:
        'Docker is running, but Docker Compose v2 isn’t available. ' +
        'Update Docker Desktop (it bundles Compose v2), then retry.',
    };
  }
  return { ok: true };
}

/** HTML-escape user-facing text for safe interpolation into the error screen. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build the Docker-missing screen HTML from the asset template. */
function renderDockerErrorHtml(result: { title: string; message: string }): string {
  return readAssetText('docker-error.html', DOCKER_ERROR_FALLBACK_HTML)
    .replace('__TITLE__', esc(result.title))
    .replace('__MESSAGE__', esc(result.message));
}

/**
 * Blocks app startup until Docker (and Compose v2) are available, rendering a
 * friendly install/retry screen in the shared splash window whenever the
 * preflight fails. Owns the pending-retry promise so the IPC layer can resolve
 * it on the user's "retry" click.
 */
export class DockerPreflight {
  private retryResolve: (() => void) | null = null;

  constructor(private readonly splash: SplashWindow) {}

  /**
   * Block until Docker is available, showing the friendly install/retry screen
   * whenever the preflight fails. Returns once Docker (and Compose v2) are ready.
   */
  async ensureReady(): Promise<void> {
    for (;;) {
      const result = await dockerPreflight();
      if (result.ok) return;
      console.warn(`Docker preflight failed: ${result.message}`);
      await this.showErrorScreen(result);
      // loop: user clicked retry — re-run the preflight.
    }
  }

  /** Open the official Docker install page in the system browser. */
  openInstallPage(): void {
    void shell.openExternal(GET_DOCKER_URL);
  }

  /** Resolve the pending preflight promise (renderer's "retry" click). */
  retry(): void {
    const resolve = this.retryResolve;
    this.retryResolve = null;
    resolve?.();
  }

  /**
   * Replace the splash spinner with a friendly Docker-missing screen. The screen
   * offers an "Install Docker" button (opens the official install page in the
   * system browser) and an "I've installed it — retry" button that re-runs the
   * preflight. Resolves when the user clicks retry.
   */
  private showErrorScreen(result: { title: string; message: string }): Promise<void> {
    this.splash.render(renderDockerErrorHtml(result), { width: 460, height: 320, withPreload: true });
    return new Promise<void>((resolve) => { this.retryResolve = resolve; });
  }
}
