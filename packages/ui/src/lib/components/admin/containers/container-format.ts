// Presentation helpers shared by ContainerRow + ContainerDetail.
// Co-located so the row badge and detail badge can never drift.

export function parseImageTag(image: string): { name: string; tag: string } {
  const atIdx = image.indexOf('@');
  const base = atIdx > -1 ? image.slice(0, atIdx) : image;
  const colonIdx = base.lastIndexOf(':');
  if (colonIdx > -1) {
    return { name: base.slice(0, colonIdx), tag: base.slice(colonIdx + 1) };
  }
  return { name: base, tag: 'latest' };
}

export function containerStatusColor(state: string): 'success' | 'danger' | 'warning' | 'idle' {
  if (state === 'running') return 'success';
  if (state === 'exited' || state === 'dead' || state === 'stopped') return 'danger';
  if (state === 'restarting' || state === 'paused') return 'warning';
  return 'idle';
}

export function fmtState(s: string | undefined | null): string {
  if (!s) return s ?? '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
