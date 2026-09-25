/**
 * Event form — create and edit.
 *
 * Times are sent with an explicit offset. `<input type="datetime-local">` gives a
 * bare local datetime, which the server would read in *its* zone (UTC on Vercel) —
 * so a 6pm event created in Accra would land as 6pm UTC. Converting here, where the
 * browser knows its own offset, is the only place that can get it right.
 *
 * There is no status field: publishing is a separate act with its own permission,
 * and lives on the detail page.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock } from '../core/dom.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const eventId = new URLSearchParams(location.search).get('id');
const isEdit = Boolean(eventId);

const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/events',
    title: isEdit ? 'Edit event' : 'Add event',
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

  function field(name, label, control, { hint, wide = false, required = false } = {}) {
    const errorId = `field-${name}-error`;
    control.id = `field-${name}`;
    control.setAttribute('aria-describedby', errorId);

    const errorNode = el('p', { class: 'field__error', id: errorId, hidden: true });
    inputs.set(name, control);
    errorNodes.set(name, errorNode);

    control.addEventListener('input', () => {
      if (control.getAttribute('aria-invalid') === 'true') setError(name, null);
    });

    return el('div', { class: `field${wide ? ' field--wide' : ''}` }, [
      el('label', { class: 'field__label', for: control.id }, [
        label,
        required ? el('span', { class: 'field__required', 'aria-hidden': 'true' }, [' *']) : null,
      ]),
      control,
      hint ? el('p', { class: 'field__hint', text: hint }) : null,
      errorNode,
    ]);
  }

  const titleInput = el('input', { class: 'form-control', type: 'text' });
  const categorySelect = el('select', { class: 'form-select' }, [
    el('option', { value: '', text: 'Loading categories…' }),
  ]);
  const ministrySelect = el('select', { class: 'form-select' }, [
    el('option', { value: '', text: 'Loading ministries…' }),
  ]);
  const startsInput = el('input', { class: 'form-control', type: 'datetime-local' });
  const endsInput = el('input', { class: 'form-control', type: 'datetime-local' });
  const venueInput = el('input', { class: 'form-control', type: 'text' });
  const capacityInput = el('input', { class: 'form-control', type: 'number', min: '1' });
  const descriptionInput = el('textarea', { class: 'form-control', rows: '5' });
  const publicInput = el('input', { class: 'form-check-input', type: 'checkbox' });

  /** A local datetime from `<input>` plus the browser's offset, as an ISO instant. */
  function toInstant(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /** An ISO instant back into the `YYYY-MM-DDTHH:MM` the input expects, in local time. */
  function toLocalInput(value) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';

    const pad = (number) => String(number).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(
      parsed.getHours(),
    )}:${pad(parsed.getMinutes())}`;
  }

  const alertBox = el('div', { hidden: true });
  const submitLabel = el('span', { text: isEdit ? 'Save changes' : 'Create event' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { novalidate: true }, [
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'What and when' }),
      el('p', {
        class: 'form-section__hint',
        text: isEdit
          ? 'Changes take effect immediately.'
          : 'The event is created as a draft. Publishing it is a separate step.',
      }),
      el('div', { class: 'form-grid' }, [
        field('title', 'Title', titleInput, { wide: true, required: true }),
        field('startsAt', 'Starts', startsInput, { required: true }),
        field('endsAt', 'Ends', endsInput, { required: true }),
        field('venue', 'Venue', venueInput),
        field('categoryId', 'Category', categorySelect),
      ]),
    ]),
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Who and how many' }),
      el('div', { class: 'form-grid' }, [
        field('ministryId', 'Ministry', ministrySelect, {
          hint: 'A ministry’s leader may edit its events.',
        }),
        field('capacity', 'Capacity', capacityInput, { hint: 'Leave empty for no limit.' }),
        el('div', { class: 'field field--wide' }, [
          el('div', { class: 'form-check' }, [
            publicInput,
            el('label', { class: 'form-check-label', for: 'field-isPublic' }, [
              'Visible to everyone signed in',
            ]),
          ]),
          el('p', {
            class: 'field__hint',
            text: 'Off by default. A draft is never visible however this is set.',
          }),
        ]),
        field('description', 'Description', descriptionInput, { wide: true }),
      ]),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', {
        class: 'btn btn-outline-secondary',
        href: isEdit ? `/events/detail?id=${encodeURIComponent(eventId)}` : '/events',
        text: 'Cancel',
      }),
    ]),
  ]);

  // Registered after the checkbox is in the tree so the label's `for` resolves.
  publicInput.id = 'field-isPublic';
  inputs.set('isPublic', publicInput);

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
    submitLabel.textContent = busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create event';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const startsAt = toInstant(startsInput.value);
    const endsAt = toInstant(endsInput.value);

    if (titleInput.value.trim().length < 2) {
      setError('title', 'Give this event a title.');
      titleInput.focus();
      return;
    }
    if (!startsAt) {
      setError('startsAt', 'Enter when the event starts.');
      startsInput.focus();
      return;
    }
    if (!endsAt) {
      setError('endsAt', 'Enter when the event ends.');
      endsInput.focus();
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      setError('endsAt', 'The event must end after it starts.');
      endsInput.focus();
      return;
    }

    const payload = {
      title: titleInput.value.trim(),
      startsAt,
      endsAt,
      isPublic: publicInput.checked,
    };
    if (venueInput.value.trim()) payload.venue = venueInput.value.trim();
    if (categorySelect.value) payload.categoryId = categorySelect.value;
    if (ministrySelect.value) payload.ministryId = ministrySelect.value;
    if (capacityInput.value.trim()) payload.capacity = Number(capacityInput.value);
    if (descriptionInput.value.trim()) payload.description = descriptionInput.value.trim();

    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/events/${encodeURIComponent(eventId)}`, payload);
        notify.success('Changes saved.');
        location.assign(`/events/detail?id=${encodeURIComponent(eventId)}`);
      } else {
        const result = await api.post('/events', payload);
        location.assign(`/events/detail?id=${encodeURIComponent(result.data.id)}`);
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
        el('h1', { class: 'page-header__title', text: isEdit ? 'Edit event' : 'Add event' }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  /* ---- reference data --------------------------------------------------- */

  async function fillOptions(select, path, query, label) {
    try {
      const payload = await api.get(path, { query });
      const options = payload.data.map((item) =>
        el('option', { value: item.id, text: item.name ?? item.title }),
      );
      render(select, [el('option', { value: '', text: `No ${label}` }), ...options]);
    } catch {
      render(select, [el('option', { value: '', text: `Could not load ${label}` })]);
    }
  }

  await Promise.all([
    fillOptions(categorySelect, '/event-categories', undefined, 'category'),
    fillOptions(ministrySelect, '/ministries', { status: 'active', pageSize: 100 }, 'ministry'),
  ]);

  if (isEdit) {
    form.hidden = true;
    try {
      const payload = await api.get(`/events/${encodeURIComponent(eventId)}`);
      const event = payload.data;

      titleInput.value = event.title ?? '';
      startsInput.value = toLocalInput(event.startsAt);
      endsInput.value = toLocalInput(event.endsAt);
      venueInput.value = event.venue ?? '';
      categorySelect.value = event.categoryId ?? '';
      ministrySelect.value = event.ministryId ?? '';
      capacityInput.value = event.capacity === null ? '' : String(event.capacity);
      descriptionInput.value = event.description ?? '';
      publicInput.checked = Boolean(event.isPublic);

      form.hidden = false;
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Event not found' : 'Could not load this event',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/events', text: 'Back' }),
        }),
      ]);
    }
  }
}
