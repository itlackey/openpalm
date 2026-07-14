#!/usr/bin/env bun
/**
 * Standalone CLI entrypoint (`bunx @openpalm/discord-portal`). Mirrors
 * containers/portal/portal-entrypoint.ts's crash safety net: under Bun an
 * unhandled rejection or uncaught exception terminates the process, so log it
 * as structured JSON first (diagnosable), then exit non-zero. Unlike the baked
 * entrypoint there is no PORTAL_PACKAGE/dynamic import here — the portal class
 * is statically known, which is the whole point of a package-local bin.
 */
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-discord',
    msg: 'unhandledRejection',
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  }));
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    service: 'portal-discord',
    msg: 'uncaughtException',
    reason: err instanceof Error ? (err.stack ?? err.message) : String(err),
  }));
  process.exit(1);
});

import Portal from '../src/index.ts';
new Portal().start();
