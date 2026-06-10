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
  if (!desktopNotifyEnabled()) return false;
  return typeof window !== 'undefined' && typeof window.openpalm?.notify === 'function';
}

export function notifyAssistantReply(replyText: string): void {
  if (!shouldNotifyDesktop()) return;
  const body = desktopReplyPreviewEnabled() && replyText.trim()
    ? replyText.trim()
    : 'Assistant replied';
  window.openpalm?.notify?.('OpenPalm', body);
}

export function notifyAssistantError(): void {
  if (!shouldNotifyDesktop()) return;
  window.openpalm?.notify?.('OpenPalm', 'Assistant error');
}
