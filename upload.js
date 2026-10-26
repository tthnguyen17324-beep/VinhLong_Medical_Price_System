// POST /api/upload  (multipart/form-data: code, token, type, file)
// Kiểm tra token -> kiểm tra đơn vị chưa khóa -> lưu vào Storage (bucket riêng tư) -> ghi nhận vào unit_files
import { json, authUnit, callRpc, storageUpload, storageRemove } from '../_lib/supabase.js';

// type -> { dung lượng tối đa (MB), chỉ nhận PDF }
const FILE_RULES = {
  QD_XepHangBV_hoac_QD_ThanhlapTYT: { maxMb: 1,  pdfOnly: true },
  QD_PheDuyetDVKT:                  { maxMb: 10, pdfOnly: true },
  QD_DuDieuKienKSK:                 { maxMb: 1,  pdfOnly: true },
  HoSo_MinhChungKhac:               { maxMb: 5,  pdfOnly: false }
};

const safeName = (name) =>
  String(name || 'file')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(-120) || 'file';

export async function onRequestPost({ request, env }) {
  let form;
  try { form = await request.formData(); } catch (e) { return json({ success: false, message: 'Dữ liệu tải lên không hợp lệ' }, 400); }
  const code = String(form.get('code') || '').trim().toUpperCase();
  const token = String(form.get('token') || '');
  const type = String(form.get('type') || '');
  const file = form.get('file');

  const rule = FILE_RULES[type];
  if (!rule) return json({ success: false, message: 'Loại tệp không hợp lệ' }, 400);
  if (!file || typeof file === 'string' || !file.size) return json({ success: false, message: 'Chưa chọn tệp' }, 400);
  if (file.size > rule.maxMb * 1024 * 1024) return json({ success: false, message: `Tệp vượt quá ${rule.maxMb}MB` }, 413);
  if (rule.pdfOnly && !(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) {
    return json({ success: false, message: 'Tệp này chỉ nhận định dạng PDF' }, 415);
  }

  const auth = await authUnit(env, code, token);
  if (!auth.ok) return json({ success: false, message: auth.message }, 401);
  if (auth.unit.is_locked) return json({ success: false, message: 'Đơn vị đã gửi báo cáo chính thức, không thể thay đổi tệp.' }, 423);

  const path = `${auth.unit.code}/${type}/${crypto.randomUUID()}_${safeName(file.name)}`;
  const up = await storageUpload(env, path, await file.arrayBuffer(), file.type);
  if (!up.ok) return json({ success: false, message: 'Không lưu được tệp: ' + (await up.text()).slice(0, 200) }, 502);

  const reg = await callRpc(env, 'register_unit_file', {
    p_code: code, p_token: token, p_type: type, p_path: path,
    p_name: file.name, p_mime: file.type || null, p_size: file.size
  });
  if (!reg.ok || reg.body.error) {
    await storageRemove(env, path);
    return json({ success: false, message: String(reg.body.message || 'Không ghi nhận được tệp').replace(/^[A-Z_]+:\s*/, '') }, 400);
  }
  return json({ success: true, file: { type, name: file.name, path, size: file.size } });
}
