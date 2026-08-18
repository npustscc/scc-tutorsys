// 系辦助理（Phase 1：角色＋白名單＋唯讀自己系）的授權測試。
// 這一組是「導師資料填報平台」的安全邊界，所以測的重點全是 fail-closed：白名單那筆被停用/
// 軟刪除、掛的系所被停用/軟刪除、以及最重要的「前端送別系的 deptId 進來要被擋」。
//
// 命名提醒：deptAssistant（系辦助理）與學諮中心的 staffAssistant 是兩回事，不共用名單與權限。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'resolveRoles_', 'isClassTutor_',
    'normalizeDeptAssistantDeptIds_', 'resolveDeptRosterScope_', 'projectClassForDeptRoster_',
  ], { BOOTSTRAP_ADMINS: ['boot@heartnpust.tw'] });
}

const DEPTS = [
  { id: '農園系', name: '農園系', collegeId: '農學院', active: true },
  { id: '森林系', name: '森林系', collegeId: '農學院', active: true },
  { id: '停用系', name: '停用系', collegeId: '農學院', active: false },
  { id: '刪除系', name: '刪除系', collegeId: '農學院', active: true, deleted: true },
];

function cfg(deptAssistants) {
  return { users: {}, settings: {}, deptAssistants: deptAssistants };
}

// ── 角色解析 ───────────────────────────────────────────────────────────────────
test('白名單命中且系所啟用 → deptAssistantOf 含該系所（可掛多系）', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('a@x.com',
    cfg([{ email: 'a@x.com', name: '助理A', deptIds: ['農園系', '森林系'] }]), DEPTS, []);
  assert.deepEqual(roles.deptAssistantOf, ['農園系', '森林系']);
  // 系辦助理不該因此拿到任何其他角色
  assert.equal(roles.isAdmin, false);
  assert.equal(roles.isStaffAssistant, false);
  assert.equal(roles.isDirector, false);
});

test('沒命中白名單 → deptAssistantOf 為空陣列（預設拒絕）', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('nobody@x.com',
    cfg([{ email: 'a@x.com', deptIds: ['農園系'] }]), DEPTS, []);
  assert.deepEqual(roles.deptAssistantOf, []);
});

test('白名單那筆 disabled=true → 整個授權消失', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('a@x.com',
    cfg([{ email: 'a@x.com', deptIds: ['農園系'], disabled: true }]), DEPTS, []);
  assert.deepEqual(roles.deptAssistantOf, []);
});

test('白名單那筆 deleted=true → 整個授權消失（軟刪除視同不存在）', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('a@x.com',
    cfg([{ email: 'a@x.com', deptIds: ['農園系'], deleted: true }]), DEPTS, []);
  assert.deepEqual(roles.deptAssistantOf, []);
});

test('掛的系所被停用或軟刪除 → 該系所就地從授權集合消失，其餘保留', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('a@x.com',
    cfg([{ email: 'a@x.com', deptIds: ['農園系', '停用系', '刪除系', '不存在系'] }]), DEPTS, []);
  assert.deepEqual(roles.deptAssistantOf, ['農園系']);
});

test('deptIds 非陣列或缺漏 → 空集合，不拋例外', () => {
  const S = makeSandbox();
  assert.deepEqual(S.resolveRoles_('a@x.com', cfg([{ email: 'a@x.com' }]), DEPTS, []).deptAssistantOf, []);
  assert.deepEqual(S.resolveRoles_('a@x.com', cfg([{ email: 'a@x.com', deptIds: '農園系' }]), DEPTS, []).deptAssistantOf, []);
});

test('config 完全沒有 deptAssistants 欄位 → 不炸、空集合', () => {
  const S = makeSandbox();
  assert.deepEqual(S.resolveRoles_('a@x.com', { users: {}, settings: {} }, DEPTS, []).deptAssistantOf, []);
});

// ── 白名單寫入時的 deptIds 驗證 ────────────────────────────────────────────────
test('deptIds 全部存在且啟用 → 通過並去重', () => {
  const S = makeSandbox();
  const r = S.normalizeDeptAssistantDeptIds_(['農園系', '森林系', '農園系'], DEPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deptIds, ['農園系', '森林系']);
});

test('deptIds 含不存在/停用/軟刪除的系所 → 拒絕整筆（不靜默丟掉）', () => {
  const S = makeSandbox();
  ['不存在系', '停用系', '刪除系'].forEach(function (bad) {
    const r = S.normalizeDeptAssistantDeptIds_(['農園系', bad], DEPTS);
    assert.equal(r.ok, false, bad + ' 應被拒絕');
    assert.match(r.error, /department not found/);
  });
});

test('deptIds 非陣列、含空字串、或筆數過多 → 拒絕', () => {
  const S = makeSandbox();
  assert.equal(S.normalizeDeptAssistantDeptIds_('農園系', DEPTS).ok, false);
  assert.equal(S.normalizeDeptAssistantDeptIds_(undefined, DEPTS).ok, false);
  assert.equal(S.normalizeDeptAssistantDeptIds_(['農園系', '  '], DEPTS).ok, false);
  assert.equal(S.normalizeDeptAssistantDeptIds_(new Array(81).fill('農園系'), DEPTS).ok, false);
});

