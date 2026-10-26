-- =====================================================================
-- Migration 002: các RPC / bảng bổ sung cho frontend mới (Cloudflare Pages)
-- =====================================================================

-- Thông tin người nhập liệu (Trang 1 - mục B) lưu tạm theo đơn vị
alter table units add column if not exists draft_contact jsonb;

-- ---------------------------------------------------------------------
-- Bộ đếm "Đang kết nối" (thay Firebase presence): mỗi trình duyệt ping 60s/lần.
-- Không dùng Realtime để tránh giới hạn kết nối đồng thời.
-- ---------------------------------------------------------------------
create table if not exists active_sessions (
  session_id uuid primary key,
  seen_at    timestamptz not null default now()
);
alter table active_sessions enable row level security;

create or replace function ping_presence(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
begin
  insert into active_sessions (session_id, seen_at) values (p_session, now())
  on conflict (session_id) do update set seen_at = now();
  if random() < 0.05 then
    delete from active_sessions where seen_at < now() - interval '10 minutes';
  end if;
  return (select count(*)::int from active_sessions where seen_at > now() - interval '2 minutes');
end $$;
grant execute on function ping_presence(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Danh sách chương PL3 + số dịch vụ (thay getPL3Chapters)
-- ---------------------------------------------------------------------
create or replace function pl3_chapters(p_scope text)
returns table (name text, cnt bigint)
language sql stable as $$
  select chapter, count(*) from catalog_pl3 where scope = p_scope
  group by chapter order by min(row_no)
$$;
grant execute on function pl3_chapters(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Lưu thông tin người nhập liệu + loại hình cơ sở (thay payloadMeta của Firebase)
-- ---------------------------------------------------------------------
create or replace function save_draft_meta(p_code text, p_token text, p_contact jsonb,
                                           p_facility_type facility_type default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units;
begin
  u := _auth_unit(p_code, p_token);
  if u.is_locked then
    raise exception 'UNIT_LOCKED: Đơn vị đã gửi báo cáo chính thức, dữ liệu chỉ ở chế độ xem.' using errcode = 'P0001';
  end if;
  update units set draft_contact = coalesce(p_contact, draft_contact),
                   facility_type = coalesce(p_facility_type, facility_type)
   where id = u.id;
  return jsonb_build_object('success', true);
end $$;
grant execute on function save_draft_meta(text, text, jsonb, facility_type) to anon, authenticated;

-- ---------------------------------------------------------------------
-- get_unit_state: bổ sung draftContact; chỉ trả các dòng đang được chọn
-- ---------------------------------------------------------------------
create or replace function get_unit_state(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u units; v_sel jsonb; v_files jsonb; v_last jsonb;
begin
  u := _auth_unit(p_code, p_token);

  select coalesce(jsonb_object_agg(a.appendix::text, a.items), '{}'::jsonb) into v_sel
  from (
    select appendix,
           jsonb_object_agg(item_key, jsonb_build_object('tichChon', true, 'ghiChu', note, 'chuong', chapter)) as items
    from unit_selections where unit_id = u.id and is_selected group by appendix
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object(
           'type', file_type, 'name', original_name, 'path', storage_path,
           'size', size_bytes, 'uploadedAt', uploaded_at) order by uploaded_at), '[]'::jsonb)
    into v_files from unit_files where unit_id = u.id and is_current;

  select to_jsonb(s) into v_last from (
    select submitted_at, contact_name, department, position, phone, contact_email, status,
           pl1_kham_benh, pl1_hoi_chan, pl1_giam_dinh, pl1_ksk_lao_dong, pl1_ksk_xkld,
           count_pl2, count_pl3, count_pl4, count_pl5, total_kt,
           old_folder_url, old_report_sheet_url, cpql_url, new_report_url
    from submissions where unit_id = u.id order by submitted_at desc limit 1) s;

  return jsonb_build_object(
    'unit', jsonb_build_object(
        'code', u.code, 'name', u.name, 'email', u.email, 'facilityType', u.facility_type,
        'isLocked', u.is_locked, 'lockedAt', u.locked_at,
        'oldFolderUrl', u.old_folder_url, 'oldReportSheetUrl', u.old_report_sheet_url,
        'cpqlUrl', u.cpql_url, 'newReportUrl', u.new_report_url,
        'supplementRequest', u.supplement_request, 'supplementResult', u.supplement_result),
    'readOnly',     u.is_locked,
    'draftContact', u.draft_contact,
    'selections',   v_sel,
    'files',        v_files,
    'lastSubmission', v_last);
end $$;
grant execute on function get_unit_state(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Tra cứu phiên cuối: bổ sung danh sách tệp đính kèm
-- ---------------------------------------------------------------------
create or replace function lookup_latest_submission(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units; s record; v_files jsonb;
begin
  u := _auth_unit(p_code, p_token);
  select * into s from submissions where unit_id = u.id order by submitted_at desc limit 1;
  if not found then
    raise exception 'NO_SUBMISSION: Đơn vị chưa có phiên báo cáo nào được ghi nhận trên hệ thống!' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('type', file_type, 'name', original_name, 'path', storage_path)
                            order by uploaded_at), '[]'::jsonb)
    into v_files from unit_files where unit_id = u.id and is_current;
  return jsonb_build_object(
    'tenDonVi', u.name, 'isLocked', u.is_locked,
    'status', case when u.is_locked then 'Đã khóa' else 'Đang mở khóa' end,
    'oldFolderUrl', coalesce(s.old_folder_url, u.old_folder_url),
    'oldReportSheetUrl', coalesce(s.old_report_sheet_url, u.old_report_sheet_url),
    'newReportUrl', coalesce(s.new_report_url, u.new_report_url),
    'cpqlUrl', coalesce(s.cpql_url, u.cpql_url),
    'submittedAt', s.submitted_at, 'hoTen', s.contact_name, 'khoaPhong', s.department,
    'chucVu', s.position, 'soDienThoai', s.phone, 'email', s.contact_email,
    'counts', jsonb_build_object('pl1_kb', s.pl1_kham_benh, 'pl1_hc', s.pl1_hoi_chan, 'pl1_gd', s.pl1_giam_dinh,
        'pl1_skld', s.pl1_ksk_lao_dong, 'pl1_xkd', s.pl1_ksk_xkld,
        'c2', s.count_pl2, 'c3', s.count_pl3, 'c4', s.count_pl4, 'c5', s.count_pl5, 'totalKT', s.total_kt),
    'noiDungYeuCauBoSung', coalesce(nullif(u.supplement_request,''), 'Không có yêu cầu bổ sung'),
    'ketQuaBoSung', coalesce(u.supplement_result, ''),
    'files', v_files);
end $$;
grant execute on function lookup_latest_submission(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Các phiên đã gửi + khôi phục (thay getSubmittedSessions / loadDraftReport theo phiên)
-- ---------------------------------------------------------------------
create or replace function list_submissions(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units;
begin
  u := _auth_unit(p_code, p_token);
  return jsonb_build_object('tenDonVi', u.name, 'list', coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', id, 'submittedAt', submitted_at, 'hoTen', contact_name, 'khoaPhong', department,
        'chucVu', position, 'soDienThoai', phone, 'email', contact_email, 'status', status,
        'hasSnapshot', snapshot is not null) order by submitted_at desc)
    from submissions where unit_id = u.id), '[]'::jsonb));
end $$;
grant execute on function list_submissions(text, text) to anon, authenticated;

-- Khôi phục tích chọn từ ảnh chụp (snapshot) của một phiên gửi bằng web. Chỉ khi đơn vị đang mở khóa.
create or replace function restore_submission(p_code text, p_token text, p_submission_id bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units; s submissions; n int;
begin
  u := _auth_unit(p_code, p_token);
  if u.is_locked then
    raise exception 'UNIT_LOCKED: Đơn vị đang khóa. Liên hệ Sở Y tế để mở khóa trước khi khôi phục phiên cũ.' using errcode = 'P0001';
  end if;
  select * into s from submissions where id = p_submission_id and unit_id = u.id;
  if not found then raise exception 'Không tìm thấy phiên gửi'; end if;
  if s.snapshot is null then
    return jsonb_build_object('success', true, 'restored', 0, 'note', 'legacy');
  end if;
  delete from unit_selections where unit_id = u.id;
  insert into unit_selections (unit_id, appendix, item_key, is_selected, note, chapter, source)
  select u.id, (i->>'appendix')::smallint, i->>'key', true, coalesce(i->>'note',''), nullif(i->>'chapter',''), 'web'
  from jsonb_array_elements(s.snapshot->'selections') i
  on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('success', true, 'restored', n);
end $$;
grant execute on function restore_submission(text, text, bigint) to anon, authenticated;

-- ---------------------------------------------------------------------
-- QUẢN TRỊ: tạo tài khoản admin trong Supabase Auth (Dashboard > Authentication > Users),
-- sau đó đặt vai trò (thay email thật):
--   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'
--   where email = 'admin@example.com';
-- ---------------------------------------------------------------------
