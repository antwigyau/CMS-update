/**
 * Event-shaped fixtures.
 */

import { BRANCH_MAIN, MINISTRY_CHOIR } from './auth-fixtures.js';

export const EVENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const REGISTRATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const CATEGORY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

export function eventRow(overrides = {}) {
  const { event_categories, ministries, members, ...rest } = overrides;

  return {
    id: EVENT_ID,
    branch_id: BRANCH_MAIN,
    category_id: CATEGORY_ID,
    title: 'Annual Harvest Service',
    description: 'The harvest thanksgiving service.',
    starts_at: '2026-10-04T09:00:00.000Z',
    ends_at: '2026-10-04T12:00:00.000Z',
    venue: 'Main hall',
    ministry_id: null,
    organizer_member_id: null,
    status: 'draft',
    is_public: false,
    capacity: null,
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-01T09:00:00.000Z',
    event_categories:
      event_categories === null
        ? null
        : { name: 'Conference', colour: '#7c3aed', ...event_categories },
    ministries: ministries ?? null,
    members: members ?? null,
    ...rest,
  };
}

/** An event owned by the choir, which 'user-6' leads. */
export function ministryEventRow(overrides = {}) {
  return eventRow({
    title: 'Choir Concert',
    ministry_id: MINISTRY_CHOIR,
    ministries: { name: 'Choir' },
    ...overrides,
  });
}

export function eventListRow(overrides = {}) {
  return {
    id: EVENT_ID,
    title: 'Annual Harvest Service',
    starts_at: '2026-10-04T09:00:00.000Z',
    ends_at: '2026-10-04T12:00:00.000Z',
    venue: 'Main hall',
    status: 'published',
    is_public: true,
    capacity: 300,
    event_categories: { name: 'Conference', colour: '#7c3aed' },
    ministries: null,
    event_registrations: [{ count: 42 }],
    ...overrides,
  };
}

export function registrationRow(overrides = {}) {
  const { members, ...rest } = overrides;

  const embedded =
    members === null
      ? null
      : {
          member_no: 'MAIN-000101',
          full_name: 'Grace Mensah',
          membership_status: 'active',
          ...members,
        };

  return {
    id: REGISTRATION_ID,
    member_id: MEMBER_ID,
    guest_name: null,
    guest_phone: null,
    guest_email: null,
    status: 'registered',
    notes: null,
    registered_at: '2026-09-10T10:00:00.000Z',
    members: embedded,
    ...rest,
  };
}

export function guestRegistrationRow(overrides = {}) {
  return registrationRow({
    id: '11112222-3333-4444-8555-666677778888',
    member_id: null,
    guest_name: 'Visiting Friend',
    guest_phone: '+233201234567',
    members: null,
    ...overrides,
  });
}

export function categoryRow(overrides = {}) {
  return {
    id: CATEGORY_ID,
    name: 'Conference',
    description: null,
    colour: '#7c3aed',
    is_active: true,
    ...overrides,
  };
}

export function eventPayload(overrides = {}) {
  return {
    title: 'Youth Camp',
    startsAt: '2026-12-01T09:00:00.000Z',
    endsAt: '2026-12-03T16:00:00.000Z',
    ...overrides,
  };
}
