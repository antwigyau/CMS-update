import js from '@eslint/js';

/**
 * Two rules here are security controls, not style preferences:
 *
 *   no-restricted-imports  blocks the service-role Supabase client everywhere
 *                          except an explicit allow-list. Adding a file to that
 *                          list is a visible, reviewable diff.
 *   no-restricted-syntax   bans innerHTML/outerHTML/insertAdjacentHTML in
 *                          frontend code, which removes the most common XSS
 *                          route by construction rather than by vigilance.
 */

const SERVICE_ROLE_ALLOW_LIST = [
  // The module itself.
  'src/data/supabase-admin.js',
  // Writes immutable audit rows the caller must not be able to influence.
  'src/lib/audit.js',
  // Creates and deactivates auth users — impossible as a normal user.
  'src/services/users.service.js',
];

export default [
  {
    ignores: ['node_modules/**', 'public/assets/vendor/**', '.vercel/**', 'coverage/**'],
  },

  js.configs.recommended,

  // ---- server-side code ---------------------------------------------------
  {
    files: ['src/**/*.js', 'api/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/supabase-admin.js', '**/data/supabase-admin.js'],
              message:
                'The service-role client bypasses RLS. If this module genuinely needs it, add it to SERVICE_ROLE_ALLOW_LIST in eslint.config.js and say why in the review.',
            },
          ],
        },
      ],
      'no-console': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // The allow-list.
  {
    files: SERVICE_ROLE_ALLOW_LIST,
    rules: { 'no-restricted-imports': 'off' },
  },

  // Scripts write to stdout by design.
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },

  // ---- browser code -------------------------------------------------------
  {
    files: ['public/assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        location: 'readonly',
        history: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Intl: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        matchMedia: 'readonly',
        CustomEvent: 'readonly',
        HTMLElement: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        FormData: 'readonly',
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'innerHTML is an XSS route. Use textContent, or the el() helper in core/dom.js.',
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message: 'outerHTML is an XSS route. Use textContent, or the el() helper in core/dom.js.',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is an XSS route. Build nodes with el() in core/dom.js.',
        },
      ],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // theme-boot.js is a classic (non-module) script loaded in <head>.
  {
    files: ['public/assets/js/core/theme-boot.js'],
    languageOptions: { sourceType: 'script' },
  },

  // ---- tests --------------------------------------------------------------
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
