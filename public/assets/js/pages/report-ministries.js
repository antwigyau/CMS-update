/**
 * Ministry report — active membership across the ministries the caller can see.
 * A ministry with no active members simply does not appear.
 */

import { mountReport } from './report-common.js';
import { barList, section, statGrid } from '../components/report-viz.js';
import { formatNumber } from '../core/format.js';

await mountReport({
  title: 'Ministry report',
  heading: 'Ministry report',
  subtitle: 'Who is currently serving, by ministry.',
  summaryPath: '/reports/ministries/summary',
  exportPath: '/reports/ministries/export',
  render(summary) {
    const perMinistry = summary.perMinistry.map((row) => ({
      label: row.ministry,
      value: row.members,
      display: formatNumber(row.members),
    }));

    return [
      statGrid([
        { label: 'Ministries', value: formatNumber(summary.ministries) },
        { label: 'Active memberships', value: formatNumber(summary.totalMemberships) },
      ]),
      section('Active members by ministry', barList({ items: perMinistry })),
    ];
  },
});
