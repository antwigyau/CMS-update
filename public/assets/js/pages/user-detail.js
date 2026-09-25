/**
 * User detail — one account, with the controls a permission unlocks.
 *
 * The capability flags in the payload — canUpdate, canDeactivate, canManageRoles —
 * decide which controls to render, but they are only a mirror. The API and its
 * escalation triggers refuse a write regardless of what this page shows, including
 * the self-service rules a user can never talk their way past: you cannot
 * deactivate your own account, and you cannot change your own role grants.
 *
 * There is no delete. An account with history is deactivated, not removed.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatDateTime } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const userId = new URLSearchParams(location.search).get('id');

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/users',
    title: 'User',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  // The detail view plus its capability flags; the role catalogue for the grant form.
  let user = null;
  let roles = [];

  const titleEl = el('h1', { class: 'page-header__title' });
  const statusLine = el('p', { class: 'page-header__subtitle' });
  const headerActions = el('div', { class: 'page-header__actions' });
  const profileRegion = el('div');
  const rolesRegion = el('div');

  /* ---- header: status + activation -------------------------------------- */

  function renderTitle() {
    titleEl.textContent = user.fullName;
  }

  function renderStatusLine() {
    render(statusLine, [
      el('span', {
        class: `pill pill--${user.isActive ? 'success' : 'neutral'}`,
        text: user.isActive ? 'Active' : 'Deactivated',
      }),
      ` · Last signed in ${formatDateTime(user.lastLoginAt)}`,
    ]);
  }

  async function toggleActive(button) {
    button.disabled = true;
    try {
      const payload = await api.post(`/admin/users/${encodeURIComponent(user.id)}/active`, {
        isActive: !user.isActive,
      });
      user = { ...user, ...payload.data };
      notify.success(user.isActive ? 'Account activated.' : 'Account deactivated.');
      renderStatusLine();
      renderHeaderActions();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not change activation.');
      button.disabled = false;
    }
  }

  function renderHeaderActions() {
    if (!user.canDeactivate) {
      render(headerActions, []);
      return;
    }
    const button = el('button', {
      class: `btn ${user.isActive ? 'btn-outline-danger' : 'btn-primary'}`,
      type: 'button',
      text: user.isActive ? 'Deactivate' : 'Activate',
    });
    button.addEventListener('click', () => toggleActive(button));
    render(headerActions, [button]);
  }

  /* ---- profile ---------------------------------------------------------- */

  function readOnlyProfile() {
    return el('dl', { class: 'detail-list' }, [
      el('div', {}, [
        el('dt', { class: 'detail-list__term', text: 'Full name' }),
        el('dd', { class: 'detail-list__value', text: user.fullName }),
      ]),
      el('div', {}, [
        el('dt', { class: 'detail-list__term', text: 'Phone' }),
        el('dd', { class: 'detail-list__value', text: user.phone ?? '—' }),
      ]),
    ]);
  }

  function profileForm() {
    const fullNameInput = el('input', {
      class: 'form-control',
      id: 'profile-fullName',
      type: 'text',
      value: user.fullName ?? '',
      autocomplete: 'off',
    });
    const phoneInput = el('input', {
      class: 'form-control',
      id: 'profile-phone',
      type: 'tel',
      value: user.phone ?? '',
      autocomplete: 'off',
    });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save changes' });

    const form = el('form', {}, [
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'profile-fullName', text: 'Full name' }),
          fullNameInput,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'profile-phone', text: 'Phone' }),
          phoneInput,
        ]),
      ]),
      el('div', { class: 'form-actions' }, [save]),
    ]);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveProfile({ fullNameInput, phoneInput, save });
    });
    return form;
  }

  async function saveProfile({ fullNameInput, phoneInput, save }) {
    const patch = {};
    const fullName = fullNameInput.value.trim();
    const phone = phoneInput.value.trim();

    if (fullName !== (user.fullName ?? '')) {
      if (fullName.length < 2) {
        notify.error('Enter a name of at least 2 characters.');
        return;
      }
      patch.fullName = fullName;
    }
    // An emptied box means "clear it": send null, not '', which the server rejects.
    if (phone !== (user.phone ?? '')) patch.phone = phone === '' ? null : phone;

    if (Object.keys(patch).length === 0) {
      notify.info('There are no changes to save.');
      return;
    }

    save.disabled = true;
    try {
      const payload = await api.patch(`/admin/users/${encodeURIComponent(user.id)}`, patch);
      user = { ...user, ...payload.data };
      notify.success('Profile saved.');
      renderTitle();
      renderProfile();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? (Object.values(error.details?.fields ?? {})[0] ?? error.message)
          : 'Could not save the profile.';
      notify.error(message);
      save.disabled = false;
    }
  }

  function renderProfile() {
    render(profileRegion, [user.canUpdate ? profileForm() : readOnlyProfile()]);
  }

  /* ---- roles ------------------------------------------------------------ */

  function grantRow(grant) {
    const children = [
      el('div', {}, [
        el('div', { class: 'text-sm', text: grant.roleName ?? '—' }),
        el('div', {
          class: 'text-xs text-muted-token',
          text: grant.branchId ? 'This branch' : 'All branches',
        }),
      ]),
    ];
    if (user.canManageRoles) {
      const revoke = el('button', {
        class: 'btn btn-sm btn-outline-danger',
        type: 'button',
        text: 'Revoke',
      });
      revoke.addEventListener('click', () => revokeGrant(grant, revoke));
      children.push(revoke);
    }
    return el('div', { class: 'list-row' }, children);
  }

  async function revokeGrant(grant, button) {
    button.disabled = true;
    try {
      await api.delete(
        `/admin/users/${encodeURIComponent(user.id)}/roles/${encodeURIComponent(grant.id)}`,
      );
      user = { ...user, roles: user.roles.filter((each) => each.id !== grant.id) };
      notify.success('Role revoked.');
      renderRoles();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not revoke that role.');
      button.disabled = false;
    }
  }

  function grantForm() {
    const branchId = session.user.defaultBranchId ?? null;
    const roleSelect = el(
      'select',
      { class: 'form-select', 'aria-label': 'Role' },
      roles.map((role) => el('option', { value: role.id, text: role.name })),
    );
    const scopeSelect = el('select', { class: 'form-select', 'aria-label': 'Scope' }, [
      branchId ? el('option', { value: branchId, text: 'This branch' }) : null,
      el('option', { value: '', text: 'All branches' }),
    ]);
    const grant = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Grant role' });

    const form = el('form', { class: 'field' }, [
      el('p', { class: 'field__label', text: 'Grant a role' }),
      el('div', { class: 'cluster' }, [roleSelect, scopeSelect, grant]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      grantRole({ roleSelect, scopeSelect, grant });
    });
    return form;
  }

  async function grantRole({ roleSelect, scopeSelect, grant }) {
    if (!roleSelect.value) return;
    grant.disabled = true;
    try {
      const payload = await api.post(`/admin/users/${encodeURIComponent(user.id)}/roles`, {
        roleId: roleSelect.value,
        branchId: scopeSelect.value || null,
      });
      user = { ...user, roles: [...user.roles, payload.data] };
      notify.success(`Granted ${payload.data.roleName ?? 'role'}.`);
      renderRoles();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not grant that role.');
      grant.disabled = false;
    }
  }

  function renderRoles() {
    const grants = user.roles ?? [];
    const items =
      grants.length === 0
        ? [el('p', { class: 'text-sm text-muted-token', text: 'No roles granted yet.' })]
        : grants.map(grantRow);
    render(rolesRegion, [...items, user.canManageRoles && roles.length > 0 ? grantForm() : null]);
  }

  /* ---- page ------------------------------------------------------------- */

  function renderPage() {
    renderTitle();
    renderStatusLine();
    renderHeaderActions();
    renderProfile();
    renderRoles();

    render(main, [
      el('div', { class: 'page-header' }, [el('div', {}, [titleEl, statusLine]), headerActions]),
      el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('person'), ' Profile']),
        ]),
        el('div', { class: 'card-surface__body' }, [profileRegion]),
      ]),
      el('section', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('shield-lock'), ' Roles']),
        ]),
        el('div', { class: 'card-surface__body' }, [rolesRegion]),
      ]),
    ]);
  }

  async function load() {
    render(main, [
      el('section', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__body' }, [skeletonLines(6)]),
      ]),
    ]);

    try {
      const payload = await api.get(`/admin/users/${encodeURIComponent(userId)}`);
      user = payload.data;

      // The grant form needs the catalogue, but only someone who can manage roles
      // ever sees it — so only they pay for the extra request.
      if (user.canManageRoles) {
        try {
          roles = (await api.get('/admin/users/roles')).data;
        } catch {
          roles = [];
        }
      }

      renderPage();

      if (new URLSearchParams(location.search).get('invited') === '1') {
        notify.success('Invitation sent. They will get an email to set a password.');
      }
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: notFound ? 'User not found' : 'Could not load this user',
          message: notFound
            ? 'It may have been removed, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/admin/users',
            text: 'Back to users',
          }),
        }),
      ]);
    }
  }

  if (!userId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No user selected',
        message: 'This page needs a user id.',
        action: el('a', {
          class: 'btn btn-outline-secondary',
          href: '/admin/users',
          text: 'Back to users',
        }),
      }),
    ]);
  } else {
    await load();
  }
}
