/**
 * The financial approval workflow — decisions D3 and D6.
 *
 * This is the most consequential file in the suite. The controls under test are
 * the ones that make the ledger defensible:
 *
 *   * only 'approved' rows count toward any total
 *   * the Finance Officer records and submits; the Senior Pastor approves
 *   * nobody approves their own entry, even a Super Administrator
 *   * financial details freeze on submission — a correction requires a rejection
 *   * there is no delete, ever
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDatabase, createUser, defaultBranchId } from './harness.js';

let db;
let branchId;
let incomeCategory;
let expenseCategory;
const users = {};

/** Insert a draft as the owner, standing in for an already-recorded row. */
async function draft({ amount = 100, kind = 'income', incomeType = 'offering' } = {}) {
  return db.value(
    `insert into public.transactions
       (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
     values ($1, $2, $3, $4, $5, 'GHS', current_date, 'cash')
     returning id`,
    [branchId, kind, kind === 'income' ? incomeCategory : expenseCategory, incomeType, amount],
  );
}

const statusOf = (id) => db.value(`select status from public.transactions where id = $1`, [id]);

before(async () => {
  db = await createTestDatabase();
  branchId = await defaultBranchId(db);

  incomeCategory = await db.value(
    `select id from public.transaction_categories where kind = 'income' and name = 'Offering'`,
  );
  expenseCategory = await db.value(
    `select id from public.transaction_categories where kind = 'expense' and name = 'Utilities'`,
  );

  users.officer = await createUser(db, {
    email: 'officer@church.test',
    roles: ['finance_officer'],
  });
  users.pastor = await createUser(db, { email: 'pastor@church.test', roles: ['senior_pastor'] });
  users.admin = await createUser(db, { email: 'admin@church.test', roles: ['super_admin'] });
  users.secretary = await createUser(db, {
    email: 'sec@church.test',
    roles: ['secretary'],
    branchId,
  });
});

after(async () => {
  await db?.close();
});

/* -------------------------------------------------------------------------- */

describe('recording a transaction', () => {
  it('lets the Finance Officer create a draft', async () => {
    await db.asUser(users.officer, async () => {
      const id = await db.value(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
         values ($1, 'income', $2, 'offering', 1250.50, 'GHS', current_date, 'cash')
         returning id`,
        [branchId, incomeCategory],
      );
      assert.equal(await statusOf(id), 'draft');
      assert.equal(
        await db.value(`select recorded_by from public.transactions where id = $1`, [id]),
        users.officer,
      );
    });
  });

  it('refuses a secretary, who has no finance permissions', async () => {
    await db.asUser(users.secretary, async () => {
      const error = await db.expectRejection(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
         values ($1, 'income', $2, 'offering', 10, 'GHS', current_date, 'cash')`,
        [branchId, incomeCategory],
      );
      assert.match(error.message, /row-level security/i);
    });
  });

  it('cannot be created already approved', async () => {
    await db.asUser(users.admin, async () => {
      const error = await db.expectRejection(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method, status)
         values ($1, 'income', $2, 'offering', 999, 'GHS', current_date, 'cash', 'approved')`,
        [branchId, incomeCategory],
      );
      assert.match(error.message, /must be created as draft or pending_approval/);
    });
  });

  it('requires finance.submit to create a row straight into the approval queue', async () => {
    const noSubmit = await createUser(db, { email: 'nosubmit@church.test' });
    const role = await db.value(
      `insert into public.roles (key, name) values ('recorder', 'Recorder') returning id`,
    );
    await db.sql(
      `insert into public.role_permissions (role_id, permission_id)
       select $1, p.id from public.permissions p where p.key in ('finance.view', 'finance.create')`,
      [role],
    );
    await db.sql(`insert into public.user_roles (user_id, role_id) values ($1, $2)`, [
      noSubmit,
      role,
    ]);

    await db.asUser(noSubmit, async () => {
      const error = await db.expectRejection(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method, status)
         values ($1, 'income', $2, 'offering', 5, 'GHS', current_date, 'cash', 'pending_approval')`,
        [branchId, incomeCategory],
      );
      assert.match(error.message, /finance.submit/);
    });
  });

  it('requires a currency — there is no default to fall back on', async () => {
    const error = await db.expectRejection(
      `insert into public.transactions
         (branch_id, kind, category_id, income_type, amount, occurred_on, payment_method)
       values ($1, 'income', $2, 'offering', 10, current_date, 'cash')`,
      [branchId, incomeCategory],
    );
    assert.match(error.message, /currency/);
  });
});

