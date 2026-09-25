/**
 * Reset-password page.
 *
 * Reached from the emailed link, which carries `token_hash` and `type=recovery`.
 * The token is read from the query string and posted to the API, which exchanges
 * it with Supabase server-side — the browser never gets a Supabase credential.
 *
 * On success the server clears any session cookies, so the user signs in again
 * with the new password. That is deliberate: if the reset was an account
 * recovery, it is also what ends the intruder's session.
 */

import { ApiError, api } from '../core/api.js';
import { el, qs, render } from '../core/dom.js';

const form = qs('#reset-form');
const alertBox = qs('#reset-alert');
const passwordInput = qs('#password');
const passwordError = qs('#password-error');
const confirmInput = qs('#confirm');
const confirmError = qs('#confirm-error');
const submitButton = qs('#reset-submit');
const submitLabel = qs('#reset-submit-label');

const MIN_LENGTH = 12;

const params = new URLSearchParams(location.search);
const tokenHash = params.get('token_hash');

function showAlert(message, variant = 'error') {
  render(alertBox, [
    el('div', { class: `inline-alert inline-alert--${variant}`, role: 'alert' }, [
      el('i', { class: 'bi bi-exclamation-triangle', 'aria-hidden': 'true' }),
      el('span', { text: message }),
    ]),
  ]);
  alertBox.hidden = false;
}

function setFieldError(input, errorNode, message) {
  errorNode.textContent = message ?? '';
  errorNode.hidden = !message;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.setAttribute('aria-busy', String(busy));
  submitLabel.textContent = busy ? 'Saving…' : 'Set new password';
}

// A link with no token cannot work. Say so immediately rather than after the
// user has typed a password twice.
if (!tokenHash) {
  form.hidden = true;
  showAlert(
    'This password reset link is incomplete. Request a new one from the sign-in page.',
    'warning',
  );
}

for (const [input, errorNode] of [
  [passwordInput, passwordError],
  [confirmInput, confirmError],
]) {
  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') setFieldError(input, errorNode, null);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  alertBox.hidden = true;

  const password = passwordInput.value;
  const confirm = confirmInput.value;

  if (password.length < MIN_LENGTH) {
    setFieldError(
      passwordInput,
      passwordError,
      `Use at least ${MIN_LENGTH} characters. A short phrase is easier to remember and harder to guess.`,
    );
    passwordInput.focus();
    return;
  }
  if (password !== confirm) {
    setFieldError(confirmInput, confirmError, 'The two passwords do not match.');
    confirmInput.focus();
    return;
  }

  setBusy(true);
  try {
    await api.post('/auth/password/reset', { tokenHash, password });

    render(form, [
      el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
        el('i', { class: 'bi bi-check-circle', 'aria-hidden': 'true' }),
        el('span', { text: 'Your password has been changed. Sign in with it now.' }),
      ]),
      el('a', { class: 'btn btn-primary w-100', href: '/', text: 'Go to sign in' }),
    ]);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (error.code === 'VALIDATION_FAILED' && error.details?.fields?.password) {
      setFieldError(passwordInput, passwordError, error.details.fields.password);
    } else if (error.code === 'RATE_LIMITED') {
      showAlert('Too many attempts. Please wait an hour and try again.', 'warning');
    } else {
      // Includes an expired or already-used link.
      showAlert(error.message);
    }
  } finally {
    setBusy(false);
  }
});
