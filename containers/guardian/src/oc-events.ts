export const TURN_IDLE_STATUSES: ReadonlySet<string> = new Set(['idle']);

export function statusName(status: unknown): string | undefined {
  if (typeof status === 'string') return status;
  if (status && typeof status === 'object' && typeof (status as { type?: unknown }).type === 'string') {
    return (status as { type: string }).type;
  }
  return undefined;
}
