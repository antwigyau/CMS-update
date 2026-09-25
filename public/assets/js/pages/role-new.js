/**
 * Create a role.
 *
 * A role is a named bundle of permissions; this form only names it. Its
 * permissions are chosen afterwards, on the detail page — so submitting a valid
 * name and key drops you straight into the editor for the new role.
 *
 * The key is asked for once and never again: it is immutable after creation, so
 * the hint says so. Client-side checks only shorten the correction loop; the
 * server validates independently, and its field errors are mapped back onto the
 * inputs.
 */

import { ApiError, api } from '../core/api.js';
import { el, render } from '../core/dom.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

// Mirrors the DB CHECK (roles_key_format): lowercase start, 3–40 total.
const KEY_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/roles',
    title: 'New role',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  const FIELDS = [
    {
      name: 'name',
      label: 'Name',
      required: true,
      hint: 'What people see, e.g. “Finance officer”.',
    },
    {
      name: 'key',
      label: 'Key',
      required: true,
      hint: 'Used internally; lowercase letters, digits and underscores. It cannot be changed later.',
    },
    { name: 'description', label: 'Description', type: 'textarea' },
    {
      name: 'sortOrder',
      label: 'Sort order',
      type: 'number',
      hint: 'Where it sits in lists. Lower comes first; the default is 100.',
    },
  ];

  const inputs = new Map();
  const errorNodes = new Map();

  function field(definition) {
    const id = `field-${definition.name}`;
    const errorId = `${id}-error`;
    const control =
      definition.type === 'textarea'
        ? el('textarea', { class: 'form-control', id, name: definition.name, rows: '3' })
        : el('input', {
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

  function validate({ name, key, sortOrder }) {
    let firstInvalid = null;
    const fail = (target, message) => {
      setError(target, message);
      if (!firstInvalid) firstInvalid = target;
    };

    if (name.length < 2) fail('name', 'Enter a name of at least 2 characters.');
    else if (name.length > 60) fail('name', 'A name can be at most 60 characters.');

    if (!key) fail('key', 'Enter a key.');
    else if (!KEY_PATTERN.test(key)) {
      fail('key', 'Start with a lowercase letter; 3–40 lowercase letters, digits or underscores.');
    }

    if (sortOrder !== '') {
      const n = Number(sortOrder);
      if (!Number.isInteger(n) || n < 0 || n > 32767) {
        fail('sortOrder', 'Enter a whole number between 0 and 32767.');
      }
    }

    if (firstInvalid) inputs.get(firstInvalid)?.focus();
    return firstInvalid === null;
  }

  const alertBox = el('div', { id: 'form-alert', hidden: true });
  const submitLabel = el('span', { text: 'Create role' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { id: 'role-new-form', novalidate: true }, [
    el('div', { class: 'form-grid' }, FIELDS.map(field)),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', { class: 'btn btn-outline-secondary', href: '/admin/roles', text: 'Cancel' }),
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
    submitLabel.textContent = busy ? 'Creating…' : 'Create role';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    clearErrors();

    const name = inputs.get('name').value.trim();
    const key = inputs.get('key').value.trim();
    const description = inputs.get('description').value.trim();
    const sortOrder = inputs.get('sortOrder').value.trim();
    if (!validate({ name, key, sortOrder })) return;

    const body = { key, name };
    if (description) body.description = description;
    if (sortOrder !== '') body.sortOrder = Number(sortOrder);

    setBusy(true);
    try {
      const created = await api.post('/admin/roles', body);
      location.assign(`/admin/roles/detail?id=${encodeURIComponent(created.data.id)}`);
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
        el('h1', { class: 'page-header__title', text: 'New role' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Name the role now; choose its permissions on the next screen.',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);
}
