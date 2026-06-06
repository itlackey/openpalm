import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TabBar from './TabBar.svelte';

describe('TabBar', () => {
  it('renders the five entity sections', async () => {
    render(TabBar, { props: { active: 'overview', onSelect: vi.fn() } });

    const sectionTablist = document.querySelector('[aria-label="Sections"]');
    expect(sectionTablist).not.toBeNull();
    const sectionTabs = Array.from(
      sectionTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(sectionTabs).toEqual(['Health', 'Knowledge', 'Voice', 'Mind', 'Capabilities']);
  });

  it('shows Health subtabs when active is "overview"', async () => {
    render(TabBar, { props: { active: 'overview', onSelect: vi.fn() } });

    const subtabTablist = document.querySelector('[aria-label="Health tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Overview', 'Containers', 'Logs', 'Updates']);
  });

  it('shows Knowledge subtabs when active is "akm"', async () => {
    render(TabBar, { props: { active: 'akm', onSelect: vi.fn() } });

    const subtabTablist = document.querySelector('[aria-label="Knowledge tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Memory', 'Host Sharing', 'Secrets']);
  });

  it('shows Capabilities subtabs when active is "addons"', async () => {
    render(TabBar, { props: { active: 'addons', onSelect: vi.fn() } });

    const subtabTablist = document.querySelector('[aria-label="Capabilities tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Add-ons', 'Automations']);
  });

  it('hides the subtab row for a single-destination section (Mind)', async () => {
    render(TabBar, { props: { active: 'connections', onSelect: vi.fn() } });
    // Mind has one destination (AI Providers) → no secondary strip.
    expect(document.querySelector('[aria-label="Mind tabs"]')).toBeNull();
  });

  it('marks the active section tab as aria-selected', async () => {
    render(TabBar, { props: { active: 'akm', onSelect: vi.fn() } });

    const sectionTabs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    );
    const selected = sectionTabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Knowledge');
  });

  it('marks the active subtab as aria-selected', async () => {
    render(TabBar, { props: { active: 'secrets', onSelect: vi.fn() } });

    const subtabs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Knowledge tabs"] [role="tab"]')
    );
    const selected = subtabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Secrets');
  });

  it('calls onSelect with the first subtab when a section tab is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, { props: { active: 'overview', onSelect } });

    const knowledge = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Knowledge');
    expect(knowledge).not.toBeUndefined();
    knowledge!.click();
    expect(onSelect).toHaveBeenCalledWith('akm');
  });

  it('navigates directly when a single-destination section is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, { props: { active: 'overview', onSelect } });

    const mind = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Mind');
    expect(mind).not.toBeUndefined();
    mind!.click();
    expect(onSelect).toHaveBeenCalledWith('connections');
  });

  it('calls onSelect with the subtab id when a subtab is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, { props: { active: 'addons', onSelect } });

    const automations = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Capabilities tabs"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Automations');
    expect(automations).not.toBeUndefined();
    automations!.click();
    expect(onSelect).toHaveBeenCalledWith('automations');
  });
});
