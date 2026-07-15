// 匯入 v3 解析器測試（Ticket E）：從 dev/index.html 以
// `// __IMPORT_PARSER_START__` / `// __IMPORT_PARSER_END__` 標記就地抽出解析器純函式區段，
// 在 node:vm 沙箱執行（比照 test/harness.js 精神——測的是同一份正式碼，改壞即紅燈；
// 不複製貼上函式進測試檔，避免漂移）。
// 涵蓋：格式偵測、系別 forward-fill、合計列排除、家族導師展開、導師2併入上一列、
// 第三位導師 uncertain、特殊班名 uncertain、合併分頁學院不明、應開份數空白=undefined、
// email 姓名比對（唯一/同名多 email/無命中）、差異分類。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML_PATH = path.join(__dirname, '..', 'dev', 'index.html');
const START = '// __IMPORT_PARSER_START__';
const END = '// __IMPORT_PARSER_END__';

function loadParser() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s === -1 || e === -1 || e <= s) throw new Error('找不到 __IMPORT_PARSER_START__/END__ 標記');
  const code = html.slice(s, e);
  const sandbox = { console, String, Number, Array, Object, JSON, RegExp, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function plain(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── 統計表 fixture（欄位對照 114-2 實檔：col0 系別、col2 班級、col3 導師、col4 應開份數）──

function statsSheet(college, dataRows) {
  const rows = [
    [college, '', '', '', '', ''],
    ['*說明文字', '', '', '', '', ''],
    ['系別', '系輔導會議(開會日期)', '班級', '導師姓名', '班會、家族會議紀錄', ''],
    ['', '', '', '', '應開\n份數', '已開\n份數'],
    ['', '', '', '', '', ''],
  ];
  return { name: college, rows: rows.concat(dataRows) };
}

// ── detectImportFormat ───────────────────────────────────────────────────────

test('detectImportFormat: row2 col0=系別且 col2=班級 → stats；否則 standard', () => {
  const S = loadParser();
  assert.equal(S.detectImportFormat([statsSheet('農學院', [])]), 'stats');
  assert.equal(S.detectImportFormat([{ name: 'S1', rows: [['學院', '系所', '班級名稱(原始)']] }]), 'standard');
  assert.equal(S.detectImportFormat([]), 'standard');
  // 多分頁只要任一分頁命中即 stats
  assert.equal(S.detectImportFormat([{ name: 'x', rows: [] }, statsSheet('工學院', [])]), 'stats');
});

// ── parseStatsWorkbook：一般列、forward-fill、合計、空列 ─────────────────────

test('parseStatsWorkbook: 系別合併儲存格 forward-fill；空列與尾端空白列跳過', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['農園系', '', '四技一A', '李鎮宇', 4, 4],
    ['', '', '四技一B', '鍾興穎', 4, ''],
    ['', '', '', '', '', ''],           // 空列
    ['植醫系', '', '四技一A', '王大明', 4, ''],
    ['', '', '', '', '', ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(function (r) { return r.deptName; }), ['農園系', '農園系', '植醫系']);
  assert.equal(rows[0].collegeName, '農學院');
  assert.equal(rows[0].classNameRaw, '四技一A');
  assert.equal(rows[0].tutor1Name, '李鎮宇');
  assert.equal(rows[0].requiredMeetingCount, 4);
  assert.equal(rows[0].flags.uncertain, false);
  assert.equal(rows[0].systemName, '', '統計表無導師制度欄');
});

test('parseStatsWorkbook: 「XX合計」「合計」列跳過且不污染系別 forward-fill', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['農園系', '', '四技一A', '李鎮宇', 4, ''],
    ['農園系合計', '', '', '', 20, ''],
    ['', '', '四技二A', '陳老師', 4, ''],   // 合計後、新系別前 → 仍屬農園系
    ['合計', '', '', '', 99, ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].deptName, '農園系', '合計列不覆蓋 forward-fill 的系別');
});