describe('the approval lifecycle (D3)', () => {
  let id;

  before(async () => {
    id = await draft({ amount: 500 });
  });

  it('starts as a draft that counts for nothing', async () => {
    assert.equal(await statusOf(id), 'draft');
    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.approved_transactions where id = $1`, [
          id,
        ]),
      ),
      0,
    );
  });

  it('cannot jump straight to approved', async () => {
    await db.asUser(users.pastor, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'approved' where id = $1`,
        [id],
      );
      assert.match(error.message, /cannot move from draft to approved/);
    });
  });

  it('is submitted by the Finance Officer, who is stamped on it', async () => {
    await db.asUser(users.officer, async () => {
      await db.sql(`update public.transactions set status = 'pending_approval' where id = $1`, [
        id,
      ]);
    });

    const row = await db.one(
      `select status, submitted_by, submitted_at from public.transactions where id = $1`,
      [id],
    );
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.submitted_by, users.officer);
    assert.ok(
      row.submitted_at,
      'the submission time is recorded without the API having to remember',
    );
  });

  it('cannot be approved by the Finance Officer who submitted it (D6)', async () => {
    await db.asUser(users.officer, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'approved' where id = $1`,
        [id],
      );
      assert.match(error.message, /finance.approve/);
    });
    assert.equal(await statusOf(id), 'pending_approval');
  });

  it('has its financial details frozen while it waits', async () => {
    await db.asUser(users.officer, async () => {
      const error = await db.expectRejection(
        `update public.transactions set amount = 5000 where id = $1`,
        [id],
      );
      assert.match(error.message, /financial details are locked/);
    });
    assert.equal(
      Number(await db.value(`select amount from public.transactions where id = $1`, [id])),
      500,
    );
  });

  it('is approved by the Senior Pastor, who is stamped on it', async () => {
    await db.asUser(users.pastor, async () => {
      await db.sql(`update public.transactions set status = 'approved' where id = $1`, [id]);
    });

    const row = await db.one(
      `select status, approved_by, approved_at from public.transactions where id = $1`,
      [id],
    );
    assert.equal(row.status, 'approved');
    assert.equal(row.approved_by, users.pastor);
    assert.ok(row.approved_at);
  });

  it('only now counts toward the ledger', async () => {
    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.approved_transactions where id = $1`, [
          id,
        ]),
      ),
      1,
    );
  });

  it('cannot be un-approved', async () => {
    await db.asUser(users.pastor, async () => {
      for (const target of ['pending_approval', 'draft', 'rejected']) {
        const error = await db.expectRejection(
          `update public.transactions set status = $2 where id = $1`,
          [id, target],
        );
        assert.match(error.message, /cannot move from approved to/);
      }
    });
  });

  it('cannot have its amount changed after approval', async () => {
    await db.asUser(users.admin, async () => {
      const error = await db.expectRejection(
        `update public.transactions set amount = 1 where id = $1`,
        [id],
      );
      assert.match(error.message, /financial details are locked/);
    });
  });
});

