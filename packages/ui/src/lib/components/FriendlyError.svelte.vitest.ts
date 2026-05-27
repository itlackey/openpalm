/**
 * FriendlyError component tests.
 *
 * Pure display component used in wizard, auth gate, and connections tab.
 * Tests: renders/hides on null, all optional sections, compact mode.
 */
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import FriendlyError from './FriendlyError.svelte';
import type { FriendlyErrorView } from '$lib/wizard/error-messages.js';

const base: FriendlyErrorView = {
  title: 'Something went wrong',
  body: undefined,
  hint: undefined,
  links: [],
  raw: undefined,
};

describe('FriendlyError — null / empty', () => {
  test('renders nothing when error is null', async () => {
    render(FriendlyError, { props: { error: null } });
    await expect.element(page.getByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  test('renders nothing when error is undefined', async () => {
    render(FriendlyError, { props: { error: undefined } });
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });
});

describe('FriendlyError — title always present', () => {
  test('renders the title', async () => {
    render(FriendlyError, { props: { error: { ...base, title: 'Docker not found' } } });
    await expect.element(page.getByText('Docker not found')).toBeVisible();
  });

  test('default role is alert', async () => {
    render(FriendlyError, { props: { error: base } });
    await expect.element(page.getByRole('alert')).toBeVisible();
  });

  test('role can be overridden to status', async () => {
    render(FriendlyError, { props: { error: base, role: 'status' } });
    await expect.element(page.getByRole('status')).toBeVisible();
  });
});

describe('FriendlyError — optional sections', () => {
  test('renders body when provided', async () => {
    render(FriendlyError, { props: { error: { ...base, body: 'The daemon is not running.' } } });
    await expect.element(page.getByText('The daemon is not running.')).toBeVisible();
  });

  test('does not render body element when body is absent', async () => {
    render(FriendlyError, { props: { error: { ...base, body: undefined } } });
    // Only title should be present
    await expect.element(page.getByText('Something went wrong')).toBeVisible();
  });

  test('renders hint when provided', async () => {
    render(FriendlyError, { props: { error: { ...base, hint: 'Try running: docker ps' } } });
    await expect.element(page.getByText('Try running: docker ps')).toBeVisible();
  });

  test('renders link labels when provided', async () => {
    render(FriendlyError, {
      props: {
        error: {
          ...base,
          links: [{ href: 'https://docs.docker.com', label: 'Docker docs' }],
        },
      },
    });
    await expect.element(page.getByRole('link', { name: /docker docs/i })).toBeVisible();
  });
});

describe('FriendlyError — technical details disclosure', () => {
  test('shows details when raw differs from body', async () => {
    render(FriendlyError, {
      props: {
        error: {
          ...base,
          body: 'Short message',
          raw: 'Error: full stack trace here\n  at line 1',
        },
      },
    });
    await expect.element(page.getByText('Technical details')).toBeVisible();
  });

  test('hides details when raw equals body', async () => {
    render(FriendlyError, {
      props: { error: { ...base, body: 'Same text', raw: 'Same text' } },
    });
    await expect.element(page.getByText('Technical details')).not.toBeInTheDocument();
  });

  test('compact mode suppresses technical details even when raw is present', async () => {
    render(FriendlyError, {
      props: {
        error: { ...base, body: 'Short', raw: 'Long stack trace' },
        compact: true,
      },
    });
    await expect.element(page.getByText('Technical details')).not.toBeInTheDocument();
  });
});