test('parseStatsWorkbook: 學院名帶前後空白 → trim（實檔「 農學院」有前導空白）', () => {
  const S = loadParser();
  const sheet = statsSheet(' 農學院', [['農園系', '', '四技一A', '李鎮宇', 4, '']]);
  assert.equal(plain(S.parseStatsWorkbook([sheet]))[0].collegeName, '農學院');
});

// ── 家族導師展開 vs 導師2併入 ────────────────────────────────────────────────

test('parseStatsWorkbook: 班級空白＋col4 有值 → 家族導師展開（每人一班、班名=家族+姓名、override=該值、type=family、不算 uncertain）', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['森林系', '', '四技一A', 'normal', 4, ''],
    ['', '', '', '陳美惠', 2, ''],
    ['', '', '', '王志強', '2', ''],   // 字串數字也接受
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 3);
  const fam = rows.slice(1);
  assert.deepEqual(fam.map(function (r) { return r.classNameRaw; }), ['家族陳美惠', '家族王志強']);
  assert.deepEqual(fam.map(function (r) { return r.requiredMeetingCount; }), [2, 2]);
  assert.deepEqual(fam.map(function (r) { return r.flags.type; }), ['family', 'family']);
  assert.deepEqual(fam.map(function (r) { return r.flags.uncertain; }), [false, false]);
  assert.equal(fam[0].deptName, '森林系');
});

test('parseStatsWorkbook: 班級空白＋col4 空 → 併入上一個班級列當導師2（實檔養殖系四技一＝丁德興＋劉俊宏）', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['養殖系', '', '四技一', '丁德興', 4, 4],
    ['', '', '', '劉俊宏', '', ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 1, '併入後不產生獨立列');
  assert.equal(rows[0].tutor1Name, '丁德興');
  assert.equal(rows[0].tutor2Name, '劉俊宏');
});

test('parseStatsWorkbook: 上一列已有導師2 → 第三位導師標 uncertain 獨立列；前面沒有班級列 → 也 uncertain', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['養殖系', '', '四技一', '丁德興', 4, ''],
    ['', '', '', '劉俊宏', '', ''],
    ['', '', '', '第三人', '', ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].tutor1Name, '第三人');
  assert.equal(rows[1].flags.uncertain, true);
  assert.match(rows[1].flags.reason, /第三位導師/);

  const orphan = statsSheet('農學院', [['養殖系', '', '', '孤兒導師', '', '']]);
  const r2 = plain(S.parseStatsWorkbook([orphan]));
  assert.equal(r2.length, 1);
  assert.equal(r2[0].flags.uncertain, true);
});

// ── 特殊班名 uncertain ───────────────────────────────────────────────────────

test('parseStatsWorkbook: 共同指導／家族／海青／非法字元（含換行）班名 → uncertain', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['森林系', '', '三A、四A共同指導', '林宜賢', 2, ''],
    ['', '', '家族', '沈朋志', 2, ''],
    ['', '', '114學年度海青\n技術研習班', '梁佑慎', 4, ''],
    ['', '', '四技 一A', '空白班名', 4, ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 4);
  rows.forEach(function (r) { assert.equal(r.flags.uncertain, true, r.classNameRaw); });
  assert.match(rows[0].flags.reason, /共同指導/);
  assert.match(rows[1].flags.reason, /家族/);
  assert.match(rows[2].flags.reason, /海青/);
  assert.match(rows[3].flags.reason, /非法字元/);
});

// ── 合併分頁（學院不明）──────────────────────────────────────────────────────

test('parseStatsWorkbook: 學院名含「、」（合併分頁）→ 整頁 collegeName 空、逐列 uncertain reason=學院不明', () => {
  const S = loadParser();
  const sheet = statsSheet('獸醫學院、國際學院、達人學院', [
    ['獸醫系', '', '四技一A', '林璟鴻', 4, ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows[0].collegeName, '');
  assert.equal(rows[0].flags.uncertain, true);
  assert.match(rows[0].flags.reason, /學院不明（合併分頁）/);
});

// ── 全表統計列與「實習」應開份數（114-2 實檔實測樣態）─────────────────────────

test('parseStatsWorkbook: 導師欄為「264/341」比值的全表統計列 → 跳過（實檔每分頁底部一列）', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['農園系', '', '四技一A', '李鎮宇', 4, ''],
    ['', '1/9', '', '264/341', '', ''],   // 實檔樣態：col1=系會議比、col3=已開/應開比
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows.length, 1, '統計列不產生資料列、也不被當成導師2併入');
  assert.equal(rows[0].tutor2Name, '');
});