describe('separation of duties (D6)', () => {
  it('blocks a Super Administrator approving their own submission, despite holding both permissions', async () => {
    let id;
    await db.asUser(users.admin, async () => {
      id = await db.value(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method, status)
         values ($1, 'income', $2, 'tithe', 300, 'GHS', current_date, 'cash', 'pending_approval')
         returning id`,
        [branchId, incomeCategory],
      );

      const error = await db.expectRejection(
        `update public.transactions set status = 'approved' where id = $1`,
        [id],
      );
      assert.match(error.message, /transactions_no_self_approval/);
    });

    assert.equal(await statusOf(id), 'pending_approval');

    // A second person can approve it, which is the whole point of the control.
    await db.asUser(users.pastor, async () => {
      await db.sql(`update public.transactions set status = 'approved' where id = $1`, [id]);
    });
    assert.equal(await statusOf(id), 'approved');
  });
});

describe('rejection and correction', () => {
  let id;

  before(async () => {
    id = await draft({ amount: 777 });
    await db.asUser(users.officer, async () => {
      await db.sql(`update public.transactions set status = 'pending_approval' where id = $1`, [
        id,
      ]);
    });
  });

  it('requires a reason to reject', async () => {
    await db.asUser(users.pastor, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'rejected' where id = $1`,
        [id],
      );
      assert.match(error.message, /transactions_rejected_complete/);
    });
  });

  it('rejects with a reason, and stamps who did it', async () => {
    await db.asUser(users.pastor, async () => {
      await db.sql(
        `update public.transactions set status = 'rejected', rejection_reason = 'Receipt does not match the amount'
         where id = $1`,
        [id],
      );
    });

    const row = await db.one(
      `select status, rejected_by, rejection_reason from public.transactions where id = $1`,
      [id],
    );
    assert.equal(row.status, 'rejected');
    assert.equal(row.rejected_by, users.pastor);
    assert.match(row.rejection_reason, /Receipt/);
  });

  it('unfreezes the amount once rejected, so the correction is possible', async () => {
    await db.asUser(users.officer, async () => {
      await db.sql(`update public.transactions set amount = 700 where id = $1`, [id]);
    });
    assert.equal(
      Number(await db.value(`select amount from public.transactions where id = $1`, [id])),
      700,
    );
  });

  it('clears the rejection when resubmitted, so the row does not carry a stale reason', async () => {
    await db.asUser(users.officer, async () => {
      await db.sql(`update public.transactions set status = 'pending_approval' where id = $1`, [
        id,
      ]);
    });

    const row = await db.one(
      `select status, rejection_reason, rejected_by from public.transactions where id = $1`,
      [id],
    );
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.rejection_reason, null);
    assert.equal(row.rejected_by, null);
  });
});

