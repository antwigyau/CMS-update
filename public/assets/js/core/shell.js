/**
 * The application shell: sidebar, top bar, main region.
 *
 * Rendered once per page by JavaScript rather than copied into every HTML file,
 * so navigation exists in exactly one place. The cost is a brief skeleton on
 * first paint, which is the right trade for an authenticated back-office app.
 *
 * Each navigation item declares the permission required to see it. Phase 1
 * passes `can: () => true` because no permission system exists yet; Phase 4
 * passes the real predicate and the menu filters itself. Hiding a link is
 * cosmetic — the API and RLS are what actually refuse the request.
 */

import { api } from './api.js';
import { el, icon } from './dom.js';
import { initTheme } from './theme.js';

export const NAVIGATION = [
  {
    section: null,
    items: [{ label: 'Dashboard', href: '/dashboard', iconName: 'speedometer2', permission: null }],
  },
  {
    section: 'People',
    items: [
      { label: 'Members', href: '/members', iconName: 'people', permission: 'members.view' },
      {
        label: 'Families',
        href: '/families',
        iconName: 'house-heart',
        permission: 'families.view',
      },
      {
        label: 'Ministries',
        href: '/ministries',
        iconName: 'diagram-3',
        permission: 'ministries.view',
      },
    ],
  },
  {
    section: 'Activity',
    items: [
      {
        label: 'Attendance',
        href: '/attendance',
        iconName: 'calendar-check',
        permission: 'attendance.view',
      },
      { label: 'Events', href: '/events', iconName: 'calendar-event', permission: 'events.view' },
    ],
  },
  {
    section: 'Finance',
    items: [
      {
        label: 'Transactions',
        href: '/finance',
        iconName: 'cash-coin',
        permission: 'finance.view',
      },
      {
        label: 'Approvals',
        href: '/finance/approvals',
        iconName: 'check2-square',
        permission: 'finance.approve',
      },
    ],
  },
  {
    section: 'Insight',
    items: [
      {
        label: 'Reports',
        href: '/reports',
        iconName: 'graph-up',
        // Any one report permission opens the hub; it shows only the reports the
        // caller may actually see.
        anyPermission: [
          'reports.members.view',
          'reports.attendance.view',
          'reports.ministry.view',
          'reports.event.view',
          'reports.finance.view',
        ],
      },
    ],
  },
  {
    section: 'Administration',
    items: [
      { label: 'Users', href: '/admin/users', iconName: 'person-gear', permission: 'users.view' },
      { label: 'Roles', href: '/admin/roles', iconName: 'shield-lock', permission: 'roles.manage' },
      {
        label: 'Announcements',
        href: '/admin/notifications',
        iconName: 'megaphone',
        permission: 'notifications.create',
      },
      {
        label: 'Audit log',
        href: '/admin/audit',
        iconName: 'journal-text',
        permission: 'audit.view',
      },
      {
        label: 'Settings',
        href: '/admin/settings',
        iconName: 'gear',
        permission: 'settings.manage',
      },
    ],
  },
];

function navLink(item, active) {
  return el(
    'a',
    {
      class: 'app-nav__link',
      href: item.href,
      'aria-current': item.href === active ? 'page' : null,
    },
    [icon(item.iconName), el('span', { text: item.label })],
  );
}

function sidebar({ active, can, churchName }) {
  const groups = [];

  for (const group of NAVIGATION) {
    const visible = group.items.filter((item) =>
      item.anyPermission
        ? item.anyPermission.some((permission) => can(permission))
        : item.permission === null || can(item.permission),
    );
    if (visible.length === 0) continue;

    if (group.section) {
      groups.push(el('p', { class: 'app-nav__section', text: group.section }));
    }
    groups.push(...visible.map((item) => navLink(item, active)));
  }

  return el('aside', { class: 'app-sidebar', id: 'app-sidebar', 'data-open': 'false' }, [
    el('div', { class: 'cluster' }, [
      el('a', { class: 'app-brand', href: '/dashboard' }, [
        el('span', { class: 'app-brand__mark' }, [icon('house-heart-fill')]),
        el('span', { text: churchName }),
      ]),
      el(
        'button',
        {
          class: 'btn btn-sm btn-outline-secondary btn-icon app-sidebar__close ms-auto',
          type: 'button',
          'aria-label': 'Close navigation',
          onclick: () => closeSidebar(),
        },
        [icon('x-lg')],
      ),
    ]),
    el('nav', { class: 'app-nav', 'aria-label': 'Main navigation' }, groups),
  ]);
}

