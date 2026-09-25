/**
 * Ministry detail: the ministry, who serves in it, and who leads it.
 *
 * The controls here reflect the two-tier authority model exactly:
 *
 *   a leader of THIS ministry   may edit it, add ordinary members, and end a
 *                               membership
 *   ministries.members.manage   is additionally needed to appoint or promote a
 *                               leader or assistant leader
 *   ministries.delete           is needed to delete the ministry
 *
 * Hiding a control is a courtesy. Every one of these actions is checked again by
 * the endpoint, and again by RLS underneath it.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import {
  MEMBERSHIP_STATUS_VARIANT,
  formatCount,
  formatDate,
  formatMeetingSchedule,
  humanise,
} from '../core/format.js';
import { can, leadsMinistry, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { memberPicker } from '../components/member-picker.js';

/** Roles a leader may assign. Leadership roles need the branch permission. */
const ORDINARY_ROLE = 'member';
const LEADERSHIP_ROLES = ['leader', 'assistant_leader'];
const ALL_ROLES = [...LEADERSHIP_ROLES, ORDINARY_ROLE];

const ministryId = new URLSearchParams(location.search).get('id');
const showFormer = new URLSearchParams(location.search).get('former') === '1';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/ministries',
    title: 'Ministry',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  // Either route into authority: leading this ministry, or the branch permission.
  const mayManage = can('ministries.members.manage') || leadsMinistry(ministryId);
  const mayAppointLeaders = can('ministries.members.manage');
  const mayEdit = can('ministries.update') || leadsMinistry(ministryId);

  if (!ministryId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No ministry specified',
        message: 'This link is incomplete.',
        action: el('a', { class: 'btn btn-outline-secondary', href: '/ministries', text: 'Back' }),
      }),
    ]);
  } else {
    render(main, [el('div', { class: 'card-surface__body' }, [skeletonLines(5)])]);
    await load();
  }

  /* ---- actions ---------------------------------------------------------- */

  function reportFieldError(error, fallback) {
    const fields = error instanceof ApiError ? (error.details?.fields ?? {}) : {};
    const first = fields.roleInMinistry ?? fields.memberId ?? fields.leftOn;
    notify.error(first ?? (error instanceof ApiError ? error.message : fallback));
  }

  async function addMember(member, roleInMinistry) {
    try {
      await api.post(`/ministries/${encodeURIComponent(ministryId)}/members`, {
        memberId: member.id,
        roleInMinistry,
      });
      notify.success(`${member.fullName} was added.`);
      await load();
    } catch (error) {
      reportFieldError(error, 'Could not add that member.');
    }
  }

  async function changeRole(member, roleInMinistry) {
    try {
      await api.patch(
        `/ministries/${encodeURIComponent(ministryId)}/members/${encodeURIComponent(member.memberId)}`,
        { roleInMinistry },
      );
      notify.success('Role updated.');
      await load();
    } catch (error) {
      reportFieldError(error, 'Could not change that role.');
      await load();
    }
  }

  async function endMembership(member) {
    const confirmed = window.confirm(
      `Record that ${member.fullName} has left this ministry?\n\nThe membership is kept with today's date, so past attendance still makes sense.`,
    );
    if (!confirmed) return;

    try {
      await api.patch(
        `/ministries/${encodeURIComponent(ministryId)}/members/${encodeURIComponent(member.memberId)}`,
        { leftOn: new Date().toISOString().slice(0, 10) },
      );
      notify.success(`${member.fullName} was recorded as having left.`);
      await load();
    } catch (error) {
      reportFieldError(error, 'Could not end that membership.');
    }
  }

  async function reinstate(member) {
    try {
      await api.patch(
        `/ministries/${encodeURIComponent(ministryId)}/members/${encodeURIComponent(member.memberId)}`,
        { leftOn: null },
      );
      notify.success(`${member.fullName} was reinstated.`);
      await load();
    } catch (error) {
      reportFieldError(error, 'Could not reinstate that member.');
    }
  }

  async function deleteMinistry(ministry) {
    const confirmed = window.confirm(
      `Delete "${ministry.name}"?\n\nIts membership history is removed. The member records themselves are not affected.`,
    );
    if (!confirmed) return;

    try {
      await api.delete(`/ministries/${encodeURIComponent(ministryId)}`);
      notify.success('Ministry deleted.');
      location.assign('/ministries');
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not delete that ministry.');
    }
  }

  /* ---- rendering -------------------------------------------------------- */

  function roleControl(member) {
    // A leader may move someone to or from an ordinary role, but not into a
    // leadership one — the endpoint enforces this, and offering a disabled option
    // is clearer than letting the request fail.
    const options = mayAppointLeaders ? ALL_ROLES : [ORDINARY_ROLE];
    const locked = !options.includes(member.roleInMinistry);

    if (locked) {
      return el('span', {}, [
        el('span', { text: humanise(member.roleInMinistry) }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: ' (needs ministry administration)',
        }),
      ]);
    }

    return el(
      'select',
      {
        class: 'form-select form-select-sm',
        'aria-label': `Role for ${member.fullName}`,
        onchange: (event) => changeRole(member, event.target.value),
      },
      options.map((value) =>
        el('option', {
          value,
          text: humanise(value),
          selected: member.roleInMinistry === value,
        }),
      ),
    );
  }

  function memberRow(member) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          el('a', {
            class: 'person__name',
            href: `/members/detail?id=${encodeURIComponent(member.memberId)}`,
            text: member.fullName ?? 'Member',
          }),
          el('div', { class: 'person__meta mono', text: member.memberNo ?? '' }),
        ]),
      ]),
      el('td', {}, [
        mayManage && member.isActive
          ? roleControl(member)
          : el('span', { text: humanise(member.roleInMinistry) }),
      ]),
      el('td', { class: 'text-sm', text: formatDate(member.joinedOn) }),
      el('td', {}, [
        member.isActive
          ? el('span', {
              class: `pill pill--${MEMBERSHIP_STATUS_VARIANT[member.membershipStatus] ?? 'neutral'}`,
              text: humanise(member.membershipStatus),
            })
          : el('span', { class: 'pill pill--neutral', text: `Left ${formatDate(member.leftOn)}` }),
      ]),
      mayManage
        ? el('td', {}, [
            member.isActive
              ? el('button', {
                  class: 'btn btn-sm btn-outline-secondary',
                  type: 'button',
                  text: 'Record as left',
                  onclick: () => endMembership(member),
                })
              : el('button', {
                  class: 'btn btn-sm btn-outline-secondary',
                  type: 'button',
                  text: 'Reinstate',
                  onclick: () => reinstate(member),
                }),
          ])
        : null,
    ]);
  }

  function membersCard(ministry) {
    if (ministry.members.length === 0) {
      return el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title', text: 'Members' }),
        ]),
        stateBlock({
          iconName: 'people',
          title: 'Nobody in this ministry yet',
          message: mayManage
            ? 'Search for a member below to add them.'
            : 'Someone who manages this ministry can add members.',
        }),
      ]);
    }

    const toggleHref = showFormer
      ? `/ministries/detail?id=${encodeURIComponent(ministryId)}`
      : `/ministries/detail?id=${encodeURIComponent(ministryId)}&former=1`;

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Members' }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: formatCount(ministry.memberCount, 'current member'),
        }),
        el('a', {
          class: 'btn btn-sm btn-outline-secondary push-right',
          href: toggleHref,
          text: showFormer ? 'Hide former members' : 'Show former members',
        }),
      ]),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Member' }),
              el('th', { scope: 'col', text: 'Role' }),
              el('th', { scope: 'col', text: 'Joined' }),
              el('th', { scope: 'col', text: 'Status' }),
              mayManage
                ? el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Actions' })])
                : null,
            ]),
          ]),
          el('tbody', {}, ministry.members.map(memberRow)),
        ]),
      ]),
    ]);
  }

  function addMemberCard(ministry) {
    const roleSelect = el(
      'select',
      { class: 'form-select', id: 'add-role', 'aria-label': 'Role in ministry' },
      (mayAppointLeaders ? ALL_ROLES : [ORDINARY_ROLE]).map((value) =>
        el('option', { value, text: humanise(value) }),
      ),
    );
    roleSelect.value = ORDINARY_ROLE;

    const picker = memberPicker({
      label: 'Add a member to this ministry',
      excludeIds: ministry.members.filter((m) => m.isActive).map((m) => m.memberId),
      onSelect: (member) => addMember(member, roleSelect.value),
    });

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Add a member' }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field' }, [
            el('label', { class: 'field__label', for: 'add-role', text: 'Role' }),
            roleSelect,
            mayAppointLeaders
              ? null
              : el('p', {
                  class: 'field__hint',
                  text: 'Appointing a leader or assistant needs ministry administration.',
                }),
          ]),
          picker.element,
        ]),
      ]),
    ]);
  }

  function definition(term, value) {
    return [
      el('dt', { class: 'detail-list__term', text: term }),
      el('dd', { class: 'detail-list__value', text: value ?? '—' }),
    ];
  }

  async function load() {
    try {
      const payload = await api.get(`/ministries/${encodeURIComponent(ministryId)}`, {
        query: showFormer ? { former: '1' } : undefined,
      });
      const ministry = payload.data;

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: ministry.name }),
            el('p', { class: 'page-header__subtitle' }, [
              el('span', {
                class: `pill pill--${ministry.status === 'active' ? 'success' : 'neutral'}`,
                text: humanise(ministry.status),
              }),
              ` · ${formatMeetingSchedule(ministry.meetingDay, ministry.meetingTime)}`,
              ministry.youLead ? ' · you lead this ministry' : '',
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-outline-secondary', href: '/ministries', text: 'Back' }),
            mayEdit
              ? el(
                  'a',
                  {
                    class: 'btn btn-primary',
                    href: `/ministries/edit?id=${encodeURIComponent(ministry.id)}`,
                  },
                  [icon('pencil'), ' Edit'],
                )
              : null,
            can('ministries.delete')
              ? el('button', {
                  class: 'btn btn-outline-secondary',
                  type: 'button',
                  text: 'Delete',
                  onclick: () => deleteMinistry(ministry),
                })
              : null,
          ]),
        ]),

        el('section', { class: 'card-surface gap-below-5' }, [
          el('div', { class: 'card-surface__header' }, [
            el('h2', { class: 'card-surface__title', text: 'Details' }),
          ]),
          el('div', { class: 'card-surface__body' }, [
            el(
              'dl',
              { class: 'detail-list' },
              [
                definition('Short code', ministry.code),
                definition('Leader', ministry.leader?.fullName),
                definition(
                  'Assistant leaders',
                  ministry.assistantLeaders.length === 0
                    ? null
                    : ministry.assistantLeaders.map((member) => member.fullName).join(', '),
                ),
                definition(
                  'Meets',
                  formatMeetingSchedule(ministry.meetingDay, ministry.meetingTime),
                ),
                definition('Location', ministry.meetingLocation),
              ].flat(),
            ),
            ministry.description
              ? el('p', { class: 'text-sm gap-above-3', text: ministry.description })
              : null,
          ]),
        ]),

        membersCard(ministry),
        mayManage ? addMemberCard(ministry) : null,
      ]);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Ministry not found' : 'Could not load this ministry',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/ministries',
            text: 'Back',
          }),
        }),
      ]);
    }
  }
}
