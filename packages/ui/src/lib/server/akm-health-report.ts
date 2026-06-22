import type { ControlPlaneState } from '@openpalm/lib';
import { runAssistantAkmCommand } from '@openpalm/lib';

export const AKM_HEALTH_REPORT_WINDOWS = ['24h', '72h', '7d', '14d', '30d'] as const;

export type AkmHealthReportWindow = (typeof AKM_HEALTH_REPORT_WINDOWS)[number];

export function clampWindow(value: string | null): AkmHealthReportWindow {
  return (AKM_HEALTH_REPORT_WINDOWS as readonly string[]).includes(value ?? '')
    ? (value as AkmHealthReportWindow)
    : '72h';
}

function errorHtml(window: AkmHealthReportWindow, missing: boolean, detail: string): string {
  const title = missing ? 'AKM is not available' : 'AKM health report unavailable';
  const body = missing
    ? 'The <code>akm</code> CLI was not found in the running assistant container.'
    : `The admin UI could not build the report from <code>akm health</code> for window <code>${window}</code>.`;
  const pre = detail ? `<pre>${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AKM Health Report</title><style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#07111f;color:#e5eefc;padding:24px}main{max-width:860px;margin:0 auto;background:#101b2d;border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:24px}pre{white-space:pre-wrap;background:#15233a;padding:16px;border-radius:12px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,monospace}</style></head><body><main><h1>${title}</h1><p>${body}</p>${pre}</main></body></html>`;
}

export async function buildAkmHealthReport(
  state: ControlPlaneState,
  requestedWindow: string | null,
): Promise<{ html: string; window: AkmHealthReportWindow }> {
  const window = clampWindow(requestedWindow);
  const result = await runAssistantAkmCommand(
    state,
    ['health', `--since=${window}`, '--format', 'html'],
    30_000,
  );

  if (result.missing) {
    return { window, html: errorHtml(window, true, '') };
  }

  if (!result.ok || !result.stdout.trim()) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n\n');
    return { window, html: errorHtml(window, false, detail) };
  }

  return { html: result.stdout, window };
}
