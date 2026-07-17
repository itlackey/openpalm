import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../app.css';
import ProfileRow from './ProfileRow.svelte';

function luminance(color: string): number {
	const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
	const channels = hex
		? [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((channel) =>
				Number.parseInt(channel, 16),
			)
		: color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
	if (!channels || channels.length !== 3) throw new Error(`unsupported color: ${color}`);
	const [red, green, blue] = channels.map((channel) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
	const values = [luminance(first), luminance(second)];
	return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

test('profile actions remain usable in 320px, 360px, and 375px panels', async () => {
	const { container } = render(ProfileRow, {
		props: {
			name: 'A profile name long enough to require wrapping on a phone',
			isDefault: false,
			onsetdefault: vi.fn(),
			onedit: vi.fn(),
			onremove: vi.fn(),
		},
	});

	const row = container.querySelector('.profile-row');
	const name = container.querySelector('.profile-row-name');
	const buttons = [...container.querySelectorAll<HTMLButtonElement>('.profile-row-actions button')];
	const remove = buttons.find((button) => button.textContent?.trim() === 'Remove');
	if (!(row instanceof HTMLElement) || !(name instanceof HTMLElement) || !remove) {
		throw new Error('profile row presentation was not rendered');
	}
	row.style.backgroundColor = 'var(--s-paper)';
	remove.style.transition = 'none';

	expect(getComputedStyle(name).whiteSpace).toBe('normal');
	for (const panelWidth of [254, 294, 309]) {
		container.style.width = `${panelWidth}px`;
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
		for (const button of buttons) {
			expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
			expect(button.getBoundingClientRect().left).toBeGreaterThanOrEqual(
				row.getBoundingClientRect().left,
			);
			expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
				row.getBoundingClientRect().right,
			);
		}
	}

	const originalTheme = document.documentElement.getAttribute('data-theme');
	for (const theme of ['light', 'dark']) {
		document.documentElement.setAttribute('data-theme', theme);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const foreground = getComputedStyle(remove).color;
		const background = getComputedStyle(row).getPropertyValue('--s-paper').trim();
		expect(
			contrast(foreground, background),
			`${theme}: ${foreground} on ${background}`,
		).toBeGreaterThanOrEqual(4.5);
		expect(getComputedStyle(remove).opacity).toBe('1');
	}
	if (originalTheme) document.documentElement.setAttribute('data-theme', originalTheme);
	else document.documentElement.removeAttribute('data-theme');
});
