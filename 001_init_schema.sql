-- =====================================================================
-- HỆ THỐNG XÂY DỰNG GIÁ DỊCH VỤ KHÁM BỆNH, CHỮA BỆNH TỈNH VĨNH LONG
-- Supabase / PostgreSQL – migration 001: schema khởi tạo
--
-- Ánh xạ từ hệ thống cũ (Google Sheets)         ->  Supabase
--   Danh_sach_don_vi (A..N, NVY, MA_KCB, CPQL…)  ->  units
--   Cac_lan_gui (20 cột + CPQL)                  ->  submissions
--   DM_PL1 / DM_PL2                              ->  catalog_pl1 / catalog_pl2
--   DM_PL3_BV + DM_PL3_TYT                       ->  catalog_pl3 (cột scope = 'BV' | 'TYT')
--   DM_PL4 / DM_PL5                              ->  catalog_pl4 / catalog_pl5
--   Firebase draft + KQ_PL1..5 (tích chọn + ghi chú) -> unit_selections
--   Drive folder/file đính kèm                   ->  unit_files + Storage bucket 'unit-files'
--
-- Nguyên tắc bảo mật:
--   * Token KHÔNG bao giờ trả về trình duyệt; chỉ lưu băm SHA-256 (token_hash).
--   * Bảng nghiệp vụ bật RLS, anon KHÔNG truy cập trực tiếp; mọi thao tác của đơn vị
--     đi qua RPC SECURITY DEFINER (kiểm tra mã đơn vị + token trong mỗi lần gọi).
--   * Danh mục (catalog_*) cho phép anon đọc (dữ liệu công khai theo Thông tư).
--   * Quản trị (Hội đồng tổng hợp) dùng Supabase Auth, claim app_metadata.role = 'admin'
--     -> thay thế mật khẩu cứng "SYT@2026" trong 1_Config.gs.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 0. KIỂU DỮ LIỆU
-- ---------------------------------------------------------------------
do $$ begin
  create type facility_type as enum ('H1','H2','H3','H4','TYT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type unit_file_type as enum (
    'QD_XepHangBV_hoac_QD_ThanhlapTYT',   -- Quyết định xếp hạng BV / thành lập TYT
    'QD_PheDuyetDVKT',                    -- Quyết định phê duyệt danh mục DVKT
    'QD_DuDieuKienKSK',                   -- Quyết định đủ điều kiện khám sức khỏe
    'HoSo_MinhChungKhac'                  -- Hồ sơ minh chứng khác (<= 5MB)
  );
exception when duplicate_object then null; end $$;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- Khóa so khớp dòng danh mục <-> tích chọn (tương đương cleanKey/uniqueKey cũ):
-- lower, trim, bỏ nháy đơn đầu, gộp khoảng trắng.
create or replace function norm_key(p text) returns text
language sql immutable parallel safe as $$
  select regexp_replace(lower(btrim(regexp_replace(coalesce(p,''), '^''+', ''))), '\s+', ' ', 'g')
$$;

