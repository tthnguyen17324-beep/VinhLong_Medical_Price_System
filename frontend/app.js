// =====================================================================================
// HỆ THỐNG XÂY DỰNG GIÁ DỊCH VỤ KHÁM BỆNH, CHỮA BỆNH TẠI TỈNH VĨNH LONG
// Frontend kết nối trực tiếp Supabase (PostgreSQL) – thay thế Google Apps Script + Firebase
// =====================================================================================

// ===================================================================================
// 1. KẾT NỐI SUPABASE & TIỆN ÍCH
// ===================================================================================
const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const adminSb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const FILE_INPUTS = [
  { id: 'fileHangBV',        type: 'QD_XepHangBV_hoac_QD_ThanhlapTYT', badge: 'currentFileHangBV' },
  { id: 'fileMinhChungKhac', type: 'HoSo_MinhChungKhac',                badge: 'currentFileMinhChungKhac' },
  { id: 'filePheDuyetDVKT',  type: 'QD_PheDuyetDVKT',                   badge: 'currentFilePheDuyet' },
  { id: 'fileDuDieuKienKSK', type: 'QD_DuDieuKienKSK',                  badge: 'currentFileKSK' }
];
const PL_TYPES = ['pl1', 'pl2', 'pl3', 'pl4', 'pl5'];
const MAX_CONNECTIONS = 300;
const AUTOSAVE_DELAY_MS = 2500;

function cleanKey(str) {
  if (str === undefined || str === null) return "";
  return String(str).trim().toLowerCase().replace(/^'+/, '').replace(/\s+/g, " ");
}
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatMoney(val) {
  if (val === undefined || val === null || val === '') return '';
  let num = Number(val);
  return isNaN(num) ? val : num.toLocaleString('vi-VN');
}
function formatDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); } catch (e) { return String(iso); }
}
function toast(msg, isError) {
  let el = document.getElementById('appToast');
  if (!el) { el = document.createElement('div'); el.id = 'appToast'; el.className = 'app-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'app-toast show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'app-toast' + (isError ? ' error' : ''); }, 2500);
}

class AppError extends Error {
  constructor(message, kind) { super(message); this.kind = kind || ''; }
}
function toAppError(error) {
  const raw = String(error && error.message ? error.message : error);
  const m = raw.match(/^(AUTH_FAILED|AUTH_BLOCKED|UNIT_LOCKED|MISSING_FILES|NO_SUBMISSION):\s*([\s\S]*)$/);
  return m ? new AppError(m[2], m[1]) : new AppError(raw, '');
}
async function rpc(name, params) {
  const { data, error } = await sb.rpc(name, params);
  if (error) throw toAppError(error);
  // Sai mã/Token: RPC trả {"error": "AUTH_FAILED|AUTH_BLOCKED", "message": ...} (để bộ đếm nhập sai được lưu)
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) throw new AppError(data.message, data.error);
  return data;
}
/** Đọc toàn bộ bảng (PostgREST giới hạn 1000 dòng/lần) */
async function fetchAll(table, columns, opts) {
  opts = opts || {};
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = (opts.client || sb).from(table).select(columns || '*').order(opts.order || 'row_no').range(from, from + 999);
    for (const [k, v] of Object.entries(opts.eq || {})) q = q.eq(k, v);
    if (opts.or) q = q.or(opts.or);
    const { data, error } = await q;
    if (error) throw toAppError(error);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ===================================================================================
// 2. TRẠNG THÁI ỨNG DỤNG
// ===================================================================================
let currentPL3DisplayLimit = 100;
let currentStep = 1;
let targetNavigateStep = 1;
let isDirty = false;
let loadedSteps = { 2: false, 3: false, 4: false, 5: false, 6: false };
let appState = {
  hospitals: [],
  lookupHospitals: [],
  chaptersPL3: [],
  sel: { pl1: {}, pl2: {}, pl3: {}, pl4: {}, pl5: {} },   // key -> { tichChon, ghiChu, chuong }
  pl1: [], pl2: [],
  pl3Cache: {},
  pl3Index: {},
  pl4: [], pl5: [],
  pl4Loaded: false, pl5Loaded: false,
  files: [],
  unit: null,
  authed: null,       // { ma, token } sau khi xác thực thành công
  readOnly: false,
  lastSubmission: null
};
const pending = { pl1: new Set(), pl2: new Set(), pl3: new Set(), pl4: new Set(), pl5: new Set() };
let autosaveTimer = null;
let flushChain = Promise.resolve();

function resetSelectionsLocal() {
  appState.sel = { pl1: {}, pl2: {}, pl3: {}, pl4: {}, pl5: {} };
  PL_TYPES.forEach(t => pending[t].clear());
  clearTimeout(autosaveTimer);
  isDirty = false;
  rerenderCurrentStep();
  updateProgressCounters();
  renderChapterProgressBar();
}
function getSel(type, key) { return appState.sel[type][key] || null; }
function isSelected(type, key) { const s = appState.sel[type][key]; return !!(s && s.tichChon); }
function setSel(type, key, patch) {
  const cur = appState.sel[type][key] || { tichChon: false, ghiChu: '', chuong: '' };
  appState.sel[type][key] = Object.assign({}, cur, patch);
  pending[type].add(key);
}

// ===================================================================================
// 3. XÁC THỰC TOKEN & NẠP TRẠNG THÁI ĐƠN VỊ TỪ SUPABASE
// ===================================================================================
let attaching = false;
function autoCheckAndAttachRealtime() { attachRealtimeSync(); }

async function attachRealtimeSync(force) {
  const selDonVi = document.getElementById('maDonVi');
  const tokenInp = document.getElementById('token');
  if (!selDonVi || !tokenInp) return;
  const ma = selDonVi.value.trim();
  const token = tokenInp.value.trim();
  if (!ma || !token) { clearAuth(); return; }
  if (!force && appState.authed && appState.authed.ma === ma && appState.authed.token === token) return;
  if (attaching) return;
  attaching = true;
  try {
    const st = await rpc('get_unit_state', { p_code: ma, p_token: token });
    applyUnitState(ma, token, st);
  } catch (e) {
    clearAuth();
    const name = selDonVi.options[selDonVi.selectedIndex].text;
    if (e.kind === 'AUTH_BLOCKED') {
      showAppDialog('warning', 'Tạm Thời Bị Chặn', esc(e.message));
    } else if (e.kind === 'AUTH_FAILED') {
      showAppDialog('warning', 'Mã Xác Thực Không Đúng',
        `Mã xác thực (Token) không chính xác đối với đơn vị <strong>${esc(name)}</strong>.<br>Hệ thống đã khóa dữ liệu để bảo mật.`);
    } else {
      showAppDialog('error', 'Lỗi Kết Nối', esc(e.message));
    }
  } finally { attaching = false; }
}

function clearAuth() {
  appState.authed = null;
  appState.unit = null;
  appState.files = [];
  appState.lastSubmission = null;
  setReadOnly(false);
  resetSelectionsLocal();
  displayFileBadges();
}

function setFieldIfEmpty(id, val) {
  const el = document.getElementById(id);
  if (el && !el.value.trim() && val) el.value = val;
}

function applyUnitState(ma, token, st) {
  appState.authed = { ma, token };
  appState.unit = st.unit;
  appState.files = st.files || [];
  appState.lastSubmission = st.lastSubmission || null;
  appState.sel = { pl1: {}, pl2: {}, pl3: {}, pl4: {}, pl5: {} };
  PL_TYPES.forEach((t, i) => {
    const m = (st.selections && st.selections[String(i + 1)]) || {};
    for (const k in m) appState.sel[t][k] = { tichChon: true, ghiChu: m[k].ghiChu || '', chuong: m[k].chuong || '' };
    pending[t].clear();
  });
  isDirty = false;

  // Loại hình cơ sở
  const selLH = document.getElementById('loaiHinhCoSo');
  if (st.unit.facilityType && selLH.value !== st.unit.facilityType) selLH.value = st.unit.facilityType;
  loadedSteps[2] = loadedSteps[3] = loadedSteps[4] = loadedSteps[5] = false;
  appState.pl3Cache = {}; appState.pl3Index = {}; appState.chaptersPL3 = [];

  // Thông tin người nhập liệu: bản lưu tạm, nếu chưa có thì lấy từ phiên gửi gần nhất
  const dc = st.draftContact || {};
  const ls = st.lastSubmission || {};
  setFieldIfEmpty('hoTen', dc.hoTen || ls.contact_name);
  setFieldIfEmpty('khoaPhong', dc.khoaPhong || ls.department);
  setFieldIfEmpty('chucVu', dc.chucVu || ls.position);
  setFieldIfEmpty('soDienThoai', dc.soDienThoai || ls.phone);
  setFieldIfEmpty('email', dc.email || ls.contact_email);

  setReadOnly(!!st.readOnly);
  displayFileBadges();
  rerenderCurrentStep(true);
  updateProgressCounters();
  renderChapterProgressBar();
  if (!st.readOnly && PL_TYPES.some(t => Object.keys(appState.sel[t]).length)) {
    toast('Đã nạp lại các mục đã chọn trước đó của đơn vị');
  }
}

// Chế độ chỉ xem khi đơn vị đã gửi báo cáo chính thức
function setReadOnly(flag) {
  appState.readOnly = flag;
  document.body.classList.toggle('readonly', flag);
  const banner = document.getElementById('lockBanner');
  if (banner) banner.style.display = flag ? 'block' : 'none';
  FILE_INPUTS.forEach(f => { const el = document.getElementById(f.id); if (el) el.disabled = flag; });
  const chk = document.getElementById('chkDuDieuKienKSK');
  if (chk) chk.disabled = flag;
  if (!flag) toggleKSKSection(); else renderLockBannerLinks();
}
function renderLockBannerLinks() {
  const box = document.getElementById('lockBannerLinks');
  if (!box || !appState.unit) return;
  const u = appState.unit;
  const ls = appState.lastSubmission || {};
  let html = '';
  const oldSheet = ls.old_report_sheet_url || u.oldReportSheetUrl;
  const oldFolder = ls.old_folder_url || u.oldFolderUrl;
  const cpql = ls.cpql_url || u.cpqlUrl;
  if (oldSheet) html += `<a href="${esc(oldSheet)}" target="_blank" rel="noopener">📊 Báo cáo cũ (Google Sheet) ↗</a>`;
  if (oldFolder) html += `<a href="${esc(oldFolder)}" target="_blank" rel="noopener">📁 Thư mục hồ sơ cũ (Drive) ↗</a>`;
  if (cpql && cpql.startsWith('http')) html += `<a href="${esc(cpql)}" target="_blank" rel="noopener">📑 Thuyết minh CPQL ↗</a>`;
  if (u.newReportUrl) html += `<a href="${esc(u.newReportUrl)}" target="_blank" rel="noopener">🆕 Báo cáo mới ↗</a>`;
  html += `<button type="button" onclick="exportCurrentReport(this)">🆕 Tải báo cáo mới (Excel)</button>`;
  html += `<button type="button" onclick="tryNavigate(7)">🔍 Mở mục Tra cứu</button>`;
  box.innerHTML = html;
}

// ===================================================================================
// 4. LƯU TỰ ĐỘNG CÁC TÍCH CHỌN (thay đồng bộ Firebase)
// ===================================================================================
function markDirty() {
  isDirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    flushPending().then(() => { if (!hasPending()) { isDirty = false; toast('✔ Đã tự động lưu'); } })
      .catch(e => toast('Lỗi lưu tự động: ' + e.message, true));
  }, AUTOSAVE_DELAY_MS);
}
function hasPending() { return PL_TYPES.some(t => pending[t].size > 0); }

