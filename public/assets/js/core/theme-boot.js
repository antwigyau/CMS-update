/**
 * Theme bootstrap. Loaded synchronously in <head>, before first paint.
 *
 * This is a classic script rather than a module because modules are deferred,
 * and a deferred theme would produce a flash of the wrong colour scheme. It
 * cannot be an inline <script> either: the Content-Security-Policy is
 * `script-src 'self'` with no 'unsafe-inline', deliberately.
 *
 * Keep it tiny and dependency-free. Full theme handling lives in theme.js.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'cma.theme';

  function preferredMode() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      // Storage can throw in private browsing. Fall through to the OS setting.
    }

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  document.documentElement.setAttribute('data-bs-theme', preferredMode());
})();
