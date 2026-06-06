import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TabBar from './TabBar.svelte';

describe('TabBar', () => {
  it('renders three section tabs', async () => {
    render(TabBar, {
      props: {
        active: 'overview',
        onSelect: vi.fn(),
      },
    });

    // Section tablist — the top strip
    const sectionTablist = document.querySelector('[aria-label="Sections"]');
    expect(sectionTablist).not.toBeNull();
    const sectionTabs = Array.from(
      sectionTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(sectionTabs).toEqual(['System', 'Configure', 'Extend']);
  });

  it('shows System subtabs when active is "overview"', async () => {
    render(TabBar, {
      props: {
        active: 'overview',
        onSelect: vi.fn(),
      },
    });

    const subtabTablist = document.querySelector('[aria-label="System tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Overview', 'Containers', 'Logs']);
  });

  it('shows Configure subtabs when active is "connections"', async () => {
    render(TabBar, {
      props: {
        active: 'connections',
        onSelect: vi.fn(),
      },
    });

    const subtabTablist = document.querySelector('[aria-label="Configure tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['AI Providers', 'Knowledge', 'Voice']);
  });

  it('shows Extend subtabs when active is "addons"', async () => {
    render(TabBar, {
      props: {
        active: 'addons',
        onSelect: vi.fn(),
      },
    });

    const subtabTablist = document.querySelector('[aria-label="Extend tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Addons', 'Automations', 'Secrets']);
  });

  it('marks the active section tab as aria-selected', async () => {
    render(TabBar, {
      props: {
        active: 'akm',
        onSelect: vi.fn(),
      },
    });

    const sectionTabs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    );
    const selected = sectionTabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Configure');
  });

  it('marks the active subtab as aria-selected', async () => {
    render(TabBar, {
      props: {
        active: 'secrets',
        onSelect: vi.fn(),
      },
    });

    const subtabs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Extend tabs"] [role="tab"]')
    );
    const selected = subtabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Secrets');
  });

  it('calls onSelect with first section subtab when a section tab is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, {
      props: {
        active: 'overview',
        onSelect,
      },
    });

    const configureSectionTab = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Configure');
    expect(configureSectionTab).not.toBeUndefined();
    configureSectionTab!.click();

    expect(onSelect).toHaveBeenCalledWith('connections');
  });

  it('calls onSelect with the subtab id when a subtab is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, {
      props: {
        active: 'addons',
        onSelect,
      },
    });

    const automationsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Extend tabs"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Automations');
    expect(automationsTab).not.toBeUndefined();
    automationsTab!.click();

    expect(onSelect).toHaveBeenCalledWith('automations');
  });
});
