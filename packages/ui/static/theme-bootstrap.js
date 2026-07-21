(() => {
  const storageKey = 'openpalm.theme';
  const darkThemeColor = '#15181B';
  const lightThemeColor = '#E5E1D5';

  try {
    const stored = window.localStorage.getItem(storageKey);
    const preference =
      stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    const resolved =
      preference === 'system'
        ? window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
          ? 'dark'
          : 'light'
        : preference;
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', resolved === 'dark' ? darkThemeColor : lightThemeColor);
    }

    const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
    if (colorSchemeMeta) {
      colorSchemeMeta.setAttribute('content', resolved);
    }
  } catch {
    // Keep the default light metadata if storage access is unavailable.
  }
})();
