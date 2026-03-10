import { page } from 'vitest/browser';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { useConsoleGuard, type ConsoleGuard } from '$lib/test-utils/console-guard';
import Page from './+page.svelte';

const mockData = {
	detectedUserId: 'test_user',
	setupToken: 'test_token'
};

describe('/setup page — step indicators', () => {
  let guard: ConsoleGuard;
  afterEach(() => { guard?.cleanup(); });

  it('shows all step indicator buttons', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await expect.element(page.getByRole('button', { name: 'Step 1: Welcome' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Step 2: Connections' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Step 3: Add Connection' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Step 4: Required Models' })).toBeInTheDocument();

    guard.expectNoErrors();
  });

  it('step indicators 2–4 are disabled on initial render', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    const step2 = page.getByRole('button', { name: 'Step 2: Connections' });
    await expect.element(step2).toBeDisabled();

    const step3 = page.getByRole('button', { name: 'Step 3: Add Connection' });
    await expect.element(step3).toBeDisabled();

    const step4 = page.getByRole('button', { name: 'Step 4: Required Models' });
    await expect.element(step4).toBeDisabled();

    guard.expectNoErrors();
  });
});

describe('/setup page — Welcome screen validation', () => {
  let guard: ConsoleGuard;
  afterEach(() => { guard?.cleanup(); });

  it('shows error when Name is empty on Next click', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await page.getByRole('textbox', { name: 'Admin Token' }).fill('secure-pass');
    await page.getByRole('button', { name: 'Start' }).click();

    const errorMsg = page.getByRole('alert');
    await expect.element(errorMsg).toHaveTextContent('Name is required.');

    guard.expectNoErrors();
  });

  it('shows error when Admin Token is empty on Next click', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await page.getByLabelText('Your Name').fill('Alice');
    await page.getByRole('button', { name: 'Start' }).click();

    const errorMsg = page.getByRole('alert');
    await expect.element(errorMsg).toHaveTextContent('Admin token is required.');

    guard.expectNoErrors();
  });

  it('shows error when Admin Token is shorter than 8 characters', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await page.getByLabelText('Your Name').fill('Alice');
    await page.getByRole('textbox', { name: 'Admin Token' }).fill('short');
    await page.getByRole('button', { name: 'Start' }).click();

    const errorMsg = page.getByRole('alert');
    await expect.element(errorMsg).toHaveTextContent('at least 8 characters');

    guard.expectNoErrors();
  });
});

describe('/setup page — connection-type screen', () => {
  let guard: ConsoleGuard;
  beforeEach(() => {
    window.history.replaceState({}, '', '/setup');
  });
  afterEach(() => { guard?.cleanup(); });

  async function advancePastToken(): Promise<void> {
    await page.getByLabelText('Your Name').fill('Alice');
    await page.getByRole('textbox', { name: 'Admin Token' }).fill('token-secure-123');
    await page.getByRole('button', { name: 'Start' }).click();
  }

  async function createLocalConnection(): Promise<void> {
    await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();
    await page.getByRole('button', { name: /Local OpenAI-compatible/ }).click();
    await expect.element(page.getByRole('heading', { name: 'Connection details' })).toBeInTheDocument();
    await page.getByLabelText('Connection name').fill('Primary local');
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect.element(page.getByRole('heading', { name: 'Connections' })).toBeInTheDocument();
  }

  it('syncs connection-type screen into URL after navigating from connections-hub', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();

    expect(window.location.search).toContain('screen=connections-hub');

    guard.expectNoErrors();
  });

  it('shows connection-type screen heading after starting a new connection', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();

    // Click Add connection to enter connection-type screen
    await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();

    const heading = page.getByRole('heading', { name: 'Add a connection' });
    await expect.element(heading).toBeInTheDocument();

    expect(window.location.search).toContain('screen=connection-type');

    guard.expectNoErrors();
  });

  it('shows OpenAI-Compatible and Local Model options on connection-type screen', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();
    await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();

    await expect.element(page.getByText('Remote OpenAI-compatible')).toBeInTheDocument();
    await expect.element(page.getByText('Local OpenAI-compatible')).toBeInTheDocument();

    guard.expectNoErrors();
  });

  it('Back button on connection-type returns to connections-hub screen', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();
    await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();
    await page.getByRole('button', { name: 'Back' }).click();

    const heading = page.getByRole('heading', { name: 'Connections' });
    await expect.element(heading).toBeInTheDocument();

    guard.expectNoErrors();
  });

  it('Back from connection-type removes the first unsaved draft connection', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();
    await page.getByTestId('step-connections-hub').getByRole('button', { name: 'Add connection' }).click();
    await page.getByRole('button', { name: 'Back' }).click();

    await expect.element(page.getByText('No connections yet')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    guard.expectNoErrors();
  });

  it('Back from connection-type keeps an existing connection when returning from edit mode', async () => {
    guard = useConsoleGuard();
    render(Page, { props: { data: mockData } });

    await advancePastToken();
    await createLocalConnection();

    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Back' }).click();

    await expect.element(page.getByRole('list', { name: 'Connections' })).toBeInTheDocument();
    await expect.element(page.getByText('Primary local')).toBeInTheDocument();

    guard.expectNoErrors();
  });
});

