// 換學期帶入＋年級升級（Ticket D）純函式測試：
// - parseClassGrade_：班名年級解析（結尾為年級字＋選填班別字母；家族/海青/共同指導回 null）。
// - resolveDuration_：修業年限鏈（班級覆寫 → 制度 durationYears → prefix 內建預設 → null）。
// - computeRolloverPlan_：升級規劃（advance/graduate/keep、uncertain 標記、排除停用/刪除班）。
// - validateRolloverRow_：套用前逐列驗證（存在且未刪除、action 白名單、newName 合法且不撞名）。
// - classNameForSemester_：歷史學期班名解析（nameHistory）。
// 函式就地從 dev/Code.gs 抽出（見 harness.js），改壞邏輯即紅燈。

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

function S() {
  return load([
    'parseClassGrade_', 'resolveDuration_', 'computeRolloverPlan_', 'validateRolloverRow_',
    'classNameForSemester_',
    // 依賴
    'fuseClassDisplayName_', 'deptShortName_', 'isValidClassName_',
  ], {
    // harness 只抽函式不抽頂層 const，比照 BOOTSTRAP_ADMINS 慣例注入
    // （值須與 dev/Code.gs 內宣告一致；改表時記得同步）
    GRADE_CHARS_: ['一', '二', '三', '四', '五', '六', '七'],
    DURATION_BY_PREFIX_: { '四技': 4, '四技進': 4, '技優': 4, '產專': 4, '產訓': 4, '碩': 2, '碩專': 2, '博': 4 },
  });
}

