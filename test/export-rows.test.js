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
  { id: '森林系', name: '森林系', collegeId: '農學院', head: { name: '吳羽婷', email: 'wu@x.com', ext: '7149', mobile: '0955' } },
  { id: '農園系', name: '農園系', collegeId: '農學院' },
];
const CLASSES = [
  { id: 'c2', name: '四技二A', displayName: '四森林二A', deptId: '森林系', active: true,
    tutors: [{ name: '甲', email: 'a@x.com', ext: '1', mobile: '0911' }, { name: '乙', email: 'b@x.com', ext: '', mobile: '' }] },
  { id: 'c1', name: '四技一A', displayName: '四森林一A', deptId: '森林系', active: true, tutors: [] },
  { id: 'c3', name: '碩一', displayName: '碩農園一', deptId: '農園系', active: false, graduatedSemester: '114-2',
    tutors: [{ name: '丙' }] },
];
const OPTS = { collegeName: function (id) { return id || '未分學院'; } };

test('一位導師一列；沒有導師的班級仍出一列（那正是要看見的缺口）', () => {
  const S = load();
  const rows = S.buildRosterExportRows(CLASSES, DEPTS, OPTS);
  const forest = rows.filter((r) => r['系所'] === '森林系');
  // 主任導師 1 + 四森林一A(無導師)1 + 四森林二A 兩位 2 = 4
  assert.equal(forest.length, 4);
  const noTutor = forest.find((r) => r['班級'] === '四森林一A');
  assert.equal(noTutor['導師'], '');
  assert.equal(noTutor['狀態'], '啟用');
  const two = forest.filter((r) => r['班級'] === '四森林二A');
  assert.deepEqual(plain(two.map((r) => r['導師'])), ['甲', '乙']);
  assert.equal(two[0]['校內分機'], '1');
  assert.equal(two[0]['私人手機'], '0911');
});

test('主任導師排在該系最前面，班級欄標「主任導師(系主任)」', () => {
  const S = load();
  const rows = S.buildRosterExportRows(CLASSES, DEPTS, OPTS);
  assert.equal(rows[0]['系所'], '森林系');
  assert.equal(rows[0]['班級'], '主任導師(系主任)');
  assert.equal(rows[0]['導師'], '吳羽婷');
  assert.equal(rows[0]['校內分機'], '7149');
  // 沒設主任導師的系所不會多出空白列
  assert.equal(rows.filter((r) => r['班級'] === '主任導師(系主任)').length, 1);
});

test('班級以顯示名排序、狀態照實寫、學院名走 collegeName 轉換', () => {
  const S = load();
  const rows = S.buildRosterExportRows(CLASSES, DEPTS, OPTS);
  const forestClasses = rows.filter((r) => r['系所'] === '森林系' && r['班級'] !== '主任導師(系主任)');
  assert.deepEqual(plain([...new Set(forestClasses.map((r) => r['班級']))]), ['四森林一A', '四森林二A']);
  const grad = rows.find((r) => r['班級'] === '碩農園一');
  assert.equal(grad['狀態'], '停用／已畢業(114-2)');
  assert.equal(grad['學院'], '農學院');
  assert.equal(grad['班級名稱(原始)'], '碩一');
});

test('withMobile=false 時整欄不存在（給不含手機的用途，例如 Google Sheet）', () => {
  const S = load();
  const rows = S.buildRosterExportRows(CLASSES, DEPTS, { collegeName: OPTS.collegeName, withMobile: false });
  assert.equal('私人手機' in rows[0], false);
  assert.equal('校內分機' in rows[0], true);
});

test('classes 有、departments 沒有的系所不會被丟掉（fail-open 到 deptId 當名稱）', () => {
  const S = load();
  const rows = S.buildRosterExportRows(
    [{ id: 'x', name: '四技一A', deptId: '孤兒系', tutors: [{ name: '丁' }] }], DEPTS, OPTS);
  const orphan = rows.find((r) => r['系所'] === '孤兒系');
  assert.ok(orphan, '孤兒系的班級不該消失');
  assert.equal(orphan['導師'], '丁');
});

test('空輸入不炸', () => {
  const S = load();
  assert.deepEqual(plain(S.buildRosterExportRows([], [], {})), []);
  assert.deepEqual(plain(S.buildRosterExportRows(null, null, {})), []);
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
