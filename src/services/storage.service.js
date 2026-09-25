/**
 * Storage access for member photos.
 *
 * The browser holds no Supabase key, so it cannot talk to Storage directly. This
 * service brokers three things through the caller's own client (so the Storage
 * RLS policies in `20260826121300_storage.sql` apply):
 *
 *   1. a short-lived **signed upload URL** the browser PUTs the file bytes to —
 *      the file never passes through the API, which is why the 128 KB body cap
 *      does not apply to a 2 MB photo;
 *   2. a short-lived **signed read URL**, minted only after the caller is shown to
 *      may see the member, so a leaked URL expires rather than exposing a face;
 *   3. removal of the object.
 *
 * The path convention the policies depend on is `{branch_id}/{member_id}/{uuid}.{ext}`.
 * The first segment is the branch, which is what the policy checks the permission
 * against — so the path is not cosmetic, it is part of the access decision.
 *
 * **Honest limit:** the Supabase Storage wire protocol (signed upload URLs, the
 * MIME and size enforcement on the bucket) has not been exercised against a real
 * project here; it is tested against a shim that records the calls. See
 * docs/SECURITY.md.
 */

import { createUserClient } from '../data/supabase-user.js';
import { conflict } from '../lib/errors.js';

const BUCKET = 'member-photos';
const READ_TTL_SECONDS = 300;

/** The only content types the bucket accepts, mapped to a file extension. */
export const PHOTO_CONTENT_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export function createStorageService({ getClient = createUserClient } = {}) {
  function bucket(accessToken) {
    return getClient(accessToken).storage.from(BUCKET);
  }

  /**
   * Mint a signed URL the browser can PUT the file to, and the path it will live
   * at. The path is returned so the caller can confirm it back when setting
   * `photo_path`.
   */
  async function createMemberPhotoUpload({ accessToken, branchId, memberId, contentType }) {
    const ext = PHOTO_CONTENT_TYPES[contentType];
    if (!ext) {
      throw conflict('That image type is not supported. Use a JPEG, PNG, or WebP.');
    }

    const path = `${branchId}/${memberId}/${crypto.randomUUID()}.${ext}`;
    const { data, error } = await bucket(accessToken).createSignedUploadUrl(path);

    if (error || !data) {
      throw conflict('Could not prepare the photo upload. Please try again.', { cause: error });
    }
    return { path, uploadUrl: data.signedUrl, token: data.token };
  }

  /** A short-lived URL to view the member's current photo. */
  async function signMemberPhoto({ accessToken, path }) {
    const { data, error } = await bucket(accessToken).createSignedUrl(path, READ_TTL_SECONDS);
    if (error || !data) {
      throw conflict('Could not produce a link to that photo.', { cause: error });
    }
    return data.signedUrl;
  }

  async function removeMemberPhoto({ accessToken, path }) {
    const { error } = await bucket(accessToken).remove([path]);
    if (error) {
      throw conflict('Could not remove that photo. Please try again.', { cause: error });
    }
  }

  return { createMemberPhotoUpload, signMemberPhoto, removeMemberPhoto };
}
