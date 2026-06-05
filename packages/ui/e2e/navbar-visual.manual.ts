/**
 * Manual visual check for the responsive navbar (#438). NOT an automated test —
 * it needs the dev server running and screenshots a human eyeballs.
 *
 * Run:
 *   1. ./scripts/dev-setup.sh --seed-env        # seeds .dev + login secret
 *   2. (cd packages/ui && OP_HOME=$PWD/../../.dev PORT=5173 npm run dev)
 *   3. (cd packages/ui && bun e2e/navbar-visual.manual.ts)
 *   → screenshots in /tmp/navshots/, login handled by e2e/helpers/auth.ts
 *
 * This is the reusable scaffold for browser-based UI verification: it logs in
 * via the AuthGate (reading the dev secret from disk) then drives the navbar at
 * mobile + desktop widths.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { login, readDevLoginPassword } from './helpers/auth';

const BASE = process.env.UI_URL ?? 'http://localhost:5173';
const OUT = '/tmp/navshots';
mkdirSync(OUT, { recursive: true });
const pw = readDevLoginPassword();

const browser = await chromium.launch();
try {
  // ── Mobile ──────────────────────────────────────────────────────────────
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mobile.newPage();
  await login(mp, BASE, pw);
  await mp.screenshot({ path: `${OUT}/m1-chat.png` });
  await mp.locator('.mobile-menu-btn').click();
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: `${OUT}/m2-sheet.png` });
  await mp.locator('#session-trigger').click();
  await mp.waitForTimeout(400);
  await mp.screenshot({ path: `${OUT}/m3-popover.png` });
  console.log('mobile: popover open =', await mp.locator(':popover-open').count());
  await mobile.close();

  // ── Desktop ─────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dp = await desktop.newPage();
  await login(dp, BASE, pw);
  await dp.screenshot({ path: `${OUT}/d1-navbar.png` });
  await dp.locator('#session-trigger').click();
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: `${OUT}/d2-popover.png` });
  console.log('desktop: hamburger hidden =', !(await dp.locator('.mobile-menu-btn').isVisible()),
              '| popover open =', await dp.locator(':popover-open').count());
  await desktop.close();
  console.log(`screenshots → ${OUT}`);
} finally {
  await browser.close();
}
