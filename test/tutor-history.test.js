// 導師歷史＋期中更換導師（Ticket C）純函式測試：
// - tutorsDiffer_：名單異動判斷（順序視為有意義）。
// - validateMidtermChange_：期中更換輸入驗證（classId 存在且未刪除、日期真實性、
//   name/email 白名單且 email 必填、note 長度上限）。
// - canViewTutorHistory_：歷史可視權限（default-deny）。
// - buildTutorHistoryEntry_：entry 形狀（快照只留 name/email）。
// 函式就地從 dev/Code.gs 抽出（見 harness.js），改壞邏輯即紅燈。

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

function S() {
  return load(['tutorsDiffer_', 'validateMidtermChange_', 'canViewTutorHistory_', 'buildTutorHistoryEntry_']);
}

function plain(obj) { return JSON.parse(JSON.stringify(obj)); }

const NOW = '2026-07-14T05:00:00.000Z';

// ── tutorsDiffer_ ────────────────────────────────────────────────────────────

test('tutorsDiffer_: 完全相同 → false；兩邊皆空/未提供 → false', () => {
  const s = S();
  const a = [{ name: '王', email: 'w@x.com' }, { name: '李', email: 'l@x.com' }];
  const b = [{ name: '王', email: 'w@x.com' }, { name: '李', email: 'l@x.com' }];
  assert.equal(s.tutorsDiffer_(a, b), false);
  assert.equal(s.tutorsDiffer_([], []), false);
  assert.equal(s.tutorsDiffer_(undefined, []), false);
  assert.equal(s.tutorsDiffer_(null, undefined), false);
});

test('tutorsDiffer_: 任一 name 或 email 不同 → true', () => {
  const s = S();
  const base = [{ name: '王', email: 'w@x.com' }];
  assert.equal(s.tutorsDiffer_(base, [{ name: '王二', email: 'w@x.com' }]), true);
  assert.equal(s.tutorsDiffer_(base, [{ name: '王', email: 'other@x.com' }]), true);
});

test('tutorsDiffer_: 順序不同視為異動（導師 1/2 槽位有意義）', () => {
  const s = S();
  const a = [{ name: '王', email: 'w@x.com' }, { name: '李', email: 'l@x.com' }];
  const b = [{ name: '李', email: 'l@x.com' }, { name: '王', email: 'w@x.com' }];
  assert.equal(s.tutorsDiffer_(a, b), true);
});

test('tutorsDiffer_: 長度不同 → true（含從無到有、從有到無）', () => {
  const s = S();
  assert.equal(s.tutorsDiffer_([], [{ name: '王', email: 'w@x.com' }]), true);
  assert.equal(s.tutorsDiffer_([{ name: '王', email: 'w@x.com' }], []), true);
  assert.equal(s.tutorsDiffer_(
    [{ name: '王', email: 'w@x.com' }],
    [{ name: '王', email: 'w@x.com' }, { name: '李', email: 'l@x.com' }]
  ), true);
});

// ── validateMidtermChange_ ───────────────────────────────────────────────────

const CLASSES = [
  { id: 'c1', name: '四技一A', deptId: 'd1', displayName: '四資管一A', tutors: [{ name: '舊導師', email: 'old@x.com' }], active: true },
  { id: 'c_inactive', name: '停用班', deptId: 'd1', tutors: [], active: false },
  { id: 'c_deleted', name: '刪除班', deptId: 'd1', tutors: [], active: true, deleted: true },
];

function validParams(overrides) {
  return Object.assign({
    classId: 'c1', effectiveDate: '2026-04-15',
    newTutors: [{ name: '新導師', email: 'NEW@NPUST.edu.tw' }],
  }, overrides || {});
}

test('validateMidtermChange_: 合法輸入 → ok，email 轉小寫、name trim', () => {
  const s = S();
  const r = s.validateMidtermChange_(validParams({ newTutors: [{ name: ' 新導師 ', email: ' NEW@NPUST.edu.tw ' }], note: '原導師退休' }), CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.cls.id, 'c1');
  assert.deepEqual(plain(r.tutors), [{ name: '新導師', email: 'new@npust.edu.tw' }]);
  assert.equal(r.note, '原導師退休');
});

