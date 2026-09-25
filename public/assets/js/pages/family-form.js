/**
 * Household form — create and edit, one module for the same reason the member
 * form is one module: a divergence between the two is a bug waiting to happen.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock } from '../core/dom.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const familyId = new URLSearchParams(location.search).get('id');
const isEdit = Boolean(familyId);

const FIELDS = [
  {
    name: 'familyName',
    label: 'Household name',
    required: true,
    wide: true,
    hint: 'For example "The Mensah Family" or "Mensah Household".',
  },
  { name: 'householdPhone', label: 'Phone', type: 'tel' },
  { name: 'householdEmail', label: 'Email', type: 'email' },
  { name: 'addressLine', label: 'Address', wide: true },
  { name: 'city', label: 'City' },
  { name: 'region', label: 'Region' },
  { name: 'country', label: 'Country' },
  { name: 'notes', label: 'Notes', type: 'textarea', wide: true },
];

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/families',
    title: isEdit ? 'Edit household' : 'Add household',
    user: session.user,
    can: (permission) => session.permissions.includes(permission),
    onSignOut: signOut,
  });

  const inputs = new Map();
  const errorNodes = new Map();

  function setError(name, message) {
    const control = inputs.get(name);
    const errorNode = errorNodes.get(name);
    if (!control || !errorNode) return;

    errorNode.textContent = message ?? '';
    errorNode.hidden = !message;
    control.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

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

    control.addEventListener('input', () => {
      if (control.getAttribute('aria-invalid') === 'true') setError(definition.name, null);
    });

    return el('div', { class: `field${definition.wide ? ' field--wide' : ''}` }, [
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

  const alertBox = el('div', { hidden: true });
  const submitLabel = el('span', { text: isEdit ? 'Save changes' : 'Add household' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { novalidate: true }, [
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Household details' }),
      el('p', {
        class: 'form-section__hint',
        text: 'Only a name is required. Members are added after the household exists.',
      }),
      el('div', { class: 'form-grid' }, FIELDS.map(field)),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', {
        class: 'btn btn-outline-secondary',
        href: isEdit ? `/families/detail?id=${encodeURIComponent(familyId)}` : '/families',
        text: 'Cancel',
      }),
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
  }

  function setBusy(busy) {
    submitButton.disabled = busy;
    submitButton.setAttribute('aria-busy', String(busy));
    submitLabel.textContent = busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add household';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const payload = {};
    for (const [name, control] of inputs) {
      const value = control.value.trim();
      if (value !== '') payload[name] = value;
    }

    if (!payload.familyName || payload.familyName.length < 2) {
      setError('familyName', 'Enter a name for this household, of at least 2 characters.');
      inputs.get('familyName').focus();
      return;
    }

    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/families/${encodeURIComponent(familyId)}`, payload);
        notify.success('Changes saved.');
        location.assign(`/families/detail?id=${encodeURIComponent(familyId)}`);
      } else {
        const result = await api.post('/families', payload);
        location.assign(`/families/detail?id=${encodeURIComponent(result.data.id)}`);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;

      if (error.details?.fields) {
        for (const [name, message] of Object.entries(error.details.fields)) setError(name, message);
        inputs.get(Object.keys(error.details.fields)[0])?.focus();
      }
      showAlert(error.message);
    } finally {
      setBusy(false);
    }
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', {
          class: 'page-header__title',
          text: isEdit ? 'Edit household' : 'Add household',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  if (isEdit) {
    form.hidden = true;
    try {
      const payload = await api.get(`/families/${encodeURIComponent(familyId)}`);
      for (const [name, control] of inputs) control.value = payload.data[name] ?? '';
      form.hidden = false;
    } catch (error) {
      render(main, [
        stateBlock({
          variant: 'error',
          title:
            error instanceof ApiError && error.status === 404
              ? 'Household not found'
              : 'Could not load this household',
          message:
            error instanceof ApiError && error.status === 404
              ? 'It may have been deleted, or you may not have permission to see it.'
              : 'The request failed. Try again in a moment.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/families', text: 'Back' }),
        }),
      ]);
    }
  }
}
