/**
 * The pieces every report page is built from: stat tiles, proportion bars, and a
 * CSV download button.
 *
 * The bars are `<meter>` elements, not styled `<div>`s. That is a deliberate
 * consequence of the strict CSP (ADR-006): an inline `style="width:62%"` is
 * blocked, and `<meter value max>` gives a proportion bar from attributes alone —
 * which is also natively accessible, announcing "62%" without any ARIA of ours.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon } from '../core/dom.js';

/** A titled block within a report. */
export function section(title, body) {
  return el('section', { class: 'report-section' }, [
    el('h2', { class: 'report-section__title', text: title }),
    body,
  ]);
}

/** A row of headline numbers. `stats` is `[{ label, value, hint? }]`. */
export function statGrid(stats) {
  return el(
    'div',
    { class: 'stat-grid' },
    stats.map((stat) =>
      el('div', { class: 'stat-tile' }, [
        el('div', { class: 'stat-tile__value', text: stat.value }),
        el('div', { class: 'stat-tile__label', text: stat.label }),
        stat.hint ? el('div', { class: 'stat-tile__hint', text: stat.hint }) : null,
      ]),
    ),
  );
}

/**
 * A list of labelled proportion bars.
 *
 * @param {object} options
 * @param {{ label: string, value: number, display: string }[]} options.items
 * @param {number} [options.max]  Bar scale; defaults to the largest value.
 */
export function barList({ items, max }) {
  if (items.length === 0) {
    return el('p', { class: 'text-sm text-muted-token', text: 'Nothing to show for this range.' });
  }

  const ceiling = max ?? Math.max(...items.map((item) => item.value), 1);

  return el(
    'div',
    { class: 'report-bars' },
    items.map((item) =>
      el('div', { class: 'report-bar' }, [
        el('span', { class: 'report-bar__label', text: item.label }),
        el('meter', {
          class: 'report-bar__meter',
          value: String(item.value),
          min: '0',
          max: String(ceiling),
          'aria-label': `${item.label}: ${item.display}`,
        }),
        el('span', { class: 'report-bar__value', text: item.display }),
      ]),
    ),
  );
}

/**
 * A button that downloads a report as CSV.
 *
 * It manages its own busy state and, on failure, shows the server's message
 * inline (a "narrow your filters" 409 is the one a caller will actually hit) so a
 * failed export never silently saves a file of error JSON. `query` is read lazily
 * so the button always exports the filters currently on screen.
 */
export function csvButton({ path, query = () => ({}), label = 'Download CSV' }) {
  const status = el('span', { class: 'text-sm text-danger-token', role: 'alert' });

  const button = el('button', { class: 'btn btn-outline-secondary', type: 'button' }, [
    icon('download'),
    ` ${label}`,
  ]);

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const { blob, filename } = await api.download(path, { query: query() });
      const url = URL.createObjectURL(blob);
      // Not el(): a blob: URL is rejected by el()'s href allow-list on purpose,
      // and this anchor carries no user content — it is a save trigger.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      status.textContent =
        error instanceof ApiError
          ? error.message
          : 'Could not download the report. Please try again.';
    } finally {
      button.disabled = false;
    }
  });

  return el('div', { class: 'cluster' }, [button, status]);
}
