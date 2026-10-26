// =====================================================================================
// BÁO CÁO MỚI (Excel): dựng từ danh mục + tích chọn trên Supabase, cùng cấu trúc cột như
// file BaoCao_DVKT_* của hệ thống cũ (PL1..PL5, tiêu đề dòng 1-3, tiêu đề cột dòng 5, dữ liệu từ dòng 6).
// =====================================================================================
const PL_TITLES = {
  PL1: "PHỤ LỤC 1: GIÁ DỊCH VỤ KHÁM BỆNH, HỘI CHẨN",
  PL2: "PHỤ LỤC 2: GIÁ DỊCH VỤ NGÀY GIƯỜNG BỆNH",
  PL3: "PHỤ LỤC 3: GIÁ DỊCH VỤ KỸ THUẬT, XÉT NGHIỆM",
  PL4: "PHỤ LỤC 4: GIÁ DỊCH VỤ KỸ THUẬT VÔ CẢM GÂY TÊ",
  PL5: "PHỤ LỤC 5: GIÁ DỊCH VỤ KỸ THUẬT CHẨN ĐOÁN HÌNH ẢNH SỬ DỤNG HỆ THỐNG PACS"
};

function exportHeaders(pl, isTYT) {
  if (pl === 'PL1') return [
    "STT\n\n(1)", "Danh mục dịch vụ\n\n(2)", "Chi phí trực tiếp\n\n(3)", "Tiền lương cơ sở 1.800.000 đồng\n\n(4)", "Tiền lương cơ sở 2.340.000 đồng\n\n(5)=(4)*2,34/1,8",
    "Giá bao gồm chi phí trực tiếp và tiền lương cơ sở 1.800.000 đồng (Thông tư số 22/2023/TT-BYT)\n\n(6)=(3)+(4)", "Giá bao gồm chi phí trực tiếp, tiền lương cơ sở 2.340.000 đồng (chưa làm tròn)\n\n(7)=(3)+(5)", " Chi phí quản lý (4%) (lương cơ sở 2.340.000 đồng)\n\n(8)=(7)*4%",
    "Giá bao gồm chi phí trực tiếp, tiền lương cơ sở 2.340.000 đồng và chi phí quản lý 4%(chưa làm tròn)\n\n(9)=(7)+(8)", "Giá đề nghị phê duyệt (làm tròn số học) (lương cơ sở 2.340.000 đồng)\n\n(10)", "Mức giá do quỹ BHYT thanh toán\n\n(11)",
    "Mức giá không thuộc quỹ BHYT thanh toán\n\n(12)", "Ghi chú của đơn vị\n\n(13)"];
  if (pl === 'PL2') return [
    "STT\n\n(1)", "Các loại dịch vụ\n\n(2)", "Chi phí trực tiếp\n\n(3)", "Phụ cấp\n\n(4)", "Lương cơ sở 1.800.000 đồng\n\n(5)", "Lương cơ sở 2.340.000 đồng\n\n(6)=(5)*2,34/1,8",
    "Giá tại Thông tư số 21/2023/TT-BYT và Thông tư số 22/2023/TT-BYT (Chi phí trực tiếp + lương 1.800.000 đồng)\n\n(7)=(3)+(4)+(5)", "Tổng 2 yếu tố  (Chi phí trực tiếp + lương 2.340.000 đồng)\n\n(8)=(3)+(4)+(6)", "Chi phí quản lý 4% (lương cơ sở 2.340.000 đồng)\n\n(9)=(8)*4%", "Tổng 3 yếu tố  (Chi phí trực tiếp + lương 2.340.000 đồng) và Chi phí quản lý 4% (chưa làm tròn)\n\n(10)=(8)+(9)",
    "Giá đề nghị phê duyệt (làm tròn)\n\n(11)", "Mức giá do quỹ BHYT thanh toán\n\n(12)", "Mức giá không thuộc quỹ BHYT thanh toán\n\n(13)", "Ghi chú của đơn vị\n\n(14)"];
  if (pl === 'PL3') {
    const head = [
      "STT\n\n(1)", "Mã DVKT dùng chung\n\n(2)", "Tên chương theo Thông tư số 23/2024/TT-BYT\n\n(3)", "Mã kỹ thuật theo Thông tư số 23/2024/TT-BYT\n\n(4)", "Tên dịch vụ kỹ thuật theo Thông tư 23/2024/TT-BYT\n\n(5)",
      "Tên dịch vụ phê duyệt giá\n\n(6)", "Chi phí trực tiếp + Phụ cấp\n\n(7)", "Lương cơ sở 1.800.000 đồng\n\n(8)", "Tiền lương cơ sở 2.340.000 đồng\n\n(9)=(8)*2,34/1,8",
      "Giá bao gồm chi phí trực tiếp, tiền lương tại Thông tư số 21/2023/TT-BYT và Thông tư số 22/2023/TT-BYT\n\n(10)=(7)+(8)", "Giá bao gồm chi phí trực tiếp, phụ cấp và tiền lương cơ sở 2.340.000 đồng\n\n(11)=(7)+(9)", "Chi phí quản lý (4%) (lương cơ sở 2.340.000 đồng)\n\n(12)=(11)*4%",
      "Giá bao gồm chi phí trực tiếp, phụ cấp, tiền lương cơ sở 2.340.000 đồng và chi phí quản lý 4% (chưa làm tròn)\n\n(13)=(11)+(12)"];
    if (isTYT) {
      head.push("[Giá bao gồm chi phí trực tiếp, phụ cấp, tiền lương cơ sở 2.340.000 đồng và chi phí quản lý 4%]*70% (chưa làm tròn)\n\n(14)", "Giá đề nghị phê duyệt (làm tròn )\n\n(15)",
        "Mức giá do quỹ BHYT thanh toán\n\n(16)", "Mức giá không thuộc quỹ BHYT thanh toán\n\n(17)", "Ghi chú gốc\n\n(18)", "Ghi chú của đơn vị\n\n(19)");
    } else {
      head.push("Giá đề nghị phê duyệt (làm tròn)\n\n(14)", "Mức giá do quỹ BHYT thanh toán\n\n(15)", "Mức giá không thuộc quỹ BHYT thanh toán\n\n(16)",
        "Ghi chú gốc\n\n(17)", "Ghi chú của đơn vị\n\n(18)");
    }
    return head;
  }
  if (pl === 'PL4') return [
    "STT\n\n(1)", "Mã DVKT dùng chung\n\n(2)", "Tên chương theo Thông tư số 23/2024/TT-BYT\n\n(3)", "Mã kỹ thuật theo Thông tư số 23/2024/TT-BYT\n\n(4)", "Tên kỹ thuật theo Thông tư số 23/2024/TT-BYT\n\n(5)",
    "Tên dịch vụ phê duyệt giá\n\n(6)", "Chi phí trực tiếp + phụ cấp\n\n(7)", "Tiền lương cơ sở 1.800.000 đồng (chưa làm tròn)\n\n(8)", "Tiền lương cơ sở 2.340.000 đồng (chưa làm tròn)\n\n(9)=(8)*2,34/1,8",
    "Giá bao gồm chi phí trực tiếp và tiền lương theo mức lương cơ sở 1.800.000 đồng (làm tròn)\n\n(10)=(7)+(8)", "Giá bao gồm chi phí trực tiếp, phụ cấp và tiền lương cơ sở 2.340.000 đồng (chưa làm tròn)\n\n(11)=(7)+(9)", "Chi phí quản lý (4%) (lương cơ sở 2.340.000 đồng)\n\n(12)=(11)*4%",
    "Giá bao gồm chi phí trực tiếp, phụ cấp và tiền lương cơ sở 2.340.000 đồng và chi phí quản lý 4% (chưa làm tròn)\n\n(13)", "Giá đề nghị phê duyệt (làm tròn)\n\n(14)", "Mức giá do quỹ BHYT thanh toán\n\n(15)",
    "Mức giá không thuộc quỹ BHYT thanh toán\n\n(16)", "Ghi chú gốc\n\n(17)", "Ghi chú của đơn vị\n\n(18)"];
  return [
    "STT\n\n(1)", "Mã DVKT dùng chung\n\n(2)", "Tên chương theo Thông tư số 23/2024/TT-BYT\n\n(3)", "Tên dịch vụ kỹ thuật theo Thông tư 23/2024/TT-BYT\n\n(4)", "Tên dịch vụ phê duyệt giá\n\n(5)",
    "Chi phí trực tiếp + Phụ cấp\n\n(6)", "Tiền lương 2.340.000 đồng\n\n(7)", "Giá bao gồm chi phí trực tiếp, phụ cấp và tiền lương 2.340.000 đồng (chưa làm tròn)\n\n(8)",
    "Chi phí bao phim và phim\n\n(9)", "Giá chưa bao gồm chi phí bao phim và phim theo lương cơ sở 2.340.000 đồng (chưa làm tròn)\n\n(10)=(8) - (9)", "Chi phí quản lý (4%)\n\n(11)=(10)*4%",
    "Giá bao gồm chi phí trực tiếp, phụ cấp, tiền lương cơ sở 2.430.000 đồng và chi phí quản lý 4% (chưa làm tròn)\n\n(12)=(10)+(11)", "Giá đề nghị phê duyệt (làm tròn số học)\n\n(13)", "Mức giá do quỹ BHYT thanh toán\n\n(14)",
    "Mức giá không thuộc quỹ BHYT thanh toán\n\n(15)", "Ghi chú gốc(16)", "Ghi chú của đơn vị(17)"];
}

