/**
 * Answer OpenCode's HTTP Basic challenge for the embedded workspace.
 *
 * `/advanced` frames OpenCode's own origin rather than the locked `/oc`
 * connection (see the UI's `routes/(app)/advanced/embeddable.ts` for why). That
 * frame is a plain browser request, so when `assistantDirect` is on — the
 * toggle that turns `OPENCODE_AUTH` on — it gets a 401 the renderer cannot
 * answer: the browser deliberately never holds the OpenCode credential.
 *
 * The desktop shell can. It already resolves that credential from OP_HOME to
 * launch the UI child, and Electron's `login` event lets the MAIN process
 * supply it without the credential ever reaching page script. Without this
 * handler Electron's default is to cancel the authentication, so the frame
 * renders OpenCode's empty 401 instead of the workspace.
 *
 * Scoped to exactly one target: the assistant endpoint THIS install resolves
 * (`resolveAssistantEndpoint`, the same resolver the UI proxy uses). Any other
 * host, port, proxy challenge, or auth scheme is left alone — an unanswered
 * `login` event falls through to Electron's default.
 */
import { app, type AuthenticationResponseDetails, type AuthInfo } from 'electron';
import {
  DEFAULT_OPENCODE_USERNAME,
  readStackEnv,
  resolveAssistantEndpoint,
  resolveOpenCodeCredential,
} from '@openpalm/lib';

/**
 * Does this challenge come from the OpenCode THIS install owns?
 *
 * Deliberately not exported: the answer is only safe inside the listener's
 * other guards below, and an exported "where is the assistant" helper is an
 * invitation for some later caller to reach the address without them.
 */
function isAssistantChallenge(
  authInfo: Pick<AuthInfo, 'host' | 'port'>,
  homeDir: string,
  persistedEnv: Record<string, string | undefined>,
): boolean {
  let url: URL;
  try {
    url = new URL(resolveAssistantEndpoint(homeDir, process.env, persistedEnv));
  } catch {
    return false;
  }
  // `new URL` guarantees `port` is either empty or a valid port, so the only
  // case to fill in is the scheme's default.
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return authInfo.host === url.hostname && authInfo.port === port;
}

export function configureAssistantWorkspaceAuth(homeDir: string): void {
  app.on(
    'login',
    (
      event: Electron.Event,
      _webContents: Electron.WebContents,
      _details: AuthenticationResponseDetails,
      authInfo: AuthInfo,
      callback: (username?: string, password?: string) => void,
    ) => {
      // Free discriminators first — resolving the target reads from disk, and
      // neither of these can ever be the assistant. A proxy challenge is some
      // middlebox in front of the app (handing it this key would leak the
      // credential to a party that never asked for it), and OpenCode serves
      // Basic, not Negotiate/NTLM.
      if (authInfo.isProxy || authInfo.scheme.toLowerCase() !== 'basic') return;
      // Read once, resolve twice. Both resolvers otherwise default to their own
      // readStackEnv(homeDir) — the same double-parse per request that the UI's
      // /oc proxy already had to retire (lib/server/opencode-target.ts).
      // Deliberately NOT cached across challenges: an operator toggling
      // `assistantDirect` rotates this at runtime, and Chromium re-challenges
      // precisely when a cached credential stopped working.
      const persistedEnv = readStackEnv(homeDir);
      if (!isAssistantChallenge(authInfo, homeDir, persistedEnv)) return;
      const { username, password } = resolveOpenCodeCredential(homeDir, process.env, persistedEnv);
      if (!password) return;
      event.preventDefault();
      callback(username || DEFAULT_OPENCODE_USERNAME, password);
    },
  );
}
