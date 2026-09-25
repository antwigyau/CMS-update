/**
 * Event detail: what it is, who is coming, and the lifecycle controls.
 *
 * The action buttons come from `canEdit`, `canPublish`, and
 * `canManageRegistrations` on the response rather than from permission names in
 * this file — the server already worked out what this caller may do, including the
 * ministry-leadership case, and duplicating that logic here would be a second place
 * for it to drift.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import {
  EVENT_STATUS_VARIANT,
  REGISTRATION_STATUS_VARIANT,
  formatCount,
  formatDateTime,
  formatEventWhen,
  humanise,
} from '../core/format.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { memberPicker } from '../components/member-picker.js';

const REGISTRATION_STATUSES = ['registered', 'cancelled', 'no_show'];

/** Which transitions to offer, from the current status. */
const NEXT_STATUSES = {
  draft: [{ status: 'published', label: 'Publish', icon: 'megaphone', needsPublish: true }],
  published: [
    { status: 'ongoing', label: 'Mark as under way', icon: 'play-circle' },
    { status: 'completed', label: 'Mark as finished', icon: 'check2-circle' },
    { status: 'cancelled', label: 'Cancel event', icon: 'x-circle' },
  ],
  ongoing: [
    { status: 'completed', label: 'Mark as finished', icon: 'check2-circle' },
    { status: 'cancelled', label: 'Cancel event', icon: 'x-circle' },
  ],
  cancelled: [
    { status: 'published', label: 'Reinstate and publish', icon: 'megaphone', needsPublish: true },
    { status: 'draft', label: 'Return to draft', icon: 'pencil' },
  ],
  completed: [],
};

