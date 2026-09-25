/**
 * Ministry-shaped fixtures.
 */

import { BRANCH_MAIN, MINISTRY_CHOIR } from './auth-fixtures.js';

export const MINISTRY_ID = MINISTRY_CHOIR;
export const OTHER_MINISTRY_ID = '6b3c9d77-5e0a-4f3c-9b8d-2c3d4e5f6071';
export const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

export function ministryRow(overrides = {}) {
  return {
    id: MINISTRY_ID,
    branch_id: BRANCH_MAIN,
    name: 'Choir',
    code: 'CHOIR',
    description: 'Music ministry for all services.',
    status: 'active',
    meeting_day: 4,
    meeting_time: '18:30:00',
    meeting_location: 'Main hall',
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export function ministryListRow(overrides = {}) {
  return {
    id: MINISTRY_ID,
    name: 'Choir',
    code: 'CHOIR',
    status: 'active',
    meeting_day: 4,
    meeting_time: '18:30:00',
    ministry_members: [{ count: 12 }],
    ...overrides,
  };
}

export function ministryMemberRow(overrides = {}) {
  const { members, ...rest } = overrides;
  return {
    id: '7c4d0e88-6f1b-4a4d-8c9e-3d4e5f607182',
    member_id: MEMBER_ID,
    role_in_ministry: 'member',
    joined_on: '2024-02-01',
    left_on: null,
    members: {
      member_no: 'MAIN-000101',
      full_name: 'Grace Mensah',
      membership_status: 'active',
      photo_path: null,
      ...members,
    },
    ...rest,
  };
}

export function ministryPayload(overrides = {}) {
  return { name: 'Ushering', ...overrides };
}
