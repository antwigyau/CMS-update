/**
 * Announcements admin — the publisher console.
 *
 * Everything published, most recent first, in one request. The server paginates
 * this endpoint; the console shows the first (newest) page, which is what a
 * publisher reaches for. Composing and retracting live on the linked pages — the
 * API and RLS gate both regardless of what renders here.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatDateTime, humanise } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

/** severity -> pill colour, matching the inbox. */
const SEVERITY_VARIANT = Object.freeze({
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
});

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/notifications',
    title: 'Announcements',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  const resultsRegion = el('div', { id: 'announcements-results' });

  /* ---- table ------------------------------------------------------------ */

  function row(notification) {
    return el('tr', {}, [
      el('td', {}, [
        el('a', {
          class: 'person__name',
          href: `/admin/notifications/detail?id=${encodeURIComponent(notification.id)}`,
          text: notification.title,
        }),
      ]),
      el('td', { class: 'text-sm', text: humanise(notification.type) }),
      el('td', {}, [
        el('span', {
          class: `pill pill--${SEVERITY_VARIANT[notification.severity] ?? 'neutral'}`,
          text: humanise(notification.severity),
        }),
      ]),
      el('td', { class: 'text-sm', text: humanise(notification.audience) }),
      el('td', { class: 'text-sm', text: formatDateTime(notification.publishedAt) }),
      el('td', { class: 'text-sm', text: String(notification.recipientCount) }),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Title' }),
            el('th', { scope: 'col', text: 'Type' }),
            el('th', { scope: 'col', text: 'Severity' }),
            el('th', { scope: 'col', text: 'Audience' }),
            el('th', { scope: 'col', text: 'Published' }),
            el('th', { scope: 'col', text: 'Recipients' }),
          ]),
        ]),
        el('tbody', {}, rows.map(row)),
      ]),
    ]);
  }

  function skeletonTable() {
    return el('div', { class: 'card-surface__body' }, [
      el('div', { class: 'skeleton skeleton--title' }),
      el(
        'div',
        { 'aria-hidden': 'true' },
        Array.from({ length: 5 }, () => el('div', { class: 'skeleton skeleton--text' })),
      ),
    ]);
  }

  /* ---- loading ---------------------------------------------------------- */

  async function load() {
    render(resultsRegion, [skeletonTable()]);
    resultsRegion.setAttribute('aria-busy', 'true');

    try {
      const payload = await api.get('/admin/notifications');
      const rows = payload.data;

      render(resultsRegion, [
        rows.length === 0
          ? stateBlock({
              iconName: 'megaphone',
              title: 'No announcements yet',
              message: 'Publish an announcement to reach your members.',
              action: el('a', {
                class: 'btn btn-primary',
                href: '/admin/notifications/new',
                text: 'New announcement',
              }),
            })
          : table(rows),
      ]);
    } catch (error) {
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load announcements',
          message:
            error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Try again',
            onclick: load,
          }),
        }),
      ]);
    } finally {
      resultsRegion.removeAttribute('aria-busy');
    }
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Announcements' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Publish an in-app announcement to everyone, a role, or a branch.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [
        el('a', { class: 'btn btn-primary', href: '/admin/notifications/new' }, [
          icon('plus-lg'),
          ' New announcement',
        ]),
      ]),
    ]),
    el('section', { class: 'card-surface' }, [resultsRegion]),
  ]);

  await load();
}
