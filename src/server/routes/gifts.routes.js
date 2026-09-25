/**
 * Spiritual-gift endpoints (decision D7).
 *
 *   GET   /api/spiritual-gifts                       the shared lookup
 *   POST  /api/spiritual-gifts                       add a gift        (settings.manage)
 *   PATCH /api/spiritual-gifts/:id                   edit / retire     (settings.manage)
 *   GET   /api/members/:id/spiritual-gifts           a member's gifts  (members.view)
 *   POST  /api/members/:id/spiritual-gifts           attach a gift     (members.update)
 *   DELETE /api/members/:id/spiritual-gifts/:giftId  detach a gift     (members.update)
 *
 * The lookup is edited under `settings.manage` because which gifts a church
 * recognises is policy, like a setting. Attaching one to a member is part of
 * editing that member, so it rides on `members.update`; RLS narrows it to the
 * specific member. There is no delete on the lookup — a gift is retired, not
 * removed (its foreign key is ON DELETE RESTRICT).
 */

import { created, noContent, ok } from '../../lib/http.js';
import { validate } from '../../validation/index.js';
import {
  giftCreateSchema,
  giftUpdateSchema,
  memberGiftAddSchema,
  toGiftRow,
  toGiftView,
  toMemberGiftView,
} from '../../validation/gifts.schemas.js';

export function registerGiftRoutes(router, { gifts, audit }) {
  /* ---- the lookup ------------------------------------------------------- */

  async function listGifts(context) {
    const rows = await gifts.listGifts({
      accessToken: context.session.accessToken,
      includeInactive: context.query.get('all') === '1',
    });
    return ok(rows.map(toGiftView));
  }

  async function createGift(context) {
    const input = validate(giftCreateSchema, await context.json());
    const row = await gifts.createGift({
      accessToken: context.session.accessToken,
      row: toGiftRow(input),
    });

    context.logger.info('spiritual gift created', { giftId: row.id });
    await audit.record(context, {
      action: 'spiritual_gift.created',
      resourceType: 'spiritual_gift',
      resourceId: row.id,
    });
    return created(toGiftView(row));
  }

  async function updateGift(context) {
    const input = validate(giftUpdateSchema, await context.json());
    const row = await gifts.updateGift({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toGiftRow(input),
    });

    context.logger.info('spiritual gift updated', {
      giftId: row.id,
      fields: Object.keys(input).sort(),
    });
    await audit.record(context, {
      action: 'spiritual_gift.updated',
      resourceType: 'spiritual_gift',
      resourceId: row.id,
      changes: { fields: Object.keys(input).sort() },
    });
    return ok(toGiftView(row));
  }

  /* ---- a member's gifts ------------------------------------------------- */

  async function listForMember(context) {
    const rows = await gifts.listForMember({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
    });
    return ok(rows.map(toMemberGiftView));
  }

  async function addForMember(context) {
    const input = validate(memberGiftAddSchema, await context.json());
    const row = await gifts.addForMember({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      giftId: input.giftId,
    });

    context.logger.info('member gift added', { memberId: context.params.id, giftId: input.giftId });
    await audit.record(context, {
      action: 'member.gift_added',
      resourceType: 'member',
      resourceId: context.params.id,
      changes: { giftId: input.giftId },
    });
    return created(toMemberGiftView(row));
  }

  async function removeForMember(context) {
    await gifts.removeForMember({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      giftId: context.params.giftId,
    });

    context.logger.info('member gift removed', {
      memberId: context.params.id,
      giftId: context.params.giftId,
    });
    await audit.record(context, {
      action: 'member.gift_removed',
      resourceType: 'member',
      resourceId: context.params.id,
      changes: { giftId: context.params.giftId },
    });
    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/spiritual-gifts', listGifts, { permission: 'members.view' });
  router.post('/spiritual-gifts', createGift, { permission: 'settings.manage' });
  router.patch('/spiritual-gifts/:id', updateGift, { permission: 'settings.manage' });

  router.get('/members/:id/spiritual-gifts', listForMember, { permission: 'members.view' });
  router.post('/members/:id/spiritual-gifts', addForMember, { permission: 'members.update' });
  router.delete('/members/:id/spiritual-gifts/:giftId', removeForMember, {
    permission: 'members.update',
  });
}
