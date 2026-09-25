import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCsv } from '../../src/lib/csv.js';

const columns = [
  { header: 'Name', value: (row) => row.name },
  { header: 'Amount', value: (row) => row.amount },
];

describe('toCsv', () => {
  it('writes a header even when there are no rows', () => {
    assert.equal(toCsv([], columns), 'Name,Amount\r\n');
  });

  it('joins fields with commas and rows with CRLF, ending in CRLF', () => {
    const csv = toCsv([{ name: 'Ama', amount: '100.00' }], columns);
    assert.equal(csv, 'Name,Amount\r\nAma,100.00\r\n');
  });

  it('quotes a field containing a comma, quote, or newline', () => {
    const csv = toCsv([{ name: 'Mensah, Ama', amount: 'say "hi"' }], columns);
    assert.equal(csv, 'Name,Amount\r\n"Mensah, Ama","say ""hi"""\r\n');
  });

  it('quotes a field containing a newline rather than breaking the row', () => {
    const csv = toCsv([{ name: 'line1\nline2', amount: '1' }], columns);
    assert.equal(csv, 'Name,Amount\r\n"line1\nline2",1\r\n');
  });

  it('renders null and undefined as empty fields', () => {
    const csv = toCsv([{ name: null, amount: undefined }], columns);
    assert.equal(csv, 'Name,Amount\r\n,\r\n');
  });

  it('neutralises a leading =, +, -, or @ so a spreadsheet will not run it', () => {
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      const csv = toCsv([{ name: dangerous, amount: '0' }], columns);
      // Prefixed with a quote; because the quote does not itself need CSV quoting
      // here, the field is emitted bare (still text to a spreadsheet).
      assert.ok(csv.includes(`'${dangerous},0`), `${dangerous} should be neutralised`);
    }
  });

  it('neutralises a formula that also needs quoting', () => {
    const csv = toCsv([{ name: '=1,2', amount: '0' }], columns);
    assert.equal(csv, `Name,Amount\r\n"'=1,2",0\r\n`);
  });
});
