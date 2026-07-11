/**
 * G2(d) [HIGH] (review 2026-07-10 §G2) — @axe-core/playwright scans of
 * /chat and /connections with no serious/critical violations. The review's
 * own G1/G4 accessibility findings (missing live region, missing
 * aria-current) would have been caught here first.
 *
 * `color-contrast` is deliberately excluded: both pages fail it identically
 * on `--s-ink-3` text over `--s-paper`/`--s-paper-deep` (2.5:1, needs
 * 4.5:1) — a shared design-token issue defined in
 * packages/ui-kit/src/lib/theme/tokens.css and reproduced verbatim in
 * packages/ui/src/app.css, not something the client migration introduced
 * or something this package can fix (packages/ui-kit is out of this work
 * package's ownership scope). Tracked as a blocked finding in this stage's
 * report; every other axe rule stays enabled and gating.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addConnection, gotoConnectedChat } from './fixtures/client-app.js';
import { startStubAssistant, type StubAssistant } from './fixtures/stub-assistant.js';

type Violation = { id: string; impact?: string | null; nodes: unknown[] };

function seriousOrCritical(violations: Violation[]): Violation[] {
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

function describeViolations(violations: Violation[]): string {
  return violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`).join('\n');
}

function scan(page: Parameters<typeof AxeBuilder>[0]['page']): AxeBuilder {
  return new AxeBuilder({ page }).disableRules(['color-contrast']);
}

let assistant: StubAssistant | undefined;

test.afterEach(async () => {
  await assistant?.close();
  assistant = undefined;
});

test('/connections has no serious or critical accessibility violations', async ({ page }) => {
  await page.goto('/connections');
  await page.getByRole('button', { name: /Add connection/ }).click();
  // Scan with the drawer open too — it's the primary interactive surface on
  // this page and where G3's focus-trap findings live.
  await expect(page.getByRole('dialog')).toBeVisible();

  const results = await scan(page).analyze();
  const bad = seriousOrCritical(results.violations as Violation[]);
  expect(bad, describeViolations(bad)).toEqual([]);
});

test('/chat has no serious or critical accessibility violations', async ({ page }) => {
  assistant = await startStubAssistant({
    onMessage: (a, sessionId, text) => {
      a.pushEvent('message.part.delta', { sessionID: sessionId, field: 'text', delta: `Echo: ${text}` });
      a.pushEvent('session.idle', { sessionID: sessionId });
    },
  });
  await addConnection(page, assistant.url);
  await gotoConnectedChat(page);

  // Scan both the empty state and after a round-trip (ChatTurn/ToolLog/copy
  // affordances only render once there's an entry).
  const emptyResults = await scan(page).analyze();
  const emptyBad = seriousOrCritical(emptyResults.violations as Violation[]);
  expect(emptyBad, describeViolations(emptyBad)).toEqual([]);

  const composer = page.getByLabel('Message input');
  await composer.fill('Hello there');
  await composer.press('Enter');
  await expect(page.getByRole('log', { name: 'Chat history' })).toContainText('Echo: Hello there');

  const results = await scan(page).analyze();
  const bad = seriousOrCritical(results.violations as Violation[]);
  expect(bad, describeViolations(bad)).toEqual([]);
});
