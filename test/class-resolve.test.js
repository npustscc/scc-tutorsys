// classResolve 純邏輯測試：className/deptName/suggestedTutors 白名單驗證、
// 系所/班級 find-or-create、id 衍生撞名後綴、導師建議（去重/上限/絕不寫入 tutors）、
// classStats 彙總。函式就地從 dev/Code.gs 抽出（見 harness.js），改壞邏輯即紅燈。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const FNS = [
  'classResolveCore_', 'isValidClassName_', 'isValidDeptName_', 'slugifyDeptId_',
  'uniqueDeptId_', 'uniqueClassId_', 'normalizeSuggestedTutors_', 'applyTutorSuggestions_',
  'computeClassStats_',
];

function S() { return load(FNS); }

// vm context 內建立的物件 prototype 與宿主不同，deepStrictEqual 會因 prototype 不相等而失敗；
// 以 JSON 往返正規化後再比對（本測試只關心資料形狀）。
function plain(obj) { return JSON.parse(JSON.stringify(obj)); }

const NOW = '2026-07-07T00:00:00.000Z';
const STU = 'student@gmail.com';

const DEPTS = [
  { id: '資訊管理系', name: '資訊管理系', headEmail: 'head@x.com', active: true },
  { id: '木材科學系', name: '木材科學與設計系', headEmail: '', active: false },
];

function baseClasses() {
  return [
    {
      id: '資訊管理系_資管三A', name: '資管三A', deptId: '資訊管理系',
      tutors: [{ name: '王導師', email: 'tutor@x.com' }],
      suggestedTutors: [{ name: '李建議', email: '', by: 'other@gmail.com', at: '2026-01-01T00:00:00.000Z' }],
      dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    },
    { id: '資訊管理系_資管三B', name: '資管三B', deptId: '資訊管理系', tutors: [], active: false },
  ];
}

// ── className 驗證 ────────────────────────────────────────────────────────────

test('isValidClassName_: 中英數 1–20 字接受（含 trim）', () => {
  const s = S();
  ['資管三A', 'A', '碩一', '1A', 'x'.repeat(20), ' 資管三A '].forEach((v) => {
    assert.equal(s.isValidClassName_(v), true, 'className ' + JSON.stringify(v));
  });
});

test('isValidClassName_: 空白/引號/斜線/符號/過長/非字串 一律拒絕', () => {
  const s = S();
  ['', '   ', 'A B', "A'", 'A"', 'A/B', 'A\\B', 'A-B', 'A(1)', 'x'.repeat(21), null, undefined, 5].forEach((v) => {
    assert.equal(s.isValidClassName_(v), false, 'className ' + JSON.stringify(v));
  });
});

test('classResolveCore_: className 無效 → 拒絕（注入字元擋在入口）', () => {
  const s = S();
  ["三A'", '三 A', 'a/../b'].forEach((name) => {
    const r = s.classResolveCore_({ deptId: '資訊管理系', className: name }, DEPTS, baseClasses(), STU, NOW);
    assert.equal(r.ok, false, 'className ' + name);
    assert.match(r.error, /invalid className/);
  });
});

// ── id 衍生與撞名後綴 ─────────────────────────────────────────────────────────

test('uniqueClassId_: 無撞名回原 slug；撞名加 _2、_2 也撞加 _3；空 slug 用 class 打底', () => {
  const s = S();
  const classes = baseClasses();
  assert.equal(s.uniqueClassId_('資訊管理系_資管四A', classes), '資訊管理系_資管四A');
  assert.equal(s.uniqueClassId_('資訊管理系_資管三A', classes), '資訊管理系_資管三A_2');
  const crowded = classes.concat([{ id: '資訊管理系_資管三A_2' }]);
  assert.equal(s.uniqueClassId_('資訊管理系_資管三A', crowded), '資訊管理系_資管三A_3');
  assert.equal(s.uniqueClassId_('', []), 'class');
});

test('classResolveCore_: 新班 id 撞既有 id（同 slug 不同名稱）→ 加序號後綴', () => {
  const s = S();
  // 既有 id '資訊管理系_資管三A' 但名稱已被改（name 比對不命中），新班名稱剛好衍生同 id
  const classes = [{ id: '資訊管理系_資管三A', name: '已改名的班', deptId: '資訊管理系', tutors: [], active: true }];
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: '資管三A' }, DEPTS, classes, STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.classCreated, true);
  assert.equal(r.cls.id, '資訊管理系_資管三A_2');
});

// ── 系所解析（沿用前輪語意）──────────────────────────────────────────────────

test('classResolveCore_: deptId 選既有且 active → 命中，不建新系所', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: '資管三A' }, DEPTS, baseClasses(), STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.dept.id, '資訊管理系');
  assert.equal(r.newDept, null);
});