function flushPending() {
  flushChain = flushChain.then(doFlush, doFlush);
  return flushChain;
}
async function doFlush() {
  if (!appState.authed || appState.readOnly) return;
  const { ma, token } = appState.authed;
  for (let i = 0; i < PL_TYPES.length; i++) {
    const type = PL_TYPES[i];
    const keys = [...pending[type]];
    if (!keys.length) continue;
    pending[type].clear();
    const items = keys.map(k => {
      const s = appState.sel[type][k] || {};
      return { key: k, tichChon: !!s.tichChon, ghiChu: s.ghiChu || '', chuong: s.chuong || '' };
    });
    try {
      for (let c = 0; c < items.length; c += 2000) {
        await rpc('save_selections', { p_code: ma, p_token: token, p_appendix: i + 1,
          p_items: items.slice(c, c + 2000), p_replace: false });
      }
    } catch (e) {
      keys.forEach(k => pending[type].add(k));
      throw e;
    }
  }
}
window.addEventListener('beforeunload', function (e) {
  if (hasPending()) { e.preventDefault(); e.returnValue = ''; }
});

function currentContact() {
  const v = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
  return { hoTen: v('hoTen'), khoaPhong: v('khoaPhong'), chucVu: v('chucVu'), soDienThoai: v('soDienThoai'), email: v('email') };
}
async function saveMeta() {
  if (!appState.authed || appState.readOnly) return;
  const { ma, token } = appState.authed;
  await rpc('save_draft_meta', { p_code: ma, p_token: token, p_contact: currentContact(),
    p_facility_type: document.getElementById('loaiHinhCoSo').value });
}

// ===================================================================================
// 5. TỆP ĐÍNH KÈM (qua Cloudflare Pages Function /api/upload và /api/file-url)
// ===================================================================================
function validateFileSize(inputElement, maxMb) {
  if (inputElement.files.length > 0) {
    const file = inputElement.files[0];
    const limitBytes = (maxMb || 15) * 1024 * 1024;
    if (file.size > limitBytes) {
      showAppDialog('warning', 'Dung Lượng Quá Lớn',
        `File <strong>${esc(file.name)}</strong> (${(file.size / 1024 / 1024).toFixed(1)}MB) vượt quá dung lượng tối đa cho phép là <strong>${maxMb}MB</strong>.<br>Vui lòng chọn file dung lượng nhỏ hơn.`);
      inputElement.value = '';
      inputElement.dataset.isNew = 'false';
      return false;
    }
    inputElement.dataset.isNew = 'true';
    renderLocalFileBadge(inputElement.id, file.name);
  }
  return true;
}
function renderLocalFileBadge(inputId, fileName) {
  const f = FILE_INPUTS.find(x => x.id === inputId);
  const badge = f && document.getElementById(f.badge);
  if (badge) badge.innerHTML = `<div class="file-badge">📎 Đã chọn: <strong>${esc(fileName)}</strong> <span style="color:#64748b;">(sẽ tải lên khi bấm Lưu)</span></div>`;
}
const FILE_BADGE_STYLE = 'margin-top:6px; font-size:12.5px; color:#059669; background:#ecfdf5; padding:6px 10px; border-radius:6px; border:1px solid #a7f3d0;';

async function openStoredFile(path) {
  if (!appState.authed) return;
  const w = window.open('', '_blank');
  try {
    const res = await fetch('/api/file-url', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: appState.authed.ma, token: appState.authed.token, path }) });
    const j = await res.json();
    if (!res.ok || !j.url) throw new Error(j.message || 'Không lấy được liên kết tệp');
    if (w) w.location = j.url; else window.location = j.url;
  } catch (e) {
    if (w) w.close();
    showAppDialog('error', 'Không Mở Được Tệp', esc(e.message));
  }
}
async function openLookupFile(path) {
  const w = window.open('', '_blank');
  try {
    const ma = document.getElementById('lookupDonVi').value.trim();
    const token = document.getElementById('lookupToken').value.trim();
    const res = await fetch('/api/file-url', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: ma, token, path }) });
    const j = await res.json();
    if (!res.ok || !j.url) throw new Error(j.message || 'Không lấy được liên kết tệp');
    if (w) w.location = j.url;
  } catch (e) { if (w) w.close(); showAppDialog('error', 'Không Mở Được Tệp', esc(e.message)); }
}

async function uploadPendingFiles() {
  if (!appState.authed) return;
  const { ma, token } = appState.authed;
  const kskOn = document.getElementById('chkDuDieuKienKSK') && document.getElementById('chkDuDieuKienKSK').checked;
  for (const f of FILE_INPUTS) {
    const el = document.getElementById(f.id);
    if (!el || !el.files.length || el.dataset.isNew !== 'true') continue;
    if (f.type === 'QD_DuDieuKienKSK' && !kskOn) continue;
    const fd = new FormData();
    fd.append('code', ma); fd.append('token', token); fd.append('type', f.type); fd.append('file', el.files[0]);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    let j = {};
    try { j = await res.json(); } catch (e) {}
    if (!res.ok || !j.success) throw new Error(j.message || ('Tải tệp lên thất bại (' + res.status + ')'));
    appState.files = appState.files.filter(x => x.type !== f.type);
    appState.files.push(j.file);
    el.value = ''; el.dataset.isNew = 'false';
  }
  displayFileBadges();
}

function displayFileBadges() {
  const cardStep5 = document.getElementById('driveSessionCardStep5');
  const listStep5 = document.getElementById('driveFileListStep5');
  let listHtml = '';
  FILE_INPUTS.forEach(f => {
    const badge = document.getElementById(f.badge);
    if (!badge) return;
    const file = appState.files.find(x => x.type === f.type);
    const inp = document.getElementById(f.id);
    if (inp && inp.dataset.isNew === 'true' && inp.files.length) return; // đang chọn file mới
    if (file) {
      badge.innerHTML = `<div style="${FILE_BADGE_STYLE}">✅ <strong>Đã có file:</strong> <a href="#" onclick="openStoredFile('${esc(file.path)}'); return false;" style="color:#0284c7; text-decoration:underline;">${esc(file.name)}</a> <span style="color:#64748b;">(Đã lưu an toàn trên hệ thống)</span></div>`;
      listHtml += `<li style="margin-bottom:6px;">📄 <a href="#" onclick="openStoredFile('${esc(file.path)}'); return false;" style="color:#334155; font-weight:600; text-decoration:none;">${esc(file.name)}</a> <span style="color:#059669; font-size:12px;">(Đã lưu)</span></li>`;
      if (f.type === 'QD_DuDieuKienKSK') {
        const chk = document.getElementById('chkDuDieuKienKSK');
        if (chk && !chk.checked) { chk.checked = true; toggleKSKSection(); }
      }
    } else {
      badge.innerHTML = '';
    }
  });
  const u = appState.unit || {};
  const ls = appState.lastSubmission || {};
  const oldSheet = ls.old_report_sheet_url || u.oldReportSheetUrl;
  if (oldSheet) {
    listHtml = `<li style="margin-bottom:10px; background:#fff; padding:10px 14px; border-radius:8px; border:1px solid #86efac;">📊 <a href="${esc(oldSheet)}" target="_blank" rel="noopener" style="font-weight:700; color:#0284c7; font-size:14.5px; text-decoration:none;">Báo cáo của phiên cũ (Google Sheet, chỉ xem) ↗</a></li>` + listHtml;
  }
  if (listStep5) listStep5.innerHTML = listHtml;
  if (cardStep5) cardStep5.style.display = listHtml ? 'block' : 'none';
}

function toggleKSKSection() {
  const chk = document.getElementById('chkDuDieuKienKSK');
  const card = document.getElementById('cardUploadKSK');
  const inp = document.getElementById('fileDuDieuKienKSK');
  const reqBadge = document.getElementById('reqBadgeKSK');
  if (!chk || !card || !inp) return;
  if (chk.checked) {
    card.style.opacity = '1'; card.style.pointerEvents = 'auto'; card.style.borderLeftColor = 'var(--danger)';
    inp.disabled = appState.readOnly;
    if (reqBadge) reqBadge.style.display = 'inline';
  } else {
    card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; card.style.borderLeftColor = '#cbd5e1';
    inp.disabled = true;
    if (reqBadge) reqBadge.style.display = 'none';
  }
}

// ===================================================================================
// 6. HỘP THOẠI HỆ THỐNG & ĐIỀU HƯỚNG WIZARD
// ===================================================================================
function showAppDialog(type, title, messageHtml, errorItems, onConfirm) {
  const overlay = document.getElementById('customAlertModal');
  const badge = document.getElementById('modalIconBadge');
  const titleEl = document.getElementById('modalTitle');
  const descEl = document.getElementById('modalDesc');
  const listEl = document.getElementById('modalErrorList');
  const btnCancel = document.getElementById('modalBtnCancel');
  const btnOk = document.getElementById('modalBtnOk');
  badge.className = 'modal-icon-badge';
  if (type === 'warning') {
    badge.classList.add('badge-icon-warning'); badge.innerHTML = '⚠️';
    btnOk.className = 'btn btn-warning'; btnCancel.style.display = 'none'; btnOk.innerText = 'Đã hiểu';
  } else if (type === 'error') {
    badge.classList.add('badge-icon-error'); badge.innerHTML = '❌';
    btnOk.className = 'btn btn-danger'; btnCancel.style.display = 'none'; btnOk.innerText = 'Đóng';
  } else if (type === 'success') {
    badge.classList.add('badge-icon-success'); badge.innerHTML = '✅';
    btnOk.className = 'btn btn-success'; btnCancel.style.display = 'none'; btnOk.innerText = 'Đồng ý';
  } else if (type === 'confirm') {
    badge.classList.add('badge-icon-confirm'); badge.innerHTML = '❓';
    btnOk.className = 'btn btn-primary'; btnCancel.style.display = 'inline-flex';
    btnCancel.innerText = 'Hủy bỏ'; btnOk.innerText = 'Xác nhận gửi';
  }
  titleEl.innerText = title;
  descEl.innerHTML = messageHtml;
  if (errorItems && errorItems.length > 0) {
    listEl.style.display = 'block';
    listEl.innerHTML = errorItems.map(item => `<li>${item}</li>`).join('');
  } else {
    listEl.style.display = 'none'; listEl.innerHTML = '';
  }
  btnOk.onclick = function () { closeAppDialog(); if (onConfirm) onConfirm(); };
  overlay.style.display = 'flex';
}
function closeAppDialog() { document.getElementById('customAlertModal').style.display = 'none'; }