function plain(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── parseClassGrade_ ─────────────────────────────────────────────────────────

test('parseClassGrade_: 規格 10 案例——可解析者回 prefix/grade/section', () => {
  const s = S();
  assert.deepEqual(plain(s.parseClassGrade_('四技一A')), { prefix: '四技', grade: 1, section: 'A' });
  assert.deepEqual(plain(s.parseClassGrade_('四技進一')), { prefix: '四技進', grade: 1, section: '' });
  assert.deepEqual(plain(s.parseClassGrade_('碩專二B')), { prefix: '碩專', grade: 2, section: 'B' });
  assert.deepEqual(plain(s.parseClassGrade_('技優三C')), { prefix: '技優', grade: 3, section: 'C' });
  assert.deepEqual(plain(s.parseClassGrade_('產訓四B')), { prefix: '產訓', grade: 4, section: 'B' });
  assert.deepEqual(plain(s.parseClassGrade_('四技五A')), { prefix: '四技', grade: 5, section: 'A' });
  assert.deepEqual(plain(s.parseClassGrade_('碩一')), { prefix: '碩', grade: 1, section: '' });
});

test('parseClassGrade_: 家族／海青班／共同指導等非年級班名 → null（升級時 keep 不動）', () => {
  const s = S();
  assert.equal(s.parseClassGrade_('家族'), null);
  assert.equal(s.parseClassGrade_('114學年度海青\n技術研習班'), null);
  assert.equal(s.parseClassGrade_('三A、四A共同指導'), null);
  assert.equal(s.parseClassGrade_(''), null);
  assert.equal(s.parseClassGrade_(null), null);
});

test('parseClassGrade_: 年級字在中段（後面接非班別字母）不算——只認結尾', () => {
  const s = S();
  assert.equal(s.parseClassGrade_('一年甲班'), null);
  // 「資管三A」無已知前綴也可解析（prefix 允許任意字首）
  assert.deepEqual(plain(s.parseClassGrade_('資管三A')), { prefix: '資管', grade: 3, section: 'A' });
});

// ── resolveDuration_ ─────────────────────────────────────────────────────────

test('resolveDuration_: 班級 graduationGrade 覆寫最優先（獸醫四技五年制）', () => {
  const s = S();
  const cls = { graduationGrade: 5 };
  const system = { durationYears: 4 };
  assert.equal(s.resolveDuration_(cls, system, { prefix: '四技', grade: 4, section: 'A' }), 5);
});

test('resolveDuration_: 無覆寫 → 制度 durationYears 次之', () => {
  const s = S();
  assert.equal(s.resolveDuration_({}, { durationYears: 2 }, { prefix: '碩', grade: 1, section: '' }), 2);
  assert.equal(s.resolveDuration_({ graduationGrade: null }, { durationYears: 4 }, null), 4);
});

test('resolveDuration_: 制度未設定 → 依 prefix 內建預設表（精確比對）', () => {
  const s = S();
  assert.equal(s.resolveDuration_({}, null, { prefix: '四技', grade: 1, section: '' }), 4);
  assert.equal(s.resolveDuration_({}, {}, { prefix: '四技進', grade: 1, section: '' }), 4);
  assert.equal(s.resolveDuration_({}, null, { prefix: '碩', grade: 1, section: '' }), 2);
  assert.equal(s.resolveDuration_({}, null, { prefix: '碩專', grade: 1, section: '' }), 2);
  assert.equal(s.resolveDuration_({}, null, { prefix: '博', grade: 1, section: '' }), 4);
  assert.equal(s.resolveDuration_({}, null, { prefix: '技優', grade: 1, section: '' }), 4);
});

test('resolveDuration_: 皆無（未知 prefix、無制度、無覆寫）→ null；非法覆寫值忽略', () => {
  const s = S();
  assert.equal(s.resolveDuration_({}, null, { prefix: '資管', grade: 3, section: 'A' }), null);
  assert.equal(s.resolveDuration_({}, null, null), null);
  // 超出 1~7 的覆寫/制度值視同未設定
  assert.equal(s.resolveDuration_({ graduationGrade: 9 }, null, { prefix: '資管', grade: 1, section: '' }), null);
  assert.equal(s.resolveDuration_({}, { durationYears: 0 }, { prefix: '資管', grade: 1, section: '' }), null);
});

// ── computeRolloverPlan_ ─────────────────────────────────────────────────────

const DEPTS = [{ id: 'd1', name: '資訊管理系', active: true }];
const SYSTEMS = [
  { id: 'day', name: '大學日間部', durationYears: 4, disabled: false },
  { id: 'master', name: '碩士', durationYears: 2, disabled: false },
];

function mkCls(overrides) {
  return Object.assign({
    id: 'c1', name: '四技一A', displayName: '四資訊管理一A', deptId: 'd1', systemId: 'day',
    graduationGrade: null, tutors: [{ name: '王導師', email: 'w@x.com' }], active: true,
  }, overrides || {});
}

test('computeRolloverPlan_: 同學年換學期（dy=0）→ 全部 keep（名單自動沿用）', () => {
  const s = S();
  const rows = s.computeRolloverPlan_([mkCls()], DEPTS, SYSTEMS, '114-1', '114-2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'keep');
  assert.equal(rows[0].uncertain, false);
});

test('computeRolloverPlan_: dy=-1（選反）→ 全部 keep，不動任何班', () => {
  const s = S();
  const rows = s.computeRolloverPlan_([mkCls()], DEPTS, SYSTEMS, '115-1', '114-1');
  assert.equal(rows[0].action, 'keep');
});

test('computeRolloverPlan_: 跨學年 advance 改名正確（年級 +1、section 保留、displayName 重算）', () => {
  const s = S();
  const rows = s.computeRolloverPlan_([mkCls()], DEPTS, SYSTEMS, '114-2', '115-1');
  const r = rows[0];
  assert.equal(r.action, 'advance');
  assert.equal(r.grade, 1);
  assert.equal(r.newGrade, 2);
  assert.equal(r.newName, '四技二A');
  assert.equal(r.newDisplayName, '四資訊管理二A');
  assert.equal(r.uncertain, false);
  assert.equal(r.duration, 4);
  assert.deepEqual(r.tutors, ['王導師']);
});

test('computeRolloverPlan_: 四技四（duration 4）→ graduate；graduationGrade=5 覆寫 → 升五年級', () => {
  const s = S();
  const grad = s.computeRolloverPlan_([mkCls({ name: '四技四A' })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(grad.action, 'graduate');
  assert.match(grad.reason, /修業年限/);

  const vet = s.computeRolloverPlan_([mkCls({ name: '四技四A', graduationGrade: 5 })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(vet.action, 'advance');
  assert.equal(vet.newName, '四技五A');
});

test('computeRolloverPlan_: 碩二（duration 2）→ graduate', () => {
  const s = S();
  const r = s.computeRolloverPlan_([mkCls({ name: '碩二', systemId: 'master' })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'graduate');
});

test('computeRolloverPlan_: 家族（無法解析年級）→ keep + uncertain', () => {
  const s = S();
  const r = s.computeRolloverPlan_([mkCls({ name: '家族' })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'keep');
  assert.equal(r.uncertain, true);
  assert.match(r.reason, /無法解析年級/);
});

test('computeRolloverPlan_: duration null（未知 prefix、無制度）→ advance 但標 uncertain', () => {
  const s = S();
  const r = s.computeRolloverPlan_([mkCls({ name: '資管三A', systemId: null })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'advance');
  assert.equal(r.newName, '資管四A');
  assert.equal(r.uncertain, true);
  assert.match(r.reason, /修業年限未設定/);
});

test('computeRolloverPlan_: duration null 且新年級超出年級字表（>7）→ keep + uncertain', () => {
  const s = S();
  const r = s.computeRolloverPlan_([mkCls({ name: '資管七A', systemId: null })], DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'keep');
  assert.equal(r.uncertain, true);
});

test('computeRolloverPlan_: 停用與已刪除班級不納入', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c_ok' }),
    mkCls({ id: 'c_inactive', active: false }),
    mkCls({ id: 'c_deleted', deleted: true }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  assert.deepEqual(rows.map(function (r) { return r.classId; }), ['c_ok']);
});

test('computeRolloverPlan_: dy=2（跳過一學年執行）→ 一次升兩級；超限則畢業', () => {
  const s = S();
  const up2 = s.computeRolloverPlan_([mkCls({ name: '四技一A' })], DEPTS, SYSTEMS, '114-2', '116-1')[0];
  assert.equal(up2.action, 'advance');
  assert.equal(up2.newName, '四技三A');
  const grad = s.computeRolloverPlan_([mkCls({ name: '四技三A' })], DEPTS, SYSTEMS, '114-2', '116-1')[0];
  assert.equal(grad.action, 'graduate');
});

// ── validateRolloverRow_ ─────────────────────────────────────────────────────

const VCLASSES = [
  { id: 'c1', name: '四技一A', deptId: 'd1', active: true },
  { id: 'c2', name: '四技二A', deptId: 'd1', active: true },
  { id: 'c3', name: '四技二B', deptId: 'd2', active: true },              // 他系同名不算撞
  { id: 'c_dis', name: '停用班二A', deptId: 'd1', active: false },        // 停用班也算撞名
  { id: 'c_del', name: '刪除班二A', deptId: 'd1', active: true, deleted: true },  // 墓碑也算撞名
];

test('validateRolloverRow_: 合法 advance/graduate/keep 通過；advance 回 trim 後 newName', () => {
  const s = S();
  const adv = s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: ' 四技三A ' }, VCLASSES, '114-2');
  assert.equal(adv.ok, true);
  assert.equal(adv.newName, '四技三A');
  assert.equal(s.validateRolloverRow_({ classId: 'c1', action: 'graduate' }, VCLASSES, '114-2').ok, true);
  assert.equal(s.validateRolloverRow_({ classId: 'c1', action: 'keep' }, VCLASSES, '114-2').ok, true);
});

test('validateRolloverRow_: advance 撞同系所既有班名 → 拒絕（含停用班與墓碑班，fail-closed）', () => {
  const s = S();
  const hitActive = s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: '四技二A' }, VCLASSES, '114-2');
  assert.equal(hitActive.ok, false);
  assert.match(hitActive.error, /already exists/);
  const hitDisabled = s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: '停用班二A' }, VCLASSES, '114-2');
  assert.equal(hitDisabled.ok, false);
  const hitDeleted = s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: '刪除班二A' }, VCLASSES, '114-2');
  assert.equal(hitDeleted.ok, false);
  // 他系同名不算撞名
  assert.equal(s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: '四技二B' }, VCLASSES, '114-2').ok, true);
  // 排除自己：改回自己現名不算撞（雖然無意義）
  assert.equal(s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: '四技一A' }, VCLASSES, '114-2').ok, true);
});

