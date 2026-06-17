import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import TabBar from './TabBar.svelte';

describe('TabBar', () => {
  it('renders the six entity sections in order', async () => {
    render(TabBar, { props: { active: 'overview', onSelect: vi.fn() } });

    const sectionTablist = document.querySelector('[aria-label="Sections"]');
    expect(sectionTablist).not.toBeNull();
    const sectionTabs = Array.from(
      sectionTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(sectionTabs).toEqual(['Health', 'Mind', 'Voice', 'Routines', 'Capabilities', 'Knowledge']);
  });

  it('shows Health subtabs when active is "overview"', async () => {
    render(TabBar, { props: { active: 'overview', onSelect: vi.fn() } });

    const subtabTablist = document.querySelector('[aria-label="Health tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Overview', 'Activity', 'Systems', 'Journal', 'Check-up', 'Recovery']);
  });

  it('shows Knowledge subtabs (Memory, Assistant, Secrets, Sharing) when active is "akm"', async () => {
    render(TabBar, { props: { active: 'akm', onSelect: vi.fn() } });

    const subtabTablist = document.querySelector('[aria-label="Knowledge tabs"]');
    expect(subtabTablist).not.toBeNull();
    const subtabLabels = Array.from(
      subtabTablist!.querySelectorAll<HTMLElement>('[role="tab"]')
    ).map((t) => t.textContent?.trim() ?? '');
    expect(subtabLabels).toEqual(['Memory', 'Assistant', 'Secrets', 'Sharing']);
  });

  it('hides the subtab row for single-destination sections (Routines, Capabilities, Mind)', async () => {
    render(TabBar, { props: { active: 'automations', onSelect: vi.fn() } });
    expect(document.querySelector('[aria-label="Routines tabs"]')).toBeNull();
    expect(document.querySelector('[aria-label="Capabilities tabs"]')).toBeNull();
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

  it('selects Routines for the automations tab', async () => {
    render(TabBar, { props: { active: 'automations', onSelect: vi.fn() } });
    const selected = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    ).find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Routines');
  });

  it('marks the active subtab as aria-selected', async () => {
    render(TabBar, { props: { active: 'host-sharing', onSelect: vi.fn() } });

    const subtabs = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Knowledge tabs"] [role="tab"]')
    );
    const selected = subtabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected?.textContent?.trim()).toBe('Sharing');
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

    const routines = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Sections"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Routines');
    expect(routines).not.toBeUndefined();
    routines!.click();
    expect(onSelect).toHaveBeenCalledWith('automations');
  });

  it('calls onSelect with the subtab id when a subtab is clicked', async () => {
    const onSelect = vi.fn();
    render(TabBar, { props: { active: 'akm', onSelect } });

    const sharing = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="Knowledge tabs"] [role="tab"]')
    ).find((t) => t.textContent?.trim() === 'Sharing');
    expect(sharing).not.toBeUndefined();
    sharing!.click();
    expect(onSelect).toHaveBeenCalledWith('host-sharing');
  });
});
