/**
 * AuthGate component tests.
 *
 * Security boundary: if this form breaks, operators are locked out.
 */
import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { userEvent } from 'vitest/browser';
import AuthGate from './AuthGate.svelte';

function defaultProps(overrides = {}) {
  return {
    onSuccess: vi.fn().mockResolvedValue(true),
    loading: false,
    error: '',
    ...overrides,
  };
}

describe('AuthGate — renders', () => {
  test('renders the admin login gate landmark', async () => {
    render(AuthGate, { props: defaultProps() });
    await expect.element(page.getByRole('main', { name: 'Admin login gate' })).toBeVisible();
  });

  test('renders the admin token input', async () => {
    render(AuthGate, { props: defaultProps() });
    await expect.element(page.getByLabelText('Admin Token')).toBeVisible();
  });

  test('renders the Unlock Console submit button', async () => {
    render(AuthGate, { props: defaultProps() });
    await expect.element(page.getByRole('button', { name: /unlock console/i })).toBeVisible();
  });
});

describe('AuthGate — submit button disabled state', () => {
  test('submit button is disabled when input is empty', async () => {
    render(AuthGate, { props: defaultProps() });
    await expect.element(page.getByRole('button', { name: /unlock console/i })).toBeDisabled();
  });

  test('submit button is enabled when input has text', async () => {
    render(AuthGate, { props: defaultProps() });
    await userEvent.type(page.getByLabelText('Admin Token'), 'my-token');
    await expect.element(page.getByRole('button', { name: /unlock console/i })).toBeEnabled();
  });

  test('submit button is disabled while loading=true', async () => {
    render(AuthGate, { props: defaultProps({ loading: true }) });
    await expect.element(page.getByRole('button', { name: /unlock console/i })).toBeDisabled();
  });
});

describe('AuthGate — error display', () => {
  test('shows error text with role=alert when error prop is set', async () => {
    render(AuthGate, { props: defaultProps({ error: 'Invalid token' }) });
    await expect.element(page.getByRole('alert')).toBeVisible();
    await expect.element(page.getByText('Invalid token')).toBeVisible();
  });

  test('does not render alert when error is empty', async () => {
    render(AuthGate, { props: defaultProps({ error: '' }) });
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AuthGate — token visibility toggle', () => {
  test('input starts as password type (token hidden)', async () => {
    render(AuthGate, { props: defaultProps() });
    const input = page.getByLabelText('Admin Token');
    await expect.element(input).toHaveAttribute('type', 'password');
  });

  test('clicking Show token changes input to text type', async () => {
    render(AuthGate, { props: defaultProps() });
    await page.getByRole('button', { name: 'Show token' }).click();
    await expect.element(page.getByLabelText('Admin Token')).toHaveAttribute('type', 'text');
  });

  test('clicking Hide token after show reverts to password type', async () => {
    render(AuthGate, { props: defaultProps() });
    await page.getByRole('button', { name: 'Show token' }).click();
    await page.getByRole('button', { name: 'Hide token' }).click();
    await expect.element(page.getByLabelText('Admin Token')).toHaveAttribute('type', 'password');
  });
});

describe('AuthGate — form submission', () => {
  test('calls onSuccess with the trimmed token value', async () => {
    const onSuccess = vi.fn().mockResolvedValue(true);
    render(AuthGate, { props: { onSuccess, loading: false, error: '' } });
    await userEvent.type(page.getByLabelText('Admin Token'), '  my-secret-token  ');
    await page.getByRole('button', { name: /unlock console/i }).click();
    expect(onSuccess).toHaveBeenCalledWith('my-secret-token');
  });
});
