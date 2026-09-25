/**
 * Attendance report — sessions and headcount over a date range, broken down by
 * the kind of gathering.
 */

import { mountReport } from './report-common.js';
import { barList, section, statGrid } from '../components/report-viz.js';
import { formatNumber, humanise } from '../core/format.js';

await mountReport({
  title: 'Attendance report',
  heading: 'Attendance report',
  subtitle: 'Headcount is the authoritative total; named records are a subset (decision D5).',
  summaryPath: '/reports/attendance/summary',
  exportPath: '/reports/attendance/export',
  filters: [
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
    {
      name: 'sessionType',
      label: 'Kind',
      type: 'select',
      options: [
        { value: '', label: 'All gatherings' },
        { value: 'service', label: 'Service' },
        { value: 'ministry', label: 'Ministry' },
        { value: 'event', label: 'Event' },
      ],
    },
  ],
  render(summary) {
    const byType = Object.entries(summary.byType)
      .map(([type, bucket]) => ({
        label: humanise(type),
        value: bucket.headcount,
        display: `${formatNumber(bucket.headcount)} over ${formatNumber(bucket.sessions)}`,
      }))
      .sort((a, b) => b.value - a.value);

    return [
      statGrid([
        { label: 'Sessions', value: formatNumber(summary.sessions) },
        { label: 'Total headcount', value: formatNumber(summary.totalHeadcount) },
        { label: 'Average per session', value: formatNumber(summary.averageHeadcount) },
      ]),
      section('Headcount by kind of gathering', barList({ items: byType })),
    ];
  },
});
