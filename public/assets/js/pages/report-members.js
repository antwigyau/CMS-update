/**
 * Member report — the composition of the roll, and (with a joined-date filter)
 * the new-member report the specification lists alongside it. One permission,
 * `reports.members.view`, covers both.
 */

import { mountReport } from './report-common.js';
import { barList, section, statGrid } from '../components/report-viz.js';
import { formatNumber, humanise } from '../core/format.js';

function bars(counts) {
  return Object.entries(counts)
    .map(([key, value]) => ({ label: humanise(key), value, display: formatNumber(value) }))
    .sort((a, b) => b.value - a.value);
}

await mountReport({
  title: 'Member report',
  heading: 'Member report',
  subtitle: 'The composition of the roll. Set a joined date range for the new-member report.',
  summaryPath: '/reports/members/summary',
  exportPath: '/reports/members/export',
  filters: [
    { name: 'joinedFrom', label: 'Joined from', type: 'date' },
    { name: 'joinedTo', label: 'Joined to', type: 'date' },
    {
      name: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: '', label: 'Any status' },
        { value: 'visitor', label: 'Visitor' },
        { value: 'new', label: 'New' },
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
        { value: 'transferred', label: 'Transferred' },
        { value: 'deceased', label: 'Deceased' },
      ],
    },
  ],
  render(summary) {
    return [
      statGrid([
        { label: 'Members', value: formatNumber(summary.count) },
        { label: 'Baptised', value: formatNumber(summary.baptised) },
      ]),
      section('By status', barList({ items: bars(summary.byStatus) })),
      section('By gender', barList({ items: bars(summary.byGender) })),
    ];
  },
});
