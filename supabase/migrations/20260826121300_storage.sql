-- ============================================================================
-- 0013 · Storage buckets and policies
-- ----------------------------------------------------------------------------
-- Every bucket is PRIVATE. Reads happen through short-lived signed URLs that the
-- API mints only after confirming the caller may see the parent record, so a
-- leaked URL expires rather than exposing a member's photo indefinitely.
--
-- `allowed_mime_types` and `file_size_limit` are enforced by Supabase Storage
-- itself, which is a real server-side check rather than a client-side hint. The
-- API additionally sniffs magic bytes, because a declared content type is just a
-- header. SVG is excluded from every bucket on purpose: it is a document format
-- that can carry script.
--
-- Path conventions, which the policies below depend on:
--   member-photos     {branch_id}/{member_id}/{uuid}.{ext}
--   user-avatars      {user_id}/{uuid}.{ext}
--   finance-receipts  {branch_id}/{yyyy}/{mm}/{transaction_id}/{uuid}.{ext}
--   event-media       {branch_id}/{event_id}/{uuid}.{ext}
-- ============================================================================

-- A storage path segment is text. Casting it straight to uuid would raise on a
-- malformed path and turn a bad upload into an error rather than a denial.
create or replace function app.try_uuid(p_value text) returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p_value::uuid;
exception
  when others then
    return null;
end;
$$;

grant execute on function app.try_uuid(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('member-photos', 'member-photos', false, 2097152,
    array['image/jpeg', 'image/png', 'image/webp']),
  ('user-avatars', 'user-avatars', false, 1048576,
    array['image/jpeg', 'image/png', 'image/webp']),
  ('finance-receipts', 'finance-receipts', false, 5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('event-media', 'event-media', false, 5242880,
    array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- member-photos
--
-- Directory holders can see photos: a name without a face is not much use to an
-- usher on the door. Changing one needs members.photo.manage.
-- ---------------------------------------------------------------------------

create policy member_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'member-photos'
    and (
      app.has_permission_in('members.view', app.try_uuid((storage.foldername(name))[1]))
      or app.has_permission_in('members.view_directory', app.try_uuid((storage.foldername(name))[1]))
    )
  );

create policy member_photos_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'member-photos'
    and app.has_permission_in('members.photo.manage', app.try_uuid((storage.foldername(name))[1]))
  );

create policy member_photos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'member-photos'
    and app.has_permission_in('members.photo.manage', app.try_uuid((storage.foldername(name))[1]))
  );

create policy member_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'member-photos'
    and app.has_permission_in('members.photo.manage', app.try_uuid((storage.foldername(name))[1]))
  );

-- ---------------------------------------------------------------------------
-- user-avatars — first path segment is the owning user's id
-- ---------------------------------------------------------------------------

create policy user_avatars_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-avatars'
    and (
      app.try_uuid((storage.foldername(name))[1]) = auth.uid()
      or app.has_permission('users.view')
    )
  );

create policy user_avatars_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-avatars'
    and (
      app.try_uuid((storage.foldername(name))[1]) = auth.uid()
      or app.has_permission('users.update')
    )
  );

create policy user_avatars_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'user-avatars'
    and (
      app.try_uuid((storage.foldername(name))[1]) = auth.uid()
      or app.has_permission('users.update')
    )
  );

create policy user_avatars_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-avatars'
    and (
      app.try_uuid((storage.foldername(name))[1]) = auth.uid()
      or app.has_permission('users.update')
    )
  );

-- ---------------------------------------------------------------------------
-- finance-receipts — the most sensitive bucket
--
-- No delete policy: a receipt supports a transaction that cannot be deleted
-- either, so removing the evidence must not be possible through the API.
-- ---------------------------------------------------------------------------

create policy finance_receipts_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'finance-receipts'
    and app.has_permission_in('finance.view', app.try_uuid((storage.foldername(name))[1]))
  );

create policy finance_receipts_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'finance-receipts'
    and app.has_permission_in('finance.create', app.try_uuid((storage.foldername(name))[1]))
  );

create policy finance_receipts_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'finance-receipts'
    and app.has_permission_in('finance.update', app.try_uuid((storage.foldername(name))[1]))
  );

-- ---------------------------------------------------------------------------
-- event-media
-- ---------------------------------------------------------------------------

create policy event_media_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'event-media'
    and app.has_permission_in('events.view', app.try_uuid((storage.foldername(name))[1]))
  );

create policy event_media_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'event-media'
    and app.has_permission_in('events.update', app.try_uuid((storage.foldername(name))[1]))
  );

create policy event_media_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'event-media'
    and app.has_permission_in('events.update', app.try_uuid((storage.foldername(name))[1]))
  );

create policy event_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'event-media'
    and app.has_permission_in('events.update', app.try_uuid((storage.foldername(name))[1]))
  );