-- ---------------------------------------------------------------------
-- 1. ĐƠN VỊ
-- ---------------------------------------------------------------------
create table if not exists units (
  id                   bigint generated always as identity primary key,
  code                 text        not null,              -- MaDonVi (BV001, TY024…), luôn UPPER
  name                 text        not null,              -- TenDonVi
  email                text,                              -- Email đơn vị
  token_hash           text        not null,              -- sha256 hex của Token (cột D cũ)
  facility_type        facility_type,                     -- H1..H4 / TYT (cũ do người dùng chọn ở UI)
  is_locked            boolean     not null default false,-- true sau "Gửi báo cáo chính thức"
  locked_at            timestamptz,

  -- Liên kết hệ thống cũ (Google Drive / Sheets) – giữ để tra cứu & để import
  old_folder_url       text,                              -- cột "File" (L) của Danh_sach_don_vi: thư mục phiên cuối
  old_report_sheet_url text,                              -- file Google Sheet BaoCao_DVKT_… trong thư mục đó (nếu có)
  cpql_url             text,                              -- cột CPQL: Thuyết minh chi phí quản lý
  new_report_url       text,                              -- link báo cáo mới (xuất từ hệ thống mới)

  -- Nghiệp vụ Y (cột C, M, N, NVY, MA_KCB…)
  system_check_note    text,                              -- "Check hệ thống" (C)
  supplement_request   text,                              -- "Nội dung yêu cầu đơn vị bổ sung (Nghiệp vụ Y)" (M)
  supplement_result    text,                              -- "Kết quả bổ sung của đơn vị" (N)
  nvy_review           text,                              -- NVY
  ma_kcb               text,                              -- MA_KCB

  last_submitted_at    timestamptz,                       -- "Thời gian gửi" (E)

  -- Chống dò token
  failed_attempts      int         not null default 0,
  auth_blocked_until   timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint units_code_upper check (code = upper(btrim(code)))
);
create unique index if not exists units_code_uq on units (code);
create trigger trg_units_updated before update on units
  for each row execute function set_updated_at();

-- Thông tin liên hệ người nộp + lịch sử các lần gửi (sheet Cac_lan_gui)
create table if not exists submissions (
  id                 bigint generated always as identity primary key,
  unit_id            bigint      not null references units(id) on delete cascade,
  submitted_at       timestamptz not null default now(),
  contact_name       text,       -- Họ và tên
  department         text,       -- Khoa / Phòng
  position           text,       -- Chức vụ
  phone              text,       -- Số điện thoại
  contact_email      text,       -- Email thao tác
  status             text        not null default 'Đã khóa',    -- 'Đã khóa' | 'Đang mở khóa'
  facility_type      facility_type,

  -- PL1: các dịch vụ được chọn (cột K..O cũ)
  pl1_kham_benh      boolean not null default false,
  pl1_hoi_chan       boolean not null default false,
  pl1_giam_dinh      boolean not null default false,
  pl1_ksk_lao_dong   boolean not null default false,
  pl1_ksk_xkld       boolean not null default false,
  -- số lượng (cột P..T cũ)
  count_pl1          int not null default 0,
  count_pl2          int not null default 0,
  count_pl3          int not null default 0,
  count_pl4          int not null default 0,
  count_pl5          int not null default 0,
  total_kt           int generated always as (count_pl3 + count_pl4 + count_pl5) stored,

  old_folder_url     text,       -- "File": thư mục Drive của phiên (dữ liệu import)
  old_report_sheet_url text,
  cpql_url           text,
  new_report_url     text,
  snapshot           jsonb,      -- ảnh chụp tích chọn + danh sách file tại thời điểm gửi (phiên mới)
  source             text not null default 'web' check (source in ('web','legacy_import')),
  legacy_row         int         -- số dòng gốc trong Cac_lan_gui (để đối soát)
);
create index if not exists submissions_unit_time_idx on submissions (unit_id, submitted_at desc);

-- ---------------------------------------------------------------------
-- 2. DANH MỤC PHỤ LỤC 1..5
--    Cột c3..c9: các cột giá trung gian theo tiêu đề "(3)…(9)" của biểu mẫu.
--    item_key: khóa so khớp với unit_selections (xem norm_key).
-- ---------------------------------------------------------------------

-- PL1: Khám bệnh, hội chẩn. Dòng "Khám bệnh" lặp theo hạng (facility_type = H1..TYT).
create table if not exists catalog_pl1 (
  id             bigint generated always as identity primary key,
  row_no         int     not null,               -- thứ tự hiển thị
  stt            text,
  name           text    not null,               -- Danh mục dịch vụ
  is_header      boolean not null default false,
  facility_type  facility_type,                  -- null = áp dụng mọi loại hình
  c3 numeric(20,4), c4 numeric(20,4), c5 numeric(20,4), c6 numeric(20,4),
  c7 numeric(20,4), c8 numeric(20,4), c9 numeric(20,4),
  proposed_price numeric(20,4),                  -- (10) Giá đề nghị phê duyệt
  bhyt_price     numeric(20,4),                  -- (11)
  non_bhyt_price numeric(20,4),                  -- (12)
  original_note  text,
  item_key       text generated always as (norm_key(name)) stored
);
create index if not exists catalog_pl1_ft_idx on catalog_pl1 (facility_type, row_no);

