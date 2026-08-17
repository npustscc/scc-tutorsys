// 全域登入閘門測試：checkSystemAccess_（2026-08-17「關閉一般入口」）
//
// 這道閘門的失效方式是**安靜的**：設定寫錯、角色鍵打錯、config 讀不到，畫面上都只是
// 「某些人進不來」或更糟的「所有人都進得來」，不會有任何錯誤訊息。所以這裡把三件事釘死：
//   ①預設關閉（缺值、拼錯、空設定一律 restricted）——失效方向必須是關門而不是開門
//   ②BOOTSTRAP_ADMINS 在 config 完全讀不到時仍進得來——否則設定檔一壞就沒人能修
//   ③允許集合是資料驅動的：加一個角色鍵就能放行該角色，不必改程式碼
//
// classes.json 的條件讀取也一起測（allow 含 'tutor' 才讀）：那是效能取捨，但寫錯的話
// 導師會被安靜地擋在外面而設定看起來完全正確。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

// readJsonSafe_ 用假的：記下讀了哪些檔，讓「有沒有讀 classes.json」變成可斷言的事實。
function makeSandbox(files) {
  const reads = [];
  const S = load(['checkSystemAccess_', 'resolveRoles_', 'isClassTutor_'], {
    BOOTSTRAP_ADMINS: ['boot@heartnpust.tw'],
    DEFAULT_ACCESS_ALLOW_ROLES_: ['admin', 'staffAssistant', 'deptAssistant'],
    DEFAULT_ACCESS_DENIED_MESSAGE_: '預設拒絕訊息',
    readJsonSafe_: function (path, ctx, fallback) {
      reads.push(path);
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : fallback;
    },
  });
  S.__reads = reads;
  return S;
}

const CTX = { root: 'root-id' };

// 一組夠真實的資料：一位系辦助理、一位中心助理、一位主責、一位系主任、一位導師。
function fixtures(extraSettings) {
  return {
    'config.json': {
      users: { 'admin@x.com': { role: 'admin' } },
      settings: extraSettings || {},
      staffLeads: [{ email: 'lead@x.com', name: '主責' }],
      staffAssistants: [{ email: 'sa@x.com', name: '中心助理', leadEmail: 'lead@x.com' }],
      deptAssistants: [{ email: 'da@x.com', name: '系辦助理', deptIds: ['d1'] }],
    },
    'departments.json': [{ id: 'd1', name: '測試系', active: true, headEmail: 'head@x.com' }],
    'classes.json': [{ id: 'c1', deptId: 'd1', active: true, tutors: [{ email: 'tutor@x.com' }] }],
  };
}

// ── ①預設關閉 ───────────────────────────────────────────────────────────────────

test('沒有任何 settings → 預設關閉，導師被擋下', () => {
  const S = makeSandbox(fixtures());
  const denied = S.checkSystemAccess_('tutor@x.com', CTX);
  assert.ok(denied, '導師應該被擋下');
  assert.equal(denied.code, 'AccessRestricted');
  assert.equal(denied.message, '預設拒絕訊息');
});

test('系主任預設被擋下（2026-08-17 決策：入口之後再開）', () => {
  const S = makeSandbox(fixtures());
  assert.ok(S.checkSystemAccess_('head@x.com', CTX));
});

test('完全沒角色的一般帳號（原本的「學生」）被擋下', () => {
  const S = makeSandbox(fixtures());
  assert.ok(S.checkSystemAccess_('nobody@gmail.com', CTX));
});

test('accessMode 拼錯（open 以外的任何值）一律視為關閉', () => {
  for (const bad of ['Open', 'OPEN', 'opened', 'true', '', null, 1]) {
    const S = makeSandbox(fixtures({ accessMode: bad }));
    assert.ok(S.checkSystemAccess_('tutor@x.com', CTX), 'accessMode=' + JSON.stringify(bad) + ' 應視為關閉');
  }
});

// ── ②允許集合：三種人進得來 ────────────────────────────────────────────────────

test('管理員 / 中心助理 / 系辦助理 預設都放行', () => {
  const S = makeSandbox(fixtures());
  assert.equal(S.checkSystemAccess_('admin@x.com', CTX), null, 'admin');
  assert.equal(S.checkSystemAccess_('sa@x.com', CTX), null, 'staffAssistant');
  assert.equal(S.checkSystemAccess_('da@x.com', CTX), null, 'deptAssistant');
});

