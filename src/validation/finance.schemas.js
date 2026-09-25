/**
 * Transaction and category payload validation.
 *
 * Kept in step with the database in `20260826121100_finance.sql`, which is the
 * real enforcement: the state-machine trigger owns the lifecycle, the self-approval
 * constraint owns the second signature, and the check constraints own the
 * income/expense shape. The schemas here mirror those rules so a mistake becomes a
 * field-attributed 422 rather than a raw database error — but they are a courtesy,
 * not the guard.
 *
 * Two fields are deliberately NOT accepted from the client:
 *   - `currency` — stamped server-side from the `finance.currency` setting, so a
 *     transaction is always in the church's configured currency (ADR — currency
 *     from settings). A ledger with a client-chosen currency per row is a ledger
 *     that cannot be summed.
 *   - `status` — the lifecycle lives at `POST /transactions/:id/status`, because
 *     submitting and approving are separate permissions. Same split as events
 *     (ADR-049): letting `PATCH { status }` through would collapse "edit a draft"
 *     and "approve for payment" into one permission.
 */

import { z } from 'zod';

export const TRANSACTION_KINDS = ['income', 'expense'];
export const INCOME_TYPES = ['tithe', 'offering', 'donation', 'other'];
export const PAYMENT_METHODS = ['cash', 'mobile_money', 'bank_transfer', 'cheque', 'card', 'other'];
export const TRANSACTION_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'void'];
export const CATEGORY_KINDS = TRANSACTION_KINDS;

/** A rejection or void must carry a reason of at least this many characters (mirrors the DB). */
const MIN_REASON_LENGTH = 3;

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

/**
 * A money amount for `numeric(14, 2)`.
 *
 * The two-decimal-place limit is checked on the *string* before it becomes a
 * float, so `19.999` is rejected outright rather than silently rounded to `20.00`
 * — a rounded amount is a wrong amount that looks right. The upper bound keeps a
 * fat-fingered entry out of `numeric(14, 2)`'s range and away from float
 * imprecision.
 */
const amount = z
  .union([z.string().trim(), z.number()])
  .refine((value) => value !== '' && value !== null && value !== undefined, 'Enter an amount.')
  .refine((value) => {
    const text = String(value);
    return /^\d+(\.\d{1,2})?$/.test(text);
  }, 'Enter an amount in cedis, with at most two decimal places.')
  .transform((value) => Number(value))
  .refine((value) => value > 0, 'Enter an amount greater than zero.')
  .refine((value) => value <= 1_000_000_000_000, 'That amount is implausibly large.');

/** A plain calendar date, refined not to be in the future (the DB enforces this too). */
const occurredOn = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'That is not a real date.')
  .refine((value) => value <= new Date().toISOString().slice(0, 10), 'That date is in the future.');

const transactionFields = {
  branchId: z.string().uuid('Choose a branch.'),
  kind: z.enum(TRANSACTION_KINDS, { message: 'Choose income or expense.' }),
  categoryId: z.string().uuid('Choose a category.'),
  incomeType: z.enum(INCOME_TYPES, { message: 'Choose what kind of income this is.' }).nullish(),
  // Optional on income: an anonymous offering has no member (owner decision Q4d).
  memberId: z.string().uuid('Choose a member.').nullish(),
  amount,
  occurredOn,
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'Choose how it was paid.' }),
  reference: optionalText(120),
  description: optionalText(2000),
  receiptPath: optionalText(1024),
};

/**
 * The income/expense shape rules, mirrored from the DB check constraints so the
 * message names the field. Income needs an income type; an expense has neither an
 * income type nor a member.
 */
function applyKindRules(schema) {
  return schema
    .refine((value) => value.kind !== 'income' || Boolean(value.incomeType), {
      message: 'Choose what kind of income this is.',
      path: ['incomeType'],
    })
    .refine((value) => value.kind !== 'expense' || !value.incomeType, {
      message: 'An expense has no income type.',
      path: ['incomeType'],
    })
    .refine((value) => value.kind !== 'expense' || !value.memberId, {
      message: 'Only income can be attributed to a member.',
      path: ['memberId'],
    });
}