-- PL2: Ngày giường bệnh. Danh mục lặp theo hạng (H1..H4).
create table if not exists catalog_pl2 (
  id             bigint generated always as identity primary key,
  row_no         int     not null,
  stt            text,
  name           text    not null,
  is_header      boolean not null default false,
  facility_type  facility_type,
  c3 numeric(20,4), c4 numeric(20,4), c5 numeric(20,4), c6 numeric(20,4),
  c7 numeric(20,4), c8 numeric(20,4), c9 numeric(20,4), c10 numeric(20,4),
  proposed_price numeric(20,4),                  -- (11)
  bhyt_price     numeric(20,4),                  -- (12)
  non_bhyt_price numeric(20,4),                  -- (13)
  original_note  text,
  item_key       text generated always as (norm_key(name)) stored
);
create index if not exists catalog_pl2_ft_idx on catalog_pl2 (facility_type, row_no);

-- PL3: DVKT, xét nghiệm. Hai bảng gốc (BV / TYT) gộp một bảng, phân biệt bằng scope.
-- Khóa so khớp: norm(common_code) || '_' || norm(tech_code)  (giống uniqueKey cũ)
create table if not exists catalog_pl3 (
  id                bigint generated always as identity primary key,
  scope             text    not null check (scope in ('BV','TYT')),
  row_no            int     not null,
  stt               text,
  common_code       text,                        -- (2) Mã DVKT dùng chung
  chapter           text    not null,            -- (3) Tên chương theo TT23/2024
  tech_code         text,                        -- (4) Mã kỹ thuật theo TT23
  tech_name         text,                        -- (5)
  approved_name     text,                        -- (6)
  direct_cost_allowance numeric(20,4),           -- (7)
  salary_1800       numeric(20,4),               -- (8)
  salary_2340       numeric(20,4),               -- (9)
  price_tt21_22     numeric(20,4),               -- (10)
  price_2340        numeric(20,4),               -- (11)
  mgmt_cost_4pct    numeric(20,4),               -- (12)
  price_incl_mgmt   numeric(20,4),               -- (13)
  price_70pct       numeric(20,4),               -- (14) chỉ TYT
  proposed_price    numeric(20,4),               -- BV (14) / TYT (15)
  bhyt_price        numeric(20,4),
  non_bhyt_price    numeric(20,4),
  original_note     text,                        -- Ghi chú gốc
  item_key          text generated always as (
                      case when norm_key(common_code) <> ''
                           then norm_key(common_code) || '_' || norm_key(tech_code)
                           else norm_key(tech_code) end) stored,
  unique (scope, row_no)
);
create index if not exists catalog_pl3_chapter_idx on catalog_pl3 (scope, chapter, row_no);
create index if not exists catalog_pl3_key_idx     on catalog_pl3 (scope, item_key);
create index if not exists catalog_pl3_techcode_idx on catalog_pl3 (scope, norm_key(tech_code));
create index if not exists catalog_pl3_common_idx   on catalog_pl3 (scope, norm_key(common_code));