test('學諮中心主責走 admin 那條放行（resolveRoles_ 的「主責 ⇒ isAdmin」）', () => {
  const S = makeSandbox(fixtures());
  assert.equal(S.checkSystemAccess_('lead@x.com', CTX), null);
});

test('停用的系辦助理進不來（deptAssistantOf 會是空的）', () => {
  const files = fixtures();
  files['config.json'].deptAssistants[0].disabled = true;
  const S = makeSandbox(files);
  assert.ok(S.checkSystemAccess_('da@x.com', CTX));
});

test('掛的系所被停用 → 系辦助理也進不來（fail-closed 一路傳導）', () => {
  const files = fixtures();
  files['departments.json'][0].active = false;
  const S = makeSandbox(files);
  assert.ok(S.checkSystemAccess_('da@x.com', CTX));
});

// ── ③資料驅動：加一個角色鍵就放行 ──────────────────────────────────────────────

test('accessAllowRoles 加上 deptHead → 系主任入口開了，不必改程式碼', () => {
  const S = makeSandbox(fixtures({ accessAllowRoles: ['admin', 'staffAssistant', 'deptAssistant', 'deptHead'] }));
  assert.equal(S.checkSystemAccess_('head@x.com', CTX), null, '系主任應放行');
  assert.ok(S.checkSystemAccess_('tutor@x.com', CTX), '導師仍應被擋');
});

test('accessMode=open → 任何通過認證的帳號都放行（＝關閉之前的原始行為）', () => {
  const S = makeSandbox(fixtures({ accessMode: 'open' }));
  assert.equal(S.checkSystemAccess_('nobody@gmail.com', CTX), null);
});

test("accessAllowRoles 含 'anyone' → 同樣全放行（緊急恢復用）", () => {
  const S = makeSandbox(fixtures({ accessAllowRoles: ['anyone'] }));
  assert.equal(S.checkSystemAccess_('nobody@gmail.com', CTX), null);
});

test('accessAllowRoles 是空陣列 → 退回預設集合，不是「誰都不准」也不是「誰都可以」', () => {
  const S = makeSandbox(fixtures({ accessAllowRoles: [] }));
  assert.equal(S.checkSystemAccess_('admin@x.com', CTX), null);
  assert.ok(S.checkSystemAccess_('tutor@x.com', CTX));
});

test('accessAllowRoles 裡的未知角色鍵不會意外放行任何人', () => {
  const S = makeSandbox(fixtures({ accessAllowRoles: ['superuser', 'ADMIN'] }));
  assert.ok(S.checkSystemAccess_('admin@x.com', CTX), '大小寫不同的鍵不該命中');
  assert.ok(S.checkSystemAccess_('nobody@gmail.com', CTX));
});

test('accessMessage 可覆寫拒絕文案', () => {
  const S = makeSandbox(fixtures({ accessMessage: '  自訂訊息  ' }));
  assert.equal(S.checkSystemAccess_('tutor@x.com', CTX).message, '自訂訊息');
});

// ── ④防鎖死與效能取捨 ──────────────────────────────────────────────────────────

test('config.json 完全讀不到時 BOOTSTRAP_ADMINS 仍進得來（否則設定一壞就沒人能修）', () => {
  const S = makeSandbox({});   // 什麼檔都沒有 → readJsonSafe_ 一律回 fallback
  assert.equal(S.checkSystemAccess_('boot@heartnpust.tw', CTX), null);
  assert.ok(S.checkSystemAccess_('admin@x.com', CTX), '其他人在無設定狀態下一律擋下');
});

test('預設集合不含 tutor 時不讀 classes.json（300+ 班，每個請求都讀不划算）', () => {
  const S = makeSandbox(fixtures());
  S.checkSystemAccess_('admin@x.com', CTX);
  assert.ok(!S.__reads.includes('classes.json'), '實際讀了：' + S.__reads.join(','));
});

test("允許集合含 'tutor' 時才讀 classes.json，且導師真的放行", () => {
  const S = makeSandbox(fixtures({ accessAllowRoles: ['admin', 'tutor'] }));
  assert.equal(S.checkSystemAccess_('tutor@x.com', CTX), null, '導師應放行');
  assert.ok(S.__reads.includes('classes.json'), '必須讀 classes.json 才算得出 tutorOf');
});
