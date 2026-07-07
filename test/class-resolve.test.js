// classResolve 純邏輯測試：輸入驗證（grade/section/deptName 白名單）、
// 系所/班級 find-or-create、id 衍生、slug 撞名後綴。
// 函式就地從 dev/Code.gs 抽出（見 harness.js），改壞邏輯即紅燈。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const FNS = [
  'classResolveCore_', 'isValidGrade_', 'isValidSection_', 'normalizeSection_',
  'isValidDeptName_', 'slugifyDeptId_', 'uniqueDeptId_', 'gradeZh_',
];

function S() { return load(FNS); }

// vm context 內建立的物件 prototype 與宿主不同，deepStrictEqual 會因 prototype 不相等而失敗；
// 以 JSON 往返正規化後再比對（本測試只關心資料形狀）。
function plain(obj) { return JSON.parse(JSON.stringify(obj)); }

const DEPTS = [
  { id: '資訊管理系', name: '資訊管理系', headEmail: 'head@x.com', active: true },
  { id: '木材科學系', name: '木材科學與設計系', headEmail: '', active: false },
];
const CLASSES = [
  {
    id: '資訊管理系_g3_A', name: '三年級A班', deptId: '資訊管理系', grade: 3, section: 'A',
    tutors: [{ name: 'T', email: 't@x.com' }], dualApprovalMode: 'any', active: true,
  },
  { id: '資訊管理系_g3_B', name: '三年級B班', deptId: '資訊管理系', grade: 3, section: 'B', tutors: [], active: false },
];

// ── grade 驗證 ────────────────────────────────────────────────────────────────

test('isValidGrade_: 整數 1–6 接受', () => {
  const s = S();
  [1, 2, 3, 4, 5, 6].forEach((g) => assert.equal(s.isValidGrade_(g), true, 'grade ' + g));
});

test('isValidGrade_: 0/7/小數/字串/null/undefined/NaN 一律拒絕', () => {
  const s = S();
  [0, 7, -1, 3.5, '3', '三', null, undefined, NaN, [3], {}].forEach((g) => {
    assert.equal(s.isValidGrade_(g), false, 'grade ' + String(g));
  });
});

test('classResolveCore_: grade 無效 → 拒絕', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: '3', section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid grade/);
});

// ── section 驗證 ─────────────────────────────────────────────────────────────

test('isValidSection_: 英數/中文 1–6 字接受', () => {
  const s = S();
  ['A', 'a', 'D', '甲', '資工1', 'AB12', '一二三四五六'].forEach((v) => {
    assert.equal(s.isValidSection_(v), true, 'section ' + v);
  });
});

test('isValidSection_: 引號/斜線/空白/空字串/過長/非字串 一律拒絕', () => {
  const s = S();
  ["A'", 'A"', 'A/B', 'A\\B', 'A B', '', 'ABCDEFG', ' A', 'A\n', null, undefined, 1].forEach((v) => {
    assert.equal(s.isValidSection_(v), false, 'section ' + JSON.stringify(v));
  });
});

test("normalizeSection_: 英文字母統一大寫（'a'→'A'），中文/數字維持原樣", () => {
  const s = S();
  assert.equal(s.normalizeSection_('a'), 'A');
  assert.equal(s.normalizeSection_('b1'), 'B1');
  assert.equal(s.normalizeSection_('甲'), '甲');
});

test('classResolveCore_: section 無效 → 拒絕（注入字元擋在入口）', () => {
  const s = S();
  ["A'", 'A B', 'a/../b'].forEach((sec) => {
    const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 3, section: sec }, DEPTS, CLASSES);
    assert.equal(r.ok, false, 'section ' + sec);
    assert.match(r.error, /invalid section/);
  });
});

// ── deptName 驗證與 slugify ──────────────────────────────────────────────────

test('isValidDeptName_: 合法名稱接受（trim 後 1–30 字，中英數/括號/空白）', () => {
  const s = S();
  ['資訊管理系', ' 資訊管理系 ', 'CS (資工)', '獸醫學系（碩士班）'].forEach((v) => {
    assert.equal(s.isValidDeptName_(v), true, 'deptName ' + v);
  });
});

test('isValidDeptName_: 引號/斜線/過長/空白-only/非字串 一律拒絕', () => {
  const s = S();
  ["資管'系", '資管/系', '資管\\系', '', '   ', 'x'.repeat(31), null, undefined, 5].forEach((v) => {
    assert.equal(s.isValidDeptName_(v), false, 'deptName ' + JSON.stringify(v));
  });
});

test('slugifyDeptId_: 只保留英數/中文/底線（去括號與空白）', () => {
  const s = S();
  assert.equal(s.slugifyDeptId_('CS (資工)'), 'CS資工');
  assert.equal(s.slugifyDeptId_('資訊 管理 系'), '資訊管理系');
  assert.equal(s.slugifyDeptId_('（）() '), '');
});

