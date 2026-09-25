/**
 * A member's photo, with upload and removal for those who may manage it.
 *
 * The upload is a three-step handshake so the file never passes through our API
 * (whose body cap is far below a 2 MB photo):
 *
 *   1. ask the API for a signed upload URL and the path it will live at;
 *   2. PUT the file bytes straight to Supabase Storage at that URL;
 *   3. confirm the path back to the API, which records it on the member.
 *
 * Honest limit: step 2's exact wire format is Supabase's and has not been run
 * against a real project here. If it needs adjusting, this is the one place.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render } from '../core/dom.js';
import { notify } from '../core/toast.js';

const ACCEPTED = { 'image/jpeg': true, 'image/png': true, 'image/webp': true };
const MAX_BYTES = 2 * 1024 * 1024;

export function memberPhotoSection({ member, canManage }) {
  const base = `/members/${encodeURIComponent(member.id)}/photo`;
  const imageRegion = el('div', { class: 'member-photo__frame' });

  function placeholder() {
    return el('div', { class: 'member-photo__placeholder' }, [icon('person')]);
  }

  async function loadPhoto() {
    render(imageRegion, [placeholder()]);
    try {
      const payload = await api.get(base);
      if (payload.data.url) {
        render(imageRegion, [
          el('img', { class: 'member-photo__img', src: payload.data.url, alt: member.fullName }),
        ]);
      }
    } catch {
      // A missing photo is not an error worth shouting about; keep the placeholder.
    }
  }

  async function upload(file) {
    if (!ACCEPTED[file.type]) {
      notify.error('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      notify.error('That image is larger than 2 MB. Choose a smaller one.');
      return;
    }

    try {
      const { data } = await api.post(`${base}/upload-url`, { contentType: file.type });

      // Step 2: the bytes go straight to Storage, not through our API.
      const put = await fetch(data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);

      await api.patch(base, { path: data.path });
      notify.success('Photo updated.');
      await loadPhoto();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not upload that photo.');
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${member.fullName}’s photo?`)) return;
    try {
      await api.delete(base);
      notify.success('Photo removed.');
      await loadPhoto();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not remove that photo.');
    }
  }

  const fileInput = el('input', {
    class: 'visually-hidden-input',
    id: 'member-photo-file',
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) upload(file);
    fileInput.value = '';
  });

  const controls = canManage
    ? el('div', { class: 'cluster' }, [
        el('label', { class: 'btn btn-sm btn-outline-secondary', for: 'member-photo-file' }, [
          icon('upload'),
          ' Upload',
        ]),
        el('button', {
          class: 'btn btn-sm btn-outline-secondary',
          type: 'button',
          text: 'Remove',
          onclick: remove,
        }),
        fileInput,
      ])
    : null;

  loadPhoto();

  return el('section', { class: 'card-surface gap-below-5 member-photo' }, [
    el('div', { class: 'card-surface__body' }, [imageRegion, controls]),
  ]);
}
