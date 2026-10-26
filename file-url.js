// POST /api/file-url  (JSON: code, token, path) -> { url } liên kết tải có thời hạn 10 phút
import { json, authUnit, storageSignedUrl } from '../_lib/supabase.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ message: 'Yêu cầu không hợp lệ' }, 400); }
  const code = String(body.code || '').trim().toUpperCase();
  const path = String(body.path || '');

  const auth = await authUnit(env, code, body.token);
  if (!auth.ok) return json({ message: auth.message }, 401);
  // Chỉ cho mở tệp thuộc chính đơn vị này
  if (!path.startsWith(auth.unit.code + '/') || path.includes('..')) return json({ message: 'Đường dẫn tệp không hợp lệ' }, 403);

  const url = await storageSignedUrl(env, path, 600);
  if (!url) return json({ message: 'Không tìm thấy tệp' }, 404);
  return json({ url });
}
