/**
 * The spiritual-gifts panel on a member's detail page (decision D7).
 *
 * Gifts come from a controlled lookup, not free text, so adding one is a pick from
 * a list rather than typing. Write controls appear only when the caller may edit
 * the member; the endpoint and RLS check again.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { notify } from '../core/toast.js';

export function spiritualGiftsSection({ memberId, canEdit }) {
  const base = `/members/${encodeURIComponent(memberId)}/spiritual-gifts`;
  const listRegion = el('div');
  const addRegion = el('div');
  let current = [];
  let lookup = [];

  async function remove(gift) {
    try {
      await api.delete(`${base}/${encodeURIComponent(gift.giftId)}`);
      notify.success(`Removed ${gift.name}.`);
      await load();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not remove that gift.');
    }
  }

  async function add(giftId) {
    try {
      await api.post(base, { giftId });
      notify.success('Gift added.');
      await load();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not add that gift.');
    }
  }

  function pill(gift) {
    return el('span', { class: 'pill pill--neutral cluster' }, [
      gift.name,
      canEdit
        ? el('button', {
            class: 'pill__remove',
            type: 'button',
            'aria-label': `Remove ${gift.name}`,
            text: '×',
            onclick: () => remove(gift),
          })
        : null,
    ]);
  }

  function renderAdd() {
    if (!canEdit) return;
    const held = new Set(current.map((gift) => gift.giftId));
    const available = lookup.filter((gift) => !held.has(gift.id));

    if (available.length === 0) {
      render(addRegion, []);
      return;
    }

    const select = el('select', { class: 'form-select', 'aria-label': 'Add a spiritual gift' }, [
      el('option', { value: '', text: 'Add a gift…' }),
      ...available.map((gift) => el('option', { value: gift.id, text: gift.name })),
    ]);
    select.addEventListener('change', () => {
      if (select.value) add(select.value);
    });
    render(addRegion, [el('div', { class: 'field' }, [select])]);
  }

  async function load() {
    try {
      const [mine, all] = await Promise.all([
        api.get(base),
        canEdit ? api.get('/spiritual-gifts') : Promise.resolve({ data: [] }),
      ]);
      current = mine.data;
      lookup = all.data;

      render(
        listRegion,
        current.length === 0
          ? [el('p', { class: 'text-sm text-muted-token', text: 'No gifts recorded.' })]
          : [el('div', { class: 'cluster' }, current.map(pill))],
      );
      renderAdd();
    } catch (error) {
      render(listRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load spiritual gifts',
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

  load();

  return el('section', { class: 'card-surface gap-below-5' }, [
    el('div', { class: 'card-surface__header' }, [
      el('h2', { class: 'card-surface__title' }, [icon('stars'), ' Spiritual gifts']),
    ]),
    el('div', { class: 'card-surface__body' }, [listRegion, addRegion]),
  ]);
}
