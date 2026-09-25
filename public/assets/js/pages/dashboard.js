/**
 * Dashboard.
 *
 * Role-specific by construction: a widget appears only when the caller holds the
 * report permission it draws from, and every figure it shows comes from the same
 * summary endpoint the full report uses — so the dashboard can never surface a
 * number the role could not reach on its own. The widgets fetch independently and
 * degrade to "unavailable" one at a time, so one slow query does not blank the
 * page (ADR-057).
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render } from '../core/dom.js';
import { formatMoney, formatNumber } from '../core/format.js';
import { can, currency, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

const WIDGETS = [
  {
    permission: 'reports.finance.view',
    href: '/reports/finance',
    title: 'Finance',
    iconName: 'cash-coin',
    summaryPath: '/reports/finance/summary',
    stats: (data) => {
      const code = data.currency ?? currency();
      return [
        { label: 'Net (approved)', value: formatMoney(data.net, code) },
        { label: 'Transactions', value: formatNumber(data.count) },
      ];
    },
  },
  {
    permission: 'reports.members.view',
    href: '/reports/members',
    title: 'Members',
    iconName: 'people',
    summaryPath: '/reports/members/summary',
    stats: (data) => [
      { label: 'Members', value: formatNumber(data.count) },
      { label: 'Baptised', value: formatNumber(data.baptised) },
    ],
  },
  {
    permission: 'reports.attendance.view',
    href: '/reports/attendance',
    title: 'Attendance',
    iconName: 'calendar-check',
    summaryPath: '/reports/attendance/summary',
    stats: (data) => [
      { label: 'Sessions', value: formatNumber(data.sessions) },
      { label: 'Headcount', value: formatNumber(data.totalHeadcount) },
    ],
  },
  {
    permission: 'reports.ministry.view',
    href: '/reports/ministries',
    title: 'Ministries',
    iconName: 'diagram-3',
    summaryPath: '/reports/ministries/summary',
    stats: (data) => [
      { label: 'Ministries', value: formatNumber(data.ministries) },
      { label: 'Active members', value: formatNumber(data.totalMemberships) },
    ],
  },
  {
    permission: 'reports.event.view',
    href: '/reports/events',
    title: 'Events',
    iconName: 'calendar-event',
    summaryPath: '/reports/events/summary',
    stats: (data) => [
      { label: 'Events', value: formatNumber(data.count) },
      { label: 'Registrations', value: formatNumber(data.totalRegistrations) },
    ],
  },
];

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/dashboard',
    title: 'Dashboard',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const firstName = (session.user.fullName ?? '').split(' ')[0] || 'there';
  const widgets = WIDGETS.filter((widget) => can(widget.permission));

  function statLine(stats) {
    return el(
      'dl',
      { class: 'stack-2' },
      stats.flatMap((stat) => [
        el('dt', { class: 'text-xs text-muted-token', text: stat.label }),
        el('dd', { class: 'text-lg', text: stat.value }),
      ]),
    );
  }

  function widgetCard(widget) {
    const body = el('div', { class: 'card-surface__body' }, [
      el('div', { 'aria-hidden': 'true' }, [el('div', { class: 'skeleton skeleton--title' })]),
    ]);

    const card = el('a', { class: 'card-surface card-link', href: widget.href }, [
      el('div', { class: 'card-surface__header' }, [
        el('span', { class: 'card-link__icon' }, [icon(widget.iconName)]),
        el('h2', { class: 'card-surface__title', text: widget.title }),
      ]),
      body,
    ]);

    api
      .get(widget.summaryPath)
      .then((payload) => render(body, [statLine(widget.stats(payload.data))]))
      .catch((error) => {
        const message =
          error instanceof ApiError && error.status !== 500
            ? error.message
            : 'Summary unavailable right now.';
        render(body, [el('p', { class: 'text-sm text-muted-token', text: message })]);
      });

    return card;
  }

  const accountCard = el('section', { class: 'card-surface' }, [
    el('div', { class: 'card-surface__header' }, [
      el('h2', { class: 'card-surface__title', text: 'Your account' }),
    ]),
    el('div', { class: 'card-surface__body' }, [
      el('dl', { class: 'stack-2' }, [
        el('dt', { class: 'text-xs text-muted-token', text: 'Name' }),
        el('dd', { text: session.user.fullName ?? '—' }),
        el('dt', { class: 'text-xs text-muted-token', text: 'Email' }),
        el('dd', { text: session.user.email ?? '—' }),
        el('dt', { class: 'text-xs text-muted-token', text: 'Permissions' }),
        el('dd', { text: formatNumber(session.permissions.length) }),
      ]),
    ]),
  ]);

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: `Welcome, ${firstName}` }),
        el('p', {
          class: 'page-header__subtitle',
          text:
            widgets.length > 0
              ? 'A snapshot of what you can see. Open a card for the full report.'
              : 'Signed in. Your reports will appear here as access is granted.',
        }),
      ]),
    ]),

    widgets.length > 0
      ? el('div', { class: 'grid-auto gap-below-5' }, widgets.map(widgetCard))
      : null,

    accountCard,
  ]);
}