test('parseStatsWorkbook: 應開份數「實習」→ 免繳（0）＋標 uncertain 供確認；其他非數字照帶原值＋uncertain', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [
    ['農園系', '', '四技三B', '趙雲洋', '實習', '實習'],
    ['', '', '四技四A', '王大明', '待定', ''],
  ]);
  const rows = plain(S.parseStatsWorkbook([sheet]));
  assert.equal(rows[0].requiredMeetingCount, 0);
  assert.equal(rows[0].flags.uncertain, true);
  assert.match(rows[0].flags.reason, /實習/);
  assert.equal(rows[1].requiredMeetingCount, '待定');
  assert.equal(rows[1].flags.uncertain, true);
  assert.match(rows[1].flags.reason, /非數字/);
});

// ── 應開份數空白＝undefined ──────────────────────────────────────────────────

test('parseStatsWorkbook: 應開份數空白 → requiredMeetingCount 為 undefined（不是 null/空字串）', () => {
  const S = loadParser();
  const sheet = statsSheet('農學院', [['農園系', '', '四技一A', '李鎮宇', '', '']]);
  const rows = S.parseStatsWorkbook([sheet]);
  assert.equal(rows[0].requiredMeetingCount, undefined);
  assert.equal('requiredMeetingCount' in rows[0], true);
  // JSON 序列化後該鍵消失 → 後端 parseRequiredMeetingCountField_ 視為未帶 → 保留既有覆寫
  assert.equal('requiredMeetingCount' in plain(rows[0]), false);
});

// ── email 姓名比對 ───────────────────────────────────────────────────────────

const EMAIL_CLASSES = [
  { id: 'c1', tutors: [{ name: '王小明', email: 'wang@x.com' }], active: true },
  { id: 'c2', tutors: [{ name: '王小明', email: 'WANG@x.com' }], active: false },            // 同人同 email（大小寫不同）→ 去重
  { id: 'c3', tutors: [{ name: '李同名', email: 'a@x.com' }], deleted: true },               // 墓碑也算比對來源
  { id: 'c4', tutors: [{ name: '李同名', email: 'b@x.com' }, { name: '陳無關', email: 'c@x.com' }], active: true },
];

test('buildTutorEmailIndex: 姓名→email 去重（含墓碑班、大小寫正規化）', () => {
  const S = loadParser();
  const idx = plain(S.buildTutorEmailIndex(EMAIL_CLASSES));
  assert.deepEqual(idx['王小明'], ['wang@x.com']);
  assert.deepEqual(idx['李同名'].sort(), ['a@x.com', 'b@x.com']);
});

test('applyEmailLookup: 唯一命中自動帶入(auto)；同名多 email → uncertain；無命中 → missing 不算 uncertain；已有 email 不動', () => {
  const S = loadParser();
  const idx = S.buildTutorEmailIndex(EMAIL_CLASSES);
  const rows = [
    { tutor1Name: '王小明', tutor1Email: '', tutor2Name: '', tutor2Email: '', flags: { uncertain: false, reason: null, type: null } },
    { tutor1Name: '李同名', tutor1Email: '', tutor2Name: '', tutor2Email: '', flags: { uncertain: false, reason: null, type: null } },
    { tutor1Name: '查無此人', tutor1Email: '', tutor2Name: '', tutor2Email: '', flags: { uncertain: false, reason: null, type: null } },
    { tutor1Name: '王小明', tutor1Email: 'keep@x.com', tutor2Name: '', tutor2Email: '', flags: { uncertain: false, reason: null, type: null } },
  ];
  S.applyEmailLookup(rows, idx);
  assert.equal(rows[0].tutor1Email, 'wang@x.com');
  assert.equal(rows[0].flags.tutor1EmailStatus, 'auto');
  assert.equal(rows[0].flags.uncertain, false);

  assert.equal(rows[1].tutor1Email, '', '同名多 email 留白');
  assert.equal(rows[1].flags.tutor1EmailStatus, 'ambiguous');
  assert.equal(rows[1].flags.uncertain, true);
  assert.match(rows[1].flags.reason, /同名多 email/);

  assert.equal(rows[2].tutor1Email, '');
  assert.equal(rows[2].flags.tutor1EmailStatus, 'missing');
  assert.equal(rows[2].flags.uncertain, false, '無命中只標黃待補，不算 uncertain');

  assert.equal(rows[3].tutor1Email, 'keep@x.com', '已有 email 不覆蓋');
  assert.equal(rows[3].flags.tutor1EmailStatus, undefined);
});

