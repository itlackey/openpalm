import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import TaskDrawer from './TaskDrawer.svelte';

describe('TaskDrawer byte preservation', () => {
  test('submits the original bytes when an existing task is saved untouched', async () => {
    const original = 'a\r\nb\rc\n';
    const onSave = vi.fn();
    await render(TaskDrawer, {
      props: {
        open: true,
        draft: {
          fileName: 'daily.yml',
          rawYaml: original,
          revision: 'sha256:original',
        },
        saving: false,
        saveError: '',
        onClose: vi.fn(),
        onSave,
      },
    });

    await expect.element(page.getByRole('textbox', { name: 'Task YAML' })).toHaveValue(
      'a\nb\nc\n',
    );
    await expect.element(page.getByText(/Untouched saves preserve the original bytes/)).toBeInTheDocument();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    expect(onSave).toHaveBeenCalledWith('daily.yml', original, 'sha256:original');
  });
});