test('validateRolloverRow_: 非法 newName（空/符號/過長）→ 拒絕', () => {
  const s = S();
  ['', null, '三 A', "A'B", 'x'.repeat(21)].forEach((n) => {
    const r = s.validateRolloverRow_({ classId: 'c1', action: 'advance', newName: n }, VCLASSES, '114-2');
    assert.equal(r.ok, false, 'newName ' + JSON.stringify(n));
  });
});

test('validateRolloverRow_: classId 缺/不存在/已刪除 → 拒絕；action 非白名單 → 拒絕', () => {
  const s = S();
  assert.equal(s.validateRolloverRow_({ action: 'keep' }, VCLASSES, '114-2').ok, false);
  assert.equal(s.validateRolloverRow_({ classId: 'ghost', action: 'keep' }, VCLASSES, '114-2').ok, false);
  assert.equal(s.validateRolloverRow_({ classId: 'c_del', action: 'keep' }, VCLASSES, '114-2').ok, false);
  const bad = s.validateRolloverRow_({ classId: 'c1', action: 'delete' }, VCLASSES, '114-2');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid action/);
});

// ── classNameForSemester_ ────────────────────────────────────────────────────

test('classNameForSemester_: 無 nameHistory / 未帶學期 → 回現行 displayName||name', () => {
  const s = S();
  const cls = { id: 'c1', name: '四技二A', displayName: '四資訊管理二A' };
  assert.equal(s.classNameForSemester_(cls, '114-2'), '四資訊管理二A');
  assert.equal(s.classNameForSemester_(cls, null), '四資訊管理二A');
  assert.equal(s.classNameForSemester_({ id: 'c1', name: '四技二A' }, '114-2'), '四技二A');
  assert.equal(s.classNameForSemester_(null, '114-2'), '');
});

