/**
 * Spiritual gifts: the shared lookup, and the gifts attached to a member.
 *
 * The lookup is world-readable to any signed-in user and editable only with
 * `settings.manage` (it is church policy, like a setting). The per-member join is
 * scoped by RLS through `app.can_view_member` / `app.can_edit_member`, so it
 * follows the same visibility as the member — no separate permission.
 *
 * There is no delete on the lookup: a gift is retired by clearing `is_active`, and
 * the join's foreign key is `ON DELETE RESTRICT`, so a gift in use cannot vanish
 * from under a member's record.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const GIFT_COLUMNS = 'id, name, description, is_active, sort_order';
const MEMBER_GIFT_COLUMNS = 'gift_id, noted_at, spiritual_gifts ( name, description )';

export function createGiftsService({ getClient = createUserClient } = {}) {
  async function listGifts({ accessToken, includeInactive = false }) {
    let query = getClient(accessToken).from('spiritual_gifts').select(GIFT_COLUMNS);
    if (!includeInactive) query = query.eq('is_active', true);

    const result = await query
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    return unwrap(result, { resource: 'spiritual gift' }) ?? [];
  }

  async function createGift({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('spiritual_gifts')
      .insert(row)
      .select(GIFT_COLUMNS)
      .single();

    return unwrap(result, { resource: 'spiritual gift' });
  }

  async function updateGift({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('spiritual_gifts')
      .update(patch)
      .eq('id', id)
      .select(GIFT_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'spiritual gift' });
    if (!row) throw notFound('That gift does not exist.');
    return row;
  }

  async function listForMember({ accessToken, memberId }) {
    const result = await getClient(accessToken)
      .from('member_spiritual_gifts')
      .select(MEMBER_GIFT_COLUMNS)
      .eq('member_id', memberId)
      .order('noted_at', { ascending: false });

    return unwrap(result, { resource: 'spiritual gift' }) ?? [];
  }

  async function addForMember({ accessToken, memberId, giftId }) {
    const result = await getClient(accessToken)
      .from('member_spiritual_gifts')
      .insert({ member_id: memberId, gift_id: giftId })
      .select(MEMBER_GIFT_COLUMNS)
      .single();

    return unwrap(result, { resource: 'spiritual gift' });
  }

  async function removeForMember({ accessToken, memberId, giftId }) {
    const result = await getClient(accessToken)
      .from('member_spiritual_gifts')
      .delete()
      .eq('member_id', memberId)
      .eq('gift_id', giftId)
      .select('gift_id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'spiritual gift' });
    if (!row) throw notFound('That gift is not recorded for this member.');
    return row;
  }

  return { listGifts, createGift, updateGift, listForMember, addForMember, removeForMember };
}