-- PL4: Vô cảm gây tê – cùng khóa như PL3 (mã dùng chung + mã kỹ thuật)
create table if not exists catalog_pl4 (
  id                bigint generated always as identity primary key,
  row_no            int     not null unique,
  stt               text,
  common_code       text,
  chapter           text    not null,
  tech_code         text,
  tech_name         text,
  approved_name     text,
  direct_cost_allowance numeric(20,4),           -- (7)
  salary_1800       numeric(20,4),               -- (8)
  salary_2340       numeric(20,4),               -- (9)
  price_tt21_22     numeric(20,4),               -- (10)
  price_2340        numeric(20,4),               -- (11)
  mgmt_cost_4pct    numeric(20,4),               -- (12)
  price_incl_mgmt   numeric(20,4),               -- (13)
  proposed_price    numeric(20,4),               -- (14)
  bhyt_price        numeric(20,4),
  non_bhyt_price    numeric(20,4),
  original_note     text,
  item_key          text generated always as (
                      case when norm_key(common_code) <> ''
                           then norm_key(common_code) || '_' || norm_key(tech_code)
                           else norm_key(tech_code) end) stored
);
create index if not exists catalog_pl4_key_idx on catalog_pl4 (item_key);
create index if not exists catalog_pl4_chapter_idx on catalog_pl4 (chapter, row_no);

-- PL5: CĐHA sử dụng PACS – không có "Mã kỹ thuật"; khóa = mã dùng chung + tên DVKT TT23
create table if not exists catalog_pl5 (
  id                bigint generated always as identity primary key,
  row_no            int     not null unique,
  stt               text,
  common_code       text,                        -- (2)
  chapter           text    not null,            -- (3)
  tech_name         text,                        -- (4) Tên DVKT theo TT23
  approved_name     text,                        -- (5)
  direct_cost_allowance numeric(20,4),           -- (6)
  salary_2340       numeric(20,4),               -- (7)
  price_8           numeric(20,4),               -- (8)
  film_cost         numeric(20,4),               -- (9)  chi phí bao phim và phim
  price_ex_film     numeric(20,4),               -- (10)
  mgmt_cost_4pct    numeric(20,4),               -- (11)
  price_incl_mgmt   numeric(20,4),               -- (12)
  proposed_price    numeric(20,4),               -- (13)
  bhyt_price        numeric(20,4),
  non_bhyt_price    numeric(20,4),
  original_note     text,
  item_key          text generated always as (
                      case when norm_key(common_code) <> ''
                           then norm_key(common_code) || '_' || norm_key(tech_name)
                           else norm_key(tech_name) end) stored
);
create index if not exists catalog_pl5_key_idx on catalog_pl5 (item_key);
create index if not exists catalog_pl5_chapter_idx on catalog_pl5 (chapter, row_no);

-- ---------------------------------------------------------------------
-- 3. TRẠNG THÁI TÍCH CHỌN (thay Firebase draft + KQ_PL1..5)
--    Mỗi dòng = một dịch vụ mà đơn vị đã xử lý trong một phụ lục.
--    is_selected = 'Có'; dịch vụ không có dòng hoặc is_selected=false = 'Không'.
-- ---------------------------------------------------------------------
create table if not exists unit_selections (
  unit_id      bigint   not null references units(id) on delete cascade,
  appendix     smallint not null check (appendix between 1 and 5),
  item_key     text     not null,                 -- xem catalog_*.item_key
  is_selected  boolean  not null default true,
  note         text     not null default '',      -- "Ghi chú của đơn vị"
  chapter      text,                              -- để tính tiến độ theo chương (PL3/4/5)
  source       text     not null default 'web' check (source in ('web','legacy_import')),
  updated_at   timestamptz not null default now(),
  primary key (unit_id, appendix, item_key)
);
create index if not exists unit_selections_chapter_idx on unit_selections (unit_id, appendix, chapter) where is_selected;
create trigger trg_unit_selections_updated before update on unit_selections
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 4. TỆP ĐÍNH KÈM (file nằm trong Supabase Storage, bucket riêng tư 'unit-files')
--    Đường dẫn chuẩn: {unit_code}/{file_type}/{uuid}_{tên_file_gốc}
-- ---------------------------------------------------------------------
create table if not exists unit_files (
  id             bigint generated always as identity primary key,
  unit_id        bigint         not null references units(id) on delete cascade,
  file_type      unit_file_type not null,
  storage_path   text           not null unique,
  original_name  text           not null,
  mime_type      text,
  size_bytes     bigint         not null check (size_bytes > 0),
  uploaded_at    timestamptz    not null default now(),
  is_current     boolean        not null default true,   -- bản đang dùng; bản cũ giữ lại để truy vết
  constraint other_file_max_5mb check (file_type <> 'HoSo_MinhChungKhac' or size_bytes <= 5*1024*1024),
  constraint file_max_20mb      check (size_bytes <= 20*1024*1024)
);
create unique index if not exists unit_files_current_uq on unit_files (unit_id, file_type) where is_current;

