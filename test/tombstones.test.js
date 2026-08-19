// 墓碑區（已刪除項目）。2026-08-19 的事故背景：這個系統的刪除幾乎都是軟刪除，
// 但畫面上沒有任何地方看得到墓碑——所以同步把 6 個已換名的舊信箱「復活」成有效帳號時，
// 6 個系各有兩個助理帳號，而任何人打開後台都看不出異狀。
//
// 這一組釘住的核心是**還原的守門**：墓碑之所以是墓碑，往往正是因為有一筆新的接手了它。
// 不檢查就還原＝把同一個身分變成兩份，而那正是那場事故的形狀。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

// harness 只抽 function 宣告，檔案裡的 const 要自己補進去（少了它 planTombstoneRestore_
// 一進門就 TypeError）。這裡刻意重寫一份而不是 import：清單變動時測試要跟著壞。
const S = load(['collectTombstones_', 'planTombstoneRestore_'], {
  TOMBSTONE_KINDS_: ['class', 'deptAssistant', 'safetyOfficer', 'staffLead', 'staffAssistant', 'user'],
});

const CLASSES = [
  { id: 'A_一A', name: '一A', deptId: 'A', deleted: true, deletedAt: '2026-08-19T02:00:00Z', deletedBy: 'x@y', tutors: [{ name: '甲' }] },
  { id: 'A_二A', name: '二A', deptId: 'A' },
  { id: 'A_三A', name: '三A', deptId: 'A', deleted: true },
];
const CONFIG = {
  users: { 'u@x.com': { name: '職員', deleted: true, deletedAt: '2026-08-19T03:00:00Z' }, 'live@x.com': { name: '在職' } },
  deptAssistants: [
    { email: 'old@x.com', name: '換名前', deleted: true, deletedAt: '2026-08-18T01:00:00Z', renamedTo: 'new@x.com', deptIds: ['A'] },
    { email: 'new@x.com', name: '換名後', deptIds: ['A'] },
    { email: 'gone@x.com', name: '純刪除', deleted: true, deletedAt: '2026-08-17T01:00:00Z', deptIds: ['B'] },
  ],
  safetyOfficers: [{ email: 's@x.com', name: '校安', deleted: true, deletedAt: '2026-08-16T01:00:00Z' }],
};

test('列出所有種類的墓碑，且不含有效資料', () => {
  const rows = S.collectTombstones_(CLASSES, CONFIG);
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['A_一A', 'A_三A', 'gone@x.com', 'old@x.com', 's@x.com', 'u@x.com']);
  assert.ok(!ids.includes('A_二A') && !ids.includes('new@x.com') && !ids.includes('live@x.com'));
});

test('新刪的排前面；沒有刪除時間的排最後（不要假裝是剛刪的）', () => {
  const rows = S.collectTombstones_(CLASSES, CONFIG);
  assert.equal(rows[0].id, 'u@x.com');            // 08-19T03
  assert.equal(rows[1].id, 'A_一A');               // 08-19T02
  assert.equal(rows[rows.length - 1].id, 'A_三A'); // 沒有 deletedAt
});

test('墓碑帶得出「換名到誰」', () => {
  const row = S.collectTombstones_(CLASSES, CONFIG).find((r) => r.id === 'old@x.com');
  assert.equal(row.renamedTo, 'new@x.com');
  assert.equal(row.kind, 'deptAssistant');
});

test('🔒 還原被同名的有效班級擋下（不然同步永遠不會收斂）', () => {
  const classes = [
    { id: 'A_舊一A', name: '一A', deptId: 'A', deleted: true },
    { id: 'A_一A', name: '一A', deptId: 'A' },
  ];
  const r = S.planTombstoneRestore_('class', 'A_舊一A', classes, CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.error, /同名/);
});

test('🔒 還原被「已換名且接手那筆還有效」擋下（事故的形狀）', () => {
  const r = S.planTombstoneRestore_('deptAssistant', 'old@x.com', CLASSES, CONFIG);
  assert.equal(r.ok, false);
  assert.match(r.error, /換名/);
});

test('接手那筆也被刪掉時，舊的可以還原（沒有人在佔那個身分）', () => {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.deptAssistants[1].deleted = true;
  const r = S.planTombstoneRestore_('deptAssistant', 'old@x.com', CLASSES, cfg);
  assert.equal(r.ok, true);
});

test('沒有撞名的純刪除可以還原', () => {
  assert.equal(S.planTombstoneRestore_('deptAssistant', 'gone@x.com', CLASSES, CONFIG).ok, true);
  assert.equal(S.planTombstoneRestore_('class', 'A_三A', CLASSES, CONFIG).ok, true);
  assert.equal(S.planTombstoneRestore_('user', 'u@x.com', CLASSES, CONFIG).ok, true);
  assert.equal(S.planTombstoneRestore_('safetyOfficer', 's@x.com', CLASSES, CONFIG).ok, true);
});

test('🔒 還原不存在或本來就有效的東西一律拒絕', () => {
  assert.equal(S.planTombstoneRestore_('class', 'A_二A', CLASSES, CONFIG).ok, false, '有效的班級不該能被「還原」');
  assert.equal(S.planTombstoneRestore_('deptAssistant', 'new@x.com', CLASSES, CONFIG).ok, false);
  assert.equal(S.planTombstoneRestore_('class', '不存在', CLASSES, CONFIG).ok, false);
  assert.equal(S.planTombstoneRestore_('亂寫', 'x', CLASSES, CONFIG).ok, false);
  assert.equal(S.planTombstoneRestore_('class', '', CLASSES, CONFIG).ok, false);
});

test('email 大小寫不影響還原（畫面上點到的可能是原始大小寫）', () => {
  assert.equal(S.planTombstoneRestore_('deptAssistant', 'GONE@x.com', CLASSES, CONFIG).ok, true);
});
