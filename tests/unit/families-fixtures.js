/**
 * Household-shaped fixtures.
 */

import { BRANCH_MAIN } from './auth-fixtures.js';

export const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
export const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

export function familyRow(overrides = {}) {
  return {
    id: FAMILY_ID,
    branch_id: BRANCH_MAIN,
    family_name: 'The Mensah Family',
    household_phone: '+233201234567',
    household_email: 'mensah@example.com',
    address_line: '12 Independence Avenue',
    city: 'Accra',
    region: 'Greater Accra',
    country: 'Ghana',
    notes: null,
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

/** A list row, with the embedded aggregate PostgREST returns for `count`. */
export function familyListRow(overrides = {}) {
  return {
    id: FAMILY_ID,
    family_name: 'The Mensah Family',
    household_phone: '+233201234567',
    city: 'Accra',
    family_members: [{ count: 4 }],
    ...overrides,
  };
}

/** A family_members row with its embedded member, as the detail query returns it. */
export function familyMemberRow(overrides = {}) {
  const { members, ...rest } = overrides;
  return {
    member_id: MEMBER_ID,
    relationship: 'head',
    is_dependent: false,
    members: {
      member_no: 'MAIN-000101',
      full_name: 'Grace Mensah',
      membership_status: 'active',
      photo_path: null,
      date_of_birth: '1990-04-12',
      ...members,
    },
    ...rest,
  };
}

export function familyPayload(overrides = {}) {
  return { familyName: 'The Osei Household', ...overrides };
}