-- ---------------------------------------------------------------------
-- 5. NHẬT KÝ IMPORT TỪ HỆ THỐNG CŨ
-- ---------------------------------------------------------------------
create table if not exists legacy_import_log (
  id               bigint generated always as identity primary key,
  unit_id          bigint references units(id) on delete cascade,
  source_folder_url text,
  source_file_url   text,
  status           text not null check (status in ('ok','no_folder','no_sheet','error','skipped')),
  counts           jsonb,          -- {"pl1":5,"pl2":10,"pl3":467,"pl4":8,"pl5":92}
  message          text,
  imported_at      timestamptz not null default now()
);
create index if not exists legacy_import_log_unit_idx on legacy_import_log (unit_id, imported_at desc);

-- ---------------------------------------------------------------------
-- 6. KHÓA GHI KHI ĐƠN VỊ ĐÃ NỘP (phòng thủ ở tầng DB)
-- ---------------------------------------------------------------------
create or replace function enforce_unit_not_locked() returns trigger
language plpgsql as $$
declare v_locked boolean; v_unit bigint;
begin
  v_unit := coalesce(new.unit_id, old.unit_id);
  -- import từ hệ thống cũ chạy bằng service_role/thủ tục đặt cờ này để bỏ qua khóa
  if current_setting('app.bypass_lock', true) = 'on' then return coalesce(new, old); end if;
  select is_locked into v_locked from units where id = v_unit;
  if coalesce(v_locked, false) then
    raise exception 'UNIT_LOCKED: Đơn vị đã gửi báo cáo chính thức, dữ liệu chỉ ở chế độ xem.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_selections_lock before insert or update or delete on unit_selections
  for each row execute function enforce_unit_not_locked();
create trigger trg_files_lock before insert or update or delete on unit_files
  for each row execute function enforce_unit_not_locked();

-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table units             enable row level security;
alter table submissions       enable row level security;
alter table unit_selections   enable row level security;
alter table unit_files        enable row level security;
alter table legacy_import_log enable row level security;
alter table catalog_pl1 enable row level security;
alter table catalog_pl2 enable row level security;
alter table catalog_pl3 enable row level security;
alter table catalog_pl4 enable row level security;
alter table catalog_pl5 enable row level security;

create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
$$;

-- Danh mục: công khai đọc
create policy catalog_pl1_read on catalog_pl1 for select to anon, authenticated using (true);
create policy catalog_pl2_read on catalog_pl2 for select to anon, authenticated using (true);
create policy catalog_pl3_read on catalog_pl3 for select to anon, authenticated using (true);
create policy catalog_pl4_read on catalog_pl4 for select to anon, authenticated using (true);
create policy catalog_pl5_read on catalog_pl5 for select to anon, authenticated using (true);

-- Bảng nghiệp vụ: chỉ admin (Hội đồng tổng hợp) đọc/ghi trực tiếp; đơn vị đi qua RPC bên dưới
create policy units_admin             on units             for all to authenticated using (is_admin()) with check (is_admin());
create policy submissions_admin       on submissions       for all to authenticated using (is_admin()) with check (is_admin());
create policy unit_selections_admin   on unit_selections   for all to authenticated using (is_admin()) with check (is_admin());
create policy unit_files_admin        on unit_files        for all to authenticated using (is_admin()) with check (is_admin());
create policy legacy_import_log_admin on legacy_import_log for select to authenticated using (is_admin());