test('uniqueDeptId_: 無撞名回原 slug；撞名加 _2、_2 也撞加 _3；空 slug 用 dept 打底', () => {
  const s = S();
  assert.equal(s.uniqueDeptId_('新系所', DEPTS), '新系所');
  assert.equal(s.uniqueDeptId_('資訊管理系', DEPTS), '資訊管理系_2');
  const crowded = DEPTS.concat([{ id: '資訊管理系_2' }]);
  assert.equal(s.uniqueDeptId_('資訊管理系', crowded), '資訊管理系_3');
  assert.equal(s.uniqueDeptId_('', []), 'dept');
  assert.equal(s.uniqueDeptId_('', [{ id: 'dept' }]), 'dept_2');
});

// ── 系所解析 ─────────────────────────────────────────────────────────────────

test('classResolveCore_: deptId 選既有且 active → 命中，不建新系所', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 3, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.dept.id, '資訊管理系');
  assert.equal(r.newDept, null);
});

test('classResolveCore_: deptId 不存在或 inactive → 拒絕', () => {
  const s = S();
  const r1 = s.classResolveCore_({ deptId: '不存在', grade: 1, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /department not found/);
  const r2 = s.classResolveCore_({ deptId: '木材科學系', grade: 1, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r2.ok, false);
});

test('classResolveCore_: deptName 完全比對既有名稱（含 inactive）→ 命中不重複建', () => {
  const s = S();
  // '木材科學與設計系' 是 inactive 系所的名稱，仍應命中（避免重複建同名系所）
  const r = s.classResolveCore_({ deptName: ' 木材科學與設計系 ', grade: 1, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.dept.id, '木材科學系');
  assert.equal(r.newDept, null);
});

test('classResolveCore_: deptName 全新 → 建新系所，id 為 slugify 後名稱、headEmail 空、active true', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: '農園生產系 (農園)', grade: 2, section: 'B' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.newDept), { id: '農園生產系農園', name: '農園生產系 (農園)', headEmail: '', headName: '', active: true });
  assert.equal(r.dept, r.newDept);
});

test('classResolveCore_: deptName slug 撞既有 id → 加序號後綴', () => {
  const s = S();
  // 名稱 '資訊管理系(新)' slugify 後 = '資訊管理系新'…改用會真正撞的：'資訊 管理系' → '資訊管理系'（撞既有 id）
  const r = s.classResolveCore_({ deptName: '資訊 管理系', grade: 1, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.newDept.id, '資訊管理系_2');
});

test('classResolveCore_: deptName 不合法 → 拒絕', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: "bad'name", grade: 1, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid deptName/);
});

// ── 班級解析 ─────────────────────────────────────────────────────────────────

test('classResolveCore_: (deptId, grade, section) 命中既有班級 → 不建新班', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 3, section: 'A' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.cls.id, '資訊管理系_g3_A');
  assert.equal(r.newClass, null);
});

test('classResolveCore_: section 小寫輸入正規化後命中既有大寫班級', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 3, section: 'a' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.cls.id, '資訊管理系_g3_A');
  assert.equal(r.newClass, null);
});

test('classResolveCore_: 找不到 → 建新班，id/name/預設欄位正確', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 4, section: 'c' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.newClass), {
    id: '資訊管理系_g4_C', name: '四年級C班',
    deptId: '資訊管理系', grade: 4, section: 'C',
    tutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true,
  });
});

test('classResolveCore_: 中文班別 → name 組合正確（六年級甲班）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 6, section: '甲' }, DEPTS, CLASSES);
  assert.equal(r.ok, true);
  assert.equal(r.newClass.id, '資訊管理系_g6_甲');
  assert.equal(r.newClass.name, '六年級甲班');
});

test('classResolveCore_: 命中既有但 inactive 班級 → 拒絕（不可對停用班上傳）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptId: '資訊管理系', grade: 3, section: 'B' }, DEPTS, CLASSES);
  assert.equal(r.ok, false);
  assert.match(r.error, /class disabled/);
});

test('classResolveCore_: 新系所 + 新班級 一次解析（newDept 與 newClass 同時回傳）', () => {
  const s = S();
  const r = s.classResolveCore_({ deptName: '時尚設計系', grade: 1, section: 'A' }, [], []);
  assert.equal(r.ok, true);
  assert.equal(r.newDept.id, '時尚設計系');
  assert.equal(r.newClass.id, '時尚設計系_g1_A');
  assert.equal(r.newClass.name, '一年級A班');
});

test('gradeZh_: 1–6 對照 一~六', () => {
  const s = S();
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(s.gradeZh_), ['一', '二', '三', '四', '五', '六']);
});
