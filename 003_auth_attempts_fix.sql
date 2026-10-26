-- =====================================================================
-- Migration 003: sửa bộ đếm nhập sai Token.
-- Lỗi cũ: _auth_unit tăng failed_attempts rồi RAISE EXCEPTION -> giao dịch bị hoàn tác nên bộ đếm
-- không bao giờ tăng. Cách mới: khi sai, _auth_unit trả về dòng rỗng (id null, code = loại lỗi) và
-- các RPC trả jsonb {"error": "...", "message": "..."} (giao dịch được commit, bộ đếm được lưu).
-- Frontend (rpc()) và Pages Function chuyển {"error"} thành lỗi hiển thị cho người dùng.
-- =====================================================================

create or replace function _auth_err(p_kind text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('error', p_kind, 'message',
    case when p_kind = 'AUTH_BLOCKED' then 'Nhập sai quá nhiều lần, vui lòng thử lại sau ít phút.'
         else 'Mã đơn vị hoặc Token không chính xác!' end)
$$;
revoke all on function _auth_err(text) from public, anon, authenticated;

create or replace function _auth_unit(p_code text, p_token text) returns units
language plpgsql security definer set search_path = public, extensions as $$
declare u units; v_fail units;
begin
  select * into u from units where code = upper(btrim(coalesce(p_code,'')));
  if not found then
    v_fail.code := 'AUTH_FAILED'; return v_fail;
  end if;
  if u.auth_blocked_until is not null and u.auth_blocked_until > now() then
    v_fail.code := 'AUTH_BLOCKED'; return v_fail;
  end if;
  if u.token_hash = encode(digest(convert_to(btrim(coalesce(p_token,'')), 'utf8'), 'sha256'), 'hex') then
    if u.failed_attempts > 0 or u.auth_blocked_until is not null then
      update units set failed_attempts = 0, auth_blocked_until = null where id = u.id;
    end if;
    return u;
  end if;
  update units set failed_attempts = failed_attempts + 1,
                   auth_blocked_until = case when failed_attempts + 1 >= 5 then now() + interval '2 minutes' end
   where id = u.id;
  v_fail.code := case when u.failed_attempts + 1 >= 5 then 'AUTH_BLOCKED' else 'AUTH_FAILED' end;
  return v_fail;
end $$;
revoke all on function _auth_unit(text, text) from public, anon, authenticated;

-- Chèn bước kiểm tra "id is null" ngay sau mọi lệnh gọi _auth_unit trong các RPC công khai
do $$
declare
  fn text; def text;
  call_line constant text := 'u := _auth_unit(p_code, p_token);';
begin
  foreach fn in array array['get_unit_state','save_selections','register_unit_file','submit_report',
                            'lookup_latest_submission','list_submissions','restore_submission','save_draft_meta']
  loop
    select pg_get_functiondef(p.oid) into def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;
    if def is null then raise exception 'không thấy hàm %', fn; end if;
    if position(call_line in def) = 0 then raise exception 'hàm % không có lệnh gọi _auth_unit', fn; end if;
    if position('u.id is null' in def) = 0 then
      def := replace(def, call_line, call_line || ' if u.id is null then return _auth_err(u.code); end if;');
      execute def;
    end if;
  end loop;
end $$;
