/**
 * Transient notifications.
 *
 * Success and info messages go into a polite live region so a screen reader
 * finishes its current sentence first. Errors are given role="alert", which
 * interrupts — appropriate, because an error usually means the user's action did
 * not happen.
 */

import { el, icon } from './dom.js';

const DEFAULT_TIMEOUT_MS = 5000;
const ERROR_TIMEOUT_MS = 9000;

const ICONS = {
  success: 'check-circle',
  error: 'exclamation-octagon',
  warning: 'exclamation-triangle',
  info: 'info-circle',
};

let stack = null;

function ensureStack() {
  if (stack && document.body.contains(stack)) return stack;

  stack = el('div', {
    class: 'toast-stack',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
  });
  document.body.append(stack);
  return stack;
}

/**
 * @param {string} message
 * @param {object} [options]
 * @param {'success'|'error'|'warning'|'info'} [options.variant]
 * @param {number} [options.timeoutMs]  0 keeps it until dismissed.
 */
export function toast(message, { variant = 'info', timeoutMs } = {}) {
  const container = ensureStack();
  const duration = timeoutMs ?? (variant === 'error' ? ERROR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const item = el(
    'div',
    { class: `toast-item toast-item--${variant}`, role: variant === 'error' ? 'alert' : null },
    [
      icon(ICONS[variant] ?? ICONS.info),
      el('div', { class: 'toast-item__body', text: message }),
      el(
        'button',
        {
          class: 'btn btn-sm btn-outline-secondary btn-icon',
          type: 'button',
          'aria-label': 'Dismiss notification',
          onclick: () => item.remove(),
        },
        [icon('x-lg')],
      ),
    ],
  );

  container.append(item);

  if (duration > 0) setTimeout(() => item.remove(), duration);
  return () => item.remove();
}

export const notify = {
  success: (message, options) => toast(message, { ...options, variant: 'success' }),
  error: (message, options) => toast(message, { ...options, variant: 'error' }),
  warning: (message, options) => toast(message, { ...options, variant: 'warning' }),
  info: (message, options) => toast(message, { ...options, variant: 'info' }),
};
