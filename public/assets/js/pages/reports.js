/**
 * The reports hub: a card per report, showing only the ones the caller may open.
 *
 * The gating is a courtesy — each linked report calls an endpoint that checks the
 * same permission and RLS underneath — but it means a finance officer sees the
 * finance report alone, and a pastor sees the whole set, without either being
 * shown a door that leads to a 403.
 */

import { el, icon, render } from '../core/dom.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

const REPORTS = [
  {
    href: '/reports/finance',
    iconName: 'cash-coin',
    title: 'Finance',
    description: 'Approved income and expense, with breakdowns by type and category.',
    permission: 'reports.finance.view',
  },
  {
    href: '/reports/members',
    iconName: 'people',
    title: 'Members',
    description: 'Roll composition by status and gender, and new members by join date.',
    permission: 'reports.members.view',
  },
  {
    href: '/reports/attendance',
    iconName: 'calendar-check',
    title: 'Attendance',
    description: 'Sessions and headcount over a date range, by kind of gathering.',
    permission: 'reports.attendance.view',
  },
  {
    href: '/reports/ministries',
    iconName: 'diagram-3',
    title: 'Ministries',
    description: 'Active membership across the ministries you can see.',
    permission: 'reports.ministry.view',
  },
  {
    href: '/reports/events',
    iconName: 'calendar-event',
    title: 'Events',
    description: 'Events by status and their registration counts.',
    permission: 'reports.event.view',
  },
];

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/reports',
    title: 'Reports',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const visible = REPORTS.filter((report) => can(report.permission));

  function card(report) {
    return el('a', { class: 'card-surface card-link', href: report.href }, [
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'card-link__icon' }, [icon(report.iconName)]),
        el('h2', { class: 'card-surface__title', text: report.title }),
        el('p', { class: 'text-sm text-muted-token', text: report.description }),
      ]),
    ]);
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Reports' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Filtered, dated summaries — each one downloadable as a CSV.',
        }),
      ]),
    ]),
    visible.length === 0
      ? el('section', { class: 'card-surface' }, [
          el('div', { class: 'card-surface__body' }, [
            el('p', {
              class: 'text-sm text-muted-token',
              text: 'You do not have access to any reports yet. An administrator grants these.',
            }),
          ]),
        ])
      : el('div', { class: 'grid-auto gap-below-5' }, visible.map(card)),
  ]);
}
