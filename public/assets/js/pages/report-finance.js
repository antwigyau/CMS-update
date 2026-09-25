/**
 * Finance report — approved income and expense over a date range, with the
 * breakdowns a treasurer's monthly statement needs.
 */

import { mountReport } from './report-common.js';
import { barList, section, statGrid } from '../components/report-viz.js';
import { formatMoney, formatNumber, humanise } from '../core/format.js';

await mountReport({
  title: 'Finance report',
  heading: 'Finance report',
  subtitle: 'Approved income and expense only — the figures that count (decision D3).',
  summaryPath: '/reports/finance/summary',
  exportPath: '/reports/finance/export',
  filters: [
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
    {
      name: 'kind',
      label: 'Type',
      type: 'select',
      options: [
        { value: '', label: 'Income and expense' },
        { value: 'income', label: 'Income only' },
        { value: 'expense', label: 'Expense only' },
      ],
    },
  ],
  render(summary, { currency }) {
    const code = summary.currency ?? currency;

    const incomeTypes = Object.entries(summary.byIncomeType).map(([type, total]) => ({
      label: humanise(type),
      value: total,
      display: formatMoney(total, code),
    }));

    const categories = summary.byCategory.map((row) => ({
      label: `${humanise(row.kind)}: ${row.category}`,
      value: row.total,
      display: formatMoney(row.total, code),
    }));

    return [
      statGrid([
        { label: 'Total income', value: formatMoney(summary.totalIncome, code) },
        { label: 'Total expense', value: formatMoney(summary.totalExpense, code) },
        { label: 'Net', value: formatMoney(summary.net, code) },
        { label: 'Transactions', value: formatNumber(summary.count) },
      ]),
      section('Income by type', barList({ items: incomeTypes })),
      section('By category', barList({ items: categories })),
    ];
  },
});
