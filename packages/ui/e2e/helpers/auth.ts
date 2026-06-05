/**
 * Reusable Playwright auth helper for the OpenPalm operator UI.
 *
 * The UI is gated by the AuthGate overlay (no /login route). The expected
 * password lives in the `op_ui_login_password` file secret under OP_HOME
 * (knowledge/secrets/) — NOT a hardcoded value (a setup re-run or a test can
 * change it). Always read it from disk so the helper matches whatever the
 * dev server's vite.config secret-bridge injected.
 *
 * Usage (run with `bun` from packages/ui so node_modules resolves):
 *   import { chromium } from 'playwright';
 *   import { readDevLoginPassword, login } from './e2e/helpers/auth';
 *   const page = await ctx.newPage();
 *   await login(page, 'http://localhost:5173', readDevLoginPassword());
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright';

/** Read the dev login password from the OP_HOME file secret. */
export function readDevLoginPassword(opHome?: string): string {
  // Repo root is four levels up from packages/ui/e2e/helpers.
  const repoRoot = resolve(import.meta.dirname, '../../../..');
  // OP_HOME is often relative (the dev env sets `.dev`); resolve it against the
  // repo root, not the cwd, so this works regardless of where it's run from.
  const raw = opHome ?? process.env.OP_HOME ?? '.dev';
  const home = resolve(repoRoot, raw);
  const path = resolve(home, 'knowledge/secrets/op_ui_login_password');
  if (!existsSync(path)) {
    throw new Error(`login secret not found at ${path} — run scripts/dev-setup.sh --seed-env`);
  }
  return readFileSync(path, 'utf-8').trimEnd();
}

/**
 * Navigate to the app and clear the AuthGate. Resolves once the navbar
 * (header.navbar) is visible. Throws on a failed login so callers fail loudly.
 */
export async function login(page: Page, baseUrl: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/chat`, { waitUntil: 'domcontentloaded' });
  const pw = page.locator('input[autocomplete="current-password"]');
  if (await pw.count()) {
    await pw.fill(password);
    await page.locator('form.auth-form button[type="submit"]').click();
  }
  // AuthGate clears → the navbar renders. If the password was wrong the
  // "Invalid password" error stays and this throws (loud, not silent).
  await page.locator('header.navbar').first().waitFor({ state: 'visible', timeout: 10_000 });
}
