import type { ChannelState } from './types.js';

export function isChannelEnabled(channelSelection: Record<string, boolean | ChannelState>, chId: string, locked?: boolean): boolean {
  if (locked) return true;
  const sel = channelSelection[chId];
  if (typeof sel === 'object' && sel !== null) return sel.enabled;
  return !!sel;
}

export function getCredValue(channelSelection: Record<string, boolean | ChannelState>, chId: string, key: string): string {
  const sel = channelSelection[chId];
  if (typeof sel === 'object' && sel !== null) return String(sel[key] ?? '');
  return '';
}