function tryNavigate(step) {
  targetNavigateStep = step;
  if (isDirty && !appState.readOnly) {
    document.getElementById('unsavedModal').style.display = 'flex';
  } else {
    doNavigate(step);
  }
}
function openThuyetMinhCPQLApp() {
  window.open("https://script.google.com/macros/s/AKfycbztDkZyJ_JunRXNrAhKcySP4tJmHR_JZzdM80Yh5u0pIs7gLAaCIk4Qap44zytszkjN/exec", '_blank');
}
function doNavigate(step) {
  if (step === 6) { openThuyetMinhCPQLApp(); return; }
  document.querySelectorAll('.step-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.step-item').forEach(el => el.classList.remove('active'));
  currentStep = step;
  document.getElementById('step' + step).classList.add('active');
  for (let i = 1; i <= 7; i++) {
    let node = document.getElementById('stepNode' + i);
    if (node) {
      if (i === step) node.classList.add('active');
      if (i < step && i !== 6) node.classList.add('completed');
    }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (step === 2 && !loadedSteps[2]) { loadPL1andPL2Data(); loadedSteps[2] = true; }
  else if (step === 3 && !loadedSteps[3]) { loadPL3DataInitial(); loadedSteps[3] = true; }
  else if (step === 4 && !loadedSteps[4]) { loadPL4Data(); loadedSteps[4] = true; }
  else if (step === 5 && !loadedSteps[5]) { loadPL5Data(); loadedSteps[5] = true; }
  else if (step === 7 && !loadedSteps[7]) { loadLookupHospitals(); loadedSteps[7] = true; }
  displayFileBadges();
}
function rerenderCurrentStep(forceReload) {
  if (forceReload) {
    if (currentStep === 2) { loadPL1andPL2Data(); loadedSteps[2] = true; }
    else if (currentStep === 3) { loadPL3DataInitial(); loadedSteps[3] = true; }
    else if (currentStep === 4) { loadPL4Data(); loadedSteps[4] = true; }
    else if (currentStep === 5) { loadPL5Data(); loadedSteps[5] = true; }
    return;
  }
  if (currentStep === 2) { renderPL1(); renderPL2(); }
  else if (currentStep === 3) {
    const c = document.getElementById('selectChuongPL3') ? document.getElementById('selectChuongPL3').value : "";
    if (c && appState.pl3Cache[c]) renderPL3(appState.pl3Cache[c]);
  }
  else if (currentStep === 4) renderPL4();
  else if (currentStep === 5) renderPL5();
}

// ---- Danh sách đơn vị ----
async function fetchUnitsPublic() {
  // Thử lại tối đa 3 lần: khi hàng trăm đơn vị mở cùng lúc, thỉnh thoảng có 1-2 yêu cầu bị từ chối tạm thời
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await sb.from('units_public').select('code,name,is_locked,facility_type').order('code');
    if (!error) return data || [];
    lastErr = error;
    await new Promise(r => setTimeout(r, 600 * attempt));
  }
  throw toAppError(lastErr);
}
function populateHospitalDropdown(hospitals) {
  const selHosp = document.getElementById('maDonVi');
  if (!selHosp) return;
  const currentVal = selHosp.value;
  let html = '<option value="">-- Chọn đơn vị --</option>';
  hospitals.forEach(h => {
    html += `<option value="${esc(h.code)}" data-name="${esc(h.name)}" ${h.code === currentVal ? 'selected' : ''}>${esc(h.name)}${h.is_locked ? ' 🔒' : ''}</option>`;
  });
  selHosp.innerHTML = html;
}
async function loadLookupHospitals() {
  const selLookup = document.getElementById('lookupDonVi');
  if (!selLookup) return;
  selLookup.innerHTML = '<option value="">-- Đang tải danh sách đầy đủ --</option>';
  try {
    appState.lookupHospitals = await fetchUnitsPublic();
    let html = '<option value="">-- Chọn đơn vị cần tra cứu --</option>';
    appState.lookupHospitals.forEach(h => { html += `<option value="${esc(h.code)}">${esc(h.name)}</option>`; });
    selLookup.innerHTML = html;
  } catch (e) {
    selLookup.innerHTML = '<option value="">-- Không thể kết nối dữ liệu --</option>';
  }
}
async function refreshHospitalList(btn) {
  let oldText = "";
  if (btn) { oldText = btn.innerHTML; btn.innerHTML = "⏳ Đang tải..."; btn.disabled = true; }
  try {
    appState.hospitals = await fetchUnitsPublic();
    populateHospitalDropdown(appState.hospitals);
    showAppDialog('success', 'Đã Làm Mới', 'Đã cập nhật danh sách đơn vị mới nhất từ hệ thống!');
  } catch (e) {
    showAppDialog('error', 'Lỗi Kết Nối', 'Không thể tải lại danh sách đơn vị: ' + esc(e.message));
  } finally { if (btn) { btn.innerHTML = oldText; btn.disabled = false; } }
}

// ---- Bộ đếm "Đang kết nối" (ping 60 giây/lần) ----
const presenceSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0');
async function pingPresence() {
  if (document.hidden) return;
  try {
    const { data } = await sb.rpc('ping_presence', { p_session: presenceSession });
    if (typeof data === 'number') updateConnectionStatusUI(data);
  } catch (e) {}
}
function updateConnectionStatusUI(count) {
  const badge = document.getElementById('badgeActiveConnections');
  const dot = document.getElementById('dotConnectionStatus');
  const txtCount = document.getElementById('countActiveConnections');
  if (!badge || !dot || !txtCount) return;
  txtCount.innerText = count;
  const ratio = count / MAX_CONNECTIONS;
  const set = (bg, bd, col, dotc, num) => { badge.style.background = bg; badge.style.borderColor = bd; badge.style.color = col; dot.style.background = dotc; txtCount.style.color = num; };
  if (ratio <= 0.5) set("#ecfdf5", "#a7f3d0", "#065f46", "#10b981", "#059669");
  else if (ratio <= 0.7) set("#fefce8", "#fef08a", "#854d0e", "#eab308", "#ca8a04");
  else if (ratio <= 0.9) set("#fff7ed", "#fed7aa", "#9a3412", "#f97316", "#ea580c");
  else set("#fef2f2", "#fecaca", "#991b1b", "#ef4444", "#dc2626");
}

window.onload = async function () {
  if (!window.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY.startsWith('DAN_')) {
    showAppDialog('error', 'Chưa Cấu Hình', 'Chưa điền <strong>SUPABASE_ANON_KEY</strong> trong file <code>config.js</code>.');
    return;
  }
  pingPresence();
  setInterval(pingPresence, 60000);
  try {
    appState.hospitals = await fetchUnitsPublic();
    populateHospitalDropdown(appState.hospitals);
  } catch (e) {
    document.getElementById('maDonVi').innerHTML = '<option value="">-- Không thể tải danh sách đơn vị --</option>';
  }
  loadLookupHospitals();
  const tokenInp = document.getElementById('token');
  if (tokenInp) {
    tokenInp.addEventListener('blur', () => attachRealtimeSync());
    tokenInp.addEventListener('keydown', e => { if (e.key === 'Enter') attachRealtimeSync(); });
  }
  ['hoTen', 'khoaPhong', 'chucVu', 'soDienThoai', 'email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { if (appState.authed && !appState.readOnly) markMetaDirty(); });
  });
  FILE_INPUTS.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) el.addEventListener('change', function () { if (this.files.length && this.dataset.isNew !== 'true') this.dataset.isNew = 'true'; });
  });
  toggleKSKSection();
};
let metaTimer = null;
function markMetaDirty() {
  // Thông tin người nhập liệu / loại hình được tự lưu ngầm, không chặn việc chuyển trang
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { saveMeta().catch(() => {}); }, AUTOSAVE_DELAY_MS);
}

function onDonViChange() {
  const sel = document.getElementById('maDonVi');
  const tokenInp = document.getElementById('token');
  clearAuth();
  if (sel && sel.selectedIndex > 0) {
    document.getElementById('tenDonVi').value = sel.options[sel.selectedIndex].dataset.name || '';
    if (tokenInp && tokenInp.value.trim()) attachRealtimeSync();
  } else {
    document.getElementById('tenDonVi').value = '';
  }
  const sessBox = document.getElementById('sessionHistoryBox');
  if (sessBox) sessBox.style.display = 'none';
}
function onLoaiHinhChange() {
  loadedSteps[2] = false; loadedSteps[3] = false;
  appState.pl3Cache = {}; appState.chaptersPL3 = [];
  if (appState.authed && !appState.readOnly) markMetaDirty();
  if (currentStep === 2) { loadPL1andPL2Data(); loadedSteps[2] = true; }
  else if (currentStep === 3) { loadPL3DataInitial(); loadedSteps[3] = true; }
}

// ===================================================================================
// 7. NẠP VÀ HIỂN THỊ DANH MỤC CÁC PHỤ LỤC (PL1..PL5) TỪ SUPABASE
// ===================================================================================
const TEN_HANG = { H1: "BỆNH VIỆN HẠNG I", H2: "BỆNH VIỆN HẠNG II", H3: "BỆNH VIỆN HẠNG III", H4: "BỆNH VIỆN HẠNG IV", TYT: "TRẠM Y TẾ" };
const currentFacility = () => document.getElementById('loaiHinhCoSo').value;

