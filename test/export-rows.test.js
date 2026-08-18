// 導師名冊匯出的列組裝測試。比照 test/import-parser.test.js 的作法：從 dev/index.html 以
// `// __ROSTER_EXPORT_START__` / `// __ROSTER_EXPORT_END__` 標記就地抽出純函式，
// 在 node:vm 沙箱執行——測的是同一份正式碼，改壞即紅燈。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// vm 沙箱裡建立的陣列來自另一個 realm，deepStrictEqual 會因「不是同一個 Array」而失敗
// （與資料無關）。比照 import-parser.test.js，比較前先 JSON 往返一次。
function plain(x) { return JSON.parse(JSON.stringify(x)); }

function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dev', 'index.html'), 'utf8');
  const s = html.indexOf('// __ROSTER_EXPORT_START__');
  const e = html.indexOf('// __ROSTER_EXPORT_END__');
  if (s === -1 || e === -1 || e <= s) throw new Error('找不到 __ROSTER_EXPORT_START__/END__ 標記');
  const sandbox = { console, String, Number, Array, Object, JSON };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(s, e), sandbox);
  return sandbox;
}

const DEPTS = [
  { id: '森林系', name: '森林系', fullName: '森林學系', collegeId: '農學院',
    head: { name: '吳羽婷', email: 'wu@x.com', ext: '7149', mobile: '0955' } },
  { id: '農園系', name: '農園系', collegeId: '農學院' },
  { id: '獸醫系', name: '獸醫系', collegeId: '獸醫學院' },
  { id: '熱農系', name: '熱農系', collegeId: '國際學院' },
];
const CLASSES = [
  { id: 'c2', name: '四技二A', displayName: '四森林二A', deptId: '森林系', active: true,
    tutors: [{ name: '甲', email: 'a@x.com', ext: '1', mobile: '0911' }, { name: '乙', email: 'b@x.com', ext: '', mobile: '' }] },
  { id: 'c1', name: '四技一A', displayName: '四森林一A', deptId: '森林系', active: true, tutors: [] },
  { id: 'c3', name: '碩一', displayName: '碩農園一', deptId: '農園系', active: false, graduatedSemester: '114-2',
    tutors: [{ name: '丙' }] },
  { id: 'c4', name: '四技一A', displayName: '四獸醫一A', deptId: '獸醫系', tutors: [{ name: '丁' }] },
  { id: 'c5', name: '四技一A', displayName: '四熱農一A', deptId: '熱農系', tutors: [{ name: '戊' }] },
];
const OPTS = { collegeName: function (id) { return id || '未分學院'; }, stamp: '20260812' };

function tabNamed(tabs, name) { return tabs.find((t) => t.tab === name); }

test('一個學院一個分頁，獸醫/國際/達人併成一頁，順序照既有統計表', () => {
  const S = load();
  const tabs = S.buildRosterExportTabs(CLASSES, DEPTS, OPTS);
  assert.deepEqual(plain(tabs.map((t) => t.tab)), ['農學院', '獸醫國際達人']);
  assert.equal(tabNamed(tabs, '獸醫國際達人').rows, 2, '獸醫系與熱農系要併在同一頁');
});

test('前五列是學院名／說明／三列表頭，資料從第 6 列起；系別只寫在該系第一列', () => {
  const S = load();
  const t = tabNamed(S.buildRosterExportTabs(CLASSES, DEPTS, OPTS), '農學院');
  assert.equal(t.values[0][0], '農學院');
  assert.match(t.values[1][0], /匯出時間：20260812/);
  assert.match(t.values[1][0], /含導師私人手機/);
  // 2026-08-18 多一欄「輔導人數」，插在私人手機之後、狀態之前（狀態從第 9 欄變第 10 欄）。
  assert.deepEqual(plain(t.values[2]), ['系別', '主任導師(系主任)', '', '班級', '班級名稱(原始)', '導師姓名', '聯絡方式', '', '', '狀態']);
  assert.deepEqual(plain(t.values[3]), ['', '姓名', '校內分機', '', '', '', '校內分機', '私人手機', '輔導人數', '']);
  // 森林系第一列：系別用**正式全名**，主任導師只出現在這一列
  assert.deepEqual(plain(t.values[5]), ['森林學系', '吳羽婷', '7149', '四森林一A', '四技一A', '', '', '', '', '啟用']);
  assert.equal(t.values[6][0], '', '系別只寫一次，其餘留白給合併');
});