test('classResolveCore_: deptId 不存在或 inactive → 拒絕', () => {
  const s = S();
  const r1 = s.classResolveCore_({ deptId: '不存在', className: 'A' }, DEPTS, [], STU, NOW);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /department not found/);
  const r2 = s.classResolveCore_({ deptId: '木材科學系', className: 'A' }, DEPTS, [], STU, NOW);
  assert.equal(r2.ok, false);
});

test('classResolveCore_: deptName 命中 inactive 系所 → 拒絕（防重打同名繞過停用）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: ' 木材科學與設計系 ', className: 'A' }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /department disabled/);
});

test('classResolveCore_: deptName 全新 → 建新系所（slugify id、headEmail 空、active true）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: '農園生產系 (農園)', className: '碩一' }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.newDept), { id: '農園生產系農園', name: '農園生產系 (農園)', headEmail: '', headName: '', active: true });
});

test('classResolveCore_: deptName slug 撞既有系所 id → 加序號後綴', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: '資訊 管理系', className: 'A' }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.newDept.id, '資訊管理系_2');
});

test('classResolveCore_: deptName 不合法 → 拒絕', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: "bad'name", className: 'A' }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid deptName/);
});

// ── 班級 find-or-create ──────────────────────────────────────────────────────

test('classResolveCore_: (deptId, name) 命中既有班級（含 trim）→ 不建新班', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: ' 資管三A ' }, DEPTS, baseClasses(), STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.cls.id, '資訊管理系_資管三A');
  assert.equal(r.classCreated, false);
});

test('classResolveCore_: 命中 inactive 班級 → 拒絕', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: '資管三B' }, DEPTS, baseClasses(), STU, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /class disabled/);
});

test('classResolveCore_: 找不到 → 建新班，形狀正確（tutors/suggestedTutors 空、any、active）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: '碩一' }, DEPTS, baseClasses(), STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.classCreated, true);
  assert.deepEqual(plain(r.cls), {
    id: '資訊管理系_碩一', name: '碩一', deptId: '資訊管理系',
    tutors: [], suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true,
  });
});

test('classResolveCore_: 舊資料殘留 grade/section 欄位無妨，只認 name 比對', () => {
  const s = S();
  const legacy = [{ id: 'x_g3_A', name: '資管三A', deptId: '資訊管理系', grade: 3, section: 'A', tutors: [], active: true }];
  const r = s.classResolveCore_({ deptId: '資訊管理系', className: '資管三A' }, DEPTS, legacy, STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.classCreated, false);
  assert.equal(r.cls.id, 'x_g3_A');
});

test('classResolveCore_: 新系所 + 新班級 一次解析', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: '時尚設計系', className: '二A' }, [], [], STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.newDept.id, '時尚設計系');
  assert.equal(r.cls.id, '時尚設計系_二A');
  assert.equal(r.classCreated, true);
});

// ── suggestedTutors 驗證與套用 ───────────────────────────────────────────────

test('normalizeSuggestedTutors_: 未提供 → ok 空陣列；非陣列 → 拒絕；超過 2 筆 → 拒絕', () => {
  const s = S();
  assert.equal(s.normalizeSuggestedTutors_(undefined).ok, true);
  assert.deepEqual(plain(s.normalizeSuggestedTutors_(null).tutors), []);
  assert.equal(s.normalizeSuggestedTutors_('bad').ok, false);
  assert.equal(s.normalizeSuggestedTutors_([{ name: '甲' }, { name: '乙' }, { name: '丙' }]).ok, false);
});

test('normalizeSuggestedTutors_: name 白名單（中英數/間隔號/空白 1–20）拒絕與接受案例', () => {
  const s = S();
  [{ name: '' }, { name: "王'導" }, { name: 'x'.repeat(21) }, { name: 'A<b>' }, { email: 'a@b.c' }, null].forEach((t) => {
    assert.equal(s.normalizeSuggestedTutors_([t]).ok, false, JSON.stringify(t));
  });
  // 合法：中文、原住民族姓名間隔號、英文含空白
  [{ name: '王小明' }, { name: '瓦歷斯·諾幹' }, { name: 'John Smith' }].forEach((t) => {
    assert.equal(s.normalizeSuggestedTutors_([t]).ok, true, JSON.stringify(t));
  });
});

