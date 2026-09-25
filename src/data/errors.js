/**
 * Translating PostgREST and PostgreSQL errors into API errors.
 *
 * Everything the database refuses arrives here. Two things must be true of the
 * result: the client learns enough to fix a genuine mistake, and learns nothing
 * about the schema. So the constraint NAME is used to choose a message, and is
 * never included in one — `members_branch_email_key` tells an attacker there is a
 * uniqueness rule on branch and email; "that email address is already in use"
 * tells the user what to do.
 *
 * The original error travels in `cause`, which the logger writes and the client
 * never sees.
 */

import { conflict, forbidden, internalError, notFound, validationFailed } from '../lib/errors.js';

/** PostgreSQL error codes we can say something useful about. */
const CODES = Object.freeze({
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  RESTRICT_VIOLATION: '23001',
  INSUFFICIENT_PRIVILEGE: '42501',
  // PostgREST returns this when a filter matched no rows for .single().
  NO_ROWS: 'PGRST116',
});

/**
 * Constraint name -> field and message.
 *
 * Only constraints a user can actually trip by filling in a form. Anything not
 * listed falls back to a generic 422, because an unrecognised constraint is
 * more likely a bug in our code than a mistake in their input.
 */
const CONSTRAINT_MESSAGES = Object.freeze({
  members_branch_email_key: {
    field: 'email',
    message: 'A member in this branch already uses that email address.',
  },
  members_email_valid: { field: 'email', message: 'Enter a valid email address.' },
  members_phone_valid: { field: 'phone', message: 'Enter a valid phone number.' },
  members_alt_phone_valid: {
    field: 'altPhone',
    message: 'Enter a valid alternative phone number.',
  },
  members_dob_not_future: {
    field: 'dateOfBirth',
    message: 'A date of birth cannot be in the future.',
  },
  members_baptism_consistent: {
    field: 'baptismDate',
    message:
      'A baptism date requires the member to be marked as baptised, and cannot precede their birth.',
  },
  members_joined_after_birth: {
    field: 'dateJoined',
    message: 'The date joined cannot be before the date of birth.',
  },
  members_first_name_length: { field: 'firstName', message: "Enter the member's first name." },
  members_last_name_length: { field: 'lastName', message: "Enter the member's last name." },

  // ---- users / profiles ----
  profiles_full_name_length: {
    field: 'fullName',
    message: 'Enter a name of at least 2 characters.',
  },
  profiles_phone_valid: { field: 'phone', message: 'Enter a valid phone number.' },

  // ---- roles ----
  // The duplicate-key case can only be caught here: two admins racing the same new
  // key both pass Zod, and the database is what refuses the second.
  roles_key_key: { field: 'key', message: 'A role with that key already exists.' },
  roles_key_format: {
    field: 'key',
    message: 'Start with a lowercase letter; 3–40 lowercase letters, digits or underscores.',
  },
  roles_name_length: { field: 'name', message: 'Enter a name of 2 to 60 characters.' },

  // ---- families ----
  families_branch_name_key: {
    field: 'familyName',
    message: 'A household with that name already exists in this branch.',
  },
  families_name_length: {
    field: 'familyName',
    message: 'Enter a name for this household, of at least 2 characters.',
  },
  families_email_valid: { field: 'householdEmail', message: 'Enter a valid email address.' },
  families_phone_valid: { field: 'householdPhone', message: 'Enter a valid phone number.' },
  family_members_one_head: {
    field: 'relationship',
    message: 'This household already has a head. Change the existing head first.',
  },
  family_members_one_household: {
    field: 'memberId',
    message: 'That member already belongs to another household.',
  },
  family_members_member_fkey: {
    field: 'memberId',
    message: 'That member is not in this branch.',
  },

  // ---- ministries ----
  ministries_branch_name_key: {
    field: 'name',
    message: 'A ministry with that name already exists in this branch.',
  },
  ministries_branch_code_key: {
    field: 'code',
    message: 'That short code is already used by another ministry.',
  },
  ministries_code_format: {
    field: 'code',
    message: 'Use 2–16 letters, digits, hyphens or underscores.',
  },
  ministries_name_length: { field: 'name', message: 'Enter a name of at least 2 characters.' },
  ministries_meeting_day_range: {
    field: 'meetingDay',
    message: 'Choose a day of the week.',
  },
  ministry_members_one_active_leader: {
    field: 'roleInMinistry',
    message: 'This ministry already has a leader. Change or end the current leadership first.',
  },
  ministry_members_active_key: {
    field: 'memberId',
    message: 'That member is already in this ministry.',
  },
  ministry_members_member_fkey: {
    field: 'memberId',
    message: 'That member is not in this branch.',
  },
  ministry_members_dates: {
    field: 'leftOn',
    message: 'The date left cannot be before the date joined.',
  },

  // ---- attendance ----
  attendance_sessions_service_key: {
    field: 'title',
    message: 'A session with that title already exists for this date.',
  },
  attendance_sessions_type_reference: {
    field: 'sessionType',
    message:
      'A service is not tied to a ministry or event; a ministry or event session must name one.',
  },
  attendance_sessions_times: {
    field: 'endTime',
    message: 'The end time cannot be before the start time.',
  },
  attendance_sessions_date_not_future: {
    field: 'sessionDate',
    message: 'A session cannot be dated more than a day ahead.',
  },
  attendance_sessions_counts_non_negative: {
    field: 'countAdults',
    message: 'A headcount cannot be negative.',
  },
  attendance_sessions_title_length: {
    field: 'title',
    message: 'Give this session a title of at least 2 characters.',
  },
  attendance_records_member_key: {
    field: 'memberId',
    message: 'That member is already recorded for this session.',
  },
  attendance_records_subject: {
    field: 'memberId',
    message: 'Record either a member or a guest name, not both.',
  },
  attendance_records_member_fkey: {
    field: 'memberId',
    message: 'That member is not in this branch.',
  },
  attendance_records_session_fkey: {
    field: 'sessionId',
    message: 'That attendance session does not exist in this branch.',
  },

  // ---- events ----
  events_ends_after_starts: {
    field: 'endsAt',
    message: 'The event must end after it starts.',
  },
  events_title_length: { field: 'title', message: 'Give this event a title.' },
  events_capacity_positive: {
    field: 'capacity',
    message: 'A capacity of zero would mean nobody can attend.',
  },
  events_ministry_fkey: {
    field: 'ministryId',
    message: 'That ministry is not in this branch.',
  },
  events_organizer_fkey: {
    field: 'organizerMemberId',
    message: 'That member is not in this branch.',
  },
  event_registrations_member_key: {
    field: 'memberId',
    message: 'That member is already registered for this event.',
  },
  event_registrations_subject: {
    field: 'memberId',
    message: 'Register either a member or a guest name, not both.',
  },
  event_registrations_member_fkey: {
    field: 'memberId',
    message: 'That member is not in this branch.',
  },
  event_registrations_guest_email_valid: {
    field: 'guestEmail',
    message: 'Enter a valid email address.',
  },
  event_registrations_guest_phone_valid: {
    field: 'guestPhone',
    message: 'Enter a valid phone number.',
  },
  event_categories_name_key: {
    field: 'name',
    message: 'A category with that name already exists.',
  },

  // ---- finance ----
  transactions_amount_positive: {
    field: 'amount',
    message: 'Enter an amount greater than zero.',
  },
  transactions_occurred_not_future: {
    field: 'occurredOn',
    message: 'A transaction cannot be dated in the future.',
  },
  transactions_income_type_required: {
    field: 'incomeType',
    message: 'Choose what kind of income this is.',
  },
  transactions_income_type_only_for_income: {
    field: 'incomeType',
    message: 'An expense has no income type.',
  },
  transactions_member_only_for_income: {
    field: 'memberId',
    message: 'Only income can be attributed to a member.',
  },
  transactions_member_fkey: {
    field: 'memberId',
    message: 'That member is not in this branch.',
  },
  transactions_no_self_approval: {
    field: 'status',
    message: 'You cannot approve a transaction you submitted. It needs a second person.',
  },
  transactions_rejected_complete: {
    field: 'reason',
    message: 'A rejection needs a reason of at least 3 characters.',
  },
  transactions_void_complete: {
    field: 'reason',
    message: 'Voiding needs a reason of at least 3 characters.',
  },
  transactions_reference_length: {
    field: 'reference',
    message: 'That reference is too long.',
  },
  transactions_description_length: {
    field: 'description',
    message: 'That description is too long.',
  },
  transaction_categories_name_length: {
    field: 'name',
    message: 'Give this category a name of at least 2 characters.',
  },
  transaction_categories_code_format: {
    field: 'code',
    message: 'Use 2–16 characters: an uppercase letter then letters, digits, - or _.',
  },
  transaction_categories_kind_name_key: {
    field: 'name',
    message: 'A category with that name already exists for this kind.',
  },
  transaction_categories_code_key: {
    field: 'code',
    message: 'That code is already in use.',
  },

  // ---- emergency contacts ----
  mec_one_primary_per_member: {
    field: 'isPrimary',
    message: 'This member already has a primary emergency contact. Unset that one first.',
  },
  mec_name_length: {
    field: 'name',
    message: 'Give the contact a name of at least 2 characters.',
  },
  mec_relationship_length: {
    field: 'relationship',
    message: 'Say how they are related, in 2 to 60 characters.',
  },
  mec_phone_valid: {
    field: 'phone',
    message: 'Enter a valid phone number.',
  },
  mec_alt_phone_valid: {
    field: 'altPhone',
    message: 'Enter a valid alternative phone number.',
  },

  // ---- spiritual gifts ----
  spiritual_gifts_name_length: {
    field: 'name',
    message: 'Give the gift a name of 2 to 60 characters.',
  },
  spiritual_gifts_name_key: {
    field: 'name',
    message: 'A gift with that name already exists.',
  },
  member_spiritual_gifts_pkey: {
    field: 'giftId',
    message: 'This member already has that gift recorded.',
  },

  // ---- notifications ----
  // Zod catches these first from the compose form; these keep a database-side
  // failure field-attributed and free of any constraint name.
  notifications_title_length: {
    field: 'title',
    message: 'Enter a title of 2 to 160 characters.',
  },
  notifications_body_length: {
    field: 'body',
    message: 'Enter a message of 2 to 4000 characters.',
  },
  notifications_link_relative: {
    field: 'linkPath',
    message: 'Enter a relative link that starts with /.',
  },
  notifications_expiry_after_publish: {
    field: 'expiresAt',
    message: 'The expiry must be after the publish time.',
  },
  notifications_audience_role: {
    field: 'audienceRoleId',
    message: 'Choose a role for a role-targeted notification.',
  },
});

