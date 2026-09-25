/**
 * Pagination control.
 *
 * Announces itself as a navigation landmark, marks the current page with
 * `aria-current`, and puts the "showing 26–50 of 312" summary in a live region so
 * a screen-reader user learns the result of pressing Next.
 *
 * Page numbers are elided around the current page rather than all rendered: 24
 * pages is a reasonable list, 400 is not.
 */

import { el, icon } from '../core/dom.js';

const WINDOW = 2;

/** Page numbers to show, with nulls marking gaps. */
function pageWindow(page, pageCount) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set([1, pageCount, page]);
  for (let offset = 1; offset <= WINDOW; offset += 1) {
    if (page - offset > 1) pages.add(page - offset);
    if (page + offset < pageCount) pages.add(page + offset);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const withGaps = [];
  let previous = 0;

  for (const value of sorted) {
    if (value - previous > 1) withGaps.push(null);
    withGaps.push(value);
    previous = value;
  }
  return withGaps;
}

/**
 * @param {object} options
 * @param {object} options.meta       The `meta` block from a paginated response.
 * @param {(page: number) => void} options.onChange
 * @param {string} [options.label]    Plural noun for the summary, e.g. 'members'.
 */
export function paginationControl({ meta, onChange, label = 'results' }) {
  const { page, pageSize, total, pageCount, hasPrevious, hasNext } = meta;

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = total === null ? null : Math.min(page * pageSize, total);

  const summary =
    total === null
      ? `Page ${page}`
      : total === 0
        ? `No ${label}`
        : `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${label}`;

  function step(direction, iconName, text, enabled) {
    return el(
      'button',
      {
        class: 'btn btn-sm btn-outline-secondary',
        type: 'button',
        disabled: !enabled,
        'aria-label': text,
        onclick: () => onChange(page + direction),
      },
      direction < 0 ? [icon(iconName), text] : [text, icon(iconName)],
    );
  }

  const numbers =
    pageCount === null
      ? []
      : pageWindow(page, pageCount).map((value) =>
          value === null
            ? el('span', { class: 'text-muted-token text-sm', text: '…', 'aria-hidden': 'true' })
            : el('button', {
                class: `btn btn-sm ${value === page ? 'btn-primary' : 'btn-outline-secondary'}`,
                type: 'button',
                'aria-label': `Page ${value}`,
                'aria-current': value === page ? 'page' : null,
                text: String(value),
                onclick: () => onChange(value),
              }),
        );

  return el('nav', { class: 'pager', 'aria-label': 'Pagination' }, [
    el('p', { class: 'pager__summary text-sm text-muted-token', role: 'status', text: summary }),
    el('div', { class: 'pager__controls' }, [
      step(-1, 'chevron-left', 'Previous', hasPrevious),
      ...numbers,
      step(1, 'chevron-right', 'Next', hasNext !== false),
    ]),
  ]);
}