test('validateMidtermChange_: 兩位導師合法；note 未帶 → null', () => {
  const s = S();
  const r = s.validateMidtermChange_(validParams({
    newTutors: [{ name: '甲', email: 'a@x.com' }, { name: '乙', email: 'b@x.com' }],
  }), CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.tutors.length, 2);
  assert.equal(r.note, null);
});

test('validateMidtermChange_: classId 缺/不存在 → 拒絕', () => {
  const s = S();
  assert.equal(s.validateMidtermChange_(validParams({ classId: undefined }), CLASSES).ok, false);
  const r = s.validateMidtermChange_(validParams({ classId: 'ghost' }), CLASSES);
  assert.equal(r.ok, false);
  assert.match(r.error, /class not found/);
});

test('validateMidtermChange_: 已刪除班級 → 拒絕（fail-closed）；停用班允許（停用班也可能要正名單）', () => {
  const s = S();
  const del = s.validateMidtermChange_(validParams({ classId: 'c_deleted' }), CLASSES);
  assert.equal(del.ok, false);
  assert.match(del.error, /class not found/);
  const inactive = s.validateMidtermChange_(validParams({ classId: 'c_inactive' }), CLASSES);
  assert.equal(inactive.ok, true);
});

test('validateMidtermChange_: effectiveDate 缺/格式錯/非真實日期 → 拒絕', () => {
  const s = S();
  [undefined, null, '', '2026/04/15', '2026-4-5', '20260415', '2026-13-01', '2026-02-30', '2026-00-10', 20260415].forEach((d) => {
    const r = s.validateMidtermChange_(validParams({ effectiveDate: d }), CLASSES);
    assert.equal(r.ok, false, 'effectiveDate ' + JSON.stringify(d));
    assert.match(r.error, /invalid effectiveDate/);
  });
  // 閏年邊界：2024-02-29 合法、2026-02-29 不合法
  assert.equal(s.validateMidtermChange_(validParams({ effectiveDate: '2024-02-29' }), CLASSES).ok, true);
  assert.equal(s.validateMidtermChange_(validParams({ effectiveDate: '2026-02-29' }), CLASSES).ok, false);
});

test('validateMidtermChange_: newTutors 缺/空/超過 2 位/非陣列 → 拒絕', () => {
  const s = S();
  [undefined, [], 'bad', [{ name: '甲', email: 'a@x.com' }, { name: '乙', email: 'b@x.com' }, { name: '丙', email: 'c@x.com' }]].forEach((t) => {
    assert.equal(s.validateMidtermChange_(validParams({ newTutors: t }), CLASSES).ok, false, JSON.stringify(t));
  });
});

test('validateMidtermChange_: email 空/缺/格式錯 → 拒絕（期中更換是正式名單，email 必填）', () => {
  const s = S();
  [{ name: '新導師' }, { name: '新導師', email: '' }, { name: '新導師', email: 'not-an-email' }, { name: '新導師', email: 'a b@x.com' }].forEach((t) => {
    const r = s.validateMidtermChange_(validParams({ newTutors: [t] }), CLASSES);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.match(r.error, /invalid tutor email/);
  });
});

test('validateMidtermChange_: name 非法（空/引號/符號/過長/非字串）→ 拒絕', () => {
  const s = S();
  [{ name: '', email: 'a@x.com' }, { name: "王'導", email: 'a@x.com' }, { name: 'A<b>', email: 'a@x.com' },
   { name: 'x'.repeat(21), email: 'a@x.com' }, { email: 'a@x.com' }, null].forEach((t) => {
    const r = s.validateMidtermChange_(validParams({ newTutors: [t] }), CLASSES);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.match(r.error, /invalid tutor name/);
  });
  // 合法：原住民族姓名間隔號、英文含空白
  assert.equal(s.validateMidtermChange_(validParams({ newTutors: [{ name: '瓦歷斯·諾幹', email: 'a@x.com' }] }), CLASSES).ok, true);
});

test('validateMidtermChange_: note 超過 200 字/非字串 → 拒絕；恰 200 字允許', () => {
  const s = S();
  const tooLong = s.validateMidtermChange_(validParams({ note: 'x'.repeat(201) }), CLASSES);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /note too long/);
  assert.equal(s.validateMidtermChange_(validParams({ note: 123 }), CLASSES).ok, false);
  assert.equal(s.validateMidtermChange_(validParams({ note: 'x'.repeat(200) }), CLASSES).ok, true);
});

