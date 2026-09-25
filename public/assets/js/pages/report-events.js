/**
 * Event report — events by status and their registration counts over a date
 * range (on the event's start).
 */

import { mountReport } from './report-common.js';
import { barList, section, statGrid } from '../components/report-viz.js';
import { formatNumber, humanise } from '../core/format.js';

await mountReport({
  title: 'Event report',
  heading: 'Event report',
  subtitle: 'Events and sign-ups over a date range.',
  summaryPath: '/reports/events/summary',
  exportPath: '/reports/events/export',
  filters: [
    { name: 'from', label: 'From', type: 'date' },
    { name: 'to', label: 'To', type: 'date' },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: '', label: 'Any status' },
        { value: 'draft', label: 'Draft' },
        { value: 'published', label: 'Published' },
        { value: 'ongoing', label: 'Ongoing' },
        { value: 'completed', label: 'Completed' },
        { value: 'cancelled', label: 'Cancelled' },
      ],
    },
  ],
  render(summary) {
    const byStatus = Object.entries(summary.byStatus)
      .map(([status, value]) => ({ label: humanise(status), value, display: formatNumber(value) }))
      .sort((a, b) => b.value - a.value);

    return [
      statGrid([
        { label: 'Events', value: formatNumber(summary.count) },
        { label: 'Registrations', value: formatNumber(summary.totalRegistrations) },
      ]),
      section('Events by status', barList({ items: byStatus })),
    ];
  },
});