async function loadPL1andPL2Data() {
  const ft = currentFacility();
  try {
    const rows1 = await fetchAll('catalog_pl1', '*', { or: `facility_type.eq.${ft},facility_type.is.null` });
    const items1 = [{ ten: `HẠNG BỆNH VIỆN / CƠ SỞ: ${TEN_HANG[ft] || ft}`, isHeader: true, hasAction: false }];
    const kb = rows1.find(r => r.facility_type === ft);
    const mk1 = (r, stt) => ({ sttDisplay: stt, ten: r.name, key: r.item_key, c3: r.c3, c4: r.c4, c5: r.c5, c6: r.c6, c7: r.c7, c8: r.c8, c9: r.c9,
      giaDeNghi: r.proposed_price, giaBHYT: r.bhyt_price, giaKhongBHYT: r.non_bhyt_price, hasAction: true });
    if (kb) items1.push(mk1(kb, '1'));
    let auto = 2;
    rows1.filter(r => !r.facility_type).forEach(r => items1.push(mk1(r, String(auto++))));
    appState.pl1 = items1;
    renderPL1();

    const rows2 = await fetchAll('catalog_pl2', '*', { or: `facility_type.eq.${ft},facility_type.is.null` });
    appState.pl2 = rows2.map(r => ({ sttDisplay: r.stt || '', ten: r.name, key: r.item_key, c3: r.c3, c4: r.c4, c5: r.c5, c6: r.c6, c7: r.c7,
      c8: r.c8, c9: r.c9, c10: r.c10, giaDeNghi: r.proposed_price, giaBHYT: r.bhyt_price, giaKhongBHYT: r.non_bhyt_price,
      isHeader: r.is_header, hasAction: !r.is_header }));
    renderPL2();
    updateProgressCounters();
  } catch (e) {
    showAppDialog('error', 'Lỗi Tải Phụ Lục 1 & 2', esc(e.message));
  }
}
function noteInput(type, idx) {
  const item = appState[type][idx];
  const s = getSel(type, item.key);
  return `<input type="text" value="${esc(s ? s.ghiChu : '')}" placeholder="Ghi chú đơn vị..." ${appState.readOnly ? 'disabled' : ''} onchange="onNoteChange('${type}', ${idx}, this.value)">`;
}
function toggleBtn(type, idx, key) {
  const on = isSelected(type, key);
  return `<button type="button" class="btn-toggle ${on ? 'btn-yes' : 'btn-no'}" onclick="toggleSelection('${type}', ${idx}, this)">${on ? 'Có' : 'Không'}</button>`;
}
function renderPL1() {
  const tbody = document.getElementById('bodyPL1');
  let html = '';
  appState.pl1.forEach((item, idx) => {
    if (item.isHeader) {
      html += `<tr class="header-row"><td colspan="14" style="background:#e9ecef; font-weight:bold; color:#0056b3;">${esc(item.ten)}</td></tr>`;
      return;
    }
    html += `
      <tr>
        <td class="col-stt"><strong>${esc(item.sttDisplay)}</strong></td>
        <td class="col-act">${toggleBtn('pl1', idx, item.key)}</td>
        <td class="col-pl1-name"><strong>${esc(item.ten)}</strong></td>
        <td class="cell-price">${formatMoney(item.c3)}</td>
        <td class="cell-price">${formatMoney(item.c4)}</td>
        <td class="cell-price">${formatMoney(item.c5)}</td>
        <td class="cell-price">${formatMoney(item.c6)}</td>
        <td class="cell-price">${formatMoney(item.c7)}</td>
        <td class="cell-price">${formatMoney(item.c8)}</td>
        <td class="cell-price">${formatMoney(item.c9)}</td>
        <td class="cell-price" style="color:var(--primary); font-weight:bold;">${formatMoney(item.giaDeNghi)}</td>
        <td class="cell-price">${formatMoney(item.giaBHYT)}</td>
        <td class="cell-price">${formatMoney(item.giaKhongBHYT)}</td>
        <td class="cell-note">${noteInput('pl1', idx)}</td>
      </tr>`;
  });
  tbody.innerHTML = html;
}
function renderPL2() {
  const tbody = document.getElementById('bodyPL2');
  let html = '';
  appState.pl2.forEach((item, idx) => {
    if (item.isHeader || !item.hasAction) {
      html += `
        <tr class="header-row" style="background:#f1f3f5;">
          <td class="col-stt"><strong>${esc(item.sttDisplay)}</strong></td>
          <td class="col-act" style="color:#888;">-</td>
          <td class="col-pl1-name" colspan="13" style="font-weight:bold; color:#0056b3;">${esc(item.ten)}</td>
        </tr>`;
      return;
    }
    html += `
      <tr>
        <td class="col-stt"><strong>${esc(item.sttDisplay)}</strong></td>
        <td class="col-act">${toggleBtn('pl2', idx, item.key)}</td>
        <td class="col-pl1-name"><strong>${esc(item.ten)}</strong></td>
        <td class="cell-price">${formatMoney(item.c3)}</td>
        <td class="cell-price">${formatMoney(item.c4)}</td>
        <td class="cell-price">${formatMoney(item.c5)}</td>
        <td class="cell-price">${formatMoney(item.c6)}</td>
        <td class="cell-price">${formatMoney(item.c7)}</td>
        <td class="cell-price">${formatMoney(item.c8)}</td>
        <td class="cell-price">${formatMoney(item.c9)}</td>
        <td class="cell-price">${formatMoney(item.c10)}</td>
        <td class="cell-price" style="color:var(--primary); font-weight:bold;">${formatMoney(item.giaDeNghi)}</td>
        <td class="cell-price">${formatMoney(item.giaBHYT)}</td>
        <td class="cell-price">${formatMoney(item.giaKhongBHYT)}</td>
        <td class="cell-note">${noteInput('pl2', idx)}</td>
      </tr>`;
  });
  tbody.innerHTML = html;
}
function onNoteChange(type, idx, value) {
  if (appState.readOnly) return;
  const item = appState[type][idx];
  setSel(type, item.key, { ghiChu: value, chuong: item.chuong || item.chapter || (getSel(type, item.key) || {}).chuong || '' });
  markDirty();
  updateProgressCounters();
}
function toggleSelection(type, idx, btn) {
  if (appState.readOnly) return;
  const item = appState[type][idx];
  const on = !isSelected(type, item.key);
  setSel(type, item.key, { tichChon: on, chuong: item.chapter || '' });
  btn.className = on ? 'btn-toggle btn-yes' : 'btn-toggle btn-no';
  btn.innerText = on ? 'Có' : 'Không';
  markDirty();
  updateProgressCounters();
}

