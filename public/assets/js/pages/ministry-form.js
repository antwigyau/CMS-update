/**
 * Ministry form — create and edit.
 *
 * A ministry leader may edit the ministry they lead without holding
 * `ministries.update`, so the edit page is reachable either way; the endpoint is
 * what decides, and it 403s if neither route to authority applies.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock } from '../core/dom.js';
import { humanise } from '../core/format.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const WEEKDAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '7', label: 'Sunday' },
];

const FIELDS = [
  {
    name: 'name',
    label: 'Ministry name',
    required: true,
    wide: true,
    hint: 'For example "Choir", "Ushering", or "Youth Fellowship".',
  },
  {
    name: 'code',
    label: 'Short code',
    hint: 'Optional. Letters, digits, hyphens or underscores — for example CHOIR.',
  },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    options: ['active', 'inactive'],
    omitBlank: true,
  },
  { name: 'meetingDay', label: 'Meeting day', type: 'weekday' },
  { name: 'meetingTime', label: 'Meeting time', type: 'time', hint: '24-hour, e.g. 18:30.' },
  { name: 'meetingLocation', label: 'Meeting location' },
  { name: 'description', label: 'Description', type: 'textarea', wide: true },
];

const ministryId = new URLSearchParams(location.search).get('id');
const isEdit = Boolean(ministryId);

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/ministries',
    title: isEdit ? 'Edit ministry' : 'Add ministry',
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

    let control;
    if (definition.type === 'select') {
      control = el('select', { class: 'form-select', id, name: definition.name }, [
        definition.omitBlank ? null : el('option', { value: '', text: '—' }),
        ...definition.options.map((value) => el('option', { value, text: humanise(value) })),
      ]);
    } else if (definition.type === 'weekday') {
      control = el('select', { class: 'form-select', id, name: definition.name }, [
        el('option', { value: '', text: 'No regular day' }),
        ...WEEKDAYS.map((day) => el('option', { value: day.value, text: day.label })),
      ]);
    } else if (definition.type === 'textarea') {
      control = el('textarea', { class: 'form-control', id, name: definition.name, rows: '4' });
    } else {
      control = el('input', {
        class: 'form-control',
        id,
        name: definition.name,
        type: definition.type ?? 'text',
        autocomplete: 'off',
      });
    }

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
  const submitLabel = el('span', { text: isEdit ? 'Save changes' : 'Add ministry' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { novalidate: true }, [
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Ministry details' }),
      el('p', {
        class: 'form-section__hint',
        text: 'Only a name is required. Members and leaders are added after the ministry exists.',
      }),
      el('div', { class: 'form-grid' }, FIELDS.map(field)),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', {
        class: 'btn btn-outline-secondary',
        href: isEdit ? `/ministries/detail?id=${encodeURIComponent(ministryId)}` : '/ministries',
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
    submitLabel.textContent = busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add ministry';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const payload = {};
    for (const [name, control] of inputs) {
      const value = control.value.trim();
      if (value === '') continue;
      // meetingDay is a number on the wire; the select gives a string.
      payload[name] = name === 'meetingDay' ? Number(value) : value;
    }

    if (!payload.name || payload.name.length < 2) {
      setError('name', 'Enter a name of at least 2 characters.');
      inputs.get('name').focus();
      return;
    }

    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/ministries/${encodeURIComponent(ministryId)}`, payload);
        notify.success('Changes saved.');
        location.assign(`/ministries/detail?id=${encodeURIComponent(ministryId)}`);
      } else {
        const result = await api.post('/ministries', payload);
        location.assign(`/ministries/detail?id=${encodeURIComponent(result.data.id)}`);
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
          text: isEdit ? 'Edit ministry' : 'Add ministry',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  if (isEdit) {
    form.hidden = true;
    try {
      const payload = await api.get(`/ministries/${encodeURIComponent(ministryId)}`);
      for (const [name, control] of inputs) {
        const value = payload.data[name];
        control.value = value === null || value === undefined ? '' : String(value);
      }
      form.hidden = false;
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Ministry not found' : 'Could not load this ministry',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/ministries',
            text: 'Back',
          }),
        }),
      ]);
    }
  } else {
    inputs.get('status').value = 'active';
  }
}
