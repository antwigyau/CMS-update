/**
 * Sign-in page.
 *
 * Posts to POST /api/auth/login. On success the server sets HttpOnly session
 * cookies and this page never sees a token — it only redirects.
 *
 * `?next=` carries where the visitor was heading before being sent here. It is
 * validated as a same-origin path before use: an open redirect on a login page is
 * how credential-phishing pages get a trustworthy-looking URL.
 */

import { ApiError, api } from '../core/api.js';
import { el, qs } from '../core/dom.js';

const form = qs('#login-form');
const alertBox = qs('#login-alert');
const submitButton = qs('#login-submit');
const submitLabel = qs('#login-submit-label');

const FIELDS = {
  email: {
    input: qs('#email'),
    error: qs('#email-error'),
    validate(value) {
      if (value.trim() === '') return 'Enter your email address.';
      // Deliberately permissive: the server and Supabase Auth are authoritative.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return 'Enter a valid email address.';
      return null;
    },
  },
  password: {
    input: qs('#password'),
    error: qs('#password-error'),
    validate(value) {
      if (value === '') return 'Enter your password.';
      return null;
    },
  },
};

function showFieldError(field, message) {
  field.error.textContent = message ?? '';
  field.error.hidden = !message;
  field.input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showAlert(message, variant = 'error') {
  alertBox.replaceChildren(
    el('div', { class: `inline-alert inline-alert--${variant}`, role: 'alert' }, [
      el('i', { class: 'bi bi-exclamation-triangle', 'aria-hidden': 'true' }),
      el('span', { text: message }),
    ]),
  );
  alertBox.hidden = false;
}

function clearAlert() {
  alertBox.replaceChildren();
  alertBox.hidden = true;
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.setAttribute('aria-busy', String(busy));
  submitLabel.textContent = busy ? 'Signing in…' : 'Sign in';
}

function validateAll() {
  let firstInvalid = null;

  for (const field of Object.values(FIELDS)) {
    const message = field.validate(field.input.value);
    showFieldError(field, message);
    if (message && !firstInvalid) firstInvalid = field;
  }

  if (firstInvalid) firstInvalid.input.focus();
  return firstInvalid === null;
}

// Clear a field's error as soon as the user starts fixing it.
for (const field of Object.values(FIELDS)) {
  field.input.addEventListener('input', () => {
    if (field.input.getAttribute('aria-invalid') === 'true') showFieldError(field, null);
  });
}

/**
 * Where to go after signing in.
 *
 * Only a same-origin absolute path is accepted. `//evil.example` and
 * `https://evil.example` are both rejected, because a login page that will
 * redirect anywhere is a phishing tool with our domain on it.
 */
function destination() {
  const next = new URLSearchParams(location.search).get('next');
  if (!next) return '/dashboard';
  if (!next.startsWith('/') || next.startsWith('//')) return '/dashboard';
  return next;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAlert();

  if (!validateAll()) return;

  setBusy(true);
  try {
    await api.post('/auth/login', {
      email: FIELDS.email.input.value.trim(),
      password: FIELDS.password.input.value,
    });

    // The server set HttpOnly session cookies; this page never sees a token.
    location.assign(destination());
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (error.code === 'VALIDATION_FAILED' && error.details?.fields) {
      // Server-side validation is authoritative; surface it on the fields.
      for (const [name, message] of Object.entries(error.details.fields)) {
        if (FIELDS[name]) showFieldError(FIELDS[name], message);
      }
      showAlert(error.message);
    } else if (error.code === 'RATE_LIMITED') {
      const minutes = Math.ceil((error.details?.retryAfterSeconds ?? 900) / 60);
      showAlert(
        `Too many attempts. Please wait about ${minutes} minutes and try again.`,
        'warning',
      );
    } else {
      // Includes UNAUTHENTICATED, which the server words identically for a wrong
      // email and a wrong password so it cannot be used to discover which
      // addresses have accounts.
      showAlert(error.message);
      FIELDS.password.input.value = '';
      FIELDS.password.input.focus();
    }
  } finally {
    setBusy(false);
  }
});
