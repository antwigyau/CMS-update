/**
 * Member detail.
 *
 * Read-only. Editing, removing, and restoring are all offered only when the
 * caller holds the matching permission — and each action's endpoint checks again,
 * so hiding the button is a courtesy rather than the control.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import {
  MEMBERSHIP_STATUS_VARIANT,
  formatAge,
  formatDate,
  formatDateTime,
  humanise,
} from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { emergencyContactsSection } from '../components/emergency-contacts.js';
import { memberPhotoSection } from '../components/member-photo.js';
import { spiritualGiftsSection } from '../components/spiritual-gifts.js';

const params = new URLSearchParams(location.search);
const memberId = params.get('id');

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/members',
    title: 'Member',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  if (!memberId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No member specified',
        message: 'This link is incomplete.',
        action: el('a', {
          class: 'btn btn-outline-secondary',
          href: '/members',
          text: 'Back to members',
        }),
      }),
    ]);
  } else {
    render(main, [el('div', { class: 'card-surface__body' }, [skeletonLines(6)])]);
    await load();
  }

  function definition(term, value) {
    return [
      el('dt', { class: 'detail-list__term', text: term }),
      el('dd', { class: 'detail-list__value', text: value ?? '—' }),
    ];
  }

  function section(title, pairs) {
    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: title }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('dl', { class: 'detail-list' }, pairs.flat()),
      ]),
    ]);
  }

  async function remove(member) {
    // A soft delete is reversible, and the dialog says so — an irreversible
    // warning here would be a lie, and people stop reading warnings that lie.
    const confirmed = window.confirm(
      `Remove ${member.fullName} from the roll?\n\nTheir record and attendance history are kept, and someone with permission can restore them.`,
    );
    if (!confirmed) return;

    try {
      await api.delete(`/members/${encodeURIComponent(memberId)}`);
      notify.success(`${member.fullName} was removed from the roll.`);
      location.assign('/members');
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not remove this member.');
    }
  }

  async function restore(member) {
    try {
      await api.post(`/members/${encodeURIComponent(memberId)}/restore`);
      notify.success(`${member.fullName} was restored.`);
      await load();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not restore this member.');
    }
  }

  async function load() {
    try {
      const payload = await api.get(`/members/${encodeURIComponent(memberId)}`);
      const member = payload.data;
      const age = formatAge(member.dateOfBirth);

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: member.fullName }),
            el('p', { class: 'page-header__subtitle' }, [
              el('span', { class: 'mono', text: member.memberNo }),
              ' · ',
              el('span', {
                class: `pill pill--${MEMBERSHIP_STATUS_VARIANT[member.membershipStatus] ?? 'neutral'}`,
                text: humanise(member.membershipStatus),
              }),
              member.hasLogin ? ' · has a login' : '',
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-outline-secondary', href: '/members', text: 'Back' }),
            can('members.update')
              ? el(
                  'a',
                  {
                    class: 'btn btn-primary',
                    href: `/members/edit?id=${encodeURIComponent(member.id)}`,
                  },
                  [icon('pencil'), ' Edit'],
                )
              : null,
            can('members.delete')
              ? el('button', {
                  class: 'btn btn-outline-secondary',
                  type: 'button',
                  text: 'Remove',
                  onclick: () => remove(member),
                })
              : null,
          ]),
        ]),

        memberPhotoSection({ member, canManage: can('members.photo.manage') }),

        section('Personal', [
          definition('Full name', member.fullName),
          definition('Gender', humanise(member.gender)),
          definition('Date of birth', formatDate(member.dateOfBirth)),
          definition('Age', age === null ? '—' : `${age}`),
          definition('Marital status', humanise(member.maritalStatus)),
          definition('Occupation', member.occupation),
          definition('Nationality', member.nationality),
        ]),

        section('Contact', [
          definition('Phone', member.phone),
          definition('Alternative phone', member.altPhone),
          definition('Email', member.email),
          definition('Address', member.addressLine),
          definition('City', member.city),
          definition('Region', member.region),
          definition('Country', member.country),
        ]),

        section('Church', [
          definition('Membership status', humanise(member.membershipStatus)),
          definition('Date joined', formatDate(member.dateJoined)),
          definition('Baptised', member.isBaptized ? 'Yes' : 'No'),
          definition('Baptism date', formatDate(member.baptismDate)),
        ]),

        spiritualGiftsSection({ memberId: member.id, canEdit: can('members.update') }),

        emergencyContactsSection({ memberId: member.id, canEdit: can('members.update') }),

        member.notes
          ? el('section', { class: 'card-surface gap-below-5' }, [
              el('div', { class: 'card-surface__header' }, [
                el('h2', { class: 'card-surface__title', text: 'Notes' }),
              ]),
              el('div', { class: 'card-surface__body' }, [
                el('p', { class: 'text-sm', text: member.notes }),
              ]),
            ])
          : null,

        el('p', { class: 'text-xs text-muted-token' }, [
          `Record created ${formatDateTime(member.createdAt)}`,
          member.updatedAt !== member.createdAt
            ? `, last updated ${formatDateTime(member.updatedAt)}`
            : '',
        ]),
      ]);

      if (params.get('created') === '1') {
        notify.success('Member added.');
        history.replaceState(null, '', `/members/detail?id=${encodeURIComponent(memberId)}`);
      }
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: notFound ? 'Member not found' : 'Could not load this member',
          message: notFound
            ? 'It may have been removed, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/members',
            text: 'Back to members',
          }),
        }),
      ]);
    }
  }

  // Exposed for the restore path, which is reachable only from the removed list.
  if (params.get('restore') === '1' && can('members.delete')) {
    const payload = await api.get(`/members/${encodeURIComponent(memberId)}`).catch(() => null);
    if (payload) await restore(payload.data);
  }
}
