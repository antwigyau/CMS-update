/**
 * CSV serialisation, RFC 4180 with one deliberate addition.
 *
 * The addition is formula-injection defence. A spreadsheet treats a cell that
 * begins with `=`, `+`, `-`, `@`, or a tab/carriage return as a formula, so an
 * attacker who gets a string like `=HYPERLINK(...)` into a member name has, in
 * effect, stored a payload that runs when a treasurer opens the export. We
 * neutralise it by prefixing such a field with a single quote — the value the
 * reader sees is unchanged, but the spreadsheet treats it as text (OWASP's
 * recommended mitigation). This matters here precisely because every report is a
 * file a human downloads and opens in Excel or Sheets.
 */

const NEEDS_QUOTING = /[",\r\n]/;
const LEADS_A_FORMULA = /^[=+\-@\t\r]/;

function serialiseField(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (LEADS_A_FORMULA.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * Turn rows into a CSV string.
 *
 * @param {object[]} rows
 * @param {{ header: string, value: (row: object) => unknown }[]} columns
 * @returns {string}  Always ends with CRLF; a header-only string when empty.
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((column) => serialiseField(column.header)).join(',')];

  for (const row of rows) {
    lines.push(columns.map((column) => serialiseField(column.value(row))).join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}