describe('voiding', () => {
  let id;

  before(async () => {
    id = await draft({ amount: 250 });
    await db.asUser(users.officer, async () => {
      await db.sql(`update public.transactions set status = 'pending_approval' where id = $1`, [
        id,
      ]);
    });
    await db.asUser(users.pastor, async () => {
      await db.sql(`update public.transactions set status = 'approved' where id = $1`, [id]);
    });
  });

  it('requires a reason', async () => {
    await db.asUser(users.pastor, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'void' where id = $1`,
        [id],
      );
      assert.match(error.message, /transactions_void_complete/);
    });
  });

  it('refuses a Finance Officer, who cannot void what they recorded', async () => {
    await db.asUser(users.officer, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'void', void_reason = 'Duplicate entry' where id = $1`,
        [id],
      );
      assert.match(error.message, /finance.void/);
    });
  });

  it('voids with a reason, and drops the row out of the ledger', async () => {
    await db.asUser(users.pastor, async () => {
      await db.sql(
        `update public.transactions set status = 'void', void_reason = 'Duplicate of receipt 1043' where id = $1`,
        [id],
      );
    });

    assert.equal(await statusOf(id), 'void');
    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.approved_transactions where id = $1`, [
          id,
        ]),
      ),
      0,
    );
    // The row itself survives, with its reason, which is the difference between
    // voiding and deleting.
    assert.match(
      await db.value(`select void_reason from public.transactions where id = $1`, [id]),
      /Duplicate/,
    );
  });

  it('is terminal', async () => {
    await db.asUser(users.admin, async () => {
      const error = await db.expectRejection(
        `update public.transactions set status = 'approved' where id = $1`,
        [id],
      );
      assert.match(error.message, /cannot move from void to approved/);
    });
  });
});

describe('deletion', () => {
  it('is impossible for every role, including a Super Administrator', async () => {
    const id = await draft({ amount: 42 });

    for (const [name, userId] of Object.entries(users)) {
      await db.asUser(userId, async () => {
        // No DELETE policy exists, so the statement matches no rows rather than
        // raising. The assertion that matters is that the row is still there.
        await db.sql(`delete from public.transactions where id = $1`, [id]);
      });

      assert.equal(
        Number(await db.value(`select count(*)::int from public.transactions where id = $1`, [id])),
        1,
        `${name} managed to delete a transaction`,
      );
    }
  });
});

describe('income and expense shape', () => {
  it('refuses an expense carrying an income type', async () => {
    const error = await db.expectRejection(
      `insert into public.transactions
         (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
       values ($1, 'expense', $2, 'tithe', 50, 'GHS', current_date, 'cash')`,
      [branchId, expenseCategory],
    );
    assert.match(error.message, /income_type_only_for_income/);
  });

  it('requires an income type on income', async () => {
    const error = await db.expectRejection(
      `insert into public.transactions
         (branch_id, kind, category_id, amount, currency, occurred_on, payment_method)
       values ($1, 'income', $2, 50, 'GHS', current_date, 'cash')`,
      [branchId, incomeCategory],
    );
    assert.match(error.message, /income_type_required/);
  });

  it('refuses a zero or negative amount', async () => {
    for (const amount of [0, -10]) {
      const error = await db.expectRejection(
        `insert into public.transactions
           (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
         values ($1, 'income', $2, 'offering', $3, 'GHS', current_date, 'cash')`,
        [branchId, incomeCategory, amount],
      );
      assert.match(error.message, /amount_positive/);
    }
  });

  it('refuses a malformed currency code', async () => {
    const error = await db.expectRejection(
      `insert into public.transactions
         (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
       values ($1, 'income', $2, 'offering', 10, 'ghs', current_date, 'cash')`,
      [branchId, incomeCategory],
    );
    assert.match(error.message, /currency_format/);
  });

  it('refuses a future-dated transaction', async () => {
    const error = await db.expectRejection(
      `insert into public.transactions
         (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
       values ($1, 'income', $2, 'offering', 10, 'GHS', current_date + 1, 'cash')`,
      [branchId, incomeCategory],
    );
    assert.match(error.message, /occurred_not_future/);
  });

  it('keeps money in exact decimal, not floating point', async () => {
    const id = await draft({ amount: 0.1 });
    await db.sql(`update public.transactions set amount = amount + 0.2 where id = $1`, [id]);
    assert.equal(
      await db.value(`select amount::text from public.transactions where id = $1`, [id]),
      '0.30',
    );
  });
});

describe('only approved rows count', () => {
  it('totals the ledger over approved rows alone', async () => {
    const fresh = await createTestDatabase();
    try {
      const freshBranch = await defaultBranchId(fresh);
      const category = await fresh.value(
        `select id from public.transaction_categories where kind = 'income' limit 1`,
      );
      const officer = await createUser(fresh, {
        email: 'ledger-officer@church.test',
        roles: ['finance_officer'],
      });
      const pastor = await createUser(fresh, {
        email: 'ledger-pastor@church.test',
        roles: ['senior_pastor'],
      });

      const make = (amount) =>
        fresh.value(
          `insert into public.transactions
             (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
           values ($1, 'income', $2, 'offering', $3, 'GHS', current_date, 'cash') returning id`,
          [freshBranch, category, amount],
        );

      const approvedId = await make(100);
      const pendingId = await make(200);
      const rejectedId = await make(400);
      await make(800); // stays a draft

      await fresh.asUser(officer, async () => {
        for (const id of [approvedId, pendingId, rejectedId]) {
          await fresh.sql(
            `update public.transactions set status = 'pending_approval' where id = $1`,
            [id],
          );
        }
      });
      await fresh.asUser(pastor, async () => {
        await fresh.sql(`update public.transactions set status = 'approved' where id = $1`, [
          approvedId,
        ]);
        await fresh.sql(
          `update public.transactions set status = 'rejected', rejection_reason = 'wrong category' where id = $1`,
          [rejectedId],
        );
      });

      // 100 approved; 200 pending, 400 rejected, 800 draft all excluded.
      const total = await fresh.value(
        `select coalesce(sum(amount), 0)::text from public.approved_transactions where branch_id = $1`,
        [freshBranch],
      );
      assert.equal(total, '100.00');

      const rowCount = Number(
        await fresh.value(`select count(*)::int from public.transactions where branch_id = $1`, [
          freshBranch,
        ]),
      );
      assert.equal(rowCount, 4, 'all four rows exist; only one of them counts');
    } finally {
      await fresh.close();
    }
  });
});