test('applyEmailLookup: tutor2 也套同一套比對', () => {
  const S = loadParser();
  const idx = S.buildTutorEmailIndex(EMAIL_CLASSES);
  const rows = [{ tutor1Name: 'X', tutor1Email: 'x@x.com', tutor2Name: '王小明', tutor2Email: '', flags: { uncertain: false, reason: null, type: null } }];
  S.applyEmailLookup(rows, idx);
  assert.equal(rows[0].tutor2Email, 'wang@x.com');
  assert.equal(rows[0].flags.tutor2EmailStatus, 'auto');
});

// ── classifyImportRow（差異分類）─────────────────────────────────────────────

const DIFF_DEPTS = [{ id: 'd1', name: '資訊管理系', active: true }];
const DIFF_CLASSES = [
  { id: 'd1_a', name: '四技一A', deptId: 'd1', tutors: [{ name: '王老師', email: 'wang@x.com' }], active: true },
  { id: 'd1_b', name: '四技一B', deptId: 'd1', tutors: [{ name: '甲', email: 'a@x.com' }, { name: '乙', email: 'b@x.com' }], active: true },
];

function diffRow(overrides) {
  return Object.assign({
    deptName: '資訊管理系', classNameRaw: '四技一A',
    tutor1Name: '王老師', tutor1Email: 'wang@x.com', tutor2Name: '', tutor2Email: '',
  }, overrides || {});
}

test('classifyImportRow: 系所或班級不存在 → new', () => {
  const S = loadParser();
  assert.equal(S.classifyImportRow(diffRow({ deptName: '新系所' }), DIFF_DEPTS, DIFF_CLASSES).status, 'new');
  assert.equal(S.classifyImportRow(diffRow({ classNameRaw: '四技九Z' }), DIFF_DEPTS, DIFF_CLASSES).status, 'new');
});

test('classifyImportRow: 同名同 email → unchanged；匯入 email 空白（統計表）只比姓名 → unchanged', () => {
  const S = loadParser();
  assert.equal(S.classifyImportRow(diffRow(), DIFF_DEPTS, DIFF_CLASSES).status, 'unchanged');
  assert.equal(S.classifyImportRow(diffRow({ tutor1Email: '' }), DIFF_DEPTS, DIFF_CLASSES).status, 'unchanged');
  // 本列完全未帶導師 → 後端沿用既有 → unchanged
  assert.equal(S.classifyImportRow(diffRow({ tutor1Name: '', tutor1Email: '' }), DIFF_DEPTS, DIFF_CLASSES).status, 'unchanged');
});

test('classifyImportRow: 導師姓名不同（或 email 不同）→ tutor_changed，附現行名單', () => {
  const S = loadParser();
  const byName = S.classifyImportRow(diffRow({ tutor1Name: '新老師', tutor1Email: '' }), DIFF_DEPTS, DIFF_CLASSES);
  assert.equal(byName.status, 'tutor_changed');
  assert.deepEqual(plain(byName.currentTutors), [{ name: '王老師', email: 'wang@x.com' }]);
  const byEmail = S.classifyImportRow(diffRow({ tutor1Email: 'other@x.com' }), DIFF_DEPTS, DIFF_CLASSES);
  assert.equal(byEmail.status, 'tutor_changed');
});