describe('/setup page — models screen URL restoration guard', () => {
  let guard: ConsoleGuard;
  afterEach(() => { guard?.cleanup(); });

  it('resets to welcome when models screen is forced via URL with no connections', async () => {
    guard = useConsoleGuard();
    window.history.replaceState({}, '', '?screen=models');
    render(Page, { props: { data: mockData } });

    const heading = page.getByRole('heading', { name: 'Welcome' });
    await expect.element(heading).toBeInTheDocument();

    guard.expectNoErrors();
  });

  it('SETUP_WIZARD_COPY.differentEmbeddingProvider matches expected copy', async () => {
    const { SETUP_WIZARD_COPY } = await import('$lib/setup-wizard/copy.js');
    expect(SETUP_WIZARD_COPY.differentEmbeddingProvider).toBe('Use a different provider for embeddings?');
    expect(SETUP_WIZARD_COPY.addAnotherConnection).toBe('Add connection');
  });
});

describe('/setup page — review screen URL restoration guard', () => {
  let guard: ConsoleGuard;
  afterEach(() => { guard?.cleanup(); });

  it('resets to welcome when review screen is forced via URL with no connections', async () => {
    guard = useConsoleGuard();
    window.history.replaceState({}, '', '?screen=review');
    render(Page, { props: { data: mockData } });

    const heading = page.getByRole('heading', { name: 'Welcome' });
    await expect.element(heading).toBeInTheDocument();

    guard.expectNoErrors();
  });
});

describe('/setup page', () => {
	let guard: ConsoleGuard;

	afterEach(() => {
		guard?.cleanup();
	});

	it('should render setup heading without console errors', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const heading = page.getByRole('heading', { level: 1 });
		await expect.element(heading).toBeInTheDocument();
		await expect.element(heading).toHaveTextContent('OpenPalm Setup Wizard');

		guard.expectNoErrors();
	});

	it('should show wizard subtitle without console errors', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const description = page.getByText('Configure your OpenPalm stack in a few steps.');
		await expect.element(description).toBeInTheDocument();

		guard.expectNoErrors();
	});

	it('should show step 1 (welcome) heading on initial render', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const welcomeHeading = page.getByRole('heading', { name: 'Welcome' });
		await expect.element(welcomeHeading).toBeInTheDocument();

		guard.expectNoErrors();
	});

	it('should show step indicators', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		const step1 = page.getByRole('button', { name: 'Step 1: Welcome' });
		await expect.element(step1).toBeInTheDocument();

		const step2 = page.getByRole('button', { name: 'Step 2: Connections' });
		await expect.element(step2).toBeInTheDocument();

		guard.expectNoErrors();
	});

	it('syncs current screen into URL query params after token step', async () => {
		guard = useConsoleGuard();
		render(Page, { props: { data: mockData } });

		await page.getByLabelText('Your Name').fill('Alice');
		await page.getByRole('textbox', { name: 'Admin Token' }).fill('token-secure-123');
		await page.getByRole('button', { name: 'Start' }).click();

		expect(window.location.search).toContain('screen=connections-hub');

		guard.expectNoErrors();
	});
});
