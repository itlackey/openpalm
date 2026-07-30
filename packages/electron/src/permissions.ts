import { session, shell, systemPreferences } from 'electron';
import { UI_PORT } from './ui-port.js';

// The navbar mic records via getUserMedia in the renderer. Two layers must both
// grant access or the captured audio is SILENT (not an error) — and silence is
// what makes Whisper transcribe a phantom "You":
//   1. Electron's session permission layer must approve the `media` request from
//      our trusted local UI origin (127.0.0.1/localhost). We deny everything else.
//   2. macOS TCC must have granted the app mic access. That requires
//      NSMicrophoneUsageDescription in the app's Info.plist (set in
//      electron-builder.yml) AND askForMediaAccess() — BUT the OS only shows the
//      prompt in response to an actual user interaction (clicking the mic button),
//      not at app startup. We therefore expose this as an IPC call so the renderer
//      can request it precisely when the user first clicks the mic.
function isTrustedLocalOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
  // The port main.ts actually served the window on — ./ui-port.ts, not a second
  // resolution. Resolving here from live env alone ignored a persisted
  // OP_HOST_UI_PORT that main.ts honours, so on a custom-port install the real
  // renderer origin failed this check and the mic recorded silence.
  const actualPort = parsed.port ? Number(parsed.port) : 80;
  return actualPort === UI_PORT;
}

/**
 * Approve microphone (`media`) capture only for our own trusted local UI origin
 * and deny everything else, on both the async request and sync check handlers.
 */
export function configureMediaPermissions(): void {
  const ses = session.defaultSession;

  // Async grant (Chromium asks once per origin). Approve audio capture only for
  // our own UI; deny anything unexpected.
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media' && isTrustedLocalOrigin(details.requestingUrl ?? '')) {
      callback(true);
      return;
    }
    callback(false);
  });

  // Some getUserMedia paths consult the synchronous check handler — grant media
  // there for the same trusted origin.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'media' && isTrustedLocalOrigin(requestingOrigin ?? '');
  });
}

// Called from the renderer via IPC when the user clicks the mic button.
// Returns the access status ('granted' | 'denied' | 'restricted' | 'unknown').
// On Windows/Linux the Electron permission handler above is sufficient; this
// is only a meaningful prompt on macOS (the OS ignores non-user-gesture calls).
//
// IMPORTANT (the 0.11.3 "OpenPalm never appears in the Microphone list" bug):
// askForMediaAccess() can resolve false WITHOUT macOS ever showing a prompt or
// registering the app under Privacy & Security → Microphone. That happens when
// the app's code signature has the Hardened Runtime flag but is missing the
// com.apple.security.device.audio-input entitlement — the runtime denies the
// request before TCC is consulted. The entitlement is shipped via
// assets/entitlements.mac.plist (see electron-builder.yml). We detect the
// "denied without prompt" signature here (status was not-determined, ask
// resolved false) and report it distinctly so the UI doesn't send the user to
// a Settings list the app isn't in.
export async function requestMicrophoneAccess(): Promise<string> {
  if (process.platform !== 'darwin') return 'granted';
  try {
    const before = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone TCC status before request:', before);
    if (before === 'granted') return 'granted';
    if (before === 'denied' || before === 'restricted') {
      // The app IS registered with TCC but switched off (or MDM-restricted).
      // Open the exact Settings pane so "enable OpenPalm" is one click away.
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      return before;
    }
    // not-determined → this ask should trigger the OS prompt.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    const after = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone TCC status after request:', after, '(askForMediaAccess →', granted, ')');
    if (granted) return 'granted';
    // Denied with no prompt and still not-determined afterwards = the OS never
    // consulted TCC (entitlement/signature problem) — Settings won't list us,
    // so don't tell the user to flip a toggle that doesn't exist.
    if (after === 'not-determined') return 'denied-no-prompt';
    return 'denied';
  } catch (err) {
    console.warn('Microphone access request failed:', err instanceof Error ? err.message : String(err));
    return 'unknown';
  }
}
