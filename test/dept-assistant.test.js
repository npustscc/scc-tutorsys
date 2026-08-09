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
  assert.deepEqual(out.tutors, [{ name: '李鎮宇', email: 'lee@x.com', phone: '' }]);
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

// ── Phase 2：導師手機與編輯權限 ───────────────────────────────────────────────
function makeSandbox2() {
  return load([
    'normalizeDeptRosterTutors_', 'sanitizeClassesForViewer_', 'projectClassForDeptRoster_',
  ], {});
}

test('導師名單：姓名必填、email/手機選填，回傳三個欄位都在', () => {
  const S = makeSandbox2();
  const r = S.normalizeDeptRosterTutors_([{ name: '陳美惠', email: 'A@X.COM', phone: '0912-345-678' }, { name: '王小明' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tutors[0], { name: '陳美惠', email: 'a@x.com', phone: '0912-345-678' });
  assert.deepEqual(r.tutors[1], { name: '王小明', email: '', phone: '' });
});

test('導師名單：沒姓名、email 格式錯、電話含不允許字元、人數超過 10 → 拒絕', () => {
  const S = makeSandbox2();
  assert.equal(S.normalizeDeptRosterTutors_([{ name: '  ' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', email: 'not-an-email' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_([{ name: 'A', phone: '0912<script>' }]).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_(new Array(11).fill({ name: 'A' })).ok, false);
  assert.equal(S.normalizeDeptRosterTutors_('nope').ok, false);
});

test('🔒 bootstrap 的 classes 一律不含 phone——連 admin 也一樣（無例外的不變量）', () => {
  const S = makeSandbox2();
  const classes = [{
    id: 'c1', deptId: 'd', name: 'n', tutors: [{ name: '陳美惠', email: 'a@x.com', phone: '0912345678' }],
  }];
  [{ isAdmin: true, tutorOf: [] }, { isAdmin: false, tutorOf: ['c1'] }, { isAdmin: false, tutorOf: [] }].forEach(function (roles) {
    const out = S.sanitizeClassesForViewer_(classes, roles);
    assert.equal('phone' in out[0].tutors[0], false, '角色 ' + JSON.stringify(roles) + ' 拿到了 phone');
    assert.equal(out[0].tutors[0].name, '陳美惠');
  });
  // 原始物件不可被就地修改（深拷貝）
  assert.equal(classes[0].tutors[0].phone, '0912345678');
});

test('deptRosterGet 的投影**要**帶 phone（那是唯一看得到手機的通道）', () => {
  const S = makeSandbox2();
  const out = S.projectClassForDeptRoster_({
    id: 'c1', name: 'n', deptId: 'd', tutors: [{ name: '陳美惠', phone: '0912345678' }],
  });
  assert.equal(out.tutors[0].phone, '0912345678');
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