// ── canViewTutorHistory_ ─────────────────────────────────────────────────────

const CLS = { id: 'c1', deptId: 'd1', name: '四技一A' };

function roles(overrides) {
  return Object.assign({
    isAdmin: false, isDirector: false, isStaffLead: false, isStaffAssistant: false,
    assistantLead: null, deptHeadOf: [], tutorOf: [],
  }, overrides || {});
}

test('canViewTutorHistory_: admin / director / staffLead / staffAssistant → 任何班都可', () => {
  const s = S();
  assert.equal(s.canViewTutorHistory_(roles({ isAdmin: true }), CLS), true);
  assert.equal(s.canViewTutorHistory_(roles({ isDirector: true }), CLS), true);
  assert.equal(s.canViewTutorHistory_(roles({ isStaffLead: true }), CLS), true);
  assert.equal(s.canViewTutorHistory_(roles({ isStaffAssistant: true }), CLS), true);
});

test('canViewTutorHistory_: 系主任限本系（deptHeadOf 含該班 deptId）', () => {
  const s = S();
  assert.equal(s.canViewTutorHistory_(roles({ deptHeadOf: ['d1'] }), CLS), true);
  assert.equal(s.canViewTutorHistory_(roles({ deptHeadOf: ['d_other'] }), CLS), false);
});

test('canViewTutorHistory_: 導師限自班（tutorOf 含該 classId）', () => {
  const s = S();
  assert.equal(s.canViewTutorHistory_(roles({ tutorOf: ['c1'] }), CLS), true);
  assert.equal(s.canViewTutorHistory_(roles({ tutorOf: ['c_other'] }), CLS), false);
});

test('canViewTutorHistory_: 一般學生（無任何角色）→ 拒絕（default-deny）', () => {
  const s = S();
  assert.equal(s.canViewTutorHistory_(roles(), CLS), false);
});

test('canViewTutorHistory_: roles 或 classInfo 缺失 → 一律拒絕（fail-closed）', () => {
  const s = S();
  assert.equal(s.canViewTutorHistory_(null, CLS), false);
  assert.equal(s.canViewTutorHistory_(roles({ isAdmin: true }), null), false);
});

// ── buildTutorHistoryEntry_ ──────────────────────────────────────────────────

test('buildTutorHistoryEntry_: entry 形狀完整，快照只留 name/email（不帶其他欄位進歷史檔）', () => {
  const s = S();
  const cls = {
    id: 'c1', name: '四技一A', displayName: '四資管一A', deptId: 'd1',
    tutors: [{ name: '新導師', email: 'new@x.com', extra: '不應進快照' }],
    uploadWhitelist: ['student@gmail.com'],
  };
  const prev = [{ name: '舊導師', email: 'old@x.com', by: '不應進快照' }];
  const e = plain(s.buildTutorHistoryEntry_(cls, prev, 'midterm', '2026-04-15', '原導師退休', '114-2', 'admin@x.com', NOW));
  assert.deepEqual(e, {
    classId: 'c1', semester: '114-2', changeType: 'midterm', effectiveDate: '2026-04-15',
    previousTutors: [{ name: '舊導師', email: 'old@x.com' }],
    tutors: [{ name: '新導師', email: 'new@x.com' }],
    classNameAtTime: '四資管一A', note: '原導師退休', at: NOW, by: 'admin@x.com',
  });
});

test('buildTutorHistoryEntry_: effectiveDate/note/semester 未帶 → null；displayName 缺 → 用 name', () => {
  const s = S();
  const cls = { id: 'c1', name: '四技一A', tutors: [] };
  const e = plain(s.buildTutorHistoryEntry_(cls, [], 'manual', null, null, null, 'admin@x.com', NOW));
  assert.equal(e.effectiveDate, null);
  assert.equal(e.note, null);
  assert.equal(e.semester, null);
  assert.equal(e.classNameAtTime, '四技一A');
  assert.deepEqual(e.previousTutors, []);
  assert.deepEqual(e.tutors, []);
});
