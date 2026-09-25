/**
 * Theme control: light, dark, or follow the operating system.
 *
 * The preference is stored per browser in localStorage. It is intentionally not
 * stored on the server: theme is a device preference, and a user on a phone at
 * night may want something different from the same user on a desktop at noon.
 */

const STORAGE_KEY = 'cma.theme';
const MODES = ['light', 'dark', 'system'];

const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function getPreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return MODES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function getEffectiveTheme(preference = getPreference()) {
  if (preference === 'system') return systemQuery.matches ? 'dark' : 'light';
  return preference;
}

function apply(preference) {
  document.documentElement.setAttribute('data-bs-theme', getEffectiveTheme(preference));
  document.dispatchEvent(
    new CustomEvent('cma:themechange', {
      detail: { preference, effective: getEffectiveTheme(preference) },
    }),
  );
}

export function setPreference(preference) {
  if (!MODES.includes(preference)) {
    throw new Error(`Unknown theme preference: ${preference}`);
  }

  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Preference will not persist, but the theme still applies for this session.
  }

  apply(preference);
}

/** Cycles light -> dark -> system. Returns the new preference. */
export function cyclePreference() {
  const order = ['light', 'dark', 'system'];
  const next = order[(order.indexOf(getPreference()) + 1) % order.length];
  setPreference(next);
  return next;
}

/**
 * Keeps the document in step with the OS while the preference is 'system',
 * and labels a toggle button if one is supplied.
 * @param {HTMLElement} [toggleButton]
 */
export function initTheme(toggleButton) {
  const labels = {
    light: { icon: 'bi-sun', text: 'Light theme' },
    dark: { icon: 'bi-moon-stars', text: 'Dark theme' },
    system: { icon: 'bi-circle-half', text: 'Match system theme' },
  };

  function paintToggle() {
    if (!toggleButton) return;
    const preference = getPreference();
    const { icon, text } = labels[preference];

    const iconEl = toggleButton.querySelector('[data-theme-icon]');
    if (iconEl) iconEl.className = `bi ${icon}`;
    toggleButton.setAttribute('aria-label', `${text}. Activate to change.`);
    toggleButton.setAttribute('title', text);
  }

  systemQuery.addEventListener('change', () => {
    if (getPreference() === 'system') apply('system');
  });

  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      cyclePreference();
      paintToggle();
    });
  }

  apply(getPreference());
  paintToggle();
}
