import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => ({
  bootstrapStart: vi.fn(),
  goto: vi.fn(async () => {}),
}));

vi.mock('./bootstrap.js', () => ({ bootstrapStart: mocks.bootstrapStart }));
vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => ({ effectiveCapabilities: ['host:setup'] }),
}));
vi.mock('$lib/endpoints-state.svelte.js', () => ({ endpointsService: {} }));

import StartPage from './+page.svelte';

afterEach(() => {
  mocks.bootstrapStart.mockReset();
  mocks.goto.mockClear();
});

describe('/start first-run surface', () => {
  test('shows only loading while display mode and browser connections settle', async () => {
    mocks.bootstrapStart.mockReturnValue(new Promise(() => {}));
    render(StartPage);

    await expect.element(page.getByRole('status')).toHaveTextContent(/checking this browser/i);
    await expect.element(page.getByText('Set up OpenPalm on this computer')).not.toBeInTheDocument();
  });

  test('renders the nontechnical local-or-existing choice after bootstrap settles', async () => {
    mocks.bootstrapStart.mockResolvedValue({ kind: 'choice' });
    render(StartPage);

    await expect.element(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
    await expect.element(page.getByText('Set up OpenPalm on this computer')).toBeVisible();
    await expect.element(page.getByText('Connect to an existing OpenPalm')).toBeVisible();
  });

  // Connecting to an OpenPalm that already exists is a first-class answer, not
  // a fallback — it used to be the only card without an accent border, a fill
  // or a badge, which read as "you probably want the other one".
  test('presents both routes as equals, each saying what it costs', async () => {
    mocks.bootstrapStart.mockResolvedValue({ kind: 'choice' });
    render(StartPage);

    await expect.element(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
    await expect.element(page.getByText('Recommended')).toBeVisible();
    await expect.element(page.getByText('No install needed')).toBeVisible();

    const cards = Array.from(document.querySelectorAll<HTMLElement>('.choice'));
    expect(cards).toHaveLength(2);
    // No card carries styling the other lacks.
    const [installStyle, connectStyle] = cards.map((card) => getComputedStyle(card));
    expect(connectStyle.borderTopWidth).toBe(installStyle.borderTopWidth);
    expect(connectStyle.borderTopColor).toBe(installStyle.borderTopColor);
    expect(connectStyle.backgroundColor).toBe(installStyle.backgroundColor);
  });

  test('shows an explicit error and retries the browser bootstrap', async () => {
    mocks.bootstrapStart
      .mockRejectedValueOnce(new Error('Browser storage is unavailable'))
      .mockResolvedValueOnce({ kind: 'choice' });
    render(StartPage);

    await expect.element(page.getByRole('alert')).toHaveTextContent('Browser storage is unavailable');
    (page.getByRole('button', { name: 'Retry' }).element() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.bootstrapStart).toHaveBeenCalledTimes(2));
    await expect.element(page.getByRole('heading', { name: 'Welcome to OpenPalm' })).toBeVisible();
    expect(mocks.bootstrapStart).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), true);
  });
});