-- Danh sách đơn vị công khai cho ô chọn đơn vị (không có token / email / link nội bộ)
create or replace view units_public with (security_invoker = false) as
  select code, name, is_locked, facility_type from units;
grant select on units_public to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. RPC CHO ĐƠN VỊ (thay verifyToken / loadDraftReport / saveFormData / lookupLatestSubmittedSession)
-- ---------------------------------------------------------------------

-- Nội bộ: xác thực mã + token, chống dò (5 lần sai => chặn 2 phút). KHÔNG cấp cho anon.
create or replace function _auth_unit(p_code text, p_token text) returns units
language plpgsql security definer set search_path = public, extensions as $$
declare u units;
begin
  select * into u from units where code = upper(btrim(coalesce(p_code,'')));
  if not found then
    raise exception 'AUTH_FAILED: Mã đơn vị hoặc Token không chính xác!' using errcode = 'P0001';
  end if;
  if u.auth_blocked_until is not null and u.auth_blocked_until > now() then
    raise exception 'AUTH_BLOCKED: Nhập sai quá nhiều lần, vui lòng thử lại sau ít phút.' using errcode = 'P0001';
  end if;
  if u.token_hash = encode(digest(convert_to(btrim(coalesce(p_token,'')), 'utf8'), 'sha256'), 'hex') then
    if u.failed_attempts > 0 then
      update units set failed_attempts = 0, auth_blocked_until = null where id = u.id;
    end if;
    return u;
  end if;
  update units set failed_attempts = failed_attempts + 1,
                   auth_blocked_until = case when failed_attempts + 1 >= 5 then now() + interval '2 minutes' end
   where id = u.id;
  raise exception 'AUTH_FAILED: Mã đơn vị hoặc Token không chính xác!' using errcode = 'P0001';
end $$;
revoke all on function _auth_unit(text, text) from public, anon, authenticated;