export const transactionCreateSchema = applyKindRules(z.object(transactionFields).strict());

/**
 * Update. `branchId` and `status` are both absent: a transaction stays in its
 * branch, and the lifecycle is a separate endpoint. The database additionally
 * freezes every financial field once the row leaves draft/rejected, so an edit to
 * a submitted transaction is refused below this layer whatever is sent.
 */
export const transactionUpdateSchema = applyKindRules(
  z
    .object(transactionFields)
    .omit({ branchId: true })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' }),
);

/**
 * The lifecycle endpoint. `reason` is required for a rejection or a void — those
 * are the transitions the DB requires an explanation for, and it belongs in the
 * record, not just a log.
 */
export const transactionStatusSchema = z
  .object({
    status: z.enum(TRANSACTION_STATUSES, { message: 'Choose a valid status.' }),
    reason: optionalText(500),
  })
  .strict()
  .refine(
    (value) =>
      !['rejected', 'void'].includes(value.status) ||
      (value.reason && value.reason.trim().length >= MIN_REASON_LENGTH),
    { message: 'Give a reason of at least 3 characters.', path: ['reason'] },
  );

const categoryFields = {
  kind: z.enum(CATEGORY_KINDS, { message: 'Choose income or expense.' }),
  name: z.string().trim().min(2, 'Give this category a name.').max(80, 'That name is too long.'),
  code: z
    .string()
    .trim()
    .regex(
      /^[A-Z][A-Z0-9_-]{1,15}$/,
      'Use 2–16 characters: an uppercase letter then letters, digits, - or _.',
    )
    .transform((value) => (value === '' ? null : value))
    .nullish(),
  description: optionalText(500),
  sortOrder: z.coerce.number().int().min(0).max(32_000).nullish(),
};

export const categoryCreateSchema = z
  .object({ ...categoryFields, isActive: z.boolean().default(true) })
  .strict();

export const categoryUpdateSchema = z
  .object({ ...categoryFields, isActive: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const TRANSACTION_SORTS = Object.freeze({
  occurred: 'occurred_on',
  amount: 'amount',
  created: 'created_at',
});

/**
 * Payload -> row. Never writes `currency`, `status`, or any actor/timestamp
 * column: currency is stamped by the route, and the lifecycle columns are stamped
 * by the database trigger. Undefined keys are dropped so a PATCH touches only what
 * was sent.
 */
export function toTransactionRow(input) {
  const columns = {
    branch_id: input.branchId,
    kind: input.kind,
    category_id: input.categoryId,
    income_type: input.incomeType,
    member_id: input.memberId,
    amount: input.amount,
    occurred_on: input.occurredOn,
    payment_method: input.paymentMethod,
    reference: input.reference,
    description: input.description,
    receipt_path: input.receiptPath,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toCategoryRow(input) {
  const columns = {
    kind: input.kind,
    name: input.name,
    code: input.code,
    description: input.description,
    is_active: input.isActive,
    sort_order: input.sortOrder,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toTransactionView(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    kind: row.kind,
    categoryId: row.category_id,
    categoryName: row.transaction_categories?.name ?? null,
    categoryCode: row.transaction_categories?.code ?? null,
    incomeType: row.income_type,
    memberId: row.member_id,
    memberNo: row.members?.member_no ?? null,
    memberName: row.members?.full_name ?? null,
    isAnonymous: row.kind === 'income' && row.member_id === null,
    amount: row.amount,
    currency: row.currency,
    occurredOn: row.occurred_on,
    paymentMethod: row.payment_method,
    reference: row.reference,
    description: row.description,
    receiptPath: row.receipt_path,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTransactionListView(row) {
  return {
    id: row.id,
    kind: row.kind,
    categoryName: row.transaction_categories?.name ?? null,
    incomeType: row.income_type,
    memberName: row.members?.full_name ?? null,
    isAnonymous: row.kind === 'income' && row.member_id === null,
    amount: row.amount,
    currency: row.currency,
    occurredOn: row.occurred_on,
    paymentMethod: row.payment_method,
    reference: row.reference,
    status: row.status,
  };
}

export function toCategoryView(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    code: row.code,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}