// ── deptRosterGet 的授權範圍（最關鍵的一段）────────────────────────────────────
function rolesOf(deptAssistantOf, isAdmin) {
  return { isAdmin: !!isAdmin, deptAssistantOf: deptAssistantOf };
}

test('系辦助理不帶 deptId → 拿到自己白名單解出來的全部系所', () => {
  const S = makeSandbox();
  const r = S.resolveDeptRosterScope_(rolesOf(['農園系', '森林系']), undefined, DEPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deptIds, ['農園系', '森林系']);
});

test('系辦助理帶自己系的 deptId → 只回那一系', () => {
  const S = makeSandbox();
  const r = S.resolveDeptRosterScope_(rolesOf(['農園系', '森林系']), '森林系', DEPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deptIds, ['森林系']);
});

test('🔒 系辦助理帶「別系」的 deptId → 拒絕（不是靜默改成自己系，是 forbidden）', () => {
  const S = makeSandbox();
  const r = S.resolveDeptRosterScope_(rolesOf(['農園系']), '森林系', DEPTS);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'forbidden');
});

test('🔒 沒有任何角色的登入者（一般學生）→ 一律 forbidden', () => {
  const S = makeSandbox();
  assert.equal(S.resolveDeptRosterScope_(rolesOf([]), undefined, DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterScope_(rolesOf([]), '農園系', DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterScope_(null, '農園系', DEPTS).ok, false);
});

test('admin 不帶 deptId → 拿到全部啟用系所（停用/軟刪除的排除）', () => {
  const S = makeSandbox();
  const r = S.resolveDeptRosterScope_(rolesOf([], true), undefined, DEPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deptIds, ['農園系', '森林系']);
});

test('admin 帶已停用系所的 deptId → 仍拒絕（停用系所不在可存取集合內）', () => {
  const S = makeSandbox();
  assert.equal(S.resolveDeptRosterScope_(rolesOf([], true), '停用系', DEPTS).ok, false);
});

test('空字串 deptId 視同不帶（不會被當成「某個叫空字串的系」而漏放行）', () => {
  const S = makeSandbox();
  const r = S.resolveDeptRosterScope_(rolesOf(['農園系']), '', DEPTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.deptIds, ['農園系']);
});

// ── 回傳投影：不該外洩的欄位不准出現 ──────────────────────────────────────────
test('🔒 班級投影只給名冊欄位：uploadWhitelist / suggestedTutors 一律不出現', () => {
  const S = makeSandbox();
  const out = S.projectClassForDeptRoster_({
    id: '農園系_四技一A', name: '四技一A', displayName: '四農園一A', deptId: '農園系',
    systemId: 'day_college', requiredMeetingOverride: 4, active: true,
    tutors: [{ name: '李鎮宇', email: 'lee@x.com' }],
    uploadWhitelist: ['student@gmail.com'],
    suggestedTutors: [{ name: '某某', by: 'student@gmail.com', email: 's@x.com' }],
    dualApprovalMode: 'any',
  });
  assert.equal('uploadWhitelist' in out, false);
  assert.equal('suggestedTutors' in out, false);
  assert.deepEqual(out.tutors, [{ name: '李鎮宇', email: 'lee@x.com', ext: '', mobile: '', advisees: '' }]);
  assert.equal(out.displayName, '四農園一A');
  assert.equal(out.active, true);
});

test('班級投影：缺欄位時給明確預設值（displayName 退回 name、覆寫份數 null）', () => {
  const S = makeSandbox();
  const out = S.projectClassForDeptRoster_({ id: 'x', name: '四技一A', deptId: '農園系' });
  assert.equal(out.displayName, '四技一A');
  assert.equal(out.requiredMeetingOverride, null);
  assert.equal(out.systemId, null);
  assert.deepEqual(out.tutors, []);
  assert.equal(out.active, true);
});

test('班級投影：active=false 照實回報（助理要知道班被停用了）', () => {
  const S = makeSandbox();
  assert.equal(S.projectClassForDeptRoster_({ id: 'x', name: 'n', deptId: 'd', active: false }).active, false);
});

// ── Phase 2：導師聯絡方式與編輯權限 ───────────────────────────────────────────
function makeSandbox2() {
  return load([
    'normalizeDeptRosterTutors_', 'sanitizeClassesForViewer_', 'projectClassForDeptRoster_',
    'carryOverTutorEmails_', 'normalizeDeptHead_', 'projectDeptHeadForRoster_',
    'sanitizeDepartmentsForViewer_',
  ], {});
}

// ── 主任導師（＝系主任）─────────────────────────────────────────────────────
test('主任導師投影：head 缺欄位時退回 headName/headEmail，舊 phone 當手機', () => {
  const S = makeSandbox2();
  const full = S.projectDeptHeadForRoster_({
    id: 'd', headName: '舊的', headEmail: 'old@x.com',
    head: { name: '吳羽婷', email: 'wu@x.com', ext: '7149', mobile: '0911' },
  });
  assert.deepEqual(full, { name: '吳羽婷', email: 'wu@x.com', ext: '7149', mobile: '0911' });
  // 還沒有 head 的系所：拿既有的 headName/headEmail 當預設，聯絡方式空白
  assert.deepEqual(S.projectDeptHeadForRoster_({ id: 'd', headName: '林盈宏', headEmail: 'lin@x.com' }),
    { name: '林盈宏', email: 'lin@x.com', ext: '', mobile: '' });
  assert.equal(S.projectDeptHeadForRoster_({ id: 'd', head: { phone: '0922' } }).mobile, '0922');
  assert.deepEqual(S.projectDeptHeadForRoster_(null), { name: '', email: '', ext: '', mobile: '' });
});

test('🔒 bootstrap 的 departments 不含主任導師的分機/手機，但保留 headName/headEmail（核章身分）', () => {
  const S = makeSandbox2();
  const depts = [{
    id: '森林系', name: '森林系', headName: '吳羽婷', headEmail: 'wu@x.com',
    head: { name: '吳羽婷', email: 'wu@x.com', ext: '7149', mobile: '0912345678' },
  }, { id: '無主任系', name: '無主任系' }];
  const out = S.sanitizeDepartmentsForViewer_(depts);
  assert.deepEqual(out[0].head, { name: '吳羽婷', email: 'wu@x.com' });
  assert.equal(out[0].headEmail, 'wu@x.com', 'headEmail 要留著，deptHeadOf 靠它解析');
  assert.equal(JSON.stringify(out).indexOf('0912345678'), -1, '手機號碼不得出現');
  assert.equal(out[1].head, undefined, '沒有 head 的系所原樣通過');
  // 原始物件不可被就地修改
  assert.equal(depts[0].head.mobile, '0912345678');
});

test('主任導師欄位驗證：姓名字元、email 格式、分機/手機字元', () => {
  const S = makeSandbox2();
  assert.equal(S.normalizeDeptHead_({ name: '吳羽婷', email: 'WU@X.COM', ext: '7149', mobile: '0912-345-678' }).ok, true);
  assert.equal(S.normalizeDeptHead_({ name: '吳羽婷', email: 'WU@X.COM' }).head.email, 'wu@x.com');
  assert.equal(S.normalizeDeptHead_({ name: 'A<script>' }).ok, false);
  assert.equal(S.normalizeDeptHead_({ name: 'A', email: 'not-an-email' }).ok, false);
  assert.equal(S.normalizeDeptHead_({ name: 'A', ext: '71<49' }).ok, false);
  assert.equal(S.normalizeDeptHead_({ name: 'A', mobile: '09一二' }).ok, false);
  // 舊鍵 phone 一樣折進 mobile
  assert.equal(S.normalizeDeptHead_({ name: 'A', phone: '0911' }).head.mobile, '0911');
  // 全空也合法（等於清掉聯絡方式）
  assert.deepEqual(S.normalizeDeptHead_({}).head, { name: '', email: '', ext: '', mobile: '' });
});

test('導師名單：姓名必填，其餘選填，回傳五個欄位都在（含輔導人數）', () => {
  const S = makeSandbox2();
  const r = S.normalizeDeptRosterTutors_([
    { name: '陳美惠', email: 'A@X.COM', ext: '7140', mobile: '0912-345-678' },
    { name: '王小明' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tutors[0], { name: '陳美惠', email: 'a@x.com', ext: '7140', mobile: '0912-345-678', advisees: '' });
  assert.deepEqual(r.tutors[1], { name: '王小明', email: '', ext: '', mobile: '', advisees: '' });
});

test('導師名單：舊鍵 phone 仍收下並折進 mobile（換版時兩軌資料不會同時換）', () => {
  const S = makeSandbox2();
  const r = S.normalizeDeptRosterTutors_([{ name: '陳美惠', phone: '0912345678' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tutors[0], { name: '陳美惠', email: '', ext: '', mobile: '0912345678', advisees: '' });
  assert.equal('phone' in r.tutors[0], false, '寫回去的物件不該再有 phone 鍵');
  // 明確給了 mobile 就以 mobile 為準，不被舊鍵蓋掉
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', phone: '0911', mobile: '0922' }]).tutors[0].mobile, '0922');
});

test('導師名單：沒姓名、email 格式錯、分機或手機含不允許字元、人數超過 10 → 拒絕', () => {
  const S = makeSandbox2();
  assert.equal(S.normalizeDeptRosterTutors_([{ name: '  ' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', email: 'not-an-email' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', mobile: '0912<script>' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', ext: '7140<script>' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', phone: '0912<script>' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_(new Array(11).fill({ name: 'A' })).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_('nope').ok, false);
});

test('🔒 bootstrap 的 classes 一律不含 ext/mobile/phone——連 admin 也一樣（無例外的不變量）', () => {
  const S = makeSandbox2();
  const classes = [{
    id: 'c1', deptId: 'd', name: 'n',
    tutors: [{ name: '陳美惠', email: 'a@x.com', ext: '7140', mobile: '0912345678', phone: '0987654321' }],
  }];
  [{ isAdmin: true, tutorOf: [] }, { isAdmin: false, tutorOf: ['c1'] }, { isAdmin: false, tutorOf: [] }].forEach(function (roles) {
    const out = S.sanitizeClassesForViewer_(classes, roles);
    ['phone', 'ext', 'mobile'].forEach(function (f) {
      assert.equal(f in out[0].tutors[0], false, '角色 ' + JSON.stringify(roles) + ' 拿到了 ' + f);
    });
    assert.equal(out[0].tutors[0].name, '陳美惠');
    assert.equal(out[0].tutors[0].email, 'a@x.com', 'email 要留著（上傳表單與核章顯示需要）');
  });
  // 原始物件不可被就地修改（深拷貝）
  assert.equal(classes[0].tutors[0].mobile, '0912345678');
});

test('deptRosterGet 的投影**要**帶 ext/mobile（那是唯一看得到聯絡方式的通道），舊 phone 當手機', () => {
  const S = makeSandbox2();
  const out = S.projectClassForDeptRoster_({
    id: 'c1', name: 'n', deptId: 'd',
    tutors: [{ name: '陳美惠', ext: '7140', mobile: '0912345678' }, { name: '舊資料', phone: '0987654321' }],
  });
  assert.equal(out.tutors[0].ext, '7140');
  assert.equal(out.tutors[0].mobile, '0912345678');
  assert.equal(out.tutors[1].mobile, '0987654321', '2026-08-11 前的單一電話欄要當成私人手機顯示');
  assert.equal(out.tutors[1].ext, '');
});

test('🔒 表單不再送 email，存檔時依姓名把既有 email 補回來（否則導師會失去核章權）', () => {
  const S = makeSandbox2();
  const existing = [{ name: '陳美惠', email: 'chen@x.com' }, { name: '王小明', email: 'wang@x.com' }];
  const incoming = [
    { name: '陳美惠', email: '', ext: '7140', mobile: '' },        // 表單送上來的形狀
    { name: '新來的', email: '', ext: '', mobile: '0911' },        // 沒有舊值可補
    { name: '王小明', email: 'typed@x.com', ext: '', mobile: '' }, // 明確給了就以送來的為準
  ];
  const out = S.carryOverTutorEmails_(incoming, existing);
  assert.equal(out[0].email, 'chen@x.com');
  assert.equal(out[0].ext, '7140', '補 email 不可動到其他欄位');
  assert.equal(out[1].email, '');
  assert.equal(out[2].email, 'typed@x.com');
  // 新增班級（沒有既有名單）時不炸
  assert.deepEqual(S.carryOverTutorEmails_(incoming, undefined)[0].email, '');
});

// ── GAS 軌的本機帳密（系辦助理校內信箱不是 Google 帳號，只能走帳密）───────────
// 純函式部分：密碼政策、分機取第一段、local-part 解析、常數時間比較。
// 雜湊本身依賴 GAS 的 Utilities，改由 e2e/實機驗證。
function makeSandbox3() {
  return load([
    'validateNewPasswordGas_', 'initialPasswordFromExtGas_',
    'resolveLocalLoginEmail_', 'constantTimeEqual_', 'bytesToHex_',
  ], {});
}

test('GAS 密碼政策與自架版一致：至少 8 字、不得全數字', () => {
  const S = makeSandbox3();
  assert.match(S.validateNewPasswordGas_('1234'), /至少 8/);
  assert.match(S.validateNewPasswordGas_('12345678'), /只有數字/);
  assert.equal(S.validateNewPasswordGas_('abcd1234'), null);
  assert.match(S.validateNewPasswordGas_('a'.repeat(201)), /過長/);
});

test('初始密碼取分機第一段（與 server/index.js 同規則）', () => {
  const S = makeSandbox3();
  assert.equal(S.initialPasswordFromExtGas_('7829/7803'), '7829');
  assert.equal(S.initialPasswordFromExtGas_('7759或7752'), '7759');
  assert.equal(S.initialPasswordFromExtGas_('6325'), '6325');
  assert.equal(S.initialPasswordFromExtGas_(''), '');
});

test('帳號可只打 local-part；剛好一個才算數，多個或查無一律原樣回傳', () => {
  const S = makeSandbox3();
  const accounts = { 'plant@mail.npust.edu.tw': {}, 'mis@mail.npust.edu.tw': {}, 'a@x.tw': {}, 'a@y.tw': {} };
  assert.equal(S.resolveLocalLoginEmail_(accounts, 'plant'), 'plant@mail.npust.edu.tw');
  assert.equal(S.resolveLocalLoginEmail_(accounts, 'PLANT'), 'plant@mail.npust.edu.tw');
  assert.equal(S.resolveLocalLoginEmail_(accounts, 'a'), 'a');           // 兩筆撞名 → 不猜
  assert.equal(S.resolveLocalLoginEmail_(accounts, 'nobody'), 'nobody'); // 查無 → 原樣（走假雜湊）
  assert.equal(S.resolveLocalLoginEmail_(accounts, 'plant@mail.npust.edu.tw'), 'plant@mail.npust.edu.tw');
});

test('constantTimeEqual_：相同為真、長度不同或內容不同為偽', () => {
  const S = makeSandbox3();
  assert.equal(S.constantTimeEqual_('abc', 'abc'), true);
  assert.equal(S.constantTimeEqual_('abc', 'abd'), false);
  assert.equal(S.constantTimeEqual_('abc', 'abcd'), false);
  assert.equal(S.constantTimeEqual_('', ''), true);
});

test('bytesToHex_：處理 GAS byte array 的負數（signed byte）', () => {
  const S = makeSandbox3();
  assert.equal(S.bytesToHex_([0, 15, 16, 127]), '000f107f');
  assert.equal(S.bytesToHex_([-1, -128]), 'ff80');   // -1 → 255、-128 → 128
});

// ── 迴歸：密碼雜湊必須真的能在 GAS 上跑 ───────────────────────────────────────
// 2026-08-09 的事故：derivePasswordKey_ 的迴圈傳 (Byte[], String) 給
// Utilities.computeHmacSha256Signature，本機模擬器兩種都收所以全綠，推上 GAS 才炸。
// 模擬器已改成照抄 GAS 的型別限制，這個測試就會在同樣的錯誤重現時紅燈。
test('derivePasswordKey_ 全程走 (Byte[],Byte[]) overload，且輸出穩定可重現', () => {
  const crypto = require('node:crypto');
  const toSignedBytes = function (buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) out.push(buf[i] > 127 ? buf[i] - 256 : buf[i]);
    return out;
  };
  const toBuffer = function (v) { return Array.isArray(v) ? Buffer.from(v.map(function (b) { return b < 0 ? b + 256 : b; })) : Buffer.from(String(v), 'utf8'); };
  const Utilities = {
    // 與 server/gas-host.js 同一份守門邏輯：型別不一致就丟例外（GAS 的真實行為）
    computeHmacSha256Signature: function (value, key) {
      const kindOf = function (v) { return Array.isArray(v) ? 'number[]' : typeof v === 'string' ? 'String' : typeof v; };
      const kv = kindOf(value), kk = kindOf(key);
      if (kv !== kk || (kv !== 'String' && kv !== 'number[]')) {
        throw new Error('The parameters (' + kv + ',' + kk + ") don't match the method signature for Utilities.computeHmacSha256Signature.");
      }
      return toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest());
    },
    newBlob: function (s) { return { getBytes: function () { return toSignedBytes(Buffer.from(String(s), 'utf8')); } }; },
  };
  const S = load(['derivePasswordKey_', 'bytesToHex_'], { Utilities: Utilities });
  const a = S.derivePasswordKey_('9999', 'aabb', 50, 'pepper-value');
  const b = S.derivePasswordKey_('9999', 'aabb', 50, 'pepper-value');
  assert.equal(a, b, '同輸入必須同輸出');
  assert.match(a, /^[0-9a-f]{64}$/, '應為 64 字元 hex：' + a);
  assert.notEqual(a, S.derivePasswordKey_('9998', 'aabb', 50, 'pepper-value'), '不同密碼要不同雜湊');
  assert.notEqual(a, S.derivePasswordKey_('9999', 'aabb', 50, 'other-pepper'), 'pepper 不同要不同雜湊');
  assert.notEqual(a, S.derivePasswordKey_('9999', 'ccdd', 50, 'pepper-value'), 'salt 不同要不同雜湊');
});

// ── 名冊 → Google Sheet 同步、以及主責通知的合併規則 ────────────────────────
// harness 的沙箱是另一個 realm，陣列比較前先 JSON 往返（同 test/export-rows.test.js）
function plain(x) { return JSON.parse(JSON.stringify(x)); }

function makeSandbox4() {
  return load(['buildRosterSheetTabs_', 'selectNotifyBatches_'], {});
}

test('Sheet 版面：一個學院一個分頁、獸醫/國際/達人併成一頁、順序照既有統計表', () => {
  const S = makeSandbox4();
  const tabs = S.buildRosterSheetTabs_(
    [{ id: 'd1', name: '農園系', collegeId: 'agri' }, { id: 'd2', name: '獸醫系', collegeId: 'vet' },
     { id: 'd3', name: '熱農系', collegeId: 'intl' }, { id: 'd4', name: '怪系', collegeId: '沒對到的學院' }],
    [{ id: 'c1', name: '四技一A', deptId: 'd1', tutors: [{ name: '甲' }] },
     { id: 'c2', name: '四技一A', deptId: 'd2', tutors: [{ name: '乙' }] },
     { id: 'c3', name: '四技一A', deptId: 'd3', tutors: [{ name: '丙' }] },
     { id: 'c4', name: '四技一A', deptId: 'd4', tutors: [{ name: '丁' }] }],
    [{ id: 'agri', name: '農學院' }, { id: 'vet', name: '獸醫學院' }, { id: 'intl', name: '國際學院' }],
    '2026-08-11 12:00');
  assert.deepEqual(plain(tabs.map((t) => t.tab)), ['農學院', '獸醫國際達人', '沒對到的學院']);
  const vet = tabs.find((t) => t.tab === '獸醫國際達人');
  assert.equal(vet.rows, 2, '獸醫系與熱農系要併在同一頁');
});

test('Sheet 版面：前五列是學院名／說明／三列表頭，資料從第 6 列開始', () => {
  const S = makeSandbox4();
  const t = S.buildRosterSheetTabs_(
    [{ id: 'd1', name: '農園系', collegeId: 'agri', head: { name: '梁佑慎', ext: '6247', mobile: '0955' } }],
    [{ id: 'c1', name: '四技一A', displayName: '四農園一A', deptId: 'd1',
       tutors: [{ name: '甲', ext: '1', mobile: '0911', email: 'a@x.com' }, { name: '乙' }] }],
    [{ id: 'agri', name: '農學院' }], '2026-08-11 12:00')[0];
  assert.equal(t.values[0][0], '農學院');
  assert.match(t.values[1][0], /最後同步：2026-08-11 12:00/);
  assert.match(t.values[1][0], /不含導師私人手機/);
  assert.deepEqual(plain(t.values[2]), ['系別', '主任導師(系主任)', '', '班級', '班級名稱(原始)', '導師姓名', '校內分機', '狀態']);
  assert.deepEqual(plain(t.values[3]), ['', '姓名', '校內分機', '', '', '', '', '']);
  // 第 6 列（index 5）起是資料：系別／主任導師／班級都只寫在區塊第一列，其餘留白給合併用
  assert.deepEqual(plain(t.values[5]), ['農園系', '梁佑慎', '6247', '四農園一A', '四技一A', '甲', '1', '啟用']);
  assert.deepEqual(plain(t.values[6]), ['', '', '', '', '', '乙', '', '啟用']);
  assert.equal(JSON.stringify(t.values).indexOf('a@x.com'), -1, 'Sheet 不放 email（2026-08-11 決策）');
  // 合併座標：系別/主任導師兩欄跨該系 2 列（從第 6 列起）、班級兩欄跨同班的 2 位導師
  const m = plain(t.merges);
  assert.ok(m.some((x) => x.row === 6 && x.col === 1 && x.numRows === 2), '系別欄沒合併：' + JSON.stringify(m));
  assert.ok(m.some((x) => x.row === 6 && x.col === 4 && x.numRows === 2), '班級欄沒合併：' + JSON.stringify(m));
  assert.ok(m.some((x) => x.row === 3 && x.col === 2 && x.numCols === 2), '主任導師表頭沒跨欄：' + JSON.stringify(m));
  assert.ok(m.some((x) => x.row === 1 && x.numCols === 8), '學院名沒跨滿整列');
  const flat = JSON.stringify(t.values);
  assert.equal(flat.indexOf('0955'), -1, '主任導師手機不得進 Sheet');
  assert.equal(flat.indexOf('0911'), -1, '導師手機不得進 Sheet');
});

test('Sheet 版面：軟刪除/停用的系所不出頁；沒有班級的系所列一行說明', () => {
  const S = makeSandbox4();
  const tabs = S.buildRosterSheetTabs_(
    [{ id: 'd1', name: '有班系', collegeId: 'agri' }, { id: 'd2', name: '空系', collegeId: 'agri' },
     { id: 'd3', name: '停用系', collegeId: 'agri', active: false },
     { id: 'd4', name: '刪除系', collegeId: 'agri', deleted: true }],
    [{ id: 'c1', name: '一', deptId: 'd1', tutors: [{ name: '甲' }] },
     { id: 'c9', name: '九', deptId: 'd3', tutors: [{ name: '不該出現' }] }],
    [{ id: 'agri', name: '農學院' }], '');
  const flat = JSON.stringify(tabs[0].values);
  assert.equal(flat.indexOf('停用系'), -1);
  assert.equal(flat.indexOf('刪除系'), -1);
  assert.ok(flat.indexOf('（此系目前沒有班級）') !== -1, '空系要留一行，才看得出「這系還沒填」');
});

test('通知合併：停手 10 分鐘就寄；一直在改滿 30 分鐘也要寄；其餘繼續等', () => {
  const S = makeSandbox4();
  const now = Date.parse('2026-08-11T10:00:00Z');
  const at = function (minAgo) { return new Date(now - minAgo * 60000).toISOString(); };
  const res = S.selectNotifyBatches_([
    { deptId: '停手系', at: at(12) }, { deptId: '停手系', at: at(11) },      // 最後一筆 11 分鐘前 → 寄
    { deptId: '狂改系', at: at(40) }, { deptId: '狂改系', at: at(1) },        // 最早 40 分鐘前 → 也要寄
    { deptId: '剛改系', at: at(2) },                                          // 才剛改 → 繼續等
  ], now, 10 * 60000, 30 * 60000);
  assert.deepEqual(res.ready.map((b) => b.deptId), ['停手系', '狂改系']);
  assert.equal(res.ready[0].events.length, 2);
  assert.deepEqual(res.keep.map((e) => e.deptId), ['剛改系']);
});

test('通知合併：同一系的事件依時間排序；沒有 deptId 的髒資料直接丟掉', () => {
  const S = makeSandbox4();
  const now = Date.parse('2026-08-11T10:00:00Z');
  const res = S.selectNotifyBatches_([
    { deptId: 'A', at: '2026-08-11T09:30:00Z', summary: '後' },
    { deptId: 'A', at: '2026-08-11T09:20:00Z', summary: '先' },
    { at: '2026-08-11T09:20:00Z' }, null,
  ], now, 10 * 60000, 30 * 60000);
  assert.equal(res.ready.length, 1);
  assert.deepEqual(res.ready[0].events.map((e) => e.summary), ['先', '後']);
  assert.equal(res.keep.length, 0);
});

test('通知合併：空佇列不炸、也不會產生空批次', () => {
  const S = makeSandbox4();
  const res = S.selectNotifyBatches_([], Date.now(), 1000, 2000);
  assert.equal(res.ready.length, 0);
  assert.equal(res.keep.length, 0);
  assert.equal(S.selectNotifyBatches_(null, Date.now(), 1000, 2000).ready.length, 0);
});

// ── 換 email（系辦助理換人／換信箱）───────────────────────────────────────────
// 這一步等於把一個系的名冊權限從甲交給乙，所以測的重點是：舊 email 立刻沒有權限、
// 撞名不合併、服務帳號動不了。
function makeRenameSandbox() {
  return load(['planDeptAssistantRename_', 'resolveRoles_', 'isClassTutor_'], {
    BOOTSTRAP_ADMINS: ['boot@heartnpust.tw'],
    IMPORTER_ACCOUNT_EMAIL_: 'importer@heartnpust.tw',
  });
}
const NOW = '2026-08-17T12:00:00.000Z';
const ACTOR = 'admin@x.com';
function baseList() {
  return [{ email: 'old@x.com', name: '甲助理', ext: '1234', deptIds: ['農園系', '森林系'] }];
}

test('換 email：新那筆帶著系所/姓名/分機搬過去，舊那筆變成帶 renamedTo 的墓碑', () => {
  const S = makeRenameSandbox();
  const r = S.planDeptAssistantRename_(baseList(), 'old@x.com', 'New@X.com', ACTOR, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.to, 'new@x.com');                       // 一律小寫，與登入時的比對一致
  const tomb = r.deptAssistants.find((e) => e.email === 'old@x.com');
  const moved = r.deptAssistants.find((e) => e.email === 'new@x.com');
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.renamedTo, 'new@x.com');
  assert.equal(tomb.deletedBy, ACTOR);
  assert.equal(moved.deleted, false);
  assert.equal(moved.renamedFrom, 'old@x.com');
  assert.deepEqual(moved.deptIds, ['農園系', '森林系']);
  assert.equal(moved.name, '甲助理');
  assert.equal(moved.ext, '1234');
  assert.equal(moved.deletedAt, undefined);              // 墓碑的欄位不能跟著搬過去
  assert.equal(moved.renamedTo, undefined);
});

test('🔒 換完 email：舊 email 立刻沒有任何系所，新 email 接手', () => {
  const S = makeRenameSandbox();
  const r = S.planDeptAssistantRename_(baseList(), 'old@x.com', 'new@x.com', ACTOR, NOW);
  const config = cfg(r.deptAssistants);
  assert.deepEqual(S.resolveRoles_('old@x.com', config, DEPTS, []).deptAssistantOf, []);
  assert.deepEqual(S.resolveRoles_('new@x.com', config, DEPTS, []).deptAssistantOf, ['農園系', '森林系']);
});

test('🔒 新 email 已經在名單上（含只是停用的）→ 拒絕，不合併兩個人的系所', () => {
  const S = makeRenameSandbox();
  [{}, { disabled: true }].forEach(function (extra) {
    const list = baseList().concat([Object.assign({ email: 'new@x.com', deptIds: ['植醫系'] }, extra)]);
    const r = S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
    assert.equal(r.ok, false);
    assert.match(r.error, /已經有/);
  });
});

test('新 email 只剩軟刪除的墓碑 → 允許，並整筆覆蓋掉那個墓碑（同一信箱先刪後回來）', () => {
  const S = makeRenameSandbox();
  const list = baseList().concat([{ email: 'new@x.com', deptIds: ['植醫系'], deleted: true }]);
  const r = S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(r.ok, true);
  const alive = r.deptAssistants.filter((e) => e.email === 'new@x.com' && e.deleted !== true);
  assert.equal(alive.length, 1);
  assert.deepEqual(alive[0].deptIds, ['農園系', '森林系']);   // 不是墓碑的植醫系
});

test('找不到舊 email、或舊那筆已軟刪除 → 拒絕', () => {
  const S = makeRenameSandbox();
  assert.equal(S.planDeptAssistantRename_(baseList(), 'nobody@x.com', 'new@x.com', ACTOR, NOW).ok, false);
  const deleted = [{ email: 'old@x.com', deptIds: ['農園系'], deleted: true }];
  assert.equal(S.planDeptAssistantRename_(deleted, 'old@x.com', 'new@x.com', ACTOR, NOW).ok, false);
});

test('新舊相同（含大小寫與前後空白差異）、空值、格式錯、過長 → 拒絕', () => {
  const S = makeRenameSandbox();
  const bad = ['old@x.com', ' OLD@x.com ', '', '   ', 'not-an-email', 'a@b', 'x'.repeat(95) + '@y.com'];
  bad.forEach(function (to) {
    assert.equal(S.planDeptAssistantRename_(baseList(), 'old@x.com', to, ACTOR, NOW).ok, false, to + ' 應被拒絕');
  });
  assert.equal(S.planDeptAssistantRename_(baseList(), '', 'new@x.com', ACTOR, NOW).ok, false);
});

test('🔒 校內同步服務帳號（importer）不能被改名，也不能被改成它', () => {
  const S = makeRenameSandbox();
  const list = baseList().concat([{ email: 'importer@heartnpust.tw', deptIds: ['農園系'] }]);
  assert.equal(S.planDeptAssistantRename_(list, 'importer@heartnpust.tw', 'new@x.com', ACTOR, NOW).ok, false);
  assert.equal(S.planDeptAssistantRename_(list, 'old@x.com', 'importer@heartnpust.tw', ACTOR, NOW).ok, false);
});

test('planner 不就地改動傳進來的陣列（呼叫端失敗時 config 不能已經被動過）', () => {
  const S = makeRenameSandbox();
  const list = baseList();
  const snapshot = JSON.stringify(list);
  S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(JSON.stringify(list), snapshot);
});

test('🔒 舊 email 有大小寫不同的重複列 → 每一列都變墓碑（漏一列＝舊帳號還有權限）', () => {
  const S = makeRenameSandbox();
  const list = [
    { email: 'Old@x.com', name: '甲', deptIds: ['農園系'] },
    { email: 'old@x.com', name: '甲', deptIds: ['森林系'] },
  ];
  const r = S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(r.ok, true);
  const stillAlive = r.deptAssistants.filter((e) => e.email.toLowerCase() === 'old@x.com' && e.deleted !== true);
  assert.deepEqual(stillAlive, []);
  assert.deepEqual(S.resolveRoles_('old@x.com', cfg(r.deptAssistants), DEPTS, []).deptAssistantOf, []);
  assert.deepEqual(S.resolveRoles_('Old@x.com', cfg(r.deptAssistants), DEPTS, []).deptAssistantOf, []);
});

test('新 email 的墓碑整列丟掉，不留在搬過來那筆的前面（後續 upsert 會改到墓碑）', () => {
  const S = makeRenameSandbox();
  const list = [
    { email: 'new@x.com', deptIds: ['植醫系'], deleted: true },
    { email: 'old@x.com', name: '甲', ext: '1234', deptIds: ['農園系'] },
  ];
  const r = S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(r.ok, true);
  const hits = r.deptAssistants.filter((e) => e.email === 'new@x.com');
  assert.equal(hits.length, 1, '同一個 email 不該同時存在墓碑與新列');
  assert.equal(hits[0].deleted, false);
  // adminUpsertDeptAssistant 是 findIndex(email 相等) 且不看 deleted，所以「第一個命中的」必須是活的那筆
  assert.equal(r.deptAssistants.findIndex((e) => e.email === 'new@x.com'),
    r.deptAssistants.findIndex((e) => e.email === 'new@x.com' && e.deleted !== true));
});

test('🔒 新 email 同時有墓碑與一筆活的 → 仍然拒絕（不能只看第一個命中的）', () => {
  const S = makeRenameSandbox();
  const list = [
    { email: 'new@x.com', deptIds: ['植醫系'], deleted: true },
    { email: 'New@x.com', deptIds: ['植醫系'] },
    { email: 'old@x.com', deptIds: ['農園系'] },
  ];
  const r = S.planDeptAssistantRename_(list, 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /已經有/);
});

test('其他人的列原封不動（含 null 這種髒資料不會讓它炸）', () => {
  const S = makeRenameSandbox();
  const other = { email: 'other@x.com', deptIds: ['植醫系'] };
  const r = S.planDeptAssistantRename_([other, null, baseList()[0]], 'old@x.com', 'new@x.com', ACTOR, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.deptAssistants.find((e) => e && e.email === 'other@x.com'), other);
});

// ── 輔導人數（2026-08-18 使用者要求，助理可填）─────────────────────────────────
test('輔導人數：空字串與 0 是**不同**的意思（空＝還沒填、0＝真的沒有輔導學生）', () => {
  const S = makeSandbox2();
  const r = S.normalizeDeptRosterTutors_([{ name: 'A' }, { name: 'B', advisees: '0' }, { name: 'C', advisees: 25 }]);
  assert.equal(r.ok, true);
  assert.equal(r.tutors[0].advisees, '', '沒填要存空字串，不能自動變成 0——否則統計時分不出「沒填」與「真的是 0」');
  assert.equal(r.tutors[1].advisees, '0');
  assert.equal(r.tutors[2].advisees, '25', '數字型別也收，一律轉成字串存');
});

test('輔導人數：前導零去掉；非整數／負數／超過四位數 → 拒絕整筆', () => {
  const S = makeSandbox2();
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', advisees: '007' }]).tutors[0].advisees, '7');
  for (const bad of ['-1', '3.5', 'abc', '12345', '1 2', '１２']) {
    const r = S.normalizeDeptRosterTutors_([{ name: 'A', advisees: bad }]);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 應該被拒絕');
    assert.match(r.error, /輔導人數/);
  }
});
