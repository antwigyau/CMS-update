/**
 * Forgot-password page.
 *
 * The response is identical whether or not the address has an account, and this
 * page reflects that: it shows the same confirmation either way. Anything else
 * would turn the form into a way of discovering who is a member.
 */

import { ApiError, api } from '../core/api.js';
import { el, qs, render } from '../core/dom.js';

const form = qs('#forgot-form');
const alertBox = qs('#forgot-alert');
const emailInput = qs('#email');
const emailError = qs('#email-error');
const submitButton = qs('#forgot-submit');
const submitLabel = qs('#forgot-submit-label');

function showAlert(message, variant = 'error') {
  render(alertBox, [
    el('div', { class: `inline-alert inline-alert--${variant}`, role: 'alert' }, [
      el('i', { class: 'bi bi-exclamation-triangle', 'aria-hidden': 'true' }),
      el('span', { text: message }),
    ]),
  ]);
  alertBox.hidden = false;
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.setAttribute('aria-busy', String(busy));
  submitLabel.textContent = busy ? 'Sending…' : 'Send reset link';
}

emailInput.addEventListener('input', () => {
  emailError.hidden = true;
  emailInput.setAttribute('aria-invalid', 'false');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  alertBox.hidden = true;

  const email = emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    emailError.textContent = 'Enter a valid email address.';
    emailError.hidden = false;
    emailInput.setAttribute('aria-invalid', 'true');
    emailInput.focus();
    return;
  }

  setBusy(true);
  try {
    const payload = await api.post('/auth/password/forgot', { email });

    // Replace the form entirely: there is nothing more to do here, and leaving a
    // submit button invites repeated clicks against a rate limit.
    render(form, [
      el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
        el('i', { class: 'bi bi-envelope-check', 'aria-hidden': 'true' }),
        el('span', { text: payload.data.message }),
      ]),
      el('a', { class: 'btn btn-outline-secondary w-100', href: '/', text: 'Back to sign in' }),
    ]);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (error.code === 'RATE_LIMITED') {
      showAlert('Too many reset requests. Please wait an hour and try again.', 'warning');
    } else {
      showAlert(error.message);
    }
  } finally {
    setBusy(false);
  }
});
