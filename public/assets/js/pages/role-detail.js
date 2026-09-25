/**
 * Role detail — the permission editor.
 *
 * A role's key is fixed at creation, so it is shown read-only; its name,
 * description and sort order are editable, and its permission set is toggled
 * against the full catalogue. System roles can be edited but never deleted, and
 * a role still granted to anyone cannot be deleted either — the API refuses both
 * regardless of what this page renders, so the affordances here only mirror it.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatCount, humanise } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const roleId = new URLSearchParams(location.search).get('id');

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/roles',
    title: 'Role',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  // The detail view (id, key, name, description, isSystem, sortOrder,
  // permissionIds, grantCount) plus the full permission catalogue for the editor.
  let role = null;
  let permissions = [];

  const titleEl = el('h1', { class: 'page-header__title' });
  const statusLine = el('p', { class: 'page-header__subtitle' });
  const profileRegion = el('div');
  const permissionsRegion = el('div');
  const dangerRegion = el('div');

  /* ---- header ----------------------------------------------------------- */

  function renderHeader() {
    titleEl.textContent = role.name;
    render(statusLine, [
      el('span', {
        class: `pill pill--${role.isSystem ? 'brand' : 'neutral'}`,
        text: role.isSystem ? 'System' : 'Custom',
      }),
      ` · ${formatCount(role.permissionIds.length, 'permission')} · ${formatCount(role.grantCount, 'user')}`,
    ]);
  }

  /* ---- profile ---------------------------------------------------------- */

  function profileForm() {
    const nameInput = el('input', {
      class: 'form-control',
      id: 'profile-name',
      type: 'text',
      value: role.name ?? '',
      autocomplete: 'off',
    });
    const descriptionInput = el('textarea', {
      class: 'form-control',
      id: 'profile-description',
      rows: '3',
    });
    descriptionInput.value = role.description ?? '';
    const sortOrderInput = el('input', {
      class: 'form-control',
      id: 'profile-sortOrder',
      type: 'number',
      value: String(role.sortOrder ?? ''),
      autocomplete: 'off',
    });
    const save = el('button', { class: 'btn btn-primary', type: 'submit', text: 'Save changes' });

    const form = el('form', {}, [
      el('div', { class: 'form-grid' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'profile-name', text: 'Name' }),
          nameInput,
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Key' }),
          el('p', {}, [el('code', { class: 'text-sm', text: role.key })]),
          el('p', { class: 'field__hint', text: 'The internal key cannot be changed.' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'profile-description', text: 'Description' }),
          descriptionInput,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'profile-sortOrder', text: 'Sort order' }),
          sortOrderInput,
        ]),
      ]),
      el('div', { class: 'form-actions' }, [save]),
    ]);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveProfile({ nameInput, descriptionInput, sortOrderInput, save });
    });
    return form;
  }

  async function saveProfile({ nameInput, descriptionInput, sortOrderInput, save }) {
    const patch = {};
    const name = nameInput.value.trim();
    const description = descriptionInput.value.trim();
    const sortOrder = sortOrderInput.value.trim();

    if (name !== (role.name ?? '')) {
      if (name.length < 2 || name.length > 60) {
        notify.error('Enter a name of 2 to 60 characters.');
        return;
      }
      patch.name = name;
    }

    // An emptied box means "clear it": send null, not '', which the server rejects.
    if (description !== (role.description ?? '')) {
      patch.description = description === '' ? null : description;
    }
    if (sortOrder !== String(role.sortOrder ?? '')) {
      const n = Number(sortOrder);
      if (!Number.isInteger(n) || n < 0 || n > 32767) {
        notify.error('Enter a whole number between 0 and 32767 for the sort order.');
        return;
      }
      patch.sortOrder = n;
    }

    if (Object.keys(patch).length === 0) {
      notify.info('There are no changes to save.');
      return;
    }

    save.disabled = true;
    try {
      const payload = await api.patch(`/admin/roles/${encodeURIComponent(role.id)}`, patch);
      // PATCH returns the plain role view — no permissionIds/grantCount — so merge
      // rather than replace, to keep the counts the header relies on.
      role = { ...role, ...payload.data };
      notify.success('Role saved.');
      renderHeader();
      renderProfile();
    } catch (error) {
      const message =
        error instanceof ApiError
          ? (Object.values(error.details?.fields ?? {})[0] ?? error.message)
          : 'Could not save the role.';
      notify.error(message);
      save.disabled = false;
    }
  }

  function renderProfile() {
    render(profileRegion, [profileForm()]);
  }

  /* ---- permissions ------------------------------------------------------ */

  // permissionId -> its checkbox, rebuilt whenever the form is rendered.
  const checkboxes = new Map();

  function permissionGroups() {
    const groups = new Map();
    for (const permission of permissions) {
      const list = groups.get(permission.group) ?? [];
      list.push(permission);
      groups.set(permission.group, list);
    }
    return groups;
  }

  function permissionCheck(permission) {
    const id = `perm-${permission.id}`;
    const input = el('input', {
      class: 'form-check-input',
      id,
      type: 'checkbox',
      value: permission.id,
      checked: role.permissionIds.includes(permission.id),
    });
    checkboxes.set(permission.id, input);
    return el('div', { class: 'form-check' }, [
      input,
      el('label', { class: 'form-check-label', for: id }, [
        el('span', { class: 'd-block', text: permission.description ?? permission.key }),
        el('span', { class: 'd-block text-xs text-muted-token', text: permission.key }),
      ]),
    ]);
  }

  function permissionsForm() {
    checkboxes.clear();
    const fieldsets = [...permissionGroups().entries()].map(([group, list]) =>
      el('fieldset', { class: 'field' }, [
        el('legend', { class: 'field__label', text: humanise(group) }),
        ...list.map(permissionCheck),
      ]),
    );
    const save = el('button', {
      class: 'btn btn-primary',
      type: 'submit',
      text: 'Save permissions',
    });
    const form = el('form', {}, [
      el('div', {}, fieldsets),
      el('div', { class: 'form-actions' }, [save]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      savePermissions(save);
    });
    return form;
  }

  async function savePermissions(save) {
    const permissionIds = [...checkboxes.entries()]
      .filter(([, input]) => input.checked)
      .map(([id]) => id);

    save.disabled = true;
    try {
      const payload = await api.put(`/admin/roles/${encodeURIComponent(role.id)}/permissions`, {
        permissionIds,
      });
      // PUT returns the full detail view — adopt it wholesale so counts stay true.
      role = { ...role, ...payload.data };
      notify.success('Permissions saved.');
      renderHeader();
    } catch (error) {
      // The escalation guard surfaces its own 403 message; show it verbatim.
      notify.error(error instanceof ApiError ? error.message : 'Could not save permissions.');
    } finally {
      save.disabled = false;
    }
  }

  function renderPermissions() {
    render(permissionsRegion, [
      permissions.length === 0
        ? el('p', { class: 'text-sm text-muted-token', text: 'No permissions are defined.' })
        : permissionsForm(),
    ]);
  }

  /* ---- delete ----------------------------------------------------------- */

  function renderDanger() {
    if (role.isSystem) {
      render(dangerRegion, [
        el('p', {
          class: 'text-sm text-muted-token',
          text: 'This is a system role. It cannot be deleted.',
        }),
      ]);
      return;
    }
    if (role.grantCount > 0) {
      render(dangerRegion, [
        el('button', {
          class: 'btn btn-outline-danger',
          type: 'button',
          text: 'Delete role',
          disabled: true,
        }),
        el('p', {
          class: 'field__hint',
          text: `This role is assigned to ${formatCount(role.grantCount, 'account')}. Revoke those grants before it can be deleted.`,
        }),
      ]);
      return;
    }
    renderDeletePrompt();
  }

  function renderDeletePrompt() {
    const button = el('button', {
      class: 'btn btn-outline-danger',
      type: 'button',
      text: 'Delete role',
    });
    button.addEventListener('click', renderDeleteConfirm);
    render(dangerRegion, [button]);
  }

  function renderDeleteConfirm() {
    const confirmButton = el('button', {
      class: 'btn btn-danger',
      type: 'button',
      text: 'Yes, delete',
    });
    const cancelButton = el('button', {
      class: 'btn btn-outline-secondary',
      type: 'button',
      text: 'Cancel',
    });
    confirmButton.addEventListener('click', () => deleteRole(confirmButton, cancelButton));
    cancelButton.addEventListener('click', renderDeletePrompt);
    render(dangerRegion, [
      el('p', { class: 'text-sm', text: 'Delete this role for good? This cannot be undone.' }),
      el('div', { class: 'cluster' }, [confirmButton, cancelButton]),
    ]);
  }

  async function deleteRole(confirmButton, cancelButton) {
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await api.delete(`/admin/roles/${encodeURIComponent(role.id)}`);
      notify.success('Role deleted.');
      location.assign('/admin/roles');
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not delete the role.');
      renderDeletePrompt();
    }
  }

  /* ---- page ------------------------------------------------------------- */

  function renderPage() {
    renderHeader();
    renderProfile();
    renderPermissions();
    renderDanger();

    render(main, [
      el('div', { class: 'page-header' }, [
        el('div', {}, [titleEl, statusLine]),
        el('div', { class: 'page-header__actions' }, [
          el('a', { class: 'btn btn-outline-secondary', href: '/admin/roles', text: 'All roles' }),
        ]),
      ]),
      el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('pencil'), ' Details']),
        ]),
        el('div', { class: 'card-surface__body' }, [profileRegion]),
      ]),
      el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('key'), ' Permissions']),
        ]),
        el('div', { class: 'card-surface__body' }, [permissionsRegion]),
      ]),
      el('section', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [
            icon('exclamation-triangle'),
            ' Danger zone',
          ]),
        ]),
        el('div', { class: 'card-surface__body' }, [dangerRegion]),
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
      const [rolePayload, permissionsPayload] = await Promise.all([
        api.get(`/admin/roles/${encodeURIComponent(roleId)}`),
        api.get('/admin/roles/permissions'),
      ]);
      role = rolePayload.data;
      permissions = permissionsPayload.data;
      renderPage();
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: notFound ? 'Role not found' : 'Could not load this role',
          message: notFound
            ? 'It may have been removed, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/admin/roles',
            text: 'Back to roles',
          }),
        }),
      ]);
    }
  }

  if (!roleId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No role selected',
        message: 'This page needs a role id.',
        action: el('a', {
          class: 'btn btn-outline-secondary',
          href: '/admin/roles',
          text: 'Back to roles',
        }),
      }),
    ]);
  } else {
    await load();
  }
}