test('classNameForSemester_: 歷史學期回當時的班名；升冪找第一筆 semesterId <= upToSemester', () => {
  const s = S();
  const cls = {
    id: 'c1', name: '四技三A', displayName: '四資訊管理三A',
    nameHistory: [
      { upToSemester: '113-2', name: '四技一A', displayName: '四資訊管理一A' },
      { upToSemester: '114-2', name: '四技二A', displayName: '四資訊管理二A' },
    ],
  };
  assert.equal(s.classNameForSemester_(cls, '113-1'), '四資訊管理一A', '最早的歷史區間');
  assert.equal(s.classNameForSemester_(cls, '114-1'), '四資訊管理二A', '兩段之間落到第二段');
  assert.equal(s.classNameForSemester_(cls, '115-1'), '四資訊管理三A', '晚於所有歷史 → 現名');
});

test('classNameForSemester_: 邊界 semesterId === upToSemester → 含（該學期止仍叫舊名）', () => {
  const s = S();
  const cls = {
    id: 'c1', name: '四技二A', displayName: '四資訊管理二A',
    nameHistory: [{ upToSemester: '114-2', name: '四技一A', displayName: '四資訊管理一A' }],
  };
  assert.equal(s.classNameForSemester_(cls, '114-2'), '四資訊管理一A');
  assert.equal(s.classNameForSemester_(cls, '115-1'), '四資訊管理二A');
});

test('classNameForSemester_: nameHistory 亂序也正確（內部升冪排序，不就地修改）', () => {
  const s = S();
  const hist = [
    { upToSemester: '114-2', name: '四技二A', displayName: '四資訊管理二A' },
    { upToSemester: '113-2', name: '四技一A', displayName: '四資訊管理一A' },
  ];
  const cls = { id: 'c1', name: '四技三A', displayName: '四資訊管理三A', nameHistory: hist };
  assert.equal(s.classNameForSemester_(cls, '113-1'), '四資訊管理一A');
  assert.equal(hist[0].upToSemester, '114-2', '輸入陣列不被就地重排');
});
