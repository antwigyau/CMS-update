/**
 * The emergency-contacts panel on a member's detail page.
 *
 * Self-contained: it fetches its own rows, and manages its own add / edit / remove
 * without the detail page needing to know how. Write controls appear only when the
 * caller may edit the member; the endpoint (and RLS beneath it) checks again, so
 * hiding them is a courtesy, not the control.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { notify } from '../core/toast.js';

export function emergencyContactsSection({ memberId, canEdit }) {
  const base = `/members/${encodeURIComponent(memberId)}/emergency-contacts`;
  const listRegion = el('div');
  const formRegion = el('div');

  function field(label, name, { type = 'text', value = '', checkbox = false } = {}) {
    const input = el('input', {
      class: checkbox ? 'form-check-input' : 'form-control',
      id: `ec-${name}`,
      name,
      type: checkbox ? 'checkbox' : type,
      value: checkbox ? undefined : value,
      checked: checkbox && value ? true : null,
    });
    return { input, node: labelled(label, name, input, checkbox) };
  }

  function labelled(label, name, input, checkbox) {
    if (checkbox) {
      return el('div', { class: 'form-check' }, [
        input,
        el('label', { class: 'form-check-label', for: `ec-${name}`, text: label }),
      ]);
    }
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: `ec-${name}`, text: label }),
      input,
    ]);
  }

  function showForm(contact) {
    const isEdit = Boolean(contact);
    const name = field('Name', 'name', { value: contact?.name ?? '' });
    const relationship = field('Relationship', 'relationship', {
      value: contact?.relationship ?? '',
    });
    const phone = field('Phone', 'phone', { type: 'tel', value: contact?.phone ?? '' });
    const altPhone = field('Alternative phone', 'altPhone', {
      type: 'tel',
      value: contact?.altPhone ?? '',
    });
    const address = field('Address', 'addressLine', { value: contact?.addressLine ?? '' });
    const primary = field('Primary contact', 'isPrimary', {
      checkbox: true,
      value: contact?.isPrimary ?? false,
    });
    const error = el('p', { class: 'text-sm text-danger-token', role: 'alert' });

    async function submit(event) {
      event.preventDefault();
      error.textContent = '';
      const body = {
        name: name.input.value.trim(),
        relationship: relationship.input.value.trim(),
        phone: phone.input.value.trim(),
        altPhone: altPhone.input.value.trim() || null,
        addressLine: address.input.value.trim() || null,
        isPrimary: primary.input.checked,
      };

      try {
        if (isEdit) {
          await api.patch(`${base}/${encodeURIComponent(contact.id)}`, body);
          notify.success('Emergency contact updated.');
        } else {
          await api.post(base, body);
          notify.success('Emergency contact added.');
        }
        render(formRegion, []);
        await load();
      } catch (caught) {
        error.textContent =
          caught instanceof ApiError ? caught.message : 'Could not save this contact.';
      }
    }

    render(formRegion, [
      el('form', { class: 'stack-4 gap-below-5', onsubmit: submit }, [
        name.node,
        relationship.node,
        phone.node,
        altPhone.node,
        address.node,
        primary.node,
        error,
        el('div', { class: 'cluster' }, [
          el('button', { class: 'btn btn-primary', type: 'submit', text: isEdit ? 'Save' : 'Add' }),
          el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Cancel',
            onclick: () => render(formRegion, []),
          }),
        ]),
      ]),
    ]);
  }

  async function remove(contact) {
    if (!window.confirm(`Remove ${contact.name} as an emergency contact?`)) return;
    try {
      await api.delete(`${base}/${encodeURIComponent(contact.id)}`);
      notify.success('Emergency contact removed.');
      await load();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not remove this contact.');
    }
  }

  function row(contact) {
    return el('div', { class: 'list-row' }, [
      el('div', {}, [
        el('div', { class: 'person__name' }, [
          contact.name,
          contact.isPrimary ? el('span', { class: 'pill pill--brand', text: 'Primary' }) : null,
        ]),
        el('div', { class: 'person__meta' }, [
          contact.relationship,
          ' · ',
          contact.phone,
          contact.altPhone ? ` · ${contact.altPhone}` : '',
        ]),
        contact.addressLine
          ? el('div', { class: 'text-xs text-muted-token', text: contact.addressLine })
          : null,
      ]),
      canEdit
        ? el('div', { class: 'cluster' }, [
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Edit',
              onclick: () => showForm(contact),
            }),
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Remove',
              onclick: () => remove(contact),
            }),
          ])
        : null,
    ]);
  }

  async function load() {
    try {
      const payload = await api.get(base);
      const contacts = payload.data;
      render(
        listRegion,
        contacts.length === 0
          ? [
              el('p', {
                class: 'text-sm text-muted-token',
                text: 'No emergency contacts recorded.',
              }),
            ]
          : contacts.map(row),
      );
    } catch (error) {
      render(listRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load emergency contacts',
          message: error instanceof ApiError ? error.message : 'Something went wrong.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Try again',
            onclick: load,
          }),
        }),
      ]);
    }
  }

  const container = el('section', { class: 'card-surface gap-below-5' }, [
    el('div', { class: 'card-surface__header' }, [
      el('h2', { class: 'card-surface__title', text: 'Emergency contacts' }),
      canEdit
        ? el('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button' }, [
            icon('plus-lg'),
            ' Add',
          ])
        : null,
    ]),
    el('div', { class: 'card-surface__body' }, [formRegion, listRegion]),
  ]);

  if (canEdit) {
    container.querySelector('button').addEventListener('click', () => showForm(null));
  }

  load();
  return container;
}
