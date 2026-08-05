import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const mocks = vi.hoisted(() => ({
  appPage: { url: new URL('http://localhost/connections/new') },
  encryptedAtRest: vi.fn(() => true),
  getStorageMode: vi.fn(async () => 'persistent'),
  goto: vi.fn(async () => {}),
  replaceState: vi.fn(),
  pairingFragment: vi.fn(() => ({ code: null as string | null, cleanPath: '/connections/new' })),
  parsePairingCode: vi.fn(),
  runtimeContext: { effectiveCapabilities: [] as string[] },
  saveVerifiedConnection: vi.fn(),
  verifyConnectionCandidate: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto, replaceState: mocks.replaceState }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/state', () => ({ page: mocks.appPage }));
vi.mock('$lib/connections/boot.js', () => ({
  getConnectionStorageMode: mocks.getStorageMode,
  getConnectionStore: () => ({}),
  getSecretStore: () => ({}),
}));
vi.mock('$lib/connections/onboarding.js', () => ({
  pairingFragment: mocks.pairingFragment,
  saveVerifiedConnection: mocks.saveVerifiedConnection,
  verifyConnectionCandidate: mocks.verifyConnectionCandidate,
}));
vi.mock('$lib/connections/pairing.js', () => ({ parsePairingCode: mocks.parsePairingCode }));
vi.mock('$lib/connections/secrets.js', () => ({
  connectionSecretsEncryptedAtRest: mocks.encryptedAtRest,
}));
vi.mock('$lib/connections/store.js', () => ({ newConnectionId: () => 'new-id' }));
vi.mock('$lib/endpoints-state.svelte.js', () => ({
  endpointsService: { activate: vi.fn(), load: vi.fn(), error: '' },
}));
vi.mock('$lib/runtime-context.svelte.js', () => ({
  getRuntimeContext: () => mocks.runtimeContext,
  hasCapability: (context: { effectiveCapabilities: string[] }, capability: string) =>
    context.effectiveCapabilities.includes(capability),
}));

import NewConnectionPage from './+page.svelte';

beforeEach(() => {
  mocks.appPage.url = new URL('http://localhost/connections/new');
  mocks.encryptedAtRest.mockReturnValue(true);
  mocks.pairingFragment.mockReturnValue({ code: null, cleanPath: '/connections/new' });
  mocks.runtimeContext.effectiveCapabilities = [];
  mocks.getStorageMode.mockResolvedValue('persistent');
  mocks.verifyConnectionCandidate.mockResolvedValue({
    ok: false,
    reason: 'network-uncertain',
    message: 'raw transport error',
  });
  mocks.saveVerifiedConnection.mockResolvedValue({ ok: false, error: 'save failed' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('/connections/new focus and navigation', () => {
  test('focuses each newly shown input and preserves values across internal Back', async () => {
    await render(NewConnectionPage);
    const pairing = page.getByRole('textbox', { name: 'Pairing code' });
    await expect.element(pairing).toHaveFocus();
    await pairing.fill('remember-this-code');

    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await expect.element(name).toHaveFocus();
    await name.fill('Home');

    await page.getByRole('button', { name: 'Back to pairing code' }).click();
    await expect.element(pairing).toHaveFocus();
    await expect.element(pairing).toHaveValue('remember-this-code');

    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await expect.element(name).toHaveValue('Home');
  });

  test('focuses pairing input when a fragment arrives while manual entry is visible', async () => {
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await expect.element(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveFocus();

    mocks.pairingFragment.mockReturnValue({
      code: 'incoming-code',
      cleanPath: '/connections/new',
    });
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    const pairing = page.getByRole('textbox', { name: 'Pairing code' });
    await expect.element(pairing).toHaveFocus();
    await expect.element(pairing).toHaveValue('incoming-code');
  });

  test('focuses and announces the password-storage warning, then restores manual focus on Back', async () => {
    mocks.encryptedAtRest.mockReturnValue(false);
    mocks.verifyConnectionCandidate.mockResolvedValue({
      ok: true,
      candidate: {
        verification: 'verified',
        label: 'Home',
        baseUrl: 'https://openpalm.example/oc',
        auth: { mode: 'basic', username: 'phone', password: 'secret' },
      },
    });
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByLabelText('Password').fill('secret');
    await page.getByRole('button', { name: 'Connect' }).click();

    const warning = page.getByRole('alert');
    await expect.element(warning).toBeVisible();
    await expect.element(page.getByRole('heading', { name: /cannot protect saved passwords/i })).toHaveFocus();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.element(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveFocus();
    await expect.element(page.getByLabelText('Password')).toHaveValue('secret');
  });

  test('keeps manual values on retry and replaces transport jargon with actionable copy', async () => {
    mocks.verifyConnectionCandidate.mockResolvedValue({
      ok: false,
      reason: 'network-uncertain',
      message: 'CORS or firewall transport failure',
    });
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent(/could not reach/i);
    await expect.element(page.getByRole('alert')).not.toHaveTextContent(/cors/i);
    await expect.element(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Home');
    await expect.element(page.getByRole('textbox', { name: 'Address' })).toHaveValue(
      'https://openpalm.example/oc',
    );
  });

  // A host-capable machine is asked the question first — install here, or
  // connect to one running elsewhere — because it is the only kind that could
  // do either. The separate welcome route this used to live on was retired
  // into this page, so Back steps back a screen rather than navigating.
  test('asks a host-capable surface how to begin, and Back returns to the question', async () => {
    mocks.appPage.url = new URL('http://localhost/connections/new?onboarding=1');
    mocks.runtimeContext.effectiveCapabilities = ['host:setup'];
    await render(NewConnectionPage);

    await expect.element(page.getByText('Set up OpenPalm on this computer')).toBeVisible();
    await page.getByText('Connect to an existing OpenPalm').click();
    await expect.element(page.getByText('Set up OpenPalm on this computer')).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.element(page.getByText('Set up OpenPalm on this computer')).toBeVisible();
    expect(mocks.goto, 'Back is a step, not a navigation').not.toHaveBeenCalled();
  });

  // Back keeps the component mounted here, so a failed attempt's error would
  // survive the step back and greet the user again on the way in.
  test('does not carry a failed attempt error back into the connect flow', async () => {
    mocks.appPage.url = new URL('http://localhost/connections/new?onboarding=1');
    mocks.runtimeContext.effectiveCapabilities = ['host:setup'];
    await render(NewConnectionPage);

    await page.getByText('Connect to an existing OpenPalm').click();
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect.element(page.getByRole('alert')).toHaveTextContent(/could not reach/i);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect.element(page.getByText('Set up OpenPalm on this computer')).toBeVisible();

    await page.getByText('Connect to an existing OpenPalm').click();
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });

  // A client build has no stack to install, so it never sees the question and
  // goes straight to the connect form.
  test('does not offer the local-install choice on client-only onboarding', async () => {
    mocks.appPage.url = new URL('http://localhost/connections/new?onboarding=1');
    await render(NewConnectionPage);
    await expect.element(page.getByRole('button', { name: 'Back', exact: true })).not.toBeInTheDocument();
    expect(mocks.goto).not.toHaveBeenCalled();
  });

  test('returns Settings-launched wizard to Connections', async () => {
    mocks.appPage.url = new URL('http://localhost/connections/new');
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    expect(mocks.goto).toHaveBeenCalledWith('/connections');
  });

  test('cancels delayed verification on Back without saving or redirecting afterward', async () => {
    let resolveVerification!: (result: unknown) => void;
    mocks.verifyConnectionCandidate.mockReturnValue(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect.element(page.getByRole('button', { name: 'Checking…' })).toBeVisible();

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    expect(mocks.goto).toHaveBeenCalledTimes(1);
    expect(mocks.goto).toHaveBeenCalledWith('/connections');
    resolveVerification({
      ok: true,
      candidate: {
        verification: 'verified',
        label: 'Home',
        baseUrl: 'https://openpalm.example/oc',
        auth: { mode: 'none' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.saveVerifiedConnection).not.toHaveBeenCalled();
    expect(mocks.goto).toHaveBeenCalledTimes(1);
  });

  test('cancels delayed verification on unmount', async () => {
    let resolveVerification!: (result: unknown) => void;
    mocks.verifyConnectionCandidate.mockReturnValue(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );
    const rendered = await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByRole('button', { name: 'Connect' }).click();
    await vi.waitFor(() => expect(mocks.verifyConnectionCandidate).toHaveBeenCalledOnce());
    await rendered.unmount();
    resolveVerification({
      ok: true,
      candidate: {
        verification: 'verified',
        label: 'Home',
        baseUrl: 'https://openpalm.example/oc',
        auth: { mode: 'none' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.saveVerifiedConnection).not.toHaveBeenCalled();
    expect(mocks.goto).not.toHaveBeenCalled();
  });

  test('disables Back after persistence starts until rollback completes', async () => {
    let resolveSave!: (result: unknown) => void;
    mocks.verifyConnectionCandidate.mockResolvedValue({
      ok: true,
      candidate: {
        verification: 'verified',
        label: 'Home',
        baseUrl: 'https://openpalm.example/oc',
        auth: { mode: 'none' },
      },
    });
    mocks.saveVerifiedConnection.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await render(NewConnectionPage);
    await page.getByRole('button', { name: 'Enter an address instead' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Home');
    await page.getByRole('textbox', { name: 'Address' }).fill('https://openpalm.example/oc');
    await page.getByRole('button', { name: 'Connect' }).click();
    await vi.waitFor(() => expect(mocks.saveVerifiedConnection).toHaveBeenCalledOnce());
    await expect.element(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
    resolveSave({ ok: false, error: 'Save rolled back.' });
    await expect.element(page.getByRole('button', { name: 'Back', exact: true })).toBeEnabled();
  });
});
