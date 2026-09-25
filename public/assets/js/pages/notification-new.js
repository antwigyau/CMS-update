/**
 * Compose an announcement.
 *
 * A publisher writes a title and message, picks a type and severity, and chooses
 * who receives it: everyone, one role, or one branch. The role and branch pickers
 * appear only when their audience is chosen. An expiry is sent as an explicit
 * instant — the browser is the only place that knows its own offset.
 *
 * Client-side checks only shorten the correction loop; the server validates
 * independently against the same rules, and its field errors are mapped back onto
 * the inputs.
 */

import { ApiError, api } from '../core/api.js';
import { el, render } from '../core/dom.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

// Mirrors the DB CHECK (notifications_link_relative): a relative path from root.
const LINK_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/notifications',
    title: 'New announcement',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
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

  /* ---- controls --------------------------------------------------------- */

  const titleInput = el('input', { class: 'form-control', type: 'text', autocomplete: 'off' });
  const messageInput = el('textarea', { class: 'form-control', rows: '6' });

  const typeSelect = el('select', { class: 'form-select' }, [
    el('option', { value: 'announcement', text: 'Announcement' }),
    el('option', { value: 'system', text: 'System' }),
    el('option', { value: 'admin', text: 'Admin' }),
  ]);
  const severitySelect = el('select', { class: 'form-select' }, [
    el('option', { value: 'info', text: 'Info' }),
    el('option', { value: 'warning', text: 'Warning' }),
    el('option', { value: 'critical', text: 'Critical' }),
  ]);
  const audienceSelect = el('select', { class: 'form-select' }, [
    el('option', { value: 'all', text: 'Everyone' }),
    el('option', { value: 'role', text: 'A role' }),
    el('option', { value: 'branch', text: 'A branch' }),
  ]);
  const roleSelect = el('select', { class: 'form-select' }, [
    el('option', { value: '', text: 'Loading roles…' }),
  ]);
  const branchSelect = el('select', { class: 'form-select' }, [
    el('option', { value: '', text: 'Loading branches…' }),
  ]);
  const linkInput = el('input', { class: 'form-control', type: 'text', autocomplete: 'off' });
  const expiresInput = el('input', { class: 'form-control', type: 'datetime-local' });

  // The two targeted pickers show only for their audience.
  const roleField = field('audienceRoleId', 'Role', roleSelect, {
    hint: 'Everyone currently holding this role receives it.',
  });
  const branchField = field('branchId', 'Branch', branchSelect, {
    hint: 'Everyone whose home branch is this receives it.',
  });

  function syncAudience() {
    const audience = audienceSelect.value;
    roleField.hidden = audience !== 'role';
    branchField.hidden = audience !== 'branch';
  }
  audienceSelect.addEventListener('change', syncAudience);

  /* ---- form ------------------------------------------------------------- */

  const alertBox = el('div', { id: 'form-alert', hidden: true });
  const submitLabel = el('span', { text: 'Publish' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { id: 'announcement-form', novalidate: true }, [
    el('div', { class: 'form-grid' }, [
      field('title', 'Title', titleInput, { wide: true, required: true }),
      field('body', 'Message', messageInput, { wide: true, required: true }),
      field('type', 'Type', typeSelect),
      field('severity', 'Severity', severitySelect),
      field('audience', 'Audience', audienceSelect, {
        required: true,
        hint: 'Who receives this announcement.',
      }),
      roleField,
      branchField,
      field('linkPath', 'Link', linkInput, {
        hint: 'Optional. A relative link opened when the item is tapped, e.g. /events.',
      }),
      field('expiresAt', 'Expires', expiresInput, {
        hint: 'Optional. After this time the announcement drops out of every inbox.',
      }),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', { class: 'btn btn-outline-secondary', href: '/admin/notifications', text: 'Cancel' }),
    ]),
  ]);

  syncAudience();

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
    submitLabel.textContent = busy ? 'Publishing…' : 'Publish';
  }

  /* ---- validation ------------------------------------------------------- */

  function validate({ title, message, audience, link, expiresLocal }) {
    let firstInvalid = null;
    const fail = (name, msg) => {
      setError(name, msg);
      if (!firstInvalid) firstInvalid = name;
    };

    if (title.length < 2) fail('title', 'Enter a title of at least 2 characters.');
    else if (title.length > 160) fail('title', 'Keep the title to 160 characters or fewer.');

    if (message.length < 2) fail('body', 'Enter a message of at least 2 characters.');
    else if (message.length > 4000) fail('body', 'Keep the message to 4000 characters or fewer.');

    if (audience === 'role' && !roleSelect.value) {
      fail('audienceRoleId', 'Choose a role for a role-targeted announcement.');
    }
    if (audience === 'branch' && !branchSelect.value) {
      fail('branchId', 'Choose a branch for a branch-targeted announcement.');
    }

    if (link) {
      if (link.length > 512) fail('linkPath', 'That link is too long.');
      else if (!LINK_PATTERN.test(link)) {
        fail('linkPath', 'Enter a relative link that starts with /.');
      }
    }

    if (expiresLocal) {
      const parsed = new Date(expiresLocal);
      if (Number.isNaN(parsed.getTime())) fail('expiresAt', 'Enter a valid date and time.');
      else if (parsed.getTime() <= Date.now()) {
        fail('expiresAt', 'The expiry must be in the future.');
      }
    }

    if (firstInvalid) inputs.get(firstInvalid)?.focus();
    return firstInvalid === null;
  }

  /* ---- submit ----------------------------------------------------------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const title = titleInput.value.trim();
    const message = messageInput.value.trim();
    const audience = audienceSelect.value;
    const link = linkInput.value.trim();
    const expiresLocal = expiresInput.value;
    if (!validate({ title, message, audience, link, expiresLocal })) return;

    const payload = {
      title,
      body: message,
      type: typeSelect.value,
      severity: severitySelect.value,
      audience,
    };
    if (audience === 'role') payload.audienceRoleId = roleSelect.value;
    if (audience === 'branch') payload.branchId = branchSelect.value;
    if (link) payload.linkPath = link;
    if (expiresLocal) payload.expiresAt = new Date(expiresLocal).toISOString();

    setBusy(true);
    try {
      const result = await api.post('/admin/notifications', payload);
      location.assign(`/admin/notifications/detail?id=${encodeURIComponent(result.data.id)}`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.details?.fields) {
        for (const [fieldName, fieldMessage] of Object.entries(error.details.fields)) {
          setError(fieldName, fieldMessage);
        }
        inputs.get(Object.keys(error.details.fields)[0])?.focus();
      }
      showAlert(error.message);
      setBusy(false);
    }
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'New announcement' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Publish an in-app announcement to everyone, a role, or a branch.',
        }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  /* ---- audience options ------------------------------------------------- */

  // Populate the role and branch pickers. They start hidden, so a slow or failed
  // load is invisible until the publisher actually targets a role or branch.
  try {
    const payload = await api.get('/admin/notifications/audiences');
    const { roles, branches } = payload.data;
    render(roleSelect, [
      el('option', { value: '', text: 'Choose a role…' }),
      ...roles.map((role) => el('option', { value: role.id, text: role.name })),
    ]);
    render(branchSelect, [
      el('option', { value: '', text: 'Choose a branch…' }),
      ...branches.map((branch) => el('option', { value: branch.id, text: branch.name })),
    ]);
  } catch {
    render(roleSelect, [el('option', { value: '', text: 'Could not load roles' })]);
    render(branchSelect, [el('option', { value: '', text: 'Could not load branches' })]);
  }
}