test('normalizeSuggestedTutors_: email 格式驗證與轉小寫；空/未填 email 允許', () => {
  const s = S();
  assert.equal(s.normalizeSuggestedTutors_([{ name: '王', email: 'not-an-email' }]).ok, false);
  assert.equal(s.normalizeSuggestedTutors_([{ name: '王', email: 'a b@x.com' }]).ok, false);
  const ok = s.normalizeSuggestedTutors_([{ name: '王', email: ' T@NPUST.EDU.TW ' }, { name: '李' }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.tutors[0].email, 't@npust.edu.tw');
  assert.equal(ok.tutors[1].email, '');
});

test('classResolveCore_: 合法建議 append 進 suggestedTutors（含 by/at），絕不寫入 tutors', () => {
  const s = S();
  const classes = baseClasses();
  const r = s.classResolveCore_({
    deptId: '資訊管理系', className: '資管三A',
    suggestedTutors: [{ name: '新導師', email: 'NEW@x.com' }],
  }, DEPTS, classes, STU, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.suggestionsAdded, 1);
  const sugs = plain(r.cls.suggestedTutors);
  assert.deepEqual(sugs[sugs.length - 1], { name: '新導師', email: 'new@x.com', by: STU, at: NOW });
  // 資安不變式：tutors 不受影響（核章授權來源只有 admin action 能動）
  assert.deepEqual(plain(r.cls.tutors), [{ name: '王導師', email: 'tutor@x.com' }]);
  // 輸入的 classes 陣列本身不被就地修改
  assert.equal(classes[0].suggestedTutors.length, 1);
});

test('classResolveCore_: 新班 + 建議 → tutors 仍為空陣列（絕不寫入）', () => {
  const s = S();
  const r = s.classResolveCore_({
    deptId: '資訊管理系', className: '碩二',
    suggestedTutors: [{ name: '陳老師', email: 'chen@x.com' }],
  }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.cls.tutors), []);
  assert.equal(r.cls.suggestedTutors.length, 1);
});

test('applyTutorSuggestions_: 依 name 對既有 tutors 與既有建議去重（靜默略過，不算 dropped）', () => {
  const s = S();
  const cls = baseClasses()[0];
  const out = s.applyTutorSuggestions_(cls, [{ name: '王導師', email: '' }, { name: '李建議', email: '' }], STU, NOW);
  assert.equal(out.added, 0);
  assert.equal(out.dropped, 0);
  assert.equal(out.cls.suggestedTutors.length, 1); // 原封不動
});

test('applyTutorSuggestions_: 每班建議總量上限 10，超過丟棄並計入 dropped', () => {
  const s = S();
  const nine = [];
  for (let i = 0; i < 9; i++) nine.push({ name: '建議' + i, email: '', by: 'x@y.z', at: NOW });
  const cls = { id: 'c', name: 'c', deptId: 'd', tutors: [], suggestedTutors: nine, active: true };
  const out = s.applyTutorSuggestions_(cls, [{ name: '第十位', email: '' }, { name: '第十一位', email: '' }], STU, NOW);
  assert.equal(out.added, 1);
  assert.equal(out.dropped, 1);
  assert.equal(out.cls.suggestedTutors.length, 10);
});

test('classResolveCore_: 建議不合法 → 整筆拒絕（連班級都不建）', () => {
  const s = S();
  const r = s.classResolveCore_({
    deptId: '資訊管理系', className: '碩三',
    suggestedTutors: [{ name: "bad'name" }],
  }, DEPTS, [], STU, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid suggested tutor name/);
});

// ── classStats 彙總 ──────────────────────────────────────────────────────────

test('computeClassStats_: 依類型/狀態彙總，pending 認 pending_* 前綴，他班與未知類型排除', () => {
  const s = S();
  const records = [
    { classId: 'c1', type: 'meeting', status: 'approved' },
    { classId: 'c1', type: 'meeting', status: 'pending_tutor' },
    { classId: 'c1', type: 'meeting', status: 'pending_director' },
    { classId: 'c1', type: 'meeting', status: 'rejected' },
    { classId: 'c1', type: 'activity', status: 'approved' },
    { classId: 'c1', type: 'activity', status: 'pending_dept' },
    { classId: 'c2', type: 'meeting', status: 'approved' },   // 他班：排除
    { classId: 'c1', type: 'weird', status: 'approved' },     // 未知類型：排除
    null,
  ];
  const out = plain(s.computeClassStats_(records, 'c1'));
  assert.deepEqual(out, {
    meeting:  { approved: 1, pending: 2, rejected: 1, total: 4 },
    activity: { approved: 1, pending: 1, rejected: 0, total: 2 },
  });
});

test('computeClassStats_: 無紀錄 → 全 0', () => {
  const s = S();
  const out = plain(s.computeClassStats_([], 'c1'));
  assert.deepEqual(out, {
    meeting:  { approved: 0, pending: 0, rejected: 0, total: 0 },
    activity: { approved: 0, pending: 0, rejected: 0, total: 0 },
  });
});
