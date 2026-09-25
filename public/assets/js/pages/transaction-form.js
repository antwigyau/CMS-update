/**
 * Transaction form — record and edit.
 *
 * The `kind` toggle changes the shape of the form: an expense has no income type
 * and no member, so those fields are hidden rather than merely ignored. The
 * category list is filtered to the chosen kind, because a tithe is never an
 * expense category.
 *
 * The currency is shown as a read-only label, not a field: it is the church's
 * configured currency (from the session), stamped by the server. There is no
 * status field — submitting for approval is a separate step on the detail page.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock } from '../core/dom.js';
import { humanise } from '../core/format.js';
import { currency, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { memberPicker } from '../components/member-picker.js';

const INCOME_TYPES = ['tithe', 'offering', 'donation', 'other'];
const PAYMENT_METHODS = ['cash', 'mobile_money', 'bank_transfer', 'cheque', 'card', 'other'];

const txnId = new URLSearchParams(location.search).get('id');
const isEdit = Boolean(txnId);

const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/finance',
    title: isEdit ? 'Edit transaction' : 'Record a transaction',
    user: account.user,
    can: (permission) => account.permissions.includes(permission),
    onSignOut: signOut,
  });

  const inputs = new Map();
  const errorNodes = new Map();
  let allCategories = [];
  let chosenMember = null; // { id, fullName } or null for anonymous

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

  const kindSelect = el(
    'select',
    { class: 'form-select' },
    ['income', 'expense'].map((value) => el('option', { value, text: humanise(value) })),
  );
  const incomeTypeSelect = el(
    'select',
    { class: 'form-select' },
    INCOME_TYPES.map((value) => el('option', { value, text: humanise(value) })),
  );
  const categorySelect = el('select', { class: 'form-select' }, [
    el('option', { value: '', text: 'Loading categories…' }),
  ]);
  const amountInput = el('input', {
    class: 'form-control',
    type: 'number',
    min: '0.01',
    step: '0.01',
    inputmode: 'decimal',
  });
  const occurredInput = el('input', {
    class: 'form-control',
    type: 'date',
    max: new Date().toISOString().slice(0, 10),
  });
  const methodSelect = el(
    'select',
    { class: 'form-select' },
    PAYMENT_METHODS.map((value) => el('option', { value, text: humanise(value) })),
  );
  const referenceInput = el('input', { class: 'form-control', type: 'text' });
  const descriptionInput = el('textarea', { class: 'form-control', rows: '4' });

  const currencyCode = currency();
  const amountAddon = el('span', {
    class: 'input-group-text',
    text: currencyCode ?? '¤',
  });
  const amountGroup = el('div', { class: 'input-group' }, [amountAddon, amountInput]);

  /* ---- member (income only) --------------------------------------------- */

  const memberDisplay = el('div', { class: 'text-sm' });

  function renderMemberDisplay() {
    if (chosenMember) {
      render(memberDisplay, [
        el('span', { class: 'person__name', text: chosenMember.fullName }),
        ' ',
        el('button', {
          class: 'btn btn-sm btn-outline-secondary',
          type: 'button',
          text: 'Clear',
          onclick: () => {
            chosenMember = null;
            renderMemberDisplay();
          },
        }),
      ]);
    } else {
      render(memberDisplay, [
        el('span', {
          class: 'text-muted-token',
          text: 'Anonymous — no member attributed. Search above to attribute it.',
        }),
      ]);
    }
  }

  const picker = memberPicker({
    label: 'Attribute to a member (optional)',
    onSelect: (member) => {
      chosenMember = member;
      renderMemberDisplay();
    },
  });

  const incomeSection = el('div', { class: 'form-grid', hidden: false }, [
    field('incomeType', 'Income type', incomeTypeSelect, { required: true }),
    el('div', { class: 'field field--wide' }, [picker.element, memberDisplay]),
  ]);

  /* ---- kind toggle ------------------------------------------------------ */

  function applyKind() {
    const isIncome = kindSelect.value === 'income';
    incomeSection.hidden = !isIncome;
    if (!isIncome) {
      chosenMember = null;
      renderMemberDisplay();
    }
    fillCategories();
  }

  kindSelect.addEventListener('change', applyKind);

  function fillCategories() {
    const forKind = allCategories.filter((category) => category.kind === kindSelect.value);
    render(categorySelect, [
      el('option', { value: '', text: forKind.length ? 'Choose a category' : 'No categories yet' }),
      ...forKind.map((category) => el('option', { value: category.id, text: category.name })),
    ]);
  }

  const alertBox = el('div', { hidden: true });
  const submitLabel = el('span', { text: isEdit ? 'Save changes' : 'Record transaction' });
  const submitButton = el('button', { class: 'btn btn-primary', type: 'submit' }, [submitLabel]);

  const form = el('form', { novalidate: true }, [
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'What' }),
      el('p', {
        class: 'form-section__hint',
        text: isEdit
          ? 'Only a draft or a sent-back transaction can be edited.'
          : 'Recorded as a draft. Submitting it for approval is a separate step.',
      }),
      el('div', { class: 'form-grid' }, [
        field('kind', 'Type', kindSelect, { required: true }),
        field('categoryId', 'Category', categorySelect, { required: true }),
        field('amount', `Amount${currencyCode ? ` (${currencyCode})` : ''}`, amountGroup, {
          required: true,
        }),
        field('occurredOn', 'Date', occurredInput, { required: true }),
        field('paymentMethod', 'Method', methodSelect, { required: true }),
      ]),
    ]),
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Who' }),
      incomeSection,
    ]),
    el('div', { class: 'form-section' }, [
      el('h2', { class: 'form-section__title', text: 'Notes' }),
      el('div', { class: 'form-grid' }, [
        field('reference', 'Reference', referenceInput, {
          hint: 'A cheque number, receipt number, or similar.',
        }),
        field('description', 'Description', descriptionInput, { wide: true }),
      ]),
    ]),
    el('div', { class: 'form-actions' }, [
      submitButton,
      el('a', {
        class: 'btn btn-outline-secondary',
        href: isEdit ? `/finance/detail?id=${encodeURIComponent(txnId)}` : '/finance',
        text: 'Cancel',
      }),
    ]),
  ]);

  // The amount control is a group, so register the inner input for error focus.
  inputs.set('amount', amountInput);

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
    submitLabel.textContent = busy ? 'Saving…' : isEdit ? 'Save changes' : 'Record transaction';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.hidden = true;
    for (const name of inputs.keys()) setError(name, null);

    const isIncome = kindSelect.value === 'income';

    if (!categorySelect.value) {
      setError('categoryId', 'Choose a category.');
      categorySelect.focus();
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(amountInput.value.trim()) || Number(amountInput.value) <= 0) {
      setError('amount', 'Enter an amount greater than zero, with at most two decimal places.');
      amountInput.focus();
      return;
    }
    if (!occurredInput.value) {
      setError('occurredOn', 'Enter the date.');
      occurredInput.focus();
      return;
    }

    const payload = {
      kind: kindSelect.value,
      categoryId: categorySelect.value,
      amount: amountInput.value.trim(),
      occurredOn: occurredInput.value,
      paymentMethod: methodSelect.value,
    };
    if (isIncome) {
      payload.incomeType = incomeTypeSelect.value;
      if (chosenMember) payload.memberId = chosenMember.id;
    }
    if (referenceInput.value.trim()) payload.reference = referenceInput.value.trim();
    if (descriptionInput.value.trim()) payload.description = descriptionInput.value.trim();

    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/transactions/${encodeURIComponent(txnId)}`, payload);
        notify.success('Changes saved.');
        location.assign(`/finance/detail?id=${encodeURIComponent(txnId)}`);
      } else {
        const result = await api.post('/transactions', payload);
        location.assign(`/finance/detail?id=${encodeURIComponent(result.data.id)}`);
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
          text: isEdit ? 'Edit transaction' : 'Record a transaction',
        }),
        currencyCode
          ? null
          : el('p', {
              class: 'page-header__subtitle text-danger-token',
              text: 'No currency has been configured. An administrator must set one before recording transactions.',
            }),
      ]),
    ]),
    alertBox,
    el('section', { class: 'card-surface' }, [form]),
  ]);

  renderMemberDisplay();

  /* ---- reference data --------------------------------------------------- */

  try {
    const payload = await api.get('/transaction-categories');
    allCategories = payload.data;
  } catch {
    allCategories = [];
  }

  applyKind();

  if (isEdit) {
    form.hidden = true;
    try {
      const { data: txn } = await api.get(`/transactions/${encodeURIComponent(txnId)}`);

      kindSelect.value = txn.kind;
      applyKind();
      incomeTypeSelect.value = txn.incomeType ?? 'offering';
      categorySelect.value = txn.categoryId ?? '';
      amountInput.value = txn.amount ?? '';
      occurredInput.value = txn.occurredOn ?? '';
      methodSelect.value = txn.paymentMethod ?? 'cash';
      referenceInput.value = txn.reference ?? '';
      descriptionInput.value = txn.description ?? '';

      if (txn.kind === 'income' && txn.memberId) {
        chosenMember = { id: txn.memberId, fullName: txn.memberName ?? 'Member' };
      }
      renderMemberDisplay();

      form.hidden = false;
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Transaction not found' : 'Could not load this transaction',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/finance', text: 'Back' }),
        }),
      ]);
    }
  }
}
