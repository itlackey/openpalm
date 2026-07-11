/**
 * Review 2026-07-10 J4 — DeployStep.svelte's two "Admin Dashboard" affordances
 * (the services-list link and the done-state button) pointed at the app root,
 * which the launch-routing guard resolves to `/chat` for a running stack —
 * not the admin dashboard the label promises. Both must target `/host`.
 *
 * Source-level assertion (same convention as the admin-paths-hygiene suite):
 * DeployStep.svelte's logic lives in a `<script>` block that isn't itself
 * componentized/exported, so a plain component-render test would need the
 * unrunnable browser vitest project (chromium headless-shell is unavailable
 * in this sandbox) — this pins the fix at the source-text level instead,
 * which the node project can run.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('./DeployStep.svelte', import.meta.url)), 'utf-8');

describe("DeployStep's admin-dashboard affordances point at /host (review 2026-07-10 J4)", () => {
  test('the services-list "admin" entry links to the /host path, not the app root', () => {
    expect(SOURCE).toMatch(/admin:\s*\{\s*port:\s*adminPort,\s*label:\s*'Admin Dashboard',\s*path:\s*'\/host'\s*\}/);
  });

  test('the done-state "Admin Dashboard" button resolves /host, not /', () => {
    expect(SOURCE).toMatch(/resolve\('\/host'\)\}\s*class="btn btn-secondary">Admin Dashboard</);
  });

  test("neither affordance still resolves the bare app root ('/') for admin", () => {
    // A bare resolve('/') anywhere immediately followed by the Admin Dashboard
    // label would indicate the J4 regression came back.
    expect(SOURCE).not.toMatch(/resolve\('\/'\)\}\s*class="btn btn-secondary">Admin Dashboard</);
  });
});
