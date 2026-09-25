/**
 * Request validation.
 *
 * Every schema is `.strict()`, so an unknown key is an error rather than being
 * quietly dropped. That is the difference between rejecting a mass-assignment
 * attempt and silently ignoring it — and it also catches typos in our own
 * frontend during development.
 */

import { z } from 'zod';
import { validationFailed } from '../lib/errors.js';

/**
 * Validate a payload, or throw a 422 carrying field-level detail.
 *
 * The details are safe to expose: they name fields and say what was wrong with
 * them, and never echo the submitted value — which matters when the field is a
 * password.
 */
export function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;

  const fieldErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join('.') || '_';
    if (!fieldErrors[field]) fieldErrors[field] = issue.message;
  }

  throw validationFailed('Some of the information you entered needs correcting.', {
    details: { fields: fieldErrors },
  });
}

/* -------------------------------------------------------------------------- */
/* Shared field types                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Emails are lowercased and trimmed here so that "Grace@Example.com " and
 * "grace@example.com" are the same account. Validation is deliberately
 * permissive — Supabase Auth is authoritative, and an over-clever regex rejects
 * valid addresses.
 */
export const emailField = z
  .string()
  .trim()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .toLowerCase()
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.');

/** Login: any non-empty string. Length rules belong on the *setting* of a password. */
export const currentPasswordField = z.string().min(1, 'Enter your password.');

/**
 * Setting a password. The minimum is 12 rather than 8: this system holds
 * personal data on a congregation, and 8 characters is no longer a meaningful
 * barrier. No composition rules (one upper, one digit, one symbol) — they push
 * people towards `Password1!` and are not what makes a password strong.
 */
export const newPasswordField = z
  .string()
  .min(12, 'Use at least 12 characters. A short phrase is easier to remember and harder to guess.')
  .max(200, 'That password is too long.');

/* -------------------------------------------------------------------------- */
/* Auth payloads                                                             */
/* -------------------------------------------------------------------------- */

export const loginSchema = z
  .object({
    email: emailField,
    password: currentPasswordField,
  })
  .strict();

export const passwordForgotSchema = z
  .object({
    email: emailField,
  })
  .strict();

export const passwordResetSchema = z
  .object({
    // The `token_hash` from the recovery email link. Named `tokenHash` so the
    // logger's key-based redaction masks it if it ever reaches a log line.
    tokenHash: z.string().min(10, 'This password reset link is not valid.').max(512),
    password: newPasswordField,
  })
  .strict();
