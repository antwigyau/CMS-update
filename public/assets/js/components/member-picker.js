/**
 * A member picker, backed by the restricted directory.
 *
 * Uses `GET /api/members/directory`, which returns name, member number, photo,
 * and status — and nothing else. That endpoint exists precisely for lookups like
 * this one: adding someone to a household needs a name and a face, not their
 * address and date of birth.
 *
 * The picker therefore works for a user who holds `members.view_directory` but not
 * `members.view`, which is the point of the two permissions being separate.
 */

import { ApiError, api } from '../core/api.js';
import { el, render } from '../core/dom.js';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * @param {object} options
 * @param {(member: {id: string, fullName: string}) => void} options.onSelect
 * @param {string[]} [options.excludeIds]  Already in the household.
 * @param {string} [options.label]
 * @returns {{element: HTMLElement, focus: () => void, reset: () => void}}
 */
export function memberPicker({ onSelect, excludeIds = [], label = 'Find a member' }) {
  const inputId = 'member-picker-input';
  const listId = 'member-picker-results';

  const input = el('input', {
    class: 'form-control',
    id: inputId,
    type: 'search',
    placeholder: 'Name or member number',
    autocomplete: 'off',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
  });

  // A live region: a screen-reader user needs to hear that results arrived.
  const results = el('div', {
    class: 'picker__results',
    id: listId,
    role: 'listbox',
    'aria-live': 'polite',
  });

  let debounce = null;
  let inFlight = null;

  function message(text) {
    render(results, [el('p', { class: 'text-sm text-muted-token picker__message', text })]);
    input.setAttribute('aria-expanded', 'false');
  }

  function show(members) {
    const selectable = members.filter((member) => !excludeIds.includes(member.id));

    if (selectable.length === 0) {
      message(
        members.length === 0
          ? 'No members found.'
          : 'Everyone matching that is already in this household.',
      );
      return;
    }

    render(
      results,
      selectable.map((member) =>
        el(
          'button',
          {
            class: 'picker__option',
            type: 'button',
            role: 'option',
            'aria-selected': 'false',
            onclick: () => {
              onSelect(member);
              reset();
            },
          },
          [
            el('span', { class: 'person__name', text: member.fullName }),
            el('span', { class: 'person__meta mono', text: member.memberNo }),
          ],
        ),
      ),
    );
    input.setAttribute('aria-expanded', 'true');
  }

  async function search(query) {
    const token = {};
    inFlight = token;

    try {
      const payload = await api.get('/members/directory', { query: { search: query } });
      if (inFlight !== token) return;
      show(payload.data);
    } catch (error) {
      if (inFlight !== token) return;
      message(
        error instanceof ApiError && error.status === 403
          ? 'You do not have permission to look up members.'
          : 'Could not search for members.',
      );
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const query = input.value.trim();

    if (query.length < MIN_QUERY_LENGTH) {
      // Below two characters the result set is the whole roll, which is neither
      // useful to read nor kind to the database.
      message(`Type at least ${MIN_QUERY_LENGTH} characters.`);
      return;
    }

    debounce = setTimeout(() => search(query), DEBOUNCE_MS);
  });

  function reset() {
    input.value = '';
    render(results, []);
    input.setAttribute('aria-expanded', 'false');
  }

  const element = el('div', { class: 'picker' }, [
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: inputId, text: label }),
      input,
    ]),
    results,
  ]);

  return { element, focus: () => input.focus(), reset };
}
