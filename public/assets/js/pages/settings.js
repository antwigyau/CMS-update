/**
 * The Settings admin page.
 *
 * Two things live here, both reachable only with `settings.manage`:
 *
 *   1. The church-wide settings — key/value rows an administrator edits in place.
 *      Only the `value` is editable; the key and its meaning are fixed metadata,
 *      changed by a migration, not a form.
 *   2. The spiritual-gifts lookup — the controlled list a church recognises, edited
 *      under the same permission because which gifts exist is policy, like a setting.
 *
 * Every control here is a convenience. The API and RLS refuse a write from anyone
 * without the permission, whatever this page chooses to render.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatDateTime, humanise } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/settings',
    title: 'Settings',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  const settingsRegion = el('div');
  const giftsRegion = el('div');

  let settings = [];
  let gifts = [];

  /* ---- church settings -------------------------------------------------- */

  /**
   * Build the right input for a setting's current value, plus a `read()` that
   * turns the control back into a JSON value. The value's type decides the
   * control: a boolean is a Yes/No select, a number a number field, a string a
   * text box. Objects and arrays have no MVP editor and are shown read-only, so a
   * structured setting can never be corrupted by a text box that flattens it.
   */
  function settingEditor(setting) {
    const value = setting.value;
    const inputId = `setting-${setting.key}`;

    if (typeof value === 'boolean') {
      const select = el('select', { class: 'form-select', id: inputId }, [
        el('option', { value: 'true', text: 'Yes', selected: value === true }),
        el('option', { value: 'false', text: 'No', selected: value === false }),
      ]);
      return { node: select, read: () => select.value === 'true' };
    }

    if (typeof value === 'number') {
      const input = el('input', { class: 'form-control', id: inputId, type: 'number', value });
      return {
        node: input,
        read: () => {
          const parsed = Number(input.value);
          return Number.isFinite(parsed) ? parsed : value;
        },
      };
    }

    if (typeof value === 'string' || value === null) {
      const input = el('input', {
        class: 'form-control',
        id: inputId,
        type: 'text',
        value: value ?? '',
      });
      return {
        node: input,
        read: () => {
          const trimmed = input.value.trim();
          return trimmed === '' ? null : trimmed;
        },
      };
    }

    return {
      node: el('code', { class: 'text-xs', text: JSON.stringify(value) }),
      read: () => value,
      readOnly: true,
    };
  }

  function settingRow(setting) {
    const editor = settingEditor(setting);
    const save = el('button', {
      class: 'btn btn-primary',
      type: 'submit',
      text: 'Save',
      disabled: editor.readOnly === true,
    });

    const form = el('form', { class: 'field' }, [
      el('label', {
        class: 'field__label',
        for: `setting-${setting.key}`,
        text: setting.description || humanise(setting.key.split('.').pop()),
      }),
      el('div', { class: 'cluster' }, [editor.node, save]),
      el('p', { class: 'text-xs text-muted-token' }, [
        el('span', { class: 'mono', text: setting.key }),
        setting.isPublic ? ' · readable by any signed-in user' : null,
        ` · last updated ${formatDateTime(setting.updatedAt)}`,
      ]),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (editor.readOnly) return;
      save.disabled = true;
      try {
        const payload = await api.patch(`/admin/settings/${encodeURIComponent(setting.key)}`, {
          value: editor.read(),
        });
        const index = settings.findIndex((row) => row.key === setting.key);
        if (index !== -1) settings[index] = payload.data;
        notify.success(`Saved ${setting.key}.`);
        renderSettings();
      } catch (error) {
        notify.error(error instanceof ApiError ? error.message : 'Could not save that setting.');
        save.disabled = false;
      }
    });

    return form;
  }

  function renderSettings() {
    if (settings.length === 0) {
      render(settingsRegion, [
        stateBlock({
          iconName: 'sliders',
          title: 'No settings to show',
          message: 'Church settings are seeded with the database.',
        }),
      ]);
      return;
    }
    render(settingsRegion, settings.map(settingRow));
  }

  async function loadSettings() {
    try {
      const payload = await api.get('/admin/settings');
      settings = payload.data;
      renderSettings();
    } catch (error) {
      render(settingsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load settings',
          message:
            error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Try again',
            onclick: loadSettings,
          }),
        }),
      ]);
    }
  }

  /* ---- spiritual-gifts lookup ------------------------------------------- */

  async function saveGift(gift, patch, button) {
    button.disabled = true;
    try {
      await api.patch(`/spiritual-gifts/${encodeURIComponent(gift.id)}`, patch);
      notify.success(`Updated ${gift.name}.`);
      await loadGifts();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not update that gift.');
      button.disabled = false;
    }
  }

  function giftRow(gift) {
    const nameInput = el('input', {
      class: 'form-control',
      type: 'text',
      value: gift.name,
      'aria-label': `Name for ${gift.name}`,
    });
    const activeSelect = el(
      'select',
      { class: 'form-select', 'aria-label': `Status for ${gift.name}` },
      [
        el('option', { value: 'true', text: 'Active', selected: gift.isActive === true }),
        el('option', { value: 'false', text: 'Retired', selected: gift.isActive === false }),
      ],
    );
    const save = el('button', { class: 'btn btn-outline-secondary', type: 'submit', text: 'Save' });

    const form = el('form', { class: 'field' }, [
      el('div', { class: 'cluster' }, [nameInput, activeSelect, save]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      const isActive = activeSelect.value === 'true';
      const patch = {};
      if (name && name !== gift.name) patch.name = name;
      if (isActive !== gift.isActive) patch.isActive = isActive;
      if (Object.keys(patch).length === 0) {
        notify.error('There are no changes to save.');
        return;
      }
      saveGift(gift, patch, save);
    });
    return form;
  }

  function addGiftForm() {
    const input = el('input', {
      class: 'form-control',
      type: 'text',
      placeholder: 'New gift name',
      'aria-label': 'New gift name',
    });
    const add = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Add gift' });

    const form = el('form', { class: 'field' }, [el('div', { class: 'cluster' }, [input, add])]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name.length < 2) {
        notify.error('Give the gift a name of at least 2 characters.');
        return;
      }
      add.disabled = true;
      try {
        await api.post('/spiritual-gifts', { name });
        notify.success(`Added ${name}.`);
        input.value = '';
        await loadGifts();
      } catch (error) {
        notify.error(error instanceof ApiError ? error.message : 'Could not add that gift.');
      } finally {
        add.disabled = false;
      }
    });
    return form;
  }

  function renderGifts() {
    const rows =
      gifts.length === 0
        ? [el('p', { class: 'text-sm text-muted-token', text: 'No gifts defined yet.' })]
        : gifts.map(giftRow);
    render(giftsRegion, [...rows, addGiftForm()]);
  }

  async function loadGifts() {
    try {
      const payload = await api.get('/spiritual-gifts', { query: { all: 1 } });
      gifts = payload.data;
      renderGifts();
    } catch (error) {
      render(giftsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load spiritual gifts',
          message: error instanceof ApiError ? error.message : 'Something went wrong.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Try again',
            onclick: loadGifts,
          }),
        }),
      ]);
    }
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Settings' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Church-wide configuration and reference lists. Changes take effect immediately.',
        }),
      ]),
    ]),
    el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title' }, [icon('sliders'), ' Church settings']),
      ]),
      el('div', { class: 'card-surface__body' }, [settingsRegion]),
    ]),
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title' }, [icon('stars'), ' Spiritual gifts']),
      ]),
      el('div', { class: 'card-surface__body' }, [giftsRegion]),
    ]),
  ]);

  render(settingsRegion, [skeletonLines(4)]);
  render(giftsRegion, [skeletonLines(3)]);

  // The lookup lists under `members.view`; a settings admin who lacks it can still
  // edit settings above, so the section degrades to a note rather than an error.
  const giftsTask = can('members.view')
    ? loadGifts()
    : Promise.resolve(
        render(giftsRegion, [
          stateBlock({
            iconName: 'stars',
            title: 'Viewing the gifts lookup needs the members permission',
            message: 'The church settings above are unaffected.',
          }),
        ]),
      );

  await Promise.all([loadSettings(), giftsTask]);
}