/** Tạo và tải file Excel báo cáo. sel = { pl1:{key:{tichChon,ghiChu}}, ... } */
async function downloadReportXlsx(unitName, ft, sel) {
  const isTYT = ft === 'TYT';
  const note = (t, k) => (sel[t] && sel[t][k] && sel[t][k].ghiChu) || '';
  const on = (t, k) => !!(sel[t] && sel[t][k] && sel[t][k].tichChon);
  const orFilter = `facility_type.eq.${ft},facility_type.is.null`;

  const [c1, c2, c3, c4, c5] = await Promise.all([
    fetchAll('catalog_pl1', '*', { or: orFilter }),
    fetchAll('catalog_pl2', '*', { or: orFilter }),
    fetchAll('catalog_pl3', '*', { eq: { scope: isTYT ? 'TYT' : 'BV' } }),
    fetchAll('catalog_pl4', '*'),
    fetchAll('catalog_pl5', '*')
  ]);
  const text = v => (v === null || v === undefined ? '' : String(v));
  const rows = { PL1: [], PL2: [], PL3: [], PL4: [], PL5: [] };
  let n = 1;
  c1.filter(r => r.facility_type === ft || !r.facility_type).forEach(r => {
    if (on('pl1', r.item_key)) rows.PL1.push([n++, r.name, r.c3, r.c4, r.c5, r.c6, r.c7, r.c8, r.c9, r.proposed_price, r.bhyt_price, r.non_bhyt_price, note('pl1', r.item_key)]);
  });
  n = 1;
  c2.filter(r => !r.is_header).forEach(r => {
    if (on('pl2', r.item_key)) rows.PL2.push([n++, r.name, r.c3, r.c4, r.c5, r.c6, r.c7, r.c8, r.c9, r.c10, r.proposed_price, r.bhyt_price, r.non_bhyt_price, note('pl2', r.item_key)]);
  });
  n = 1;
  c3.forEach(r => {
    if (!on('pl3', r.item_key)) return;
    const row = [n++, text(r.common_code), r.chapter, text(r.tech_code), r.tech_name, r.approved_name, r.direct_cost_allowance, r.salary_1800, r.salary_2340,
      r.price_tt21_22, r.price_2340, r.mgmt_cost_4pct, r.price_incl_mgmt];
    if (isTYT) row.push(r.price_70pct);
    row.push(r.proposed_price, r.bhyt_price, r.non_bhyt_price, text(r.original_note), note('pl3', r.item_key));
    rows.PL3.push(row);
  });
  n = 1;
  c4.forEach(r => {
    if (on('pl4', r.item_key)) rows.PL4.push([n++, text(r.common_code), r.chapter, text(r.tech_code), r.tech_name, r.approved_name, r.direct_cost_allowance, r.salary_1800,
      r.salary_2340, r.price_tt21_22, r.price_2340, r.mgmt_cost_4pct, r.price_incl_mgmt, r.proposed_price, r.bhyt_price, r.non_bhyt_price, text(r.original_note), note('pl4', r.item_key)]);
  });
  n = 1;
  c5.forEach(r => {
    if (on('pl5', r.item_key)) rows.PL5.push([n++, text(r.common_code), r.chapter, r.tech_name, r.approved_name, r.direct_cost_allowance, r.salary_2340, r.price_8,
      r.film_cost, r.price_ex_film, r.mgmt_cost_4pct, r.price_incl_mgmt, r.proposed_price, r.bhyt_price, r.non_bhyt_price, text(r.original_note), note('pl5', r.item_key)]);
  });

  const stamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  const wb = XLSX.utils.book_new();
  ['PL1', 'PL2', 'PL3', 'PL4', 'PL5'].forEach(pl => {
    const aoa = [[`ĐƠN VỊ: ${String(unitName).toUpperCase()}`], [PL_TITLES[pl]], [`Thời gian xuất: ${stamp}`], [],
      exportHeaders(pl, isTYT), ...rows[pl]];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = exportHeaders(pl, isTYT).map((h, i) => ({ wch: i === 1 || i === 4 || i === 5 ? 40 : 16 }));
    XLSX.utils.book_append_sheet(wb, ws, pl);
  });
  const safe = String(unitName).replace(/[\\/:*?"<>|]/g, '_');
  XLSX.writeFile(wb, `BaoCao_DVKT_${safe}.xlsx`);
}

// Nút trong thanh "Chỉ xem" của đơn vị đang đăng nhập
async function exportCurrentReport(btn) {
  if (!appState.authed || !appState.unit) return;
  const old = btn ? btn.innerText : '';
  if (btn) { btn.innerText = '⏳ Đang dựng báo cáo...'; btn.disabled = true; }
  try {
    await downloadReportXlsx(appState.unit.name, currentFacility(), appState.sel);
  } catch (e) {
    showAppDialog('error', 'Không Xuất Được Báo Cáo', esc(e.message));
  } finally { if (btn) { btn.innerText = old; btn.disabled = false; } }
}

// Nút trong mục Tra cứu
async function exportLookupReport(btn) {
  const ma = document.getElementById('lookupDonVi').value.trim();
  const token = document.getElementById('lookupToken').value.trim();
  if (!ma || !token) return;
  const old = btn ? btn.innerText : '';
  if (btn) { btn.innerText = '⏳ Đang dựng báo cáo...'; btn.disabled = true; }
  try {
    const st = await rpc('get_unit_state', { p_code: ma, p_token: token });
    const sel = {};
    PL_TYPES.forEach((t, i) => { sel[t] = (st.selections && st.selections[String(i + 1)]) || {}; });
    await downloadReportXlsx(st.unit.name, st.unit.facilityType || 'H2', sel);
  } catch (e) {
    showAppDialog('error', 'Không Xuất Được Báo Cáo', esc(e.message));
  } finally { if (btn) { btn.innerText = old; btn.disabled = false; } }
}
