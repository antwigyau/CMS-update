/**
 * Member-shaped fixtures. The query recorder itself lives in query-recorder.js
 * and is shared with the other feature modules.
 */

import { BRANCH_MAIN } from './auth-fixtures.js';

export { createQueryRecorder } from './query-recorder.js';

/** A row as the database would return it, with sensible defaults. */
export function memberRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    member_no: 'MAIN-000101',
    branch_id: BRANCH_MAIN,
    user_id: null,
    first_name: 'Grace',
    middle_name: null,
    last_name: 'Mensah',
    full_name: 'Grace Mensah',
    gender: 'female',
    date_of_birth: '1990-04-12',
    marital_status: 'single',
    occupation: 'Teacher',
    phone: '+233201234567',
    alt_phone: null,
    email: 'grace@example.com',
    address_line: '12 Independence Avenue',
    city: 'Accra',
    region: 'Greater Accra',
    country: 'Ghana',
    nationality: 'Ghanaian',
    membership_status: 'active',
    date_joined: '2020-01-05',
    is_baptized: true,
    baptism_date: '2020-06-14',
    photo_path: null,
    notes: null,
    created_at: '2026-08-01T09:00:00.000Z',
    updated_at: '2026-08-01T09:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

/** A minimal valid create payload. */
export function memberPayload(overrides = {}) {
  return {
    firstName: 'Kofi',
    lastName: 'Annan',
    ...overrides,
  };
}