-- Đăng nhập + nạp toàn bộ trạng thái để dựng giao diện PL1..PL5 (không phải tích chọn lại)
create or replace function get_unit_state(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u units; v_sel jsonb; v_files jsonb; v_last jsonb;
begin
  u := _auth_unit(p_code, p_token);

  select coalesce(jsonb_object_agg(a.appendix::text, a.items), '{}'::jsonb) into v_sel
  from (
    select appendix,
           jsonb_object_agg(item_key, jsonb_build_object('tichChon', is_selected, 'ghiChu', note, 'chuong', chapter)) as items
    from unit_selections where unit_id = u.id group by appendix
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
    'readOnly',   u.is_locked,
    'selections', v_sel,
    'files',      v_files,
    'lastSubmission', v_last);
end $$;
grant execute on function get_unit_state(text, text) to anon, authenticated;

-- Lưu tạm một phụ lục. p_items = [{"key":"...","tichChon":true,"ghiChu":"...","chuong":"..."}]
-- p_replace = true: thay toàn bộ phụ lục (đồng bộ cả thao tác bỏ chọn)
create or replace function save_selections(p_code text, p_token text, p_appendix smallint,
                                           p_items jsonb, p_replace boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units; n int;
begin
  u := _auth_unit(p_code, p_token);
  if u.is_locked then
    raise exception 'UNIT_LOCKED: Đơn vị đã gửi báo cáo chính thức, dữ liệu chỉ ở chế độ xem.' using errcode = 'P0001';
  end if;
  if p_appendix not between 1 and 5 then raise exception 'Phụ lục không hợp lệ'; end if;

  if p_replace then
    delete from unit_selections where unit_id = u.id and appendix = p_appendix;
  end if;

  insert into unit_selections (unit_id, appendix, item_key, is_selected, note, chapter, source)
  select u.id, p_appendix, norm_key(i->>'key'),
         coalesce((i->>'tichChon')::boolean, true),
         coalesce(i->>'ghiChu', ''), nullif(i->>'chuong',''), 'web'
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) i
  where coalesce(norm_key(i->>'key'),'') <> ''
  on conflict (unit_id, appendix, item_key) do update
     set is_selected = excluded.is_selected, note = excluded.note,
         chapter = excluded.chapter, source = 'web';
  get diagnostics n = row_count;
  return jsonb_build_object('success', true, 'saved', n);
end $$;
grant execute on function save_selections(text, text, smallint, jsonb, boolean) to anon, authenticated;

-- Ghi nhận tệp pháp lý đã upload lên Storage (đường dẫn do Edge Function / Pages Function cấp)
create or replace function register_unit_file(p_code text, p_token text, p_type unit_file_type,
       p_path text, p_name text, p_mime text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units;
begin
  u := _auth_unit(p_code, p_token);
  if u.is_locked then
    raise exception 'UNIT_LOCKED: Đơn vị đã gửi báo cáo chính thức, không thể thay đổi tệp.' using errcode = 'P0001';
  end if;
  if p_path not like u.code || '/%' then raise exception 'Đường dẫn tệp không hợp lệ'; end if;
  update unit_files set is_current = false where unit_id = u.id and file_type = p_type and is_current;
  insert into unit_files (unit_id, file_type, storage_path, original_name, mime_type, size_bytes)
  values (u.id, p_type, p_path, p_name, p_mime, p_size);
  return jsonb_build_object('success', true);
end $$;
grant execute on function register_unit_file(text, text, unit_file_type, text, text, text, bigint) to anon, authenticated;

-- Gửi báo cáo chính thức: kiểm tra tệp bắt buộc, chụp snapshot, ghi submissions, khóa đơn vị
create or replace function submit_report(p_code text, p_token text, p_contact jsonb,
                                         p_facility_type facility_type default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  u units; v_ft facility_type; v_id bigint;
  c1 int; c2 int; c3 int; c4 int; c5 int;
  has_rank boolean; has_approval boolean;
  f_kb boolean; f_hc boolean; f_gd boolean; f_sk boolean; f_xk boolean;
begin
  u := _auth_unit(p_code, p_token);
  if u.is_locked then
    raise exception 'UNIT_LOCKED: Đơn vị đã gửi báo cáo chính thức.' using errcode = 'P0001';
  end if;
  v_ft := coalesce(p_facility_type, u.facility_type);
  if v_ft is null then raise exception 'Chưa chọn loại hình cơ sở'; end if;

  select bool_or(file_type = 'QD_XepHangBV_hoac_QD_ThanhlapTYT'), bool_or(file_type = 'QD_PheDuyetDVKT')
    into has_rank, has_approval from unit_files where unit_id = u.id and is_current;
  if not coalesce(has_rank, false) or not coalesce(has_approval, false) then
    raise exception 'MISSING_FILES: Cần tải lên Quyết định xếp hạng/thành lập và Quyết định phê duyệt DVKT trước khi gửi.' using errcode = 'P0001';
  end if;

  select count(*) filter (where appendix=1), count(*) filter (where appendix=2), count(*) filter (where appendix=3),
         count(*) filter (where appendix=4), count(*) filter (where appendix=5)
    into c1, c2, c3, c4, c5 from unit_selections where unit_id = u.id and is_selected;

  -- Cờ PL1 theo tên dịch vụ (tương đương pl1Map của 3_SaveSubmit.gs)
  select coalesce(bool_or(k like '%khám bệnh%'), false),
         coalesce(bool_or(k like '%hội chẩn%'), false),
         coalesce(bool_or(k like '%chứng thương%' or k like '%giám định%'), false),
         coalesce(bool_or(k like '%sức khỏe toàn diện lao động%' or k like '%định kỳ%'), false),
         coalesce(bool_or(k like '%xuất khẩu lao động%' or k like '%xklđ%'), false)
    into f_kb, f_hc, f_gd, f_sk, f_xk
    from (select item_key k from unit_selections where unit_id = u.id and appendix = 1 and is_selected) t;

  insert into submissions (unit_id, contact_name, department, position, phone, contact_email, status, facility_type,
         pl1_kham_benh, pl1_hoi_chan, pl1_giam_dinh, pl1_ksk_lao_dong, pl1_ksk_xkld,
         count_pl1, count_pl2, count_pl3, count_pl4, count_pl5, cpql_url, snapshot, source)
  values (u.id, p_contact->>'hoTen', p_contact->>'khoaPhong', p_contact->>'chucVu', p_contact->>'soDienThoai',
         p_contact->>'emailThaoTac', 'Đã khóa', v_ft, f_kb, f_hc, f_gd, f_sk, f_xk, c1, c2, c3, c4, c5, u.cpql_url,
         jsonb_build_object(
           'selections', (select coalesce(jsonb_agg(jsonb_build_object('appendix', appendix, 'key', item_key,
                           'note', note, 'chapter', chapter)), '[]'::jsonb)
                          from unit_selections where unit_id = u.id and is_selected),
           'files', (select coalesce(jsonb_agg(jsonb_build_object('type', file_type, 'path', storage_path,
                           'name', original_name)), '[]'::jsonb)
                     from unit_files where unit_id = u.id and is_current)),
         'web')
  returning id into v_id;

  update units set is_locked = true, locked_at = now(), last_submitted_at = now(), facility_type = v_ft
   where id = u.id;

  return jsonb_build_object('success', true, 'submissionId', v_id,
         'counts', jsonb_build_object('pl1', c1, 'pl2', c2, 'pl3', c3, 'pl4', c4, 'pl5', c5));
end $$;
grant execute on function submit_report(text, text, jsonb, facility_type) to anon, authenticated;

-- Tra cứu phiên cuối (thay lookupLatestSubmittedSession): link báo cáo cũ + mới, số liệu, yêu cầu bổ sung
create or replace function lookup_latest_submission(p_code text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u units; s record;
begin
  u := _auth_unit(p_code, p_token);
  select * into s from submissions where unit_id = u.id order by submitted_at desc limit 1;
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
    'ketQuaBoSung', coalesce(u.supplement_result, ''));
end $$;
grant execute on function lookup_latest_submission(text, text) to anon, authenticated;

-- Admin: mở khóa đơn vị để cho phép nộp lại
create or replace function admin_unlock_unit(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update units set is_locked = false, locked_at = null where code = upper(btrim(p_code));
end $$;
revoke all on function admin_unlock_unit(text) from public, anon;
grant execute on function admin_unlock_unit(text) to authenticated;

-- Admin: bảng tổng hợp đơn vị đã nộp (thay getSummarySubmittedUnitsWithAuth)
create or replace view admin_submitted_summary with (security_invoker = true) as
select distinct on (u.id)
       u.code, u.name, s.submitted_at,
       s.pl1_kham_benh, s.pl1_hoi_chan, s.pl1_giam_dinh, s.pl1_ksk_lao_dong, s.pl1_ksk_xkld,
       s.count_pl2, s.count_pl3, s.count_pl4, s.count_pl5, s.total_kt,
       coalesce(s.old_folder_url, u.old_folder_url) as old_folder_url,
       coalesce(s.new_report_url, u.new_report_url) as new_report_url,
       u.supplement_request, u.supplement_result
from units u join submissions s on s.unit_id = u.id
where u.is_locked and s.status = 'Đã khóa'
order by u.id, s.submitted_at desc;

-- ---------------------------------------------------------------------
-- 9. STORAGE: bucket riêng tư. Upload/download thực hiện qua signed URL do
--    Pages Function / Edge Function cấp sau khi kiểm tra token (service_role),
--    nên không mở policy nào cho anon trên storage.objects.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('unit-files', 'unit-files', false, 20 * 1024 * 1024)
on conflict (id) do nothing;
