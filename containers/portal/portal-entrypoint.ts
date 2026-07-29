function logError(msg: string): void {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-entrypoint',
    msg,
  }));
}

// Last-resort safety net: under Bun an unhandled rejection or uncaught
// exception terminates the process. Log it as structured JSON first so the
// crash is diagnosable, then exit non-zero so Docker's restart policy recovers.
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-entrypoint',
    msg: 'unhandledRejection',
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  }));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-entrypoint',
    msg: 'uncaughtException',
    reason: err instanceof Error ? (err.stack ?? err.message) : String(err),
  }));
  process.exit(1);
});

const portalPackage = Bun.env.PORTAL_PACKAGE;

if (!portalPackage) {
  logError('PORTAL_PACKAGE environment variable is required');
  process.exit(1);
}

const versionAt = portalPackage.lastIndexOf('@');
const name = versionAt > 0 ? portalPackage.slice(0, versionAt) : portalPackage;

// Adapters are installed under /opt/openpalm/tools from local candidate
// tarballs. Import by package name so the runtime selector stays stable.
const toolsRoot = Bun.env.TOOLS_ROOT ?? '/opt/openpalm/tools';
const importTarget = `${toolsRoot}/node_modules/${name}`;

let mod: Record<string, unknown>;
try {
  mod = await import(importTarget);
} catch (err) {
  logError(`Failed to import portal "${name}" from ${importTarget}: ${err instanceof Error ? err.message : String(err)}`);
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
