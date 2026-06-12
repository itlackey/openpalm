function logError(msg: string): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-entrypoint',
    msg,
  }));
}

const portalPackage = Bun.env.PORTAL_PACKAGE;

if (!portalPackage) {
  logError('PORTAL_PACKAGE environment variable is required');
  process.exit(1);
}

const versionAt = portalPackage.lastIndexOf('@');
const importTarget = versionAt > 0 ? portalPackage.slice(0, versionAt) : portalPackage;

let mod: Record<string, unknown>;
try {
  mod = await import(importTarget);
} catch (err) {
  logError(`Failed to import portal "${importTarget}": ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const PortalClass = mod.default as { new (): { start?: () => void } } | undefined;
if (!PortalClass || typeof PortalClass !== 'function') {
  logError('Portal module must have a default export that is a class with a zero-argument constructor');
  process.exit(1);
}

let portal: { start?: () => void };
try {
  portal = new PortalClass();
} catch (err) {
  logError(`Failed to instantiate portal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (typeof portal.start !== 'function') {
  logError('Default export must expose a start() method');
  process.exit(1);
}

portal.start();