test('一班多位導師 → 多列，且班級欄縱向合併；沒有導師的班級仍出一列', () => {
  const S = load();
  const t = tabNamed(S.buildRosterExportTabs(CLASSES, DEPTS, OPTS), '農學院');
  const rows = t.values.slice(5);
  const two = rows.filter((r) => r[3] === '四森林二A' || (r[5] === '甲' || r[5] === '乙'));
  assert.equal(two.length, 2, '兩位導師兩列');
  assert.equal(two[0][7], '0911', '私人手機要在（匯出含手機，Sheet 不含）');
  const noTutor = rows.find((r) => r[3] === '四森林一A');
  assert.equal(noTutor[5], '', '沒有導師的班級導師欄留白');
  const m = plain(t.merges);
  assert.ok(m.some((x) => x.col === 4 && x.numRows === 2), '班級欄沒有縱向合併：' + JSON.stringify(m));
  assert.ok(m.some((x) => x.col === 1 && x.numRows > 1), '系別欄沒有縱向合併');
  assert.ok(m.some((x) => x.row === 3 && x.col === 2 && x.numCols === 2), '主任導師表頭沒跨欄');
});

test('狀態照實寫；classes 有、departments 沒有的系所不會被丟掉', () => {
  const S = load();
  const t = tabNamed(S.buildRosterExportTabs(CLASSES, DEPTS, OPTS), '農學院');
  const grad = t.values.slice(5).find((r) => r[3] === '碩農園一');
  assert.equal(grad[9], '停用／已畢業(114-2)');   // 狀態欄因為多了輔導人數而右移一格
  const tabs = S.buildRosterExportTabs(
    [{ id: 'x', name: '四技一A', deptId: '孤兒系', tutors: [{ name: '丁' }] }], DEPTS, OPTS);
  const orphan = tabs.find((t2) => t2.values.slice(5).some((r) => r[0] === '孤兒系'));
  assert.ok(orphan, '孤兒系的班級不該消失');
});

test('空輸入不炸', () => {
  const S = load();
  assert.deepEqual(plain(S.buildRosterExportTabs([], [], {})), []);
  assert.deepEqual(plain(S.buildRosterExportTabs(null, null, {})), []);
});

// ── 系辦助理帳號的匯出（用途是寄通知信給各系：帳號＋分機）──────────────────────
const ACCTS = [
  { email: 'Plant@mail.npust.edu.tw', name: '羅芬芳', ext: '6325', deptIds: ['農園系'],
    hasAccount: true, accountDisabled: false, mustChangePassword: true },
  { email: 'ibf@mail.npust.edu.tw', name: '張文瓊', ext: '7829/7803', deptIds: ['財金學程'],
    hasAccount: true, accountDisabled: false, mustChangePassword: false },
  { email: 'x@mail.npust.edu.tw', name: '待建', ext: '7040', deptIds: ['食品系', '生技系'], hasAccount: false },
];

test('帳號匯出：登入帳號取 local-part 並轉小寫，多系所以頓號串接', () => {
  const S = load();
  const rows = S.buildDeptAccountExportRows(ACCTS, (id) => id + '（名）');
  assert.equal(rows[0]['登入帳號'], 'plant');
  assert.equal(rows[0]['系所'], '農園系（名）');
  assert.equal(rows[2]['系所'], '食品系（名）、生技系（名）');
});

test('帳號匯出：初始密碼取分機第一段；已自行改過密碼的人不列出（免得誤導）', () => {
  const S = load();
  const rows = S.buildDeptAccountExportRows(ACCTS, (id) => id);
  assert.equal(rows[0]['初始密碼'], '6325', '仍是初始密碼 → 要列出');
  assert.equal(rows[1]['初始密碼'], '', '已自行更改 → 不列');
  assert.equal(rows[1]['分機'], '7829/7803', '分機欄仍保留原文');
  assert.equal(rows[2]['初始密碼'], '7040', '還沒建帳號 → 列出將來會用的初始密碼');
});

test('帳號匯出：狀態欄照實寫', () => {
  const S = load();
  const rows = S.buildDeptAccountExportRows(ACCTS, (id) => id);
  assert.deepEqual(plain(rows.map((r) => r['帳號狀態'])), ['啟用', '啟用', '尚未建立']);
  assert.deepEqual(plain(rows.map((r) => r['密碼'])), ['仍是初始密碼', '已自行更改', '—']);
  assert.deepEqual(plain(S.buildDeptAccountExportRows([], (id) => id)), []);
});