// ---------- PL3 ----------
async function loadPL3DataInitial() {
  const isTYT = currentFacility() === "TYT";
  const selChuong = document.getElementById('selectChuongPL3');
  selChuong.innerHTML = '<option value="">⏳ Đang nạp danh mục Chương...</option>';
  try {
    const chapters = (await rpc('pl3_chapters', { p_scope: isTYT ? 'TYT' : 'BV' })) || [];
    appState.chaptersPL3 = chapters.map(c => ({ name: c.name, count: Number(c.cnt) }));
    selChuong.innerHTML = '';
    if (!chapters.length) { selChuong.innerHTML = '<option value="">Không có dữ liệu chương</option>'; return; }
    appState.chaptersPL3.forEach(c => {
      let opt = document.createElement('option');
      opt.value = c.name; opt.text = `${c.name} (${c.count} DV)`;
      selChuong.appendChild(opt);
    });
    updateProgressCounters();
    renderChapterProgressBar();
    loadPL3Chapter(appState.chaptersPL3[0].name);
  } catch (e) {
    selChuong.innerHTML = '<option value="">❌ Lỗi tải danh sách chương</option>';
    showAppDialog('error', 'Lỗi Tải Phụ Lục 3', 'Không thể kết nối danh sách chương: ' + esc(e.message));
  }
}
function onChuongPL3Change() {
  currentPL3DisplayLimit = 100;
  const chuong = document.getElementById('selectChuongPL3').value;
  if (chuong) loadPL3Chapter(chuong);
}
async function loadPL3Chapter(chuong) {
  const isTYT = currentFacility() === "TYT";
  const tbody = document.getElementById('bodyPL3');
  if (appState.pl3Cache[chuong]) { renderPL3(appState.pl3Cache[chuong]); return; }
  tbody.innerHTML = '<tr><td colspan="20" style="text-align:center;">⏳ Đang tải kỹ thuật của chương...</td></tr>';
  try {
    const rows = await fetchAll('catalog_pl3', '*', { eq: { scope: isTYT ? 'TYT' : 'BV', chapter: chuong } });
    rows.forEach(r => { r.key = r.item_key; });
    appState.pl3Cache[chuong] = rows;
    if (document.getElementById('selectChuongPL3').value === chuong) renderPL3(rows);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="20" style="color:red; text-align:center;">Lỗi máy chủ: ${esc(e.message)}</td></tr>`;
  }
}
function renderPL3(items) {
  const tbody = document.getElementById('bodyPL3');
  const search = document.getElementById('searchPL3').value.toLowerCase().trim();
  const onlyCo = document.getElementById('chkOnlyCoPL3').checked;
  const isTYT = currentFacility() === "TYT";
  const filtered = items.filter(r => {
    if (onlyCo && !isSelected('pl3', r.key)) return false;
    if (search) {
      return String(r.tech_code || '').toLowerCase().includes(search) ||
             String(r.tech_name || '').toLowerCase().includes(search) ||
             String(r.approved_name || '').toLowerCase().includes(search);
    }
    return true;
  });
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="20" style="text-align:center; color:#888;">Không có dịch vụ phù hợp.</td></tr>';
    return;
  }
  let stt = 1, html = '';
  filtered.slice(0, currentPL3DisplayLimit).forEach(r => {
    const s = getSel('pl3', r.key);
    const isCo = !!(s && s.tichChon);
    html += `
      <tr>
        <td class="col-stt"><strong>${stt++}</strong></td>
        <td class="col-act"><button type="button" class="btn-toggle ${isCo ? 'btn-yes' : 'btn-no'}" data-k="${esc(r.key)}" onclick="togglePL3Selection(this)">${isCo ? 'Có' : 'Không'}</button></td>
        <td class="col-pl3-3">${esc(r.common_code)}</td>
        <td class="col-pl3-4">${esc(r.chapter)}</td>
        <td class="col-pl3-5"><strong>${esc(r.tech_code)}</strong></td>
        <td class="col-pl3-6"><strong>${esc(r.tech_name)}</strong></td>
        <td class="col-pl3-7" style="color:#0056b3; font-weight:500;">${esc(r.approved_name)}</td>
        <td class="cell-price">${formatMoney(r.direct_cost_allowance)}</td>
        <td class="cell-price">${formatMoney(r.salary_1800)}</td>
        <td class="cell-price">${formatMoney(r.salary_2340)}</td>
        <td class="cell-price">${formatMoney(r.price_tt21_22)}</td>
        <td class="cell-price">${formatMoney(r.price_2340)}</td>
        <td class="cell-price">${formatMoney(r.mgmt_cost_4pct)}</td>
        <td class="cell-price">${formatMoney(r.price_incl_mgmt)}</td>
        <td class="cell-price" style="font-weight: 500; color: #d63384;">${isTYT ? formatMoney(r.price_70pct) : '-'}</td>
        <td class="cell-price" style="color:var(--primary); font-weight:bold;">${formatMoney(r.proposed_price)}</td>
        <td class="cell-price">${formatMoney(r.bhyt_price)}</td>
        <td class="cell-price">${formatMoney(r.non_bhyt_price)}</td>
        <td style="font-size:12px; color:#475569; min-width:120px;">${esc(r.original_note)}</td>
        <td class="cell-note"><input type="text" value="${esc(s ? s.ghiChu : '')}" placeholder="Ghi chú đơn vị..." ${appState.readOnly ? 'disabled' : ''} data-k="${esc(r.key)}" onchange="updatePL3Note(this)"></td>
      </tr>`;
  });
  if (filtered.length > currentPL3DisplayLimit) {
    html += `<tr><td colspan="20" style="text-align:center; background:#f8fafc; padding:12px;">
      <button type="button" class="btn btn-primary" onclick="loadMorePL3()">Hiển thị thêm 100 dịch vụ tiếp theo (Còn ${filtered.length - currentPL3DisplayLimit} DV) ⏬</button></td></tr>`;
  }
  tbody.innerHTML = html;
}
function loadMorePL3() {
  currentPL3DisplayLimit += 100;
  const chuong = document.getElementById('selectChuongPL3').value;
  if (appState.pl3Cache[chuong]) renderPL3(appState.pl3Cache[chuong]);
}
function togglePL3Selection(btn) {
  if (appState.readOnly) return;
  const key = btn.dataset.k;
  const chuong = document.getElementById('selectChuongPL3').value;
  const on = !isSelected('pl3', key);
  setSel('pl3', key, { tichChon: on, chuong });
  btn.className = on ? 'btn-toggle btn-yes' : 'btn-toggle btn-no';
  btn.innerText = on ? 'Có' : 'Không';
  markDirty();
  updateProgressCounters();
  renderChapterProgressBar();
}
function updatePL3Note(inp) {
  if (appState.readOnly) return;
  const chuong = document.getElementById('selectChuongPL3').value;
  setSel('pl3', inp.dataset.k, { ghiChu: inp.value, chuong });
  markDirty();
}
function setAllPL3ForChapter(status) {
  if (appState.readOnly) return;
  const chuong = document.getElementById('selectChuongPL3').value;
  if (!chuong || !appState.pl3Cache[chuong]) return;
  appState.pl3Cache[chuong].forEach(r => setSel('pl3', r.key, { tichChon: status, chuong }));
  markDirty();
  renderPL3(appState.pl3Cache[chuong]);
  updateProgressCounters();
  renderChapterProgressBar();
}
function filterPL3Table() {
  const chuong = document.getElementById('selectChuongPL3').value;
  if (appState.pl3Cache[chuong]) renderPL3(appState.pl3Cache[chuong]);
}

// ---------- PL4 / PL5 ----------
async function loadPL4Data() {
  try {
    if (!appState.pl4Loaded) {
      const rows = await fetchAll('catalog_pl4', '*');
      rows.forEach(r => { r.key = r.item_key; });
      appState.pl4 = rows; appState.pl4Loaded = true;
    }
    renderPL4(); updateProgressCounters();
  } catch (e) { showAppDialog('error', 'Lỗi Tải Phụ Lục 4', esc(e.message)); }
}
async function loadPL5Data() {
  try {
    if (!appState.pl5Loaded) {
      const rows = await fetchAll('catalog_pl5', '*');
      rows.forEach(r => { r.key = r.item_key; });
      appState.pl5 = rows; appState.pl5Loaded = true;
    }
    renderPL5(); updateProgressCounters();
  } catch (e) { showAppDialog('error', 'Lỗi Tải Phụ Lục 5', esc(e.message)); }
}
function renderPL4() {
  const tbody = document.getElementById('bodyPL4');
  const search = document.getElementById('searchPL4').value.toLowerCase().trim();
  const onlyCo = document.getElementById('chkOnlyCoPL4').checked;
  const filtered = appState.pl4.filter(r => {
    if (onlyCo && !isSelected('pl4', r.key)) return false;
    if (search) return String(r.tech_code || '').toLowerCase().includes(search) ||
      String(r.tech_name || '').toLowerCase().includes(search) || String(r.common_code || '').toLowerCase().includes(search);
    return true;
  });
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="20" style="text-align:center; color:#888;">Không có dữ liệu.</td></tr>'; return; }
  let stt = 1, html = '';
  filtered.forEach(r => {
    const idx = appState.pl4.indexOf(r);
    html += `
      <tr>
        <td class="col-stt"><strong>${stt++}</strong></td>
        <td class="col-act">${toggleBtn('pl4', idx, r.key)}</td>
        <td class="col-pl3-3">${esc(r.common_code)}</td>
        <td class="col-pl3-4">${esc(r.chapter)}</td>
        <td class="col-pl3-5"><strong>${esc(r.tech_code)}</strong></td>
        <td class="col-pl3-6"><strong>${esc(r.tech_name)}</strong></td>
        <td class="col-pl3-7" style="color:#0056b3;">${esc(r.approved_name)}</td>
        <td class="cell-price">${formatMoney(r.direct_cost_allowance)}</td>
        <td class="cell-price">${formatMoney(r.salary_1800)}</td>
        <td class="cell-price">${formatMoney(r.salary_2340)}</td>
        <td class="cell-price">${formatMoney(r.price_tt21_22)}</td>
        <td class="cell-price">${formatMoney(r.price_2340)}</td>
        <td class="cell-price">${formatMoney(r.mgmt_cost_4pct)}</td>
        <td class="cell-price">${formatMoney(r.price_incl_mgmt)}</td>
        <td class="cell-price" style="color:var(--primary); font-weight:bold;">${formatMoney(r.proposed_price)}</td>
        <td class="cell-price">${formatMoney(r.bhyt_price)}</td>
        <td class="cell-price">${formatMoney(r.non_bhyt_price)}</td>
        <td>${esc(r.original_note)}</td>
        <td class="cell-note">${noteInput('pl4', idx)}</td>
      </tr>`;
  });
  tbody.innerHTML = html;
}
function renderPL5() {
  const tbody = document.getElementById('bodyPL5');
  const search = document.getElementById('searchPL5').value.toLowerCase().trim();
  const onlyCo = document.getElementById('chkOnlyCoPL5').checked;
  const filtered = appState.pl5.filter(r => {
    if (onlyCo && !isSelected('pl5', r.key)) return false;
    if (search) return String(r.common_code || '').toLowerCase().includes(search) || String(r.tech_name || '').toLowerCase().includes(search);
    return true;
  });
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="19" style="text-align:center; color:#888;">Không có dữ liệu.</td></tr>'; return; }
  let stt = 1, html = '';
  filtered.forEach(r => {
    const idx = appState.pl5.indexOf(r);
    html += `
      <tr>
        <td class="col-stt"><strong>${stt++}</strong></td>
        <td class="col-act">${toggleBtn('pl5', idx, r.key)}</td>
        <td class="col-pl5-3">${esc(r.common_code)}</td>
        <td class="col-pl5-4">${esc(r.chapter)}</td>
        <td class="col-pl5-5"><strong>${esc(r.tech_name)}</strong></td>
        <td class="col-pl5-6" style="color:#0056b3;">${esc(r.approved_name)}</td>
        <td class="cell-price">${formatMoney(r.direct_cost_allowance)}</td>
        <td class="cell-price">${formatMoney(r.salary_2340)}</td>
        <td class="cell-price">${formatMoney(r.price_8)}</td>
        <td class="cell-price">${formatMoney(r.film_cost)}</td>
        <td class="cell-price">${formatMoney(r.price_ex_film)}</td>
        <td class="cell-price">${formatMoney(r.mgmt_cost_4pct)}</td>
        <td class="cell-price">${formatMoney(r.price_incl_mgmt)}</td>
        <td class="cell-price" style="color:var(--primary); font-weight:bold;">${formatMoney(r.proposed_price)}</td>
        <td class="cell-price">${formatMoney(r.bhyt_price)}</td>
        <td class="cell-price">${formatMoney(r.non_bhyt_price)}</td>
        <td>${esc(r.original_note)}</td>
        <td class="cell-note">${noteInput('pl5', idx)}</td>
      </tr>`;
  });
  tbody.innerHTML = html;
}
function filterGenericTable(plType) {
  if (plType === 'PL4') renderPL4(); else if (plType === 'PL5') renderPL5();
}
function setAllGeneric(type, status) {
  if (appState.readOnly) return;
  appState[type].forEach(r => setSel(type, r.key, { tichChon: status, chuong: r.chapter || '' }));
  markDirty();
  if (type === 'pl4') renderPL4(); else if (type === 'pl5') renderPL5();
  updateProgressCounters();
}

// ===================================================================================
// 8. NHẬP TỪ EXCEL (đối chiếu trực tiếp ở trình duyệt với danh mục Supabase)
// ===================================================================================
async function ensureCatalogForMatch(targetPL, isTYT) {
  if (targetPL === 'pl3') {
    const scope = isTYT ? 'TYT' : 'BV';
    if (!appState.pl3Index[scope]) {
      appState.pl3Index[scope] = await fetchAll('catalog_pl3', 'common_code,chapter,tech_code,item_key', { eq: { scope } });
    }
    return appState.pl3Index[scope];
  }
  if (targetPL === 'pl4') { if (!appState.pl4Loaded) await loadPL4Data(); return appState.pl4; }
  if (!appState.pl5Loaded) await loadPL5Data();
  return appState.pl5;
}
function matchExcelEntries(targetPL, data, excelEntries) {
  const norm = s => String(s || "").trim().toLowerCase().replace(/[\s\.\-_]/g, "");
  const cleanCh = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const matched = [], added = new Set();
  excelEntries.forEach(entry => {
    const exMaKT = norm(entry.maKT), exMaChung = norm(entry.maChung), exChuong = cleanCh(entry.chuong);
    const note = String(entry.note || "").trim();
    if (!exMaKT && !exMaChung) return;
    let cands = [];
    if (targetPL === 'pl3' || targetPL === 'pl4') {
      if (exMaKT) cands = data.filter(r => norm(r.tech_code) === exMaKT);
      if (cands.length !== 1 && exMaChung) {
        const byMa = (cands.length > 1 ? cands : data).filter(r => norm(r.common_code) === exMaChung);
        if (byMa.length > 0) cands = byMa;
      }
    } else if (exMaChung) {
      cands = data.filter(r => norm(r.common_code) === exMaChung);
    }
    if (cands.length > 1 && exChuong) {
      const byCh = cands.filter(r => { const c = cleanCh(r.chapter); return c.includes(exChuong) || exChuong.includes(c); });
      if (byCh.length > 0) cands = byCh;
    }
    cands.forEach(r => {
      const k = r.item_key;
      if (!added.has(k)) { added.add(k); matched.push({ key: k, chuong: String(r.chapter || '').trim(), ghiChu: note }); }
    });
  });
  return matched;
}
function handleExcelImportPL3(e) { handleExcelImportUniversal('pl3', e); }
function handleExcelImportUniversal(targetPL, e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!appState.authed) {
    showAppDialog('warning', 'Thiếu Thông Tin', 'Vui lòng chọn <strong>Tên Đơn vị</strong> và nhập đúng <strong>Mã xác thực</strong> trước khi import Excel!');
    e.target.value = '';
    return;
  }
  if (appState.readOnly) { e.target.value = ''; return; }
  const isTYT = currentFacility() === "TYT";
  showAppDialog('confirm', 'Đang Xử Lý', '⏳ Hệ thống đang đọc file Excel và đối chiếu danh mục kỹ thuật, vui lòng chờ...');
  const reader = new FileReader();
  reader.onload = async function (evt) {
    try {
      const workbook = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: false });
      if (!rows || rows.length <= 1) { closeAppDialog(); showAppDialog('warning', 'File Rỗng', 'File Excel không có dữ liệu nội dung!'); return; }
      let colMaChung = -1, colMaKT = -1, colChuong = -1, colGhiChu = -1, startRowIdx = 0;
      for (let r = 0; r < Math.min(rows.length, 15); r++) {
        const row = rows[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) {
          const val = cleanKey(row[c]);
          if (val.includes('dùng chung') || val.includes('ma dung chung') || val.includes('mã c')) colMaChung = c;
          if (val.includes('mã kỹ thuật') || val.includes('ma ky thuat') || val.includes('mã kt') || val.includes('23/2024')) colMaKT = c;
          if (val.includes('chương') || val.includes('chuong')) colChuong = c;
          if (val.includes('ghi chú') || val.includes('ghichu') || val.includes('note')) colGhiChu = c;
        }
        if (colMaKT !== -1 || colMaChung !== -1) { startRowIdx = r + 1; break; }
      }
      if (colMaKT === -1 && colMaChung === -1) { colMaChung = 1; colChuong = 2; colMaKT = (targetPL === 'pl5') ? -1 : 3; startRowIdx = 1; }
      const excelEntries = [];
      for (let i = startRowIdx; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        const mC = colMaChung !== -1 ? String(r[colMaChung] || '').trim() : '';
        const mKT = colMaKT !== -1 ? String(r[colMaKT] || '').trim() : '';
        if (mC || mKT) excelEntries.push({ maChung: mC, maKT: mKT,
          chuong: colChuong !== -1 ? String(r[colChuong] || '').trim() : '',
          note: colGhiChu !== -1 ? String(r[colGhiChu] || '').trim() : '' });
      }
      if (!excelEntries.length) { closeAppDialog(); showAppDialog('warning', 'Không Có Dữ Liệu', 'Không tìm thấy cột Mã dịch vụ trong file Excel!'); return; }
      const catalog = await ensureCatalogForMatch(targetPL, isTYT);
      const matched = matchExcelEntries(targetPL, catalog, excelEntries);
      closeAppDialog();
      if (!matched.length) {
        showAppDialog('warning', 'Không Tìm Thấy Mã Phù Hợp',
          `Không có dịch vụ kỹ thuật nào trong file khớp với danh mục <strong>${targetPL.toUpperCase()}</strong>.<br>Vui lòng kiểm tra lại cột mã kỹ thuật hoặc mã dùng chung.`);
        return;
      }
      matched.forEach(m => setSel(targetPL, m.key, { tichChon: true, ghiChu: m.ghiChu, chuong: m.chuong }));
      markDirty();
      rerenderCurrentStep();
      updateProgressCounters();
      renderChapterProgressBar();
      showAppDialog('success', 'Nhập Dữ Liệu Thành Công',
        `Đã đối chiếu thành công và tự động tích chọn <strong>${matched.length}</strong> dịch vụ kỹ thuật cho <strong>${targetPL.toUpperCase()}</strong>!`);
    } catch (err) {
      closeAppDialog();
      showAppDialog('error', 'Lỗi Đọc File', 'Không thể đọc file: ' + esc(err.message));
    } finally { e.target.value = ''; }
  };
  reader.readAsArrayBuffer(file);
}

// ===================================================================================
// 9. BỘ ĐẾM TIẾN ĐỘ
// ===================================================================================
function countSelected(type) {
  let n = 0;
  const m = appState.sel[type];
  for (const k in m) if (m[k] && m[k].tichChon) n++;
  return n;
}
function updateProgressCounters() {
  const c = PL_TYPES.map(countSelected);
  ['statPL1', 'statPL2', 'statPL3', 'statPL4', 'statPL5'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.innerText = c[i];
  });
  const elTotal = document.getElementById('statTotal');
  if (elTotal) elTotal.innerText = c.reduce((a, b) => a + b, 0);
}
function renderChapterProgressBar() {
  const bar = document.getElementById('chapterProgressBar');
  if (!bar) return;
  if (!appState.chaptersPL3 || appState.chaptersPL3.length === 0) { bar.innerHTML = ''; return; }
  const chapterActiveCount = {};
  const m = appState.sel.pl3;
  for (const k in m) {
    if (m[k] && m[k].tichChon && m[k].chuong) {
      const kc = cleanKey(m[k].chuong);
      chapterActiveCount[kc] = (chapterActiveCount[kc] || 0) + 1;
    }
  }
  let html = '';
  appState.chaptersPL3.forEach(c => {
    const countCo = chapterActiveCount[cleanKey(c.name)] || 0;
    html += `<div class="${countCo > 0 ? 'chapter-badge has-co' : 'chapter-badge'}">${esc(c.name)}: <strong>${countCo}</strong>/${c.count}</div>`;
  });
  bar.innerHTML = html;
}

// ===================================================================================
// 10. LƯU TẠM
// ===================================================================================
async function ensureAuthed() {
  if (appState.authed) return true;
  const ma = document.getElementById('maDonVi').value;
  const token = document.getElementById('token').value;
  if (!ma || !token) {
    showAppDialog('warning', 'Thiếu Thông Tin Xác Thực', 'Vui lòng chọn <strong>Tên đơn vị</strong> và nhập <strong>Mã xác thực (Token)</strong> trước khi bấm Lưu!');
    return false;
  }
  await attachRealtimeSync(true);
  return !!appState.authed;
}
async function saveDraft(pageIndex, callback) {
  if (!(await ensureAuthed())) return;
  if (appState.readOnly) { showAppDialog('warning', 'Chế Độ Chỉ Xem', 'Đơn vị đã gửi báo cáo chính thức nên không thể chỉnh sửa.'); return; }
  const saveButtons = document.querySelectorAll('.btn-success');
  saveButtons.forEach(btn => { btn.dataset.oldText = btn.innerText; btn.innerText = "⏳ Đang lưu..."; btn.disabled = true; });
  const restore = () => saveButtons.forEach(btn => { btn.innerText = btn.dataset.oldText || "💾 Lưu"; btn.disabled = false; });
  try {
    clearTimeout(autosaveTimer); clearTimeout(metaTimer);
    await uploadPendingFiles();
    await flushPending();
    await saveMeta();
    isDirty = false;
    restore();
    if (callback) { toast('✔ Đã lưu tạm'); callback(); }
    else showAppDialog('success', 'Lưu Thành Công', pageIndex === 1
      ? 'Đã lưu thông tin đơn vị và tải các tệp đính kèm lên hệ thống.'
      : 'Dữ liệu đã được lưu an toàn trên hệ thống.');
  } catch (e) {
    restore();
    showAppDialog('error', 'Lỗi Lưu Tạm', esc(e.message));
  }
}

// ===================================================================================
// 11. NỘP BÁO CÁO CHÍNH THỨC
// ===================================================================================
async function submitFinalReport() {
  const ma = document.getElementById('maDonVi').value;
  const token = document.getElementById('token').value;
  const c = currentContact();
  const missingErrors = [];
  if (!ma) missingErrors.push("Chưa chọn <strong>Tên Đơn vị</strong>.");
  if (!token) missingErrors.push("Chưa nhập <strong>Mã xác thực (Token)</strong>.");
  if (!c.hoTen) missingErrors.push("Chưa nhập <strong>Họ và tên người thực hiện</strong>.");
  if (!c.khoaPhong) missingErrors.push("Chưa nhập <strong>Khoa / Phòng</strong>.");
  if (!c.chucVu) missingErrors.push("Chưa nhập <strong>Chức vụ</strong>.");
  if (!c.soDienThoai) missingErrors.push("Chưa nhập <strong>Số điện thoại liên hệ</strong>.");
  if (!c.email) missingErrors.push("Chưa nhập <strong>Email liên hệ</strong>.");
  const hasNew = id => { const el = document.getElementById(id); return el && el.files.length > 0; };
  const hasStored = t => appState.files.some(f => f.type === t);
  const isKSKChecked = document.getElementById('chkDuDieuKienKSK') && document.getElementById('chkDuDieuKienKSK').checked;
  if (!(hasNew('fileHangBV') || hasStored('QD_XepHangBV_hoac_QD_ThanhlapTYT')))
    missingErrors.push("Thiếu: <strong>Quyết định xếp hạng Bệnh viện / Quyết định thành lập Trạm Y tế (*)</strong> (Trang 1).");
  if (!(hasNew('filePheDuyetDVKT') || hasStored('QD_PheDuyetDVKT')))
    missingErrors.push("Thiếu: <strong>Quyết định phê duyệt dịch vụ kỹ thuật (*)</strong> (Trang 2).");
  if (isKSKChecked && !(hasNew('fileDuDieuKienKSK') || hasStored('QD_DuDieuKienKSK')))
    missingErrors.push("Đơn vị đã tích chọn đủ điều kiện khám sức khỏe nhưng chưa đính kèm: <strong>Quyết định / Thông báo đủ điều kiện khám sức khỏe (*)</strong> (Trang 2).");
  if (missingErrors.length > 0) {
    showAppDialog('warning', 'CẢNH BÁO THIẾU HỒ SƠ BẮT BUỘC', 'Hồ sơ báo cáo chưa đầy đủ. Vui lòng bổ sung các nội dung sau trước khi gửi:', missingErrors);
    return;
  }
  if (!(await ensureAuthed())) return;
  const total = Number(document.getElementById('statTotal').innerText);
  const confirmHtml = `
    <p style="margin: 4px 0;">Đơn vị đã chọn đề xuất: <strong style="color:#059669; font-size:16px;">${total}</strong> dịch vụ kỹ thuật.</p>
    <p style="margin: 4px 0;">Sau khi gửi thành công, đơn vị sẽ <strong>CHUYỂN SANG TRẠNG THÁI KHÓA</strong> để Hội đồng tổng hợp.</p>
    <p style="margin: 4px 0; color:#0284c7;"><em>Quý đơn vị có thể mở mục Tra cứu để xem lại liên kết báo cáo và hồ sơ bất kỳ lúc nào.</em></p>`;
  showAppDialog('confirm', 'XÁC NHẬN GỬI BÁO CÁO CHÍNH THỨC', confirmHtml, null, async function () {
    const btnSubmit = document.getElementById('btnFinalSubmit');
    btnSubmit.disabled = true;
    btnSubmit.innerText = "⏳ Đang xử lý nộp báo cáo...";
    try {
      clearTimeout(autosaveTimer); clearTimeout(metaTimer);
      await uploadPendingFiles();
      await flushPending();
      await saveMeta();
      const res = await rpc('submit_report', { p_code: appState.authed.ma, p_token: appState.authed.token,
        p_contact: { hoTen: c.hoTen, khoaPhong: c.khoaPhong, chucVu: c.chucVu, soDienThoai: c.soDienThoai, emailThaoTac: c.email },
        p_facility_type: currentFacility() });
      isDirty = false;
      showAppDialog('success', 'Nộp Báo Cáo Thành Công',
        `Đã gửi báo cáo thành công lúc ${formatDateTime(new Date().toISOString())}!<br>Đơn vị đã được khóa để Hội đồng tổng hợp.<br>(Quý đơn vị có thể tra cứu lại báo cáo và hồ sơ tại mục Tra cứu).`,
        null, function () { window.location.reload(); });
    } catch (e) {
      showAppDialog(e.kind === 'MISSING_FILES' ? 'warning' : 'error', 'Lỗi Nộp Báo Cáo', esc(e.message));
      btnSubmit.disabled = false;
      btnSubmit.innerText = "🚀 GỬI BÁO CÁO CHÍNH THỨC";
    }
  });
}

// ===================================================================================
// 12. KHÔI PHỤC BẢN LƯU TẠM & CÁC PHIÊN CŨ
// ===================================================================================
async function restoreDraftData() {
  const btn = window.event ? window.event.target : null;
  const ma = document.getElementById('maDonVi').value, token = document.getElementById('token').value;
  if (!ma || !token) { showAppDialog('warning', 'Thiếu Thông Tin', 'Vui lòng chọn Đơn vị và nhập Token để khôi phục bản lưu tạm!'); return; }
  let oldText = "";
  if (btn) { oldText = btn.innerText; btn.innerText = "⏳ Đang tải..."; btn.disabled = true; }
  try {
    await attachRealtimeSync(true);
    if (appState.authed) showAppDialog('success', 'Khôi Phục Thành Công', 'Đã tải lại số liệu và hồ sơ đã lưu của đơn vị!');
  } finally { if (btn) { btn.innerText = oldText; btn.disabled = false; } }
}
async function openSubmittedSessionsModal() {
  const ma = document.getElementById('maDonVi').value, token = document.getElementById('token').value;
  if (!ma || !token) { showAppDialog('warning', 'Yêu Cầu Xác Thực', 'Vui lòng chọn Đơn vị và nhập Mã xác thực (Token) để tra cứu các phiên cũ!'); return; }
  const btn = window.event ? window.event.target : null;
  let oldText = "";
  if (btn) { oldText = btn.innerText; btn.innerText = "⏳ Đang tìm..."; btn.disabled = true; }
  try {
    const res = await rpc('list_submissions', { p_code: ma, p_token: token });
    if (!res.list || !res.list.length) { showAppDialog('warning', 'Không Tìm Thấy', 'Đơn vị chưa có phiên báo cáo nào đã nộp trước đó.'); return; }
    const sel = document.getElementById('selectSubmittedSessions');
    sel.innerHTML = '';
    res.list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.text = `Phiên gửi: ${formatDateTime(item.submittedAt)} - Người gửi: ${item.hoTen || 'Chưa rõ'} (${item.status})`;
      opt.dataset.hoTen = item.hoTen || ''; opt.dataset.khoaPhong = item.khoaPhong || ''; opt.dataset.chucVu = item.chucVu || '';
      opt.dataset.soDienThoai = item.soDienThoai || ''; opt.dataset.email = item.email || ''; opt.dataset.hasSnapshot = item.hasSnapshot ? '1' : '';
      sel.appendChild(opt);
    });
    document.getElementById('sessionHistoryBox').style.display = 'block';
  } catch (e) {
    showAppDialog(e.kind === 'AUTH_FAILED' ? 'warning' : 'error', 'Lỗi Tra Cứu', esc(e.message));
  } finally { if (btn) { btn.innerText = oldText; btn.disabled = false; } }
}
async function loadSelectedSubmittedSession() {
  const ma = document.getElementById('maDonVi').value, token = document.getElementById('token').value;
  const sel = document.getElementById('selectSubmittedSessions');
  if (!sel || !sel.value) { showAppDialog('warning', 'Chưa Chọn Phiên', 'Vui lòng chọn một phiên trong danh sách!'); return; }
  const opt = sel.options[sel.selectedIndex];
  const btn = window.event ? window.event.target : null;
  let oldText = "";
  if (btn) { oldText = btn.innerText; btn.innerText = "⏳ Đang tải..."; btn.disabled = true; }
  try {
    const res = await rpc('restore_submission', { p_code: ma, p_token: token, p_submission_id: Number(sel.value) });
    const setVal = (id, v) => { if (v) document.getElementById(id).value = v; };
    setVal('hoTen', opt.dataset.hoTen); setVal('khoaPhong', opt.dataset.khoaPhong); setVal('chucVu', opt.dataset.chucVu);
    setVal('soDienThoai', opt.dataset.soDienThoai); setVal('email', opt.dataset.email);
    await attachRealtimeSync(true);
    showAppDialog('success', 'Khôi Phục Thành Công', res.note === 'legacy'
      ? 'Phiên này được nhập từ hệ thống cũ: số liệu hiện tại của đơn vị chính là dữ liệu của phiên gửi cuối cùng. Đã tải lại thông tin người gửi của phiên.'
      : `Đã tải lại toàn bộ số liệu của phiên gửi [${esc(opt.text)}]!`);
  } catch (e) {
    showAppDialog(e.kind === 'UNIT_LOCKED' ? 'warning' : 'error', e.kind === 'UNIT_LOCKED' ? 'Đơn Vị Đang Khóa' : 'Lỗi Tải Phiên', esc(e.message));
  } finally { if (btn) { btn.innerText = oldText; btn.disabled = false; } }
}
function confirmSaveAndNavigate() {
  closeUnsavedModal();
  saveDraft(currentStep, function () { isDirty = false; doNavigate(targetNavigateStep); });
}
function confirmIgnoreAndNavigate() { isDirty = false; closeUnsavedModal(); doNavigate(targetNavigateStep); }
function closeUnsavedModal() { document.getElementById('unsavedModal').style.display = 'none'; }
function toggleTokenVisibility(btn) {
  const t = document.getElementById('token');
  if (!t) return;
  t.type = t.type === 'password' ? 'text' : 'password';
  btn.innerText = t.type === 'password' ? '👁️' : '🙈';
}
function toggleLookupTokenVisibility(btn) {
  const t = document.getElementById('lookupToken');
  if (!t) return;
  t.type = t.type === 'password' ? 'text' : 'password';
  btn.innerText = t.type === 'password' ? '👁️' : '🙈';
}

// ===================================================================================
// 13. TRA CỨU PHIÊN CUỐI CÙNG
// ===================================================================================
const X_OR_DASH = v => v ? '<span class="badge-x">X</span>' : '<span style="color:#94a3b8;">-</span>';
async function lookupLatestSession(btn) {
  const ma = document.getElementById('lookupDonVi').value.trim();
  const token = document.getElementById('lookupToken').value.trim();
  const resultBox = document.getElementById('lookupResultBox');
  const detailInfo = document.getElementById('lookupDetailInfo');
  const linksArea = document.getElementById('lookupLinksArea');
  if (!ma || !token) { showAppDialog('warning', 'Thiếu Thông Tin', 'Vui lòng chọn <strong>Tên đơn vị</strong> và nhập <strong>Mã xác thực (Token)</strong> để tra cứu!'); return; }
  let oldText = "";
  if (btn) { oldText = btn.innerHTML; btn.innerHTML = "⏳ Đang tra cứu..."; btn.disabled = true; }
  try {
    const res = await rpc('lookup_latest_submission', { p_code: ma, p_token: token });
    const statusBadge = res.isLocked
      ? `<span style="color:#b91c1c; background:#fee2e2; padding:3px 10px; border-radius:12px; font-weight:bold; border:1px solid #fca5a5;">🔒 ${esc(res.status)}</span>`
      : `<span style="color:#15803d; background:#dcfce7; padding:3px 10px; border-radius:12px; font-weight:bold; border:1px solid #86efac;">🔓 ${esc(res.status)}</span>`;
    const counts = res.counts || {};
    const n = v => (v || 0).toLocaleString('vi-VN');
    const pl1Html = `
      <div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
        <div style="font-weight: 700; color: #0369a1; margin-bottom: 6px;">PHỤ LỤC 1 (ĐÁNH DẤU X LÀ CÓ):</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px; font-size: 12.5px;">
          <div>• Khám bệnh: ${X_OR_DASH(counts.pl1_kb)}</div>
          <div>• Hội chẩn để xác định ca bệnh khó (chuyên gia/ca; Chỉ áp dụng đối với trường hợp mời chuyên gia đơn vị khác đến hội chẩn tại cơ sở khám, chữa bệnh): ${X_OR_DASH(counts.pl1_hc)}</div>
          <div>• Khám cấp giấy chứng thương, giám định y khoa (không kể xét nghiệm, X-quang): ${X_OR_DASH(counts.pl1_gd)}</div>
          <div>• Khám sức khỏe toàn diện lao động, lái xe, khám sức khỏe định kỳ (không kể xét nghiệm, X-quang): ${X_OR_DASH(counts.pl1_skld)}</div>
          <div>• Khám sức khỏe toàn diện cho người đi xuất khẩu lao động (không kể xét nghiệm, X-quang): ${X_OR_DASH(counts.pl1_xkd)}</div>
        </div>
      </div>`;
    const countsSummaryHtml = `
      <div style="margin-top: 8px; padding: 10px; background: #f0fdf4; border-radius: 8px; border: 1px solid #bbf7d0; display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px;">
        <div><strong>Phụ lục 2:</strong> <span style="color:#0369a1; font-weight:800;">${n(counts.c2)}</span></div>
        <div><strong>Phụ lục 3:</strong> <span style="color:#0369a1; font-weight:800;">${n(counts.c3)}</span></div>
        <div><strong>Phụ lục 4:</strong> <span style="color:#0369a1; font-weight:800;">${n(counts.c4)}</span></div>
        <div><strong>Phụ lục 5:</strong> <span style="color:#0369a1; font-weight:800;">${n(counts.c5)}</span></div>
        <div><strong>Tổng KT (PL3+PL4+PL5):</strong> <span style="color:#059669; font-weight:800;">${n(counts.totalKT)}</span></div>
      </div>`;
    const boSungReqHtml = res.noiDungYeuCauBoSung
      ? `<div style="margin-top: 8px; padding: 10px; background: #fef2f2; border-radius: 8px; border: 1px solid #fecaca; color: #991b1b;"><strong>⚠️ Nội dung yêu cầu đơn vị bổ sung (Nghiệp vụ Y):</strong><br>${esc(res.noiDungYeuCauBoSung)}</div>` : '';
    const boSungResHtml = res.ketQuaBoSung
      ? `<div style="margin-top: 8px; padding: 10px; background: #eff6ff; border-radius: 8px; border: 1px solid #bfdbfe; color: #1e40af;"><strong>📝 Kết quả bổ sung của đơn vị:</strong><br>${esc(res.ketQuaBoSung)}</div>` : '';
    detailInfo.innerHTML = `
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px 16px;">
        <div><strong>Tên đơn vị:</strong> <span style="color:#0369a1; font-weight:bold;">${esc(res.tenDonVi)}</span> (${esc(ma)})</div>
        <div><strong>Thời gian gửi phiên cuối:</strong> <span style="color:#059669; font-weight:bold;">${esc(formatDateTime(res.submittedAt))}</span></div>
        <div><strong>Người nộp/người đầu mối phụ trách:</strong> ${esc(res.hoTen || 'Chưa rõ')} (${esc(res.chucVu || '')} - ${esc(res.khoaPhong || '')})</div>
        <div><strong>Số điện thoại:</strong> ${esc(res.soDienThoai || 'Chưa cập nhật')}</div>
        <div><strong>Email liên hệ:</strong> ${esc(res.email || 'Chưa cập nhật')}</div>
        <div><strong>Trạng thái hồ sơ:</strong> ${statusBadge}</div>
      </div>
      ${boSungReqHtml}${boSungResHtml}${pl1Html}${countsSummaryHtml}`;

    let linksHtml = '';
    // BÁO CÁO CŨ (hệ thống Google Sheets/Drive trước đây)
    if (res.oldReportSheetUrl) {
      linksHtml += `<div style="margin-bottom:12px; padding:12px 14px; background:#eff6ff; border:1.5px solid #bfdbfe; border-radius:8px;">
        📊 <strong>BÁO CÁO GIÁ DVKT CŨ (GOOGLE SHEET):</strong><br>
        <a href="${esc(res.oldReportSheetUrl)}" target="_blank" rel="noopener" style="color:#0284c7; font-weight:700; text-decoration:underline; font-size:13.5px;">👉 Mở xem Bảng tính báo cáo giá DVKT của phiên cuối trên hệ thống cũ ↗</a></div>`;
    }
    if (res.oldFolderUrl) {
      linksHtml += `<div style="margin-bottom:12px; padding:12px 14px; background:#f8fafc; border:1.5px solid #e2e8f0; border-radius:8px;">
        📁 <strong>THƯ MỤC HỒ SƠ CŨ (GOOGLE DRIVE):</strong><br>
        <a href="${esc(res.oldFolderUrl)}" target="_blank" rel="noopener" style="color:#0284c7; font-weight:700; text-decoration:underline; font-size:13.5px;">👉 Mở thư mục hồ sơ phiên cuối trên hệ thống cũ ↗</a></div>`;
    }
    // BÁO CÁO MỚI (hệ thống mới)
    linksHtml += `<div style="margin-bottom:12px; padding:12px 14px; background:#f0fdf4; border:1.5px solid #86efac; border-radius:8px;">
      🆕 <strong>BÁO CÁO MỚI (HỆ THỐNG MỚI):</strong><br>
      ${res.newReportUrl ? `<a href="${esc(res.newReportUrl)}" target="_blank" rel="noopener" style="color:#15803d; font-weight:700; text-decoration:underline; font-size:13.5px;">👉 Mở báo cáo mới ↗</a><br>` : ''}
      <button type="button" class="btn btn-success" style="margin-top:6px; padding:6px 14px; font-size:13px;" onclick="exportLookupReport(this)">📥 Tải báo cáo mới (Excel)</button></div>`;
    if (res.cpqlUrl && String(res.cpqlUrl).startsWith('http')) {
      linksHtml += `<div style="margin-bottom:12px; padding:12px 14px; background:#fefce8; border:1.5px solid #fef08a; border-radius:8px;">
        📑 <strong>BÁO CÁO THUYẾT MINH CHI PHÍ QUẢN LÝ:</strong><br>
        <a href="${esc(res.cpqlUrl)}" target="_blank" rel="noopener" style="color:#b45309; font-weight:700; text-decoration:underline; font-size:13.5px;">👉 Mở xem Bảng tính Thuyết minh Chi phí quản lý của đơn vị ↗</a></div>`;
    } else {
      linksHtml += `<div style="margin-bottom:12px; padding:10px 14px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; font-size:13px; color:#64748b;">
        📑 <strong>Thuyết minh chi phí quản lý:</strong> Chưa có dữ liệu liên kết báo cáo của đơn vị.</div>`;
    }
    if (res.files && res.files.length) {
      linksHtml += `<div style="margin-top:14px;"><strong>📎 DANH SÁCH CÁC TỆP ĐÍNH KÈM ĐÃ NỘP:</strong><ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13.5px; line-height: 2;">`;
      res.files.forEach(f => {
        linksHtml += `<li>📄 <a href="#" onclick="openLookupFile('${esc(f.path)}'); return false;" style="color:#0284c7; font-weight:600; text-decoration:underline;">${esc(f.name)}</a> <span style="color:#64748b;">(Xem/Tải trực tiếp)</span></li>`;
      });
      linksHtml += `</ul></div>`;
    }
    linksArea.innerHTML = linksHtml;
    resultBox.style.display = 'block';
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    resultBox.style.display = 'none';
    showAppDialog('warning', e.kind === 'NO_SUBMISSION' ? 'Không Có Dữ Liệu' : 'Không Tra Cứu Được', esc(e.message));
  } finally { if (btn) { btn.innerHTML = oldText; btn.disabled = false; } }
}

