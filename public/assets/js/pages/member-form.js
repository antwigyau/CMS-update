/**
 * Member form — used for both creating and editing.
 *
 * `/members/new` creates; `/members/edit?id=…` loads and PATCHes. The two share
 * every field, so they share a module: a divergence between the create and edit
 * forms is a bug waiting to happen.
 *
 * Client-side validation exists to shorten the correction loop, not to enforce
 * anything. The server validates independently and its field errors are mapped
 * back onto the inputs, so a rule that exists only server-side still lands in the
 * right place.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock } from '../core/dom.js';
import { humanise } from '../core/format.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const GENDERS = ['male', 'female'];
const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced', 'separated'];
const MEMBERSHIP_STATUSES = ['visitor', 'new', 'active', 'inactive', 'transferred', 'deceased'];

const memberId = new URLSearchParams(location.search).get('id');
const isEdit = Boolean(memberId);

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/members',
    title: isEdit ? 'Edit member' : 'Add member',
    user: session.user,
    can: (permission) => session.permissions.includes(permission),
    onSignOut: signOut,
  });

  /* ---- field definitions ------------------------------------------------ */

  /** name, label, type, and any options. Order is the order rendered. */
  const SECTIONS = [
    {
      title: 'Personal information',
      hint: 'Only a first and last name are required. Everything else can be filled in later.',
      fields: [
        { name: 'firstName', label: 'First name', required: true },
        { name: 'middleName', label: 'Middle name' },
        { name: 'lastName', label: 'Last name', required: true },
        { name: 'gender', label: 'Gender', type: 'select', options: GENDERS },
        { name: 'dateOfBirth', label: 'Date of birth', type: 'date' },
        {
          name: 'maritalStatus',
          label: 'Marital status',
          type: 'select',
          options: MARITAL_STATUSES,
        },
        { name: 'occupation', label: 'Occupation' },
      ],
    },
    {
      title: 'Contact',
      fields: [
        { name: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel' },
        { name: 'altPhone', label: 'Alternative phone', type: 'tel' },
        { name: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
        { name: 'addressLine', label: 'Address', wide: true },
        { name: 'city', label: 'City' },
        { name: 'region', label: 'Region' },
        { name: 'country', label: 'Country' },
        { name: 'nationality', label: 'Nationality' },
      ],
    },
    {
      title: 'Church information',
      fields: [
        {
          name: 'membershipStatus',
          label: 'Membership status',
          type: 'select',
          options: MEMBERSHIP_STATUSES,
          required: true,
          omitBlank: true,
        },
        { name: 'dateJoined', label: 'Date joined', type: 'date' },
        { name: 'isBaptized', label: 'Baptised', type: 'checkbox' },
        { name: 'baptismDate', label: 'Baptism date', type: 'date' },
        {
          name: 'notes',
          label: 'Notes',
          type: 'textarea',
          wide: true,
          hint: 'Visible to anyone who can view this member. Keep it factual.',
        },
      ],
    },
  ];

  const inputs = new Map();
  const errorNodes = new Map();

  function field(definition) {
    const id = `field-${definition.name}`;
    const errorId = `${id}-error`;

    let control;
    if (definition.type === 'select') {
      control = el('select', { class: 'form-select', id, name: definition.name }, [
        definition.omitBlank ? null : el('option', { value: '', text: '—' }),
        ...definition.options.map((value) => el('option', { value, text: humanise(value) })),
      ]);
    } else if (definition.type === 'textarea') {
      control = el('textarea', { class: 'form-control', id, name: definition.name, rows: '4' });
    } else if (definition.type === 'checkbox') {
      control = el('input', {
        class: 'form-check-input',
        id,
        name: definition.name,
        type: 'checkbox',
      });
    } else {
      control = el('input', {
        class: 'form-control',
        id,
        name: definition.name,
        type: definition.type ?? 'text',
        autocomplete: definition.autocomplete ?? 'off',
      });
    }

    control.setAttribute('aria-describedby', errorId);
    const errorNode = el('p', { class: 'field__error', id: errorId, hidden: true });

    inputs.set(definition.name, control);
    errorNodes.set(definition.name, errorNode);

    // Clear a field's error as soon as the user starts fixing it.
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

  /* ---- reading and writing values -------------------------------------- */

  function fill(member) {
    for (const [name, control] of inputs) {
      const value = member[name];
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = value ?? '';
    }
  }

  /** Only the fields the user actually filled in, so a PATCH stays minimal. */
  function collect() {
    const payload = {};
    for (const [name, control] of inputs) {
      if (control.type === 'checkbox') {
        payload[name] = control.checked;
      } else {
        const value = control.value.trim();
        if (value !== '') payload[name] = value;
      }
    }
    return payload;
  }

  function validateLocally(payload) {
    let firstInvalid = null;

    const fail = (name, message) => {
      setError(name, message);
      if (!firstInvalid) firstInvalid = name;
    };

    if (!payload.firstName) fail('firstName', "Enter the member's first name.");
    if (!payload.lastName) fail('lastName', "Enter the member's last name.");

    const today = new Date().toISOString().slice(0, 10);
    if (payload.dateOfBirth && payload.dateOfBirth > today) {
      fail('dateOfBirth', 'A date of birth cannot be in the future.');
    }
    if (payload.baptismDate && !payload.isBaptized) {
      fail('baptismDate', 'Mark the member as baptised before recording a baptism date.');
    }
    if (payload.baptismDate && payload.dateOfBirth && payload.baptismDate < payload.dateOfBirth) {
      fail('baptismDate', 'A baptism date cannot be before the date of birth.');
    }

    if (firstInvalid) inputs.get(firstInvalid)?.focus();
    return firstInvalid === null;
  }

  /* ---- page ------------------------------------------------------------- */

  const alertBox = el('div', { id: 'form-alert', hidden: true });
  const submitLabel = el('span', { text: isEdit ? 'Save changes' : 'Add member' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { id: 'member-form', novalidate: true }, [
    ...SECTIONS.map((section) =>
      el('div', { class: 'form-section' }, [
        el('h2', { class: 'form-section__title', text: section.title }),
        section.hint ? el('p', { class: 'form-section__hint', text: section.hint }) : null,
        el('div', { class: 'form-grid' }, section.fields.map(field)),
      ]),
    ),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', {
        class: 'btn btn-outline-secondary',
        href: isEdit ? `/members/detail?id=${encodeURIComponent(memberId)}` : '/members',
        text: 'Cancel',
      }),
      el('div', { class: 'form-actions__spacer' }),
    ]),
  ]);

  function showAlert(message, variant = 'error') {
    render(alertBox, [
      el('div', { class: `inline-alert inline-alert--${variant}`, role: 'alert' }, [
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
    submitLabel.textContent = busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add member';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    clearErrors();

    const payload = collect();
    if (!validateLocally(payload)) return;

    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/members/${encodeURIComponent(memberId)}`, payload);
        notify.success('Changes saved.');
        location.assign(`/members/detail?id=${encodeURIComponent(memberId)}`);
      } else {
        const created = await api.post('/members', payload);
        location.assign(`/members/detail?id=${encodeURIComponent(created.data.id)}&created=1`);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;

      if (error.details?.fields) {
        // Server-side validation is authoritative — put its messages on the fields.
        for (const [name, message] of Object.entries(error.details.fields)) setError(name, message);
        const firstField = Object.keys(error.details.fields)[0];
        inputs.get(firstField)?.focus();
        showAlert(error.message);
      } else {
        showAlert(error.message);
      }
    } finally {
      setBusy(false);
    }
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: isEdit ? 'Edit member' : 'Add member' }),
        el('p', {
          class: 'page-header__subtitle',
          text: isEdit
            ? 'Changes take effect immediately.'
            : 'A member number is assigned automatically once the record is saved.',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  if (isEdit) {
    form.hidden = true;
    try {
      const payload = await api.get(`/members/${encodeURIComponent(memberId)}`);
      fill(payload.data);
      form.hidden = false;
    } catch (error) {
      render(main, [
        stateBlock({
          variant: 'error',
          title:
            error instanceof ApiError && error.status === 404
              ? 'Member not found'
              : 'Could not load this member',
          message:
            error instanceof ApiError && error.status === 404
              ? 'It may have been removed, or you may not have permission to see it.'
              : 'The request failed. Try again in a moment.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/members',
            text: 'Back to members',
          }),
        }),
      ]);
    }
  } else {
    // A sensible default for a new record, matching the API's own default.
    inputs.get('membershipStatus').value = 'visitor';
  }
}