const eventId = new URLSearchParams(location.search).get('id');
const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/events',
    title: 'Event',
    user: account.user,
    can: (permission) => account.permissions.includes(permission),
    onSignOut: signOut,
  });

  if (!eventId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No event specified',
        message: 'This link is incomplete.',
        action: el('a', { class: 'btn btn-outline-secondary', href: '/events', text: 'Back' }),
      }),
    ]);
  } else {
    render(main, [el('div', { class: 'card-surface__body' }, [skeletonLines(6)])]);
    await load();
  }

  /* ---- actions ---------------------------------------------------------- */

  function reportError(error, fallback) {
    const fields = error instanceof ApiError ? (error.details?.fields ?? {}) : {};
    const first = Object.values(fields)[0];
    notify.error(first ?? (error instanceof ApiError ? error.message : fallback));
  }

  async function changeStatus(target) {
    if (target.status === 'cancelled') {
      const confirmed = window.confirm(
        'Cancel this event?\n\nIt stays on the calendar marked as cancelled, and can be reinstated.',
      );
      if (!confirmed) return;
    }

    try {
      await api.post(`/events/${encodeURIComponent(eventId)}/status`, { status: target.status });
      notify.success(`Event ${humanise(target.status).toLowerCase()}.`);
      await load();
    } catch (error) {
      reportError(error, 'Could not change the event status.');
    }
  }

  async function deleteEvent(event) {
    const confirmed = window.confirm(
      `Delete "${event.title}"?\n\nThis removes the event and its ${formatCount(
        event.registeredCount ?? 0,
        'registration',
      )}. Cancelling instead keeps the record.`,
    );
    if (!confirmed) return;

    try {
      await api.delete(`/events/${encodeURIComponent(eventId)}`);
      notify.success('Event deleted.');
      location.assign('/events');
    } catch (error) {
      reportError(error, 'Could not delete that event.');
    }
  }

  async function addRegistration(body, describe) {
    try {
      await api.post(`/events/${encodeURIComponent(eventId)}/registrations`, body);
      notify.success(`${describe} registered.`);
      await load();
    } catch (error) {
      reportError(error, 'Could not register that person.');
    }
  }

  async function changeRegistrationStatus(registration, status) {
    try {
      await api.patch(
        `/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(registration.id)}`,
        { status },
      );
      await load();
    } catch (error) {
      reportError(error, 'Could not update that registration.');
      await load();
    }
  }

  async function removeRegistration(registration) {
    const confirmed = window.confirm(`Remove ${registration.fullName} from this event?`);
    if (!confirmed) return;

    try {
      await api.delete(
        `/events/${encodeURIComponent(eventId)}/registrations/${encodeURIComponent(registration.id)}`,
      );
      notify.success('Registration removed.');
      await load();
    } catch (error) {
      reportError(error, 'Could not remove that registration.');
    }
  }

  /* ---- rendering -------------------------------------------------------- */

  function definition(term, value) {
    return [
      el('dt', { class: 'detail-list__term', text: term }),
      el('dd', { class: 'detail-list__value', text: value ?? '—' }),
    ];
  }

  function registrationRow(registration, mayManage) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          registration.isGuest
            ? el('span', { class: 'person__name', text: registration.fullName })
            : el('a', {
                class: 'person__name',
                href: `/members/detail?id=${encodeURIComponent(registration.memberId)}`,
                text: registration.fullName,
              }),
          el('div', { class: 'person__meta' }, [
            registration.isGuest
              ? (registration.guestPhone ?? registration.guestEmail ?? 'Guest')
              : el('span', { class: 'mono', text: registration.memberNo ?? '' }),
          ]),
        ]),
      ]),
      el('td', {}, [
        mayManage
          ? el(
              'select',
              {
                class: 'form-select form-select-sm',
                'aria-label': `Status for ${registration.fullName}`,
                onchange: (event) => changeRegistrationStatus(registration, event.target.value),
              },
              REGISTRATION_STATUSES.map((value) =>
                el('option', {
                  value,
                  text: humanise(value),
                  selected: registration.status === value,
                }),
              ),
            )
          : el('span', {
              class: `pill pill--${REGISTRATION_STATUS_VARIANT[registration.status] ?? 'neutral'}`,
              text: humanise(registration.status),
            }),
      ]),
      el('td', { class: 'text-sm', text: formatDateTime(registration.registeredAt) }),
      mayManage
        ? el('td', {}, [
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Remove',
              onclick: () => removeRegistration(registration),
            }),
          ])
        : null,
    ]);
  }

  function registrationsCard(event, registrations, mayManage) {
    const full = event.placesLeft === 0;

    if (registrations.length === 0) {
      return el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title', text: 'Registrations' }),
        ]),
        stateBlock({
          iconName: 'person-plus',
          title: 'Nobody registered yet',
          message: mayManage
            ? 'Search for a member below, or add a guest.'
            : 'No registrations have been recorded.',
        }),
      ]);
    }

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Registrations' }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: event.capacity
            ? `${registrations.length} of ${event.capacity} places taken`
            : formatCount(registrations.length, 'registration'),
        }),
        full ? el('span', { class: 'pill pill--warning push-right', text: 'Full' }) : null,
      ]),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Person' }),
              el('th', { scope: 'col', text: 'Status' }),
              el('th', { scope: 'col', text: 'Registered' }),
              mayManage
                ? el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Actions' })])
                : null,
            ]),
          ]),
          el(
            'tbody',
            {},
            registrations.map((registration) => registrationRow(registration, mayManage)),
          ),
        ]),
      ]),
    ]);
  }

  function addCard(event, registrations) {
    const picker = memberPicker({
      label: 'Register a member',
      excludeIds: registrations.filter((r) => !r.isGuest).map((r) => r.memberId),
      onSelect: (member) => addRegistration({ memberId: member.id }, member.fullName),
    });

    const guestName = el('input', {
      class: 'form-control',
      id: 'guest-name',
      type: 'text',
      placeholder: 'Name',
      autocomplete: 'off',
    });
    const guestPhone = el('input', {
      class: 'form-control',
      id: 'guest-phone',
      type: 'tel',
      placeholder: 'Phone (optional)',
      autocomplete: 'off',
    });

    const guestButton = el('button', {
      class: 'btn btn-outline-secondary',
      type: 'button',
      text: 'Register guest',
      onclick: () => {
        const name = guestName.value.trim();
        if (name.length < 2) {
          notify.warning('Enter the guest’s name first.');
          guestName.focus();
          return;
        }
        const body = { guestName: name };
        if (guestPhone.value.trim()) body.guestPhone = guestPhone.value.trim();

        guestName.value = '';
        guestPhone.value = '';
        addRegistration(body, name);
      },
    });

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Add a registration' }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'form-grid' }, [
          picker.element,
          el('div', { class: 'field' }, [
            el('label', { class: 'field__label', for: 'guest-name', text: 'Or register a guest' }),
            guestName,
            el('div', { class: 'gap-above-3' }, [guestPhone]),
            el('div', { class: 'gap-above-3' }, [guestButton]),
          ]),
        ]),
      ]),
    ]);
  }

  async function load() {
    try {
      const [eventPayload, registrationsPayload] = await Promise.all([
        api.get(`/events/${encodeURIComponent(eventId)}`),
        api.get(`/events/${encodeURIComponent(eventId)}/registrations`).catch(() => ({ data: [] })),
      ]);

      const event = eventPayload.data;
      const registrations = registrationsPayload.data;
      const transitions = (NEXT_STATUSES[event.status] ?? []).filter(
        (target) => !target.needsPublish || event.canPublish,
      );

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: event.title }),
            el('p', { class: 'page-header__subtitle' }, [
              el('span', {
                class: `pill pill--${EVENT_STATUS_VARIANT[event.status] ?? 'neutral'}`,
                text: humanise(event.status),
              }),
              ` · ${formatEventWhen(event.startsAt, event.endsAt)}`,
              event.venue ? ` · ${event.venue}` : '',
              event.isPublic ? ' · visible to everyone signed in' : '',
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-outline-secondary', href: '/events', text: 'Back' }),
            event.canEdit
              ? el(
                  'a',
                  {
                    class: 'btn btn-outline-secondary',
                    href: `/events/edit?id=${encodeURIComponent(event.id)}`,
                  },
                  [icon('pencil'), ' Edit'],
                )
              : null,
            ...transitions.map((target, index) =>
              el(
                'button',
                {
                  class: `btn ${index === 0 ? 'btn-primary' : 'btn-outline-secondary'}`,
                  type: 'button',
                  onclick: () => changeStatus(target),
                },
                [icon(target.icon), ` ${target.label}`],
              ),
            ),
            // Deletion is offered only where the server says it is allowed —
            // `events.delete`, which a ministry leader does not hold. Cancelling
            // is the reversible option and appears above.
            event.canDelete
              ? el('button', {
                  class: 'btn btn-outline-secondary',
                  type: 'button',
                  text: 'Delete',
                  onclick: () => deleteEvent(event),
                })
              : null,
          ]),
        ]),

        event.status === 'draft'
          ? el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
              icon('eye-slash'),
              el('span', {
                text: event.canPublish
                  ? 'This event is a draft. Publish it when it is ready to be announced.'
                  : 'This event is a draft. Someone with permission to publish must announce it.',
              }),
            ])
          : null,

        el('section', { class: 'card-surface gap-below-5' }, [
          el('div', { class: 'card-surface__header' }, [
            el('h2', { class: 'card-surface__title', text: 'Details' }),
          ]),
          el('div', { class: 'card-surface__body' }, [
            el(
              'dl',
              { class: 'detail-list' },
              [
                definition('Category', event.categoryName),
                definition('Ministry', event.ministryName),
                definition('Organiser', event.organizerName),
                definition('Venue', event.venue),
                definition(
                  'Capacity',
                  event.capacity === null ? 'No limit' : String(event.capacity),
                ),
                definition(
                  'Places left',
                  event.placesLeft === null ? 'No limit' : String(event.placesLeft),
                ),
              ].flat(),
            ),
            event.description
              ? el('p', { class: 'text-sm gap-above-3', text: event.description })
              : null,
          ]),
        ]),

        registrationsCard(event, registrations, event.canManageRegistrations),
        event.canManageRegistrations && event.status !== 'cancelled'
          ? addCard(event, registrations)
          : null,
      ]);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Event not found' : 'Could not load this event',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/events', text: 'Back' }),
        }),
      ]);
    }
  }
}