test('classifyImportRow: 現行 1 位＋匯入同名第 1 位＋多第 2 位 → tutor2_added；兩位變一位 → tutor_changed', () => {
  const S = loadParser();
  const added = S.classifyImportRow(diffRow({ tutor2Name: '新二師', tutor2Email: '' }), DIFF_DEPTS, DIFF_CLASSES);
  assert.equal(added.status, 'tutor2_added');
  const removed = S.classifyImportRow(diffRow({ classNameRaw: '四技一B', tutor1Name: '甲', tutor1Email: 'a@x.com' }), DIFF_DEPTS, DIFF_CLASSES);
  assert.equal(removed.status, 'tutor_changed');
});

// ── displayName 自動融合（前端複本 fuseClassDisplayNameFront）────────────────
// 與 dev/Code.gs 的 fuseClassDisplayName_ 為同邏輯雙生（改動時兩處同步）；除固定案例外，
// 另以 test/harness.js 抽出 Code.gs 版本做 parity 比對——兩處漂移即紅燈。

const { load: loadGs } = require('./harness');

test('fuseClassDisplayNameFront: 四技/四技進/碩/碩專/博/家族/海青/無學制關鍵字 fallback 的固定案例', () => {
  const S = loadParser();
  const f = S.fuseClassDisplayNameFront;
  assert.equal(f('四技一A', '農園系'), '四農園一A');
  assert.equal(f('四技進一A', '農園系'), '進四農園一A');
  assert.equal(f('碩一', '農園系'), '碩農園一');
  assert.equal(f('碩專一B', '農園系'), '碩專農園一B');
  assert.equal(f('博一', '農園系'), '博農園一');
  assert.equal(f('家族陳美惠', '森林系', null, '陳美惠'), '森林家族(陳美惠)');
  assert.equal(f('家族陳美惠', '森林系'), '森林家族', '未帶導師名 → 不含括號');
  assert.equal(f('海青技術研習班', '農園系'), '海青農園技術研習班');
  assert.equal(f('技優一A', '農園系'), '技優農園一A');
  assert.equal(f('進修部一A', '農園系'), '農園進修部一A', '無學制關鍵字 → 系簡+原名 fallback');
  assert.equal(f('', '農園系'), '農園', '空班名 → 只回系簡稱');
  assert.equal(f('四技一A', '通識教育中心'), '四通識教育中心一A', '非「系」結尾 → 用全名');
});

test('fuseClassDisplayNameFront ↔ Code.gs fuseClassDisplayName_ parity（同輸入同輸出，抓兩處漂移）', () => {
  const S = loadParser();
  const G = loadGs(['deptShortName_', 'fuseClassDisplayName_']);
  const cases = [
    ['四技一A', '農園系', null, undefined],
    ['四技進一A', '農園系', null, undefined],
    ['碩一', '農園系', 'master', undefined],
    ['碩專一B', '農園系', null, undefined],
    ['博一', '獸醫系', null, undefined],
    ['家族陳美惠', '森林系', 'family', '陳美惠'],
    ['家族陳美惠', '森林系', 'family', undefined],
    ['家族', '森林系', null, '王志強'],
    ['技優一A', '農園系', null, undefined],
    ['產訓一A', '農園系', null, undefined],
    ['產專一A', '農園系', null, undefined],
    ['海青技術研習班', '農園系', null, undefined],
    ['進修部一A', '農園系', null, undefined],
    ['', '農園系', null, undefined],
    ['四技一A', '通識教育中心', null, undefined],
    ['四技一A', '系', null, undefined],          // 邊界：單字「系」不去尾
    [undefined, undefined, null, undefined],
  ];
  cases.forEach(function (c) {
    assert.equal(
      S.fuseClassDisplayNameFront(c[0], c[1], c[2], c[3]),
      G.fuseClassDisplayName_(c[0], c[1], c[2], c[3]),
      'parity 失敗：' + JSON.stringify(c)
    );
  });
});
