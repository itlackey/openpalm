/**
 * Desktop notifications for reply completion/error (review 2026-07-10 §B12).
 * Ported from packages/ui/src/lib/desktop-notifications.ts with a web
 * `Notification` fallback added: the host app only ever runs inside
 * Electron, so `window.openpalm?.notify` was its only path — the client SPA
 * can also run as a plain browser tab (or PWA) with no Electron bridge, so
 * this feature-detects the bridge first and falls back to the standard
 * `Notification` API when it's absent and permission has already been
 * granted. Content-free by default (title/body never leak assistant text
 * unless the user opts in) — same privacy posture as the host app.
 */

const DESKTOP_NOTIFY_ENABLED_KEY = 'openpalm.desktop.notify';
const DESKTOP_NOTIFY_PREVIEW_KEY = 'openpalm.desktop.notify.preview';

function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage is optional. Keep the runtime state best-effort.
  }
}

export function desktopNotifyEnabled(): boolean {
  return readFlag(DESKTOP_NOTIFY_ENABLED_KEY);
}

export function desktopReplyPreviewEnabled(): boolean {
  return readFlag(DESKTOP_NOTIFY_PREVIEW_KEY);
}

export function setDesktopNotifyEnabled(value: boolean): void {
  writeFlag(DESKTOP_NOTIFY_ENABLED_KEY, value);
}

export function setDesktopReplyPreviewEnabled(value: boolean): void {
  writeFlag(DESKTOP_NOTIFY_PREVIEW_KEY, value);
}

function shouldNotifyDesktop(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.hasFocus()) return false;
  return desktopNotifyEnabled();
}

/** True if window.openpalm?.notify exists and was called. */
function notifyViaElectronBridge(title: string, body: string): boolean {
  if (typeof window === 'undefined') return false;
  const notify = window.openpalm?.notify;
  if (typeof notify !== 'function') return false;
  notify(title, body);
  return true;
}

/**
 * Fallback for the plain-browser-tab / PWA case, where there is no Electron
 * bridge. Never requests permission from here — that must happen from a
 * user-gesture handler (e.g. the settings toggle) via
 * `requestDesktopNotifyPermission()` below; a reply/error completion is not
 * a user gesture, and browsers ignore (or the spec forbids) permission
 * prompts outside one.
 */
function notifyViaWebNotification(title: string, body: string): void {
  if (typeof window === 'undefined') return;
  const NotificationCtor = window.Notification;
  if (typeof NotificationCtor === 'undefined' || NotificationCtor.permission !== 'granted') return;
  new NotificationCtor(title, { body });
}

/**
 * Ask the browser for Notification permission. Call this from a user-gesture
 * handler (e.g. the moment the user flips the notify toggle on) — never from
 * `notifyAssistantReply`/`notifyAssistantError` themselves.
 */
export async function requestDesktopNotifyPermission(): Promise<NotificationPermission | null> {
  if (typeof window === 'undefined') return null;
  const NotificationCtor = window.Notification;
  if (typeof NotificationCtor === 'undefined') return null;
  if (NotificationCtor.permission !== 'default') return NotificationCtor.permission;
  try {
    return await NotificationCtor.requestPermission();
  } catch {
    return NotificationCtor.permission;
  }
}

/**
 * F7 (review 2026-07-11): flip the desktop-notify preference and, when
 * turning it ON, request the browser Notification permission — the pure
 * logic behind the client's reachable notify-toggle control (routes/
 * +layout.svelte). Before this, nothing in packages/client ever WROTE
 * 'openpalm.desktop.notify', so `desktopNotifyEnabled()` (and therefore
 * `shouldNotifyDesktop()`, which every notify call is gated on) could never
 * become true — the whole feature was inert regardless of how a turn ended.
 * Mirrors the host app's UpdatesTab.svelte onchange handler, adapted from a
 * checkbox to a toggle button. Permission is requested fire-and-forget
 * (never awaited) since this runs from a click handler, not an async flow —
 * the toggle's own visible state already reflects the stored preference
 * immediately regardless of what the browser's permission prompt decides.
 */
export function toggleDesktopNotify(current: boolean): boolean {
  const next = !current;
  setDesktopNotifyEnabled(next);
  if (next) void requestDesktopNotifyPermission();
  return next;
}

export function notifyAssistantReply(replyText: string): void {
  if (!shouldNotifyDesktop()) return;
  const body =
    desktopReplyPreviewEnabled() && replyText.trim() ? replyText.trim() : 'Assistant replied';
  if (notifyViaElectronBridge('OpenPalm', body)) return;
  notifyViaWebNotification('OpenPalm', body);
}

export function notifyAssistantError(): void {
  if (!shouldNotifyDesktop()) return;
  if (notifyViaElectronBridge('OpenPalm', 'Assistant error')) return;
  notifyViaWebNotification('OpenPalm', 'Assistant error');
}
