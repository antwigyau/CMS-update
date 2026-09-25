/**
 * Open an attendance session.
 *
 * The kind of session decides which other fields apply — a service is tied to
 * neither a ministry nor an event, a ministry session must name one. The form
 * shows only the relevant field rather than validating a contradiction after the
 * fact.
 *
 * Headcounts are deliberately not on this form: they are taken during the
 * gathering, not before it, and the register page has them inline.
 */

import { ApiError, api } from '../core/api.js';
import { el, render } from '../core/dom.js';
import { humanise } from '../core/format.js';
import { leadsAnyMinistry, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

const TYPES = ['service', 'ministry', 'event'];

const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/attendance',
    title: 'Open a session',
    user: account.user,
    can: (permission) => account.permissions.includes(permission),
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

  function field(name, label, control, { hint, wide = false } = {}) {
    const errorId = `field-${name}-error`;
    control.id = `field-${name}`;
    control.setAttribute('aria-describedby', errorId);

    const errorNode = el('p', { class: 'field__error', id: errorId, hidden: true });
    inputs.set(name, control);
    errorNodes.set(name, errorNode);

    control.addEventListener('input', () => {
      if (control.getAttribute('aria-invalid') === 'true') setError(name, null);
    });

    return el('div', { class: `field${wide ? ' field--wide' : ''}`, id: `wrap-${name}` }, [
      el('label', { class: 'field__label', for: control.id, text: label }),
      control,
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
      errorNode,
    ]);
  }

  const typeSelect = el(
    'select',
    { class: 'form-select', name: 'sessionType' },
    TYPES.map((value) => el('option', { value, text: humanise(value) })),
  );

  const ministrySelect = el('select', { class: 'form-select', name: 'ministryId' }, [
    el('option', { value: '', text: 'Loading ministries…' }),
  ]);

  const titleInput = el('input', { class: 'form-control', name: 'title', type: 'text' });
  const dateInput = el('input', {
    class: 'form-control',
    name: 'sessionDate',
    type: 'date',
    value: new Date().toISOString().slice(0, 10),
  });
  const startInput = el('input', { class: 'form-control', name: 'startTime', type: 'time' });
  const endInput = el('input', { class: 'form-control', name: 'endTime', type: 'time' });
  const notesInput = el('textarea', { class: 'form-control', name: 'notes', rows: '3' });

  const ministryField = field('ministryId', 'Which ministry', ministrySelect, {
    hint: 'Only ministries you may take a register for are listed.',
  });

  /** Show the ministry field only for a ministry session. */
  function syncVisibility() {
    ministryField.hidden = typeSelect.value !== 'ministry';
  }
  typeSelect.addEventListener('change', () => {
    syncVisibility();
    if (typeSelect.value === 'service' && titleInput.value === '') {
      titleInput.value = 'Sunday Service';
    }
  });

  const alertBox = el('div', { hidden: true });
  const submitLabel = el('span', { text: 'Open session' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { novalidate: true }, [
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Session details' }),
      el('p', {
        class: 'form-section__hint',
        text: 'Headcounts are entered on the register itself, during the gathering.',
      }),
      el('div', { class: 'form-grid' }, [
        field('sessionType', 'Kind of gathering', typeSelect),
        ministryField,
        field('title', 'Title', titleInput, {
          wide: true,
          hint: 'For example "First Service" or "Choir Rehearsal".',
        }),
        field('sessionDate', 'Date', dateInput),
        field('startTime', 'Start time', startInput),
        field('endTime', 'End time', endInput),
        field('notes', 'Notes', notesInput, { wide: true }),
      ]),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', { class: 'btn btn-outline-secondary', href: '/attendance', text: 'Cancel' }),
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
    submitLabel.textContent = busy ? 'Opening…' : 'Open session';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const payload = {
      sessionType: typeSelect.value,
      title: titleInput.value.trim(),
      sessionDate: dateInput.value,
    };
    if (startInput.value) payload.startTime = startInput.value;
    if (endInput.value) payload.endTime = endInput.value;
    if (notesInput.value.trim()) payload.notes = notesInput.value.trim();
    if (typeSelect.value === 'ministry' && ministrySelect.value) {
      payload.ministryId = ministrySelect.value;
    }

    if (payload.title.length < 2) {
      setError('title', 'Give this session a title.');
      titleInput.focus();
      return;
    }
    if (typeSelect.value === 'ministry' && !payload.ministryId) {
      setError('ministryId', 'Choose which ministry met.');
      ministrySelect.focus();
      return;
    }

    setBusy(true);
    try {
      const result = await api.post('/attendance/sessions', payload);
      location.assign(`/attendance/session?id=${encodeURIComponent(result.data.id)}`);
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
        el('h1', { class: 'page-header__title', text: 'Open an attendance session' }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  syncVisibility();

  // Ministries are fetched for the picker. A ministry leader with no
  // `ministries.view` still sees their own, because the API narrows by RLS.
  try {
    const payload = await api.get('/ministries', { query: { status: 'active', pageSize: 100 } });
    const options = payload.data.map((ministry) =>
      el('option', { value: ministry.id, text: ministry.name }),
    );

    render(ministrySelect, [
      el('option', { value: '', text: options.length === 0 ? 'No ministries available' : '—' }),
      ...options,
    ]);
  } catch {
    // Not fatal: a service session needs no ministry, and the field is hidden
    // unless the kind is set to ministry.
    render(ministrySelect, [
      el('option', {
        value: '',
        text: leadsAnyMinistry() ? 'Could not load ministries' : 'No ministries available',
      }),
    ]);
  }
}
