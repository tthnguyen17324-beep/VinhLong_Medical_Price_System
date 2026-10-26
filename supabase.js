// Tiện ích dùng chung cho các Pages Function (chạy trên Cloudflare, giữ SERVICE ROLE KEY ở phía máy chủ)

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const svcHeaders = (env) => ({
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
});

/** Xác thực mã đơn vị + token bằng hàm _auth_unit trong DB (chỉ service_role gọi được). */
export async function authUnit(env, code, token) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/_auth_unit`, {
    method: 'POST',
    headers: { ...svcHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_code: String(code || ''), p_token: String(token || '') })
  });
  if (!res.ok) return { ok: false, message: 'Không xác thực được đơn vị' };
  const unit = await res.json();
  if (!unit || unit.id === null) {   // _auth_unit trả dòng rỗng (id null, code = loại lỗi) khi sai mã/token
    return { ok: false, message: unit && unit.code === 'AUTH_BLOCKED'
      ? 'Nhập sai quá nhiều lần, vui lòng thử lại sau ít phút.' : 'Mã đơn vị hoặc Token không chính xác!' };
  }
  return { ok: true, unit };
}

export async function callRpc(env, name, params) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...svcHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

export const storageUpload = (env, path, bytes, contentType) =>
  fetch(`${env.SUPABASE_URL}/storage/v1/object/unit-files/${path}`, {
    method: 'POST',
    headers: { ...svcHeaders(env), 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'false' },
    body: bytes
  });

export const storageRemove = (env, path) =>
  fetch(`${env.SUPABASE_URL}/storage/v1/object/unit-files/${path}`, { method: 'DELETE', headers: svcHeaders(env) });

export async function storageSignedUrl(env, path, seconds = 600) {
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/unit-files/${path}`, {
    method: 'POST',
    headers: { ...svcHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: seconds })
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.signedURL ? `${env.SUPABASE_URL}/storage/v1${j.signedURL}` : null;
}
