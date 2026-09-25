/**
 * The register.
 *
 * This is the screen someone stands at a door with, so it is built for speed:
 * pick a member, they are marked present immediately, the picker clears and keeps
 * focus. Nothing is batched behind a Save button that could be forgotten.
 *
 * Decision D5 is on display at the top: the headcount and the identified count sit
 * side by side, and the headcount inputs are editable in place because the person
 * counting and the person identifying are usually the same person doing both at
 * once.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatDate, formatTime, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { memberPicker } from '../components/member-picker.js';

const STATUSES = ['present', 'late', 'excused', 'absent'];
const HEADCOUNTS = [
  { key: 'countAdults', label: 'Adults', from: 'adults' },
  { key: 'countYouth', label: 'Youth', from: 'youth' },
  { key: 'countChildren', label: 'Children', from: 'children' },
  { key: 'countVisitors', label: 'Visitors', from: 'visitors' },
];

const sessionId = new URLSearchParams(location.search).get('id');
const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/attendance',
    title: 'Register',
    user: account.user,
    can,
    onSignOut: signOut,
  });

  if (!sessionId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No session specified',
        message: 'This link is incomplete.',
        action: el('a', { class: 'btn btn-outline-secondary', href: '/attendance', text: 'Back' }),
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

  async function record(entry, describe) {
    try {
      await api.post(`/attendance/sessions/${encodeURIComponent(sessionId)}/records`, entry);
      notify.success(`${describe} marked present.`);
      await load({ keepFocus: true });
    } catch (error) {
      reportError(error, 'Could not record that.');
    }
  }

  async function changeStatus(entry, status) {
    try {
      await api.patch(
        `/attendance/sessions/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(entry.id)}`,
        { status },
      );
      await load();
    } catch (error) {
      reportError(error, 'Could not change that.');
      await load();
    }
  }

  async function removeRecord(entry) {
    const confirmed = window.confirm(`Remove ${entry.fullName} from this register?`);
    if (!confirmed) return;

    try {
      await api.delete(
        `/attendance/sessions/${encodeURIComponent(sessionId)}/records/${encodeURIComponent(entry.id)}`,
      );
      notify.success('Removed from the register.');
      await load();
    } catch (error) {
      reportError(error, 'Could not remove that entry.');
    }
  }

  async function saveHeadcount(key, value) {
    try {
      await api.patch(`/attendance/sessions/${encodeURIComponent(sessionId)}`, {
        [key]: Number(value),
      });
      await load({ keepFocus: true });
    } catch (error) {
      reportError(error, 'Could not save that count.');
    }
  }

  async function setStatus(status) {
    const closing = status === 'closed';
    if (closing) {
      const confirmed = window.confirm(
        'Close this session?\n\nThe register is frozen once closed. Reopening needs permission to close sessions.',
      );
      if (!confirmed) return;
    }

    try {
      await api.patch(`/attendance/sessions/${encodeURIComponent(sessionId)}`, { status });
      notify.success(closing ? 'Session closed.' : 'Session reopened.');
      await load();
    } catch (error) {
      reportError(error, 'Could not change the session status.');
    }
  }

  /* ---- rendering -------------------------------------------------------- */

  function headcountCard(session, editable) {
    const inputs = HEADCOUNTS.map((definition) => {
      const id = `count-${definition.from}`;
      const input = el('input', {
        class: 'form-control',
        id,
        type: 'number',
        min: '0',
        inputmode: 'numeric',
        value: String(session.headcount[definition.from] ?? 0),
        disabled: !editable,
      });

      // Saved on blur rather than on every keystroke: typing "120" would
      // otherwise fire three requests, the first two of them wrong.
      input.addEventListener('change', () => saveHeadcount(definition.key, input.value));

      return el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: id, text: definition.label }),
        input,
      ]);
    });

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Headcount' }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: 'Counted at the door. Kept separate from the names below, on purpose.',
        }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'form-grid' }, inputs),
        el('p', { class: 'text-sm gap-above-3' }, [
          el('strong', { text: String(session.headcount.total ?? 0) }),
          ' counted · ',
          el('strong', { text: String(session.namedCount) }),
          ' identified by name',
        ]),
      ]),
    ]);
  }

  function registerRow(entry, editable) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          entry.isGuest
            ? el('span', { class: 'person__name', text: entry.fullName })
            : el('a', {
                class: 'person__name',
                href: `/members/detail?id=${encodeURIComponent(entry.memberId)}`,
                text: entry.fullName,
              }),
          el('div', { class: 'person__meta' }, [
            entry.isGuest ? 'Guest' : el('span', { class: 'mono', text: entry.memberNo ?? '' }),
          ]),
        ]),
      ]),
      el('td', {}, [
        editable && can('attendance.update')
          ? el(
              'select',
              {
                class: 'form-select form-select-sm',
                'aria-label': `Status for ${entry.fullName}`,
                onchange: (event) => changeStatus(entry, event.target.value),
              },
              STATUSES.map((value) =>
                el('option', { value, text: humanise(value), selected: entry.status === value }),
              ),
            )
          : el('span', {
              class: `pill pill--${entry.status === 'present' ? 'success' : 'neutral'}`,
              text: humanise(entry.status),
            }),
      ]),
      el('td', { class: 'text-sm', text: formatTime(entry.checkInAt?.slice(11, 16)) }),
      can('attendance.delete') && editable
        ? el('td', {}, [
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Remove',
              onclick: () => removeRecord(entry),
            }),
          ])
        : null,
    ]);
  }

  function registerCard(session, editable) {
    if (session.records.length === 0) {
      return el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title', text: 'Named register' }),
        ]),
        stateBlock({
          iconName: 'person-check',
          title: 'Nobody recorded by name yet',
          message: editable
            ? 'Search for a member below, or add a guest.'
            : 'This session has no named records.',
        }),
      ]);
    }

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Named register' }),
        el('span', {
          class: 'text-xs text-muted-token',
          text: `${session.presentCount} present of ${session.namedCount} recorded`,
        }),
      ]),
      el('div', { class: 'data-table-wrap' }, [
        el('table', { class: 'data-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Person' }),
              el('th', { scope: 'col', text: 'Status' }),
              el('th', { scope: 'col', text: 'Checked in' }),
              can('attendance.delete') && editable
                ? el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Actions' })])
                : null,
            ]),
          ]),
          el(
            'tbody',
            {},
            session.records.map((entry) => registerRow(entry, editable)),
          ),
        ]),
      ]),
    ]);
  }

  function addCard(session, keepFocus) {
    const picker = memberPicker({
      label: 'Mark a member present',
      excludeIds: session.records.filter((r) => !r.isGuest).map((r) => r.memberId),
      onSelect: (member) => record({ memberId: member.id, method: 'search' }, member.fullName),
    });

    const guestInput = el('input', {
      class: 'form-control',
      id: 'guest-name',
      type: 'text',
      placeholder: 'Name of a visitor',
      autocomplete: 'off',
    });

    const guestButton = el('button', {
      class: 'btn btn-outline-secondary',
      type: 'button',
      text: 'Add guest',
      onclick: () => {
        const name = guestInput.value.trim();
        if (name.length < 2) {
          notify.warning('Enter the guest’s name first.');
          guestInput.focus();
          return;
        }
        guestInput.value = '';
        record({ guestName: name, method: 'manual' }, name);
      },
    });

    guestInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        guestButton.click();
      }
    });

    if (keepFocus) {
      // The picker keeps focus across a reload so a whole queue can be marked in
      // without touching the mouse.
      setTimeout(() => picker.focus(), 0);
    }

    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: 'Add to the register' }),
      ]),
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'form-grid' }, [
          picker.element,
          el('div', { class: 'field' }, [
            el('label', { class: 'field__label', for: 'guest-name', text: 'Or add a guest' }),
            guestInput,
            el('div', { class: 'gap-above-3' }, [guestButton]),
          ]),
        ]),
      ]),
    ]);
  }

  async function load({ keepFocus = false } = {}) {
    try {
      const payload = await api.get(`/attendance/sessions/${encodeURIComponent(sessionId)}`);
      const session = payload.data;
      const open = session.status === 'open';

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: session.title }),
            el('p', { class: 'page-header__subtitle' }, [
              formatDate(session.sessionDate),
              ` · ${humanise(session.sessionType)}`,
              session.ministryName ? ` · ${session.ministryName}` : '',
              session.startTime ? ` · ${session.startTime}` : '',
              ' · ',
              el('span', {
                class: `pill pill--${open ? 'brand' : 'neutral'}`,
                text: open ? 'Open' : 'Closed',
              }),
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-outline-secondary', href: '/attendance', text: 'Back' }),
            can('attendance.session.close')
              ? el(
                  'button',
                  {
                    class: 'btn btn-primary',
                    type: 'button',
                    onclick: () => setStatus(open ? 'closed' : 'open'),
                  },
                  [icon(open ? 'lock' : 'unlock'), open ? ' Close session' : ' Reopen session'],
                )
              : null,
          ]),
        ]),

        open
          ? null
          : el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
              icon('lock'),
              el('span', {
                text: 'This session is closed. The register is frozen; reopen it to make a change.',
              }),
            ]),

        headcountCard(session, session.canRecord),
        registerCard(session, session.canRecord),
        session.canRecord ? addCard(session, keepFocus) : null,
      ]);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Session not found' : 'Could not load this session',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/attendance',
            text: 'Back',
          }),
        }),
      ]);
    }
  }
}