// ===================================================================================
// 14. BẢNG TỔNG HỢP QUẢN TRỊ (Supabase Auth – vai trò admin)
// ===================================================================================
let summarySubmittedData = [];
async function unlockAndLoadSummary(forceRefresh) {
  const email = document.getElementById('txtAdminEmail').value.trim();
  const pass = document.getElementById('txtAdminSummaryPass').value;
  const container = document.getElementById('summaryTableContainer');
  const passBox = document.getElementById('adminPasswordBox');
  const contentArea = document.getElementById('summaryContentArea');
  const badge = document.getElementById('countSummarySubmitted');
  const { data: sess } = await adminSb.auth.getSession();
  if (!sess.session) {
    if (!email || !pass) { showAppDialog('warning', 'Yêu Cầu Đăng Nhập', 'Vui lòng nhập email và mật khẩu tài khoản quản trị để xem bảng tổng hợp!'); return; }
    const { error } = await adminSb.auth.signInWithPassword({ email, password: pass });
    if (error) { showAppDialog('error', 'Không Thể Mở', 'Sai email hoặc mật khẩu quản trị.'); return; }
  }
  container.innerHTML = `<div class="loading-spinner-box"><div class="spinner"></div><div style="font-weight: 600; font-size: 13.5px;">Đang đọc dữ liệu tổng hợp...</div></div>`;
  contentArea.style.display = 'block';
  try {
    const rows = await fetchAll('admin_submitted_summary', '*', { client: adminSb, order: 'name' });
    summarySubmittedData = rows.map(r => ({
      ma: r.code, ten: r.name, time: formatDateTime(r.submitted_at),
      pl1_kb: r.pl1_kham_benh, pl1_hc: r.pl1_hoi_chan, pl1_gd: r.pl1_giam_dinh, pl1_skld: r.pl1_ksk_lao_dong, pl1_xkd: r.pl1_ksk_xkld,
      c2: r.count_pl2, c3: r.count_pl3, c4: r.count_pl4, c5: r.count_pl5, totalKT: r.total_kt,
      folderUrl: r.old_folder_url, newReportUrl: r.new_report_url,
      noiDungYeuCauBoSung: r.supplement_request, ketQuaBoSung: r.supplement_result
    }));
    if (!summarySubmittedData.length) {
      const { data: s2 } = await adminSb.auth.getSession();
      if (s2.session) {
        const probe = await adminSb.from('units').select('id', { count: 'exact', head: true });
        if (probe.error || probe.count === 0) throw new Error('Tài khoản này không có quyền quản trị (thiếu app_metadata.role = admin).');
      }
    }
    passBox.style.display = 'none';
    badge.style.display = 'inline-block';
    badge.innerText = summarySubmittedData.length;
    renderSummaryTable(summarySubmittedData);
  } catch (e) {
    contentArea.style.display = 'none';
    await adminSb.auth.signOut();
    showAppDialog('error', 'Không Thể Mở', esc(e.message));
  }
}
async function adminUnlockUnit(code, name) {
  showAppDialog('confirm', 'Mở Khóa Đơn Vị', `Mở khóa <strong>${esc(name)}</strong> để đơn vị được chỉnh sửa và nộp lại báo cáo?`, null, async function () {
    const { error } = await adminSb.rpc('admin_unlock_unit', { p_code: code });
    if (error) { showAppDialog('error', 'Lỗi', esc(error.message)); return; }
    toast('Đã mở khóa ' + name);
    unlockAndLoadSummary(true);
  });
}
function renderSummaryTable(list) {
  const container = document.getElementById('summaryTableContainer');
  if (!container) return;
  if (!list || !list.length) {
    container.innerHTML = '<div style="text-align:center; padding: 22px; color:#64748b;">Chưa có đơn vị nào hoàn thành nộp báo cáo chính thức.</div>';
    return;
  }
  const th = (txt, extra) => `<th style="padding: 10px 6px; text-align: center; border-bottom: 2px solid #075985; ${extra || ''}">${txt}</th>`;
  let html = `
    <div style="max-height: 480px; overflow-y: auto; overflow-x: auto; border: 1px solid #cbd5e1; border-radius: 8px;">
      <table style="width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; text-align: left;">
        <thead><tr style="background: #0369a1; color: #ffffff; position: sticky; top: 0; z-index: 10;">
          ${th('STT', 'width:40px;')}${th('Tên đơn vị', 'min-width:200px; text-align:left;')}${th('Thời gian nộp', 'min-width:110px;')}
          ${th('PL1.1 Khám', 'background:#0284c7;')}${th('PL1.2 H.Chẩn', 'background:#0284c7;')}${th('PL1.3 G.Định', 'background:#0284c7;')}
          ${th('PL1.4 KSK.LĐ', 'background:#0284c7;')}${th('PL1.5 XK.LĐ', 'background:#0284c7;')}
          ${th('PL2', 'background:#0284c7;')}${th('PL3', 'background:#0284c7;')}${th('PL4', 'background:#0284c7;')}${th('PL5', 'background:#0284c7;')}
          ${th('Tổng KT (PL3+PL4+PL5)', 'background:#075985;')}${th('Báo cáo cũ', 'min-width:95px;')}
          ${th('Nội dung yêu cầu bổ sung', 'min-width:180px; text-align:left;')}${th('Kết quả bổ sung', 'min-width:160px; text-align:left;')}${th('Thao tác')}
        </tr></thead><tbody>`;
  const td = (v, s) => `<td style="padding: 8px 4px; text-align: center; border-bottom: 1px solid #e2e8f0; ${s || ''}">${v}</td>`;
  const num = v => `<span style="font-weight:700; color:#0369a1;">${(v || 0).toLocaleString('vi-VN')}</span>`;
  list.forEach((u, idx) => {
    const bg = (idx % 2 === 0) ? '#ffffff' : '#f8fafc';
    const link = u.folderUrl ? `<a href="${esc(u.folderUrl)}" target="_blank" rel="noopener" style="color:#0284c7; font-weight:700; text-decoration:underline;">Mở Drive ↗</a>` : '<span style="color:#94a3b8;">-</span>';
    html += `<tr style="background:${bg};">
      ${td(idx + 1, 'font-weight:600;')}${td(esc(u.ten), 'text-align:left; padding:8px 10px; font-weight:600; color:#0f172a;')}${td(esc(u.time), 'color:#64748b; font-size:11.5px;')}
      ${td(u.pl1_kb ? '<span class="badge-x">X</span>' : '-')}${td(u.pl1_hc ? '<span class="badge-x">X</span>' : '-')}${td(u.pl1_gd ? '<span class="badge-x">X</span>' : '-')}
      ${td(u.pl1_skld ? '<span class="badge-x">X</span>' : '-')}${td(u.pl1_xkd ? '<span class="badge-x">X</span>' : '-')}
      ${td(num(u.c2))}${td(num(u.c3))}${td(num(u.c4))}${td(num(u.c5))}
      ${td(`<span style="font-weight:800; color:#059669;">${(u.totalKT || 0).toLocaleString('vi-VN')}</span>`, 'background:#ecfdf5;')}
      ${td(link)}
      ${td(u.noiDungYeuCauBoSung ? `<span class="badge-bosung-req">${esc(u.noiDungYeuCauBoSung)}</span>` : '<span style="color:#94a3b8;">-</span>', 'text-align:left; padding:8px 10px;')}
      ${td(u.ketQuaBoSung ? `<span class="badge-bosung-res">${esc(u.ketQuaBoSung)}</span>` : '<span style="color:#94a3b8;">-</span>', 'text-align:left; padding:8px 10px;')}
      ${td(`<button type="button" class="btn btn-warning" style="padding:4px 10px; font-size:12px;" data-code="${esc(u.ma)}" data-name="${esc(u.ten)}" onclick="adminUnlockUnit(this.dataset.code, this.dataset.name)">🔓 Mở khóa</button>`)}
    </tr>`;
  });
  html += `</tbody></table></div>`;
  container.innerHTML = html;
}
function filterSummaryTable(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  renderSummaryTable(!kw ? summarySubmittedData
    : summarySubmittedData.filter(i => i.ten.toLowerCase().includes(kw) || i.ma.toLowerCase().includes(kw)));
}
