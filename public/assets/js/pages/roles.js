/**
 * Roles admin — the role roster.
 *
 * The set is small and fixed, so there is no search, sort, or pagination: the
 * whole list is one request. Every control is a convenience; the API and RLS
 * refuse a write regardless of what this page renders.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/roles',
    title: 'Roles',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  const resultsRegion = el('div', { id: 'roles-results' });

  /* ---- table ------------------------------------------------------------ */

  function row(role) {
    return el('tr', {}, [
      el('td', {}, [
        el('a', {
          class: 'person__name',
          href: `/admin/roles/detail?id=${encodeURIComponent(role.id)}`,
          text: role.name,
        }),
      ]),
      el('td', {}, [el('code', { class: 'text-sm', text: role.key })]),
      el('td', {}, [
        el('span', {
          class: `pill pill--${role.isSystem ? 'brand' : 'neutral'}`,
          text: role.isSystem ? 'System' : 'Custom',
        }),
      ]),
      el('td', { class: 'text-sm', text: String(role.permissionCount) }),
      el('td', { class: 'text-sm', text: String(role.grantCount) }),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Name' }),
            el('th', { scope: 'col', text: 'Key' }),
            el('th', { scope: 'col', text: 'Type' }),
            el('th', { scope: 'col', text: 'Permissions' }),
            el('th', { scope: 'col', text: 'Users' }),
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
      const payload = await api.get('/admin/roles');
      const roles = payload.data;

      render(resultsRegion, [
        roles.length === 0
          ? stateBlock({
              iconName: 'shield-lock',
              title: 'No roles yet',
              message: 'Create a role to start bundling permissions.',
              action: el('a', {
                class: 'btn btn-primary',
                href: '/admin/roles/new',
                text: 'New role',
              }),
            })
          : table(roles),
      ]);
    } catch (error) {
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load roles',
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
        el('h1', { class: 'page-header__title', text: 'Roles' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'A role is a named bundle of permissions; grant one to give someone that access.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [
        el('a', { class: 'btn btn-primary', href: '/admin/roles/new' }, [
          icon('plus-lg'),
          ' New role',
        ]),
      ]),
    ]),
    el('section', { class: 'card-surface' }, [resultsRegion]),
  ]);

  await load();
}
