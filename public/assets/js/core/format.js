/**
 * Display formatting.
 *
 * Dates arrive from PostgreSQL as `YYYY-MM-DD` (a plain date, no timezone) or as
 * an ISO timestamp. The two need different handling: `new Date('1990-04-12')` is
 * parsed as UTC midnight, which renders as 11 April in any negative offset. So a
 * plain date is formatted from its parts and never passed through a timezone.
 */

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A plain `YYYY-MM-DD`, formatted without ever crossing a timezone. */
export function formatDate(value, fallback = '—') {
  if (!value) return fallback;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return fallback;

  const [, year, month, day] = match;
  // Construct in UTC and format in UTC: the parts go in and come out unchanged.
  return dateFormatter.format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

/** A timestamptz, which genuinely should be shown in the reader's own timezone. */
export function formatDateTime(value, fallback = '—') {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : dateTimeFormatter.format(parsed);
}

/** Whole years, using UTC parts so the answer does not shift with the timezone. */
export function formatAge(dateOfBirth) {
  if (!dateOfBirth) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth);
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const today = new Date();
  let age = today.getUTCFullYear() - year;

  const beforeBirthday =
    today.getUTCMonth() + 1 < month ||
    (today.getUTCMonth() + 1 === month && today.getUTCDate() < day);
  if (beforeBirthday) age -= 1;

  return age >= 0 && age < 130 ? age : null;
}

/** Sentence case for an enum value: 'pending_approval' -> 'Pending approval'. */
export function humanise(value, fallback = '—') {
  if (!value) return fallback;
  const spaced = String(value).replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Which pill colour a membership status should wear. */
export const MEMBERSHIP_STATUS_VARIANT = Object.freeze({
  active: 'success',
  new: 'brand',
  visitor: 'neutral',
  inactive: 'warning',
  transferred: 'neutral',
  deceased: 'neutral',
});

export function formatCount(count, singular, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** A plain integer with thousands separators, for a stat tile. */
export function formatNumber(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : fallback;
}

/** ISO-8601 weekday number (1 = Monday … 7 = Sunday) to a name. */
const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function formatWeekday(value, fallback = '—') {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1 || index > 7) return fallback;
  return WEEKDAY_NAMES[index - 1];
}

/**
 * A meeting time as `HH:MM`, formatted for the reader.
 *
 * Deliberately NOT passed through a Date: a meeting time is a wall-clock time in
 * the branch's own timezone, not an instant. Constructing a Date would apply the
 * reader's offset and show a Thursday 18:30 rehearsal as 13:30 somewhere else.
 */
export function formatTime(value, fallback = '—') {
  if (!value) return fallback;
  const match = /^(\d{2}):(\d{2})/.exec(String(value));
  if (!match) return fallback;

  const [, hours, minutes] = match;
  return `${hours}:${minutes}`;
}

/** "Thursdays at 18:30", or as much of it as is known. */
export function formatMeetingSchedule(meetingDay, meetingTime) {
  const day = formatWeekday(meetingDay, null);
  const time = formatTime(meetingTime, null);

  if (day && time) return `${day}s at ${time}`;
  if (day) return `${day}s`;
  if (time) return `at ${time}`;
  return 'No regular meeting recorded';
}

/**
 * An event's start and end, in the reader's own timezone.
 *
 * Unlike a ministry's meeting time, an event happens at an *instant* — so this one
 * deliberately does go through a Date and does apply the reader's offset.
 */
const timeOnlyFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

export function formatEventWhen(startsAt, endsAt) {
  if (!startsAt) return '—';

  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return '—';

  const startText = dateTimeFormatter.format(start);
  if (!endsAt) return startText;

  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return startText;

  // Same day: show the end as a time only, which is how people read a schedule.
  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${startText} – ${timeOnlyFormatter.format(end)}`
    : `${startText} – ${dateTimeFormatter.format(end)}`;
}

/** Which pill colour an event status should wear. */
export const EVENT_STATUS_VARIANT = Object.freeze({
  draft: 'neutral',
  published: 'brand',
  ongoing: 'success',
  completed: 'neutral',
  cancelled: 'danger',
});

export const REGISTRATION_STATUS_VARIANT = Object.freeze({
  registered: 'success',
  cancelled: 'neutral',
  no_show: 'warning',
});

/** Which pill colour a transaction status should wear. */
export const TRANSACTION_STATUS_VARIANT = Object.freeze({
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  rejected: 'danger',
  void: 'neutral',
});

/**
 * Money, in the church's configured currency.
 *
 * The formatter is built per currency code and cached, because constructing an
 * `Intl.NumberFormat` is not free. A missing or malformed currency degrades to a
 * plain number rather than throwing — a mis-seeded currency should not blank the
 * whole ledger.
 */
const moneyFormatters = new Map();

export function formatMoney(amount, currency, fallback = '—') {
  if (amount === null || amount === undefined || amount === '') return fallback;
  const value = Number(amount);
  if (Number.isNaN(value)) return fallback;

  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (/^[A-Z]{3}$/.test(code)) {
    let formatter = moneyFormatters.get(code);
    if (!formatter) {
      try {
        formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
      } catch {
        formatter = null;
      }
      moneyFormatters.set(code, formatter);
    }
    if (formatter) return formatter.format(value);
  }

  // No usable currency: show the number with two places, and the code if we have
  // one, so the amount is still legible.
  const plain = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return code ? `${plain} ${code}` : plain;
}
