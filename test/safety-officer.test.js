// 校安人員（2026-08-18 新增）：**全校唯讀、含私人手機、一個字都不能改**。
//
// 這個角色的存在理由是危機事件要立刻聯絡得到導師本人，所以它比系辦助理看得更多（全校）
// 而不是更少。正因為如此，「不能寫」這件事不能只靠 UI 收起按鈕——測的重點全在這裡：
// 寫入路徑那支 scope 解析器完全不認這個角色，所以每一個寫入 action 都會回 forbidden，
// **而且日後新增的寫入 action 只要照既有寫法呼叫它，就自動安全**。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'resolveRoles_', 'isClassTutor_',
    'resolveDeptRosterScope_', 'resolveDeptRosterReadScope_',
    'checkSystemAccess_',
  ], {
    BOOTSTRAP_ADMINS: ['boot@heartnpust.tw'],
    DEFAULT_ACCESS_ALLOW_ROLES_: ['admin', 'staffAssistant', 'deptAssistant', 'safetyOfficer'],
    DEFAULT_ACCESS_DENIED_MESSAGE_: '擋下',
  });
}

const DEPTS = [
  { id: '農園系', name: '農園系', active: true },
  { id: '森林系', name: '森林系', active: true },
  { id: '停用系', name: '停用系', active: false },
  { id: '刪除系', name: '刪除系', active: true, deleted: true },
];

function cfg(extra) {
  return Object.assign({ users: {}, settings: {} }, extra || {});
}
const SO = [{ email: 'safety@x.com', name: '校安人員', unit: '軍訓室' }];

// ── 角色解析 ───────────────────────────────────────────────────────────────────
test('命中 safetyOfficers → isSafetyOfficer，且**不會**因此拿到任何其他角色', () => {
  const S = makeSandbox();
  const r = S.resolveRoles_('safety@x.com', cfg({ safetyOfficers: SO }), DEPTS, []);
  assert.equal(r.isSafetyOfficer, true);
  assert.equal(r.isAdmin, false);
  assert.equal(r.isStaffAssistant, false);
  // 最重要的一條：**不可以**混進 deptAssistantOf——那個集合的意思是「可以維護哪些系」
  assert.deepEqual(r.deptAssistantOf, []);
});

test('停用／軟刪除／沒命中 → isSafetyOfficer 為 false（fail-closed）', () => {
  const S = makeSandbox();
  const cases = [
    [{ email: 'safety@x.com', disabled: true }, '停用'],
    [{ email: 'safety@x.com', deleted: true }, '軟刪除'],
    [{ email: 'other@x.com' }, '沒命中'],
  ];
  for (const [row, why] of cases) {
    const r = S.resolveRoles_('safety@x.com', cfg({ safetyOfficers: [row] }), DEPTS, []);
    assert.equal(r.isSafetyOfficer, false, why);
  }
});

test('config 沒有 safetyOfficers 欄位 → 不炸、false', () => {
  const S = makeSandbox();
  assert.equal(S.resolveRoles_('safety@x.com', cfg(), DEPTS, []).isSafetyOfficer, false);
});

// ── 讀：全校 ───────────────────────────────────────────────────────────────────
test('校安人員讀取範圍＝全部啟用中的系所（停用/軟刪除的不給），並標記 readOnly', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('safety@x.com', cfg({ safetyOfficers: SO }), DEPTS, []);
  const scope = S.resolveDeptRosterReadScope_(roles, undefined, DEPTS);
  assert.equal(scope.ok, true);
  assert.deepEqual(scope.deptIds, ['農園系', '森林系']);
  assert.equal(scope.readOnly, true);
});

test('校安人員指定單一系所也可以，但不存在/停用的系所仍然拒絕', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('safety@x.com', cfg({ safetyOfficers: SO }), DEPTS, []);
  assert.deepEqual(S.resolveDeptRosterReadScope_(roles, '森林系', DEPTS).deptIds, ['森林系']);
  assert.equal(S.resolveDeptRosterReadScope_(roles, '停用系', DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterReadScope_(roles, '沒這個系', DEPTS).ok, false);
});

test('系辦助理走讀取路徑時範圍不變（沒有因為多了這個角色而擴大）', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('a@x.com',
    cfg({ deptAssistants: [{ email: 'a@x.com', deptIds: ['農園系'] }] }), DEPTS, []);
  const scope = S.resolveDeptRosterReadScope_(roles, undefined, DEPTS);
  assert.deepEqual(scope.deptIds, ['農園系']);
  assert.notEqual(scope.readOnly, true);   // 助理不是唯讀
});

// ── 寫：一律拒絕（這是這個角色的核心約束）─────────────────────────────────────
test('🔒 校安人員在**寫入**路徑上什麼都拿不到——所有寫入 action 因此回 forbidden', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('safety@x.com', cfg({ safetyOfficers: SO }), DEPTS, []);
  // 寫入路徑的每一種呼叫形狀都試一次（不帶 deptId／帶自己想改的系／帶不存在的系）
  assert.equal(S.resolveDeptRosterScope_(roles, undefined, DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterScope_(roles, '森林系', DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterScope_(roles, '沒這個系', DEPTS).ok, false);
  assert.equal(S.resolveDeptRosterScope_(roles, '', DEPTS).error, 'forbidden');
});

test('🔒 同時是校安人員又是系辦助理 → 寫入仍然只限他當助理的那幾系', () => {
  const S = makeSandbox();
  const roles = S.resolveRoles_('both@x.com', cfg({
    safetyOfficers: [{ email: 'both@x.com' }],
    deptAssistants: [{ email: 'both@x.com', deptIds: ['農園系'] }],
  }), DEPTS, []);
  assert.deepEqual(S.resolveDeptRosterScope_(roles, undefined, DEPTS).deptIds, ['農園系']);
  assert.equal(S.resolveDeptRosterScope_(roles, '森林系', DEPTS).ok, false, '寫入不該擴到全校');
  // 讀取則兩者取聯集後的較大範圍（助理身分先命中，仍是全校可讀由校安身分提供）
  assert.deepEqual(S.resolveDeptRosterReadScope_(roles, '森林系', DEPTS).deptIds, ['森林系']);
});

// ── 登入閘門 ───────────────────────────────────────────────────────────────────
test('校安人員通得過全域登入閘門（預設允許集合含 safetyOfficer）', () => {
  const S = makeSandbox();
  const files = {
    'config.json': cfg({ safetyOfficers: SO }),
    'departments.json': DEPTS,
    'classes.json': [],
  };
  S.readJsonSafe_ = function (name, ctx, dflt) { return files[name] === undefined ? dflt : files[name]; };
  assert.equal(S.checkSystemAccess_('safety@x.com', {}), null, '應該放行');
  const denied = S.checkSystemAccess_('nobody@x.com', {});
  assert.ok(denied && denied.code === 'AccessRestricted', '沒角色的人仍該被擋');
});

test('🔒 允許集合明確不含 safetyOfficer 時，校安人員照樣被擋（設定說了算）', () => {
  const S = makeSandbox();
  const files = {
    'config.json': cfg({ safetyOfficers: SO, settings: { accessAllowRoles: ['admin'] } }),
    'departments.json': DEPTS,
    'classes.json': [],
  };
  S.readJsonSafe_ = function (name, ctx, dflt) { return files[name] === undefined ? dflt : files[name]; };
  const denied = S.checkSystemAccess_('safety@x.com', {});
  assert.ok(denied && denied.code === 'AccessRestricted');
});
