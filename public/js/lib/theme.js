const KEY = 'overseer-theme';
const MODES = ['system', 'light', 'dark'];
const BAR = { light: '#f3efe2', dark: '#0a0f0a' };

// The saved choice: system (follow the device), light, or dark.
export function themeMode() {
  try {
    const saved = localStorage.getItem(KEY);
    return MODES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

// The theme that is on screen: a saved light or dark, or the device's preference when the mode is system.
export function resolveTheme(mode, prefersLight) {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersLight ? 'light' : 'dark';
}

export function nextMode(mode) {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function applyTheme(mode = themeMode()) {
  const theme = resolveTheme(mode, matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[theme]);
  return theme;
}

export function setThemeMode(mode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* The choice holds for this page load even when storage is blocked. */
  }
  applyTheme(mode);
  window.dispatchEvent(new CustomEvent('overseer-theme', { detail: { mode } }));
}

// Follows the device while the mode is system.
export function watchSystemTheme() {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themeMode() === 'system') applyTheme('system');
  });
}
