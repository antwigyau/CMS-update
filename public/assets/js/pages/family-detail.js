/**
 * Household detail: the household's contact details and who lives in it.
 *
 * Membership changes are guarded by `families.update` on the server, so the
 * controls appear only for a caller who holds it — and the endpoint checks again
 * regardless of what this page renders.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { MEMBERSHIP_STATUS_VARIANT, formatAge, formatCount, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { memberPicker } from '../components/member-picker.js';

const RELATIONSHIPS = [
  'head',
  'spouse',
  'son',
  'daughter',
  'father',
  'mother',
  'brother',
  'sister',
  'grandparent',
  'grandchild',
  'other',
];

const familyId = new URLSearchParams(location.search).get('id');
const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/families',
    title: 'Household',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const mayEdit = can('families.update');

  if (!familyId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No household specified',
        message: 'This link is incomplete.',
        action: el('a', { class: 'btn btn-outline-secondary', href: '/families', text: 'Back' }),
      }),
    ]);
  } else {
    render(main, [el('div', { class: 'card-surface__body' }, [skeletonLines(5)])]);
    await load();
  }

  /* ---- actions ---------------------------------------------------------- */

  async function addMember(member, relationship) {
    try {
      await api.post(`/families/${encodeURIComponent(familyId)}/members`, {
        memberId: member.id,
        relationship,
      });
      notify.success(`${member.fullName} was added to the household.`);
      await load();
    } catch (error) {
      // The two uniqueness rules land here: a second head, or a member who is
      // already in another household. Both arrive as field-level messages.
      const fieldMessage =
        error instanceof ApiError
          ? (error.details?.fields?.relationship ?? error.details?.fields?.memberId)
          : null;
      notify.error(
        fieldMessage ?? (error instanceof ApiError ? error.message : 'Could not add that member.'),
      );
    }
  }

  async function changeRelationship(member, relationship) {
    try {
      await api.patch(
        `/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(member.memberId)}`,
        { relationship },
      );
      notify.success('Relationship updated.');
      await load();
    } catch (error) {
      const fieldMessage = error instanceof ApiError ? error.details?.fields?.relationship : null;
      notify.error(fieldMessage ?? 'Could not change that relationship.');
      await load();
    }
  }

  async function removeMember(member) {
    const confirmed = window.confirm(
      `Remove ${member.fullName} from this household?\n\nTheir member record is not affected.`,
    );
    if (!confirmed) return;

    try {
      await api.delete(
        `/families/${encodeURIComponent(familyId)}/members/${encodeURIComponent(member.memberId)}`,
      );
      notify.success(`${member.fullName} was removed from the household.`);
      await load();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not remove that member.');
    }
  }

  async function deleteFamily(family) {
    const confirmed = window.confirm(
      `Delete "${family.familyName}"?\n\nThe household grouping is removed. The ${formatCount(
        family.memberCount,
        'member record',
      )} in it are not affected.`,
    );
    if (!confirmed) return;

    try {
      await api.delete(`/families/${encodeURIComponent(familyId)}`);
      notify.success('Household deleted.');
      location.assign('/families');
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not delete that household.');
    }
  }

  /* ---- rendering -------------------------------------------------------- */

  function memberRow(member) {
    const age = formatAge(member.dateOfBirth);

    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'person' }, [
          el('div', {}, [
            el('a', {
              class: 'person__name',
              href: `/members/detail?id=${encodeURIComponent(member.memberId)}`,
              text: member.fullName ?? 'Member',
            }),
            el('div', { class: 'person__meta mono', text: member.memberNo ?? '' }),
          ]),
        ]),
      ]),
      el('td', {}, [
        mayEdit
          ? el(
              'select',
              {
                class: 'form-select form-select-sm',
                'aria-label': `Relationship for ${member.fullName}`,
                onchange: (event) => changeRelationship(member, event.target.value),
              },
              RELATIONSHIPS.map((value) =>
                el('option', {
                  value,
                  text: humanise(value),
                  selected: member.relationship === value,
                }),
              ),
            )
          : el('span', { text: humanise(member.relationship) }),
      ]),
      el('td', { class: 'text-sm', text: age === null ? '—' : String(age) }),
      el('td', {}, [
        member.membershipStatus
          ? el('span', {
              class: `pill pill--${MEMBERSHIP_STATUS_VARIANT[member.membershipStatus] ?? 'neutral'}`,
              text: humanise(member.membershipStatus),
            })
          : el('span', { class: 'text-muted-token', text: '—' }),
      ]),
      mayEdit
        ? el('td', {}, [
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Remove',
              onclick: () => removeMember(member),
            }),
          ])
        : null,
    ]);
  }

  function membersCard(family) {
    if (family.members.length === 0) {
      return el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title', text: 'Members' }),
        ]),
        stateBlock({
          iconName: 'people',
          title: 'Nobody in this household yet',
          message: mayEdit
            ? 'Search for a member below to add them.'
            : 'Someone with permission to edit households can add members.',
        }),
      ]);
    }

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Members' }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: formatCount(family.memberCount, 'person', 'people'),
        }),
      ]),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Member' }),
              el('th', { scope: 'col', text: 'Relationship' }),
              el('th', { scope: 'col', text: 'Age' }),
              el('th', { scope: 'col', text: 'Status' }),
              mayEdit
                ? el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Actions' })])
                : null,
            ]),
          ]),
          el('tbody', {}, family.members.map(memberRow)),
        ]),
      ]),
    ]);
  }

  function addMemberCard(family) {
    // The relationship is chosen before the member, so one click on a search
    // result completes the action.
    const relationshipSelect = el(
      'select',
      { class: 'form-select', id: 'add-relationship', 'aria-label': 'Relationship' },
      RELATIONSHIPS.map((value) => el('option', { value, text: humanise(value) })),
    );
    relationshipSelect.value = family.head ? 'spouse' : 'head';

    const picker = memberPicker({
      label: 'Add a member to this household',
      excludeIds: family.members.map((member) => member.memberId),
      onSelect: (member) => addMember(member, relationshipSelect.value),
    });

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Add a member' }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field' }, [
            el('label', { class: 'field__label', for: 'add-relationship', text: 'Relationship' }),
            relationshipSelect,
            el('p', {
              class: 'field__hint',
              text: family.head
                ? 'This household already has a head.'
                : 'No head recorded yet — the first person added is usually the head.',
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
      const payload = await api.get(`/families/${encodeURIComponent(familyId)}`);
      const family = payload.data;

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: family.familyName }),
            el('p', { class: 'page-header__subtitle' }, [
              formatCount(family.memberCount, 'member'),
              family.head ? ` · headed by ${family.head.fullName}` : ' · no head recorded',
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-outline-secondary', href: '/families', text: 'Back' }),
            mayEdit
              ? el(
                  'a',
                  {
                    class: 'btn btn-primary',
                    href: `/families/edit?id=${encodeURIComponent(family.id)}`,
                  },
                  [icon('pencil'), ' Edit'],
                )
              : null,
            can('families.delete')
              ? el('button', {
                  class: 'btn btn-outline-secondary',
                  type: 'button',
                  text: 'Delete',
                  onclick: () => deleteFamily(family),
                })
              : null,
          ]),
        ]),

        el('section', { class: 'card-surface gap-below-5' }, [
          el('div', { class: 'card-surface__header' }, [
            el('h2', { class: 'card-surface__title', text: 'Household' }),
          ]),
          el('div', { class: 'card-surface__body' }, [
            el(
              'dl',
              { class: 'detail-list' },
              [
                definition('Phone', family.householdPhone),
                definition('Email', family.householdEmail),
                definition('Address', family.addressLine),
                definition('City', family.city),
                definition('Region', family.region),
                definition('Country', family.country),
              ].flat(),
            ),
          ]),
        ]),

        membersCard(family),
        mayEdit ? addMemberCard(family) : null,

        family.notes
          ? el('section', { class: 'card-surface' }, [
              el('div', { class: 'card-surface__header' }, [
                el('h2', { class: 'card-surface__title', text: 'Notes' }),
              ]),
              el('div', { class: 'card-surface__body' }, [
                el('p', { class: 'text-sm', text: family.notes }),
              ]),
            ])
          : null,
      ]);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Household not found' : 'Could not load this household',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/families', text: 'Back' }),
        }),
      ]);
    }
  }
}
