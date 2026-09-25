/**
 * A month calendar.
 *
 * Built as a real table-free grid rather than a `<table>`: a month view is a
 * layout, not tabular data, and a screen reader gets far more from a list of dated
 * links than from a seven-column grid whose cells are mostly empty. So the grid is
 * `aria-hidden` on small screens and the list view is offered instead — the toggle
 * in events-list.js is the accessible path, not a lesser one.
 *
 * Weeks start on Monday, matching the ISO weekday numbers the ministries module
 * already uses.
 */

import { el, icon } from '../core/dom.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday, 1 = Monday. `Date#getDay` gives 0 = Sunday. */
function isoWeekday(date) {
  return date.getDay() === 0 ? 7 : date.getDay();
}

function toKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * The grid of dates to render: the target month, padded to whole weeks.
 *
 * Padding days belong to the neighbouring months and are marked as such, because a
 * calendar that starts mid-row is harder to scan than one with quiet edges.
 */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - (isoWeekday(first) - 1));

  const days = [];
  const cursor = new Date(start);

  // Six weeks covers every possible month layout, including a 31-day month
  // beginning on a Sunday.
  for (let index = 0; index < 42; index += 1) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // Trim a trailing week that belongs entirely to the next month.
  const lastWeek = days.slice(35);
  return lastWeek.every((day) => day.getMonth() !== month) ? days.slice(0, 35) : days;
}

/**
 * @param {object} options
 * @param {number} options.year
 * @param {number} options.month              0-indexed, as `Date` uses.
 * @param {object[]} options.events           Events with `startsAt`.
 * @param {(event: object) => string} options.href
 */
export function monthCalendar({ year, month, events, href }) {
  /** Events bucketed by local date, since that is how a calendar reads them. */
  const byDate = new Map();
  for (const event of events) {
    const start = new Date(event.startsAt);
    if (Number.isNaN(start.getTime())) continue;

    const key = toKey(start);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(event);
  }

  const todayKey = toKey(new Date());

  const cells = monthGrid(year, month).map((date) => {
    const key = toKey(date);
    const outside = date.getMonth() !== month;
    const dayEvents = byDate.get(key) ?? [];

    const classes = ['calendar__day'];
    if (outside) classes.push('calendar__day--outside');
    if (key === todayKey) classes.push('calendar__day--today');

    return el('div', { class: classes.join(' ') }, [
      el('span', { class: 'calendar__date', text: String(date.getDate()) }),
      ...dayEvents.map((event) =>
        el('a', {
          class: [
            'calendar__event',
            event.status === 'draft' ? 'calendar__event--draft' : '',
            event.status === 'cancelled' ? 'calendar__event--cancelled' : '',
          ]
            .filter(Boolean)
            .join(' '),
          href: href(event),
          title: `${event.title}${event.venue ? ` · ${event.venue}` : ''}`,
          text: event.title,
        }),
      ),
    ]);
  });

  return el('div', {}, [
    // Hidden from assistive technology: the list view carries the same events in a
    // form that reads sensibly. See the note at the top of this file.
    el('div', { class: 'calendar', 'aria-hidden': 'true' }, [
      ...WEEKDAYS.map((day) => el('div', { class: 'calendar__weekday', text: day })),
      ...cells,
    ]),
    el('p', { class: 'calendar-fallback' }, [
      icon('info-circle'),
      ' The calendar needs a wider screen. Switch to the list view to see these events.',
    ]),
  ]);
}

export function monthLabel(year, month) {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1),
  );
}

/** First and last instant of a month, as ISO strings, for the API's date window. */
export function monthWindow(year, month) {
  return {
    from: new Date(year, month, 1).toISOString(),
    // Day 0 of the next month is the last day of this one.
    to: new Date(year, month + 1, 0, 23, 59, 59).toISOString(),
  };
}