function findConstraintName(error) {
  const haystack = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.constraint ?? ''}`;
  for (const name of Object.keys(CONSTRAINT_MESSAGES)) {
    if (haystack.includes(name)) return name;
  }
  return null;
}

/**
 * @param {object} error         The error object from supabase-js.
 * @param {object} [options]
 * @param {string} [options.resource]  Used in a 404 message, e.g. 'member'.
 */
export function mapDatabaseError(error, { resource = 'record' } = {}) {
  const code = error?.code;

  if (code === CODES.NO_ROWS) {
    // Also the answer when RLS hid the row: "does not exist" and "you may not see
    // it" must be indistinguishable, or a 403 confirms the id is real.
    return notFound(`That ${resource} does not exist.`, { cause: error });
  }

  if (code === CODES.INSUFFICIENT_PRIVILEGE || /row-level security/i.test(error?.message ?? '')) {
    return forbidden('You do not have permission to do that.', { cause: error });
  }

  if (code === CODES.RESTRICT_VIOLATION) {
    // Raised by our own triggers — immutable member numbers, closed attendance
    // sessions, locked transactions. The message is written for a user.
    return conflict(error?.message ?? 'That change is not allowed.', { cause: error });
  }

  const constraint = findConstraintName(error);
  if (constraint) {
    const { field, message } = CONSTRAINT_MESSAGES[constraint];
    const status = code === CODES.UNIQUE_VIOLATION ? conflict : validationFailed;
    return status('Some of the information you entered needs correcting.', {
      details: { fields: { [field]: message } },
      cause: error,
    });
  }

  if (code === CODES.UNIQUE_VIOLATION) {
    return conflict('That record already exists.', { cause: error });
  }
  if (code === CODES.FOREIGN_KEY_VIOLATION) {
    return validationFailed('One of the linked records does not exist.', { cause: error });
  }
  if (code === CODES.CHECK_VIOLATION || code === CODES.NOT_NULL_VIOLATION) {
    return validationFailed('Some of the information you entered needs correcting.', {
      cause: error,
    });
  }

  // Unrecognised: a 500 with nothing exposed. The detail is in the log.
  return internalError(error?.message ?? 'A database error occurred.', { cause: error });
}

/** Throw if the supabase-js result carries an error; otherwise return the data. */
export function unwrap(result, options) {
  if (result?.error) throw mapDatabaseError(result.error, options);
  return result?.data;
}
