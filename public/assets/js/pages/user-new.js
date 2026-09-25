/**
 * Invite a new user.
 *
 * The account is provisioned server-side — the auth user and its profile are
 * created together — so this form asks only who the person is, never a password
 * or an id. The invited user gets an email and follows the link to set their own
 * password. Client-side checks only shorten the correction loop; the server
 * validates independently, and its field errors are mapped back onto the inputs.
 */

import { ApiError, api } from '../core/api.js';
import { el, render } from '../core/dom.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/users',
    title: 'Invite user',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  const FIELDS = [
    {
      name: 'email',
      label: 'Email',
      type: 'email',
      required: true,
      hint: 'The invitation and the link to set a password are sent here.',
    },
    { name: 'fullName', label: 'Full name', required: true },
  ];

  const inputs = new Map();
  const errorNodes = new Map();

  function field(definition) {
    const id = `field-${definition.name}`;
    const errorId = `${id}-error`;
    const control = el('input', {
      class: 'form-control',
      id,
      name: definition.name,
      type: definition.type ?? 'text',
      autocomplete: 'off',
    });
    control.setAttribute('aria-describedby', errorId);
    const errorNode = el('p', { class: 'field__error', id: errorId, hidden: true });

    inputs.set(definition.name, control);
    errorNodes.set(definition.name, errorNode);

    // Clear a field's error as soon as the user starts fixing it.
    control.addEventListener('input', () => {
      if (control.getAttribute('aria-invalid') === 'true') setError(definition.name, null);
    });

    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id }, [
        definition.label,
        definition.required
          ? el('span', { class: 'field__required', 'aria-hidden': 'true' }, [' *'])
          : null,
      ]),
      control,
      definition.hint ? el('p', { class: 'field__hint', text: definition.hint }) : null,
      errorNode,
    ]);
  }

  function setError(name, message) {
    const control = inputs.get(name);
    const errorNode = errorNodes.get(name);
    if (!control || !errorNode) return;
    errorNode.textContent = message ?? '';
    errorNode.hidden = !message;
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearErrors() {
    for (const name of inputs.keys()) setError(name, null);
  }

  function validate({ email, fullName }) {
    let firstInvalid = null;
    const fail = (name, message) => {
      setError(name, message);
      if (!firstInvalid) firstInvalid = name;
    };

    if (!email) fail('email', 'Enter an email address.');
    else if (!EMAIL_PATTERN.test(email)) fail('email', 'Enter a valid email address.');
    if (fullName.length < 2) fail('fullName', 'Enter a name of at least 2 characters.');

    if (firstInvalid) inputs.get(firstInvalid)?.focus();
    return firstInvalid === null;
  }

  const alertBox = el('div', { id: 'form-alert', hidden: true });
  const submitLabel = el('span', { text: 'Send invitation' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { id: 'user-invite-form', novalidate: true }, [
    el('div', { class: 'form-grid' }, FIELDS.map(field)),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', { class: 'btn btn-outline-secondary', href: '/admin/users', text: 'Cancel' }),
      el('div', { class: 'form-actions__spacer' }),
    ]),
  ]);

  function showAlert(message) {
    render(alertBox, [
      el('div', { class: 'inline-alert inline-alert--error', role: 'alert' }, [
        el('i', { class: 'bi bi-exclamation-triangle', 'aria-hidden': 'true' }),
        el('span', { text: message }),
      ]),
    ]);
    alertBox.hidden = false;
    alertBox.scrollIntoView({ block: 'nearest' });
  }

  function setBusy(busy) {
    submitButton.disabled = busy;
    submitButton.setAttribute('aria-busy', String(busy));
    submitLabel.textContent = busy ? 'Sending…' : 'Send invitation';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    clearErrors();

    const email = inputs.get('email').value.trim();
    const fullName = inputs.get('fullName').value.trim();
    if (!validate({ email, fullName })) return;

    setBusy(true);
    try {
      const created = await api.post('/admin/users', {
        email,
        fullName,
        defaultBranchId: session.user.defaultBranchId ?? undefined,
      });
      // Straight to the new account; the detail page shows the "invited" toast.
      location.assign(`/admin/users/detail?id=${encodeURIComponent(created.data.id)}&invited=1`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.details?.fields) {
        for (const [name, message] of Object.entries(error.details.fields)) setError(name, message);
        inputs.get(Object.keys(error.details.fields)[0])?.focus();
      }
      showAlert(error.message);
      setBusy(false);
    }
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Invite user' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'They receive an email with a link to set their own password.',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);
}