function openSidebar() {
  document.getElementById('app-sidebar')?.setAttribute('data-open', 'true');
}

function closeSidebar() {
  document.getElementById('app-sidebar')?.setAttribute('data-open', 'false');
}

/**
 * The unread-notifications bell for the top bar. The count element starts
 * hidden and stays hidden until `renderShell` has fetched a positive count, so
 * a page never briefly shows a stale or zero badge.
 */
function notificationBell() {
  return el(
    'a',
    {
      class: 'app-topbar__bell btn btn-sm btn-outline-secondary btn-icon',
      href: '/notifications',
      'aria-label': 'Notifications',
    },
    [icon('bell'), el('span', { class: 'notif-badge', hidden: true, 'aria-hidden': 'true' })],
  );
}

function topbar({ title, user, onSignOut, can }) {
  const themeToggle = el(
    'button',
    {
      class: 'btn btn-sm btn-outline-secondary btn-icon',
      type: 'button',
    },
    [el('i', { 'data-theme-icon': '', class: 'bi bi-circle-half', 'aria-hidden': 'true' })],
  );

  const bar = el('header', { class: 'app-topbar' }, [
    el(
      'button',
      {
        class: 'btn btn-sm btn-outline-secondary btn-icon app-topbar__menu',
        type: 'button',
        'aria-label': 'Open navigation',
        'aria-controls': 'app-sidebar',
        onclick: () => openSidebar(),
      },
      [icon('list')],
    ),
    el('span', { class: 'text-sm text-secondary-token', text: title ?? '' }),
    el('div', { class: 'app-topbar__spacer' }),
    can('notifications.view') ? notificationBell() : null,
    themeToggle,
    user ? el('span', { class: 'text-sm', text: user.fullName ?? user.email ?? '' }) : null,
    onSignOut
      ? el('button', {
          class: 'btn btn-sm btn-outline-secondary',
          type: 'button',
          text: 'Sign out',
          onclick: onSignOut,
        })
      : null,
  ]);

  initTheme(themeToggle);
  return bar;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.mount     Container element, usually #app.
 * @param {string} [options.active]       href of the current page, for aria-current.
 * @param {string} [options.title]        Context label shown in the top bar.
 * @param {object} [options.user]
 * @param {(permission: string) => boolean} [options.can]
 * @param {() => void} [options.onSignOut]  Omitted => no sign-out button rendered.
 * @param {string} [options.churchName]
 * @returns {{ main: HTMLElement }}  Render page content into `main`.
 */
export function renderShell({
  mount,
  active,
  title,
  user,
  can = () => true,
  onSignOut,
  churchName = 'Church Manager',
}) {
  const main = el('main', { class: 'app-main', id: 'main-content', tabindex: '-1' }, [
    el('div', { class: 'app-main__inner' }),
  ]);

  mount.replaceChildren(
    el('a', { class: 'skip-link', href: '#main-content', text: 'Skip to main content' }),
    el('div', { class: 'app-shell' }, [
      sidebar({ active, can, churchName }),
      topbar({ title, user, onSignOut, can }),
      main,
    ]),
  );
  mount.removeAttribute('aria-busy');

  // Escape closes the mobile drawer — expected keyboard behaviour for an overlay.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });

  // Read the unread count on every page load. This is best-effort chrome: a
  // failure leaves the badge hidden rather than surfacing an error, since the
  // page's own content is what matters.
  if (can('notifications.view')) {
    refreshUnreadBadge(mount);
  }

  return { main: main.firstElementChild };
}

/**
 * Fetch the caller's unread count and reveal the bell badge when it is positive.
 * Swallows failures on purpose — see the call site in `renderShell`.
 */
async function refreshUnreadBadge(root) {
  const badge = root.querySelector('.notif-badge');
  if (!badge) return;
  try {
    const { data } = await api.get('/notifications/unread-count');
    const count = data?.count ?? 0;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch {
    badge.hidden = true;
  }
}

/**
 * Re-read the unread count and update the top-bar badge. Exported so the inbox
 * page can keep the bell honest after marking notifications read, without a
 * full reload. A no-op when the bell is not on the page.
 */
export function refreshNotificationBadge() {
  return refreshUnreadBadge(document);
}
