// 換學期帶入＋年級升級（Ticket D）純函式測試：
// - parseClassGrade_：班名年級解析（結尾為年級字＋選填班別字母；家族/海青/共同指導回 null）。
// - resolveDuration_：修業年限鏈（班級覆寫 → 制度 durationYears → prefix 內建預設 → null）。
// - computeRolloverPlan_：升級規劃——2026-08-11 事故後改為席位式（inherit/vacate/keep，
//   不再改名、不再畢業任何班；見 dev/Code.gs 該函式頂端的事故背景註解）。2026-08-13 再修
//   一輪（正式資料骨架實跑抓到的洞）：
//   * gate 4 只檢查「目標席位存在」，沒檢查「目標席位這次真的會接手」——cascadeDowngrade_
//     反覆掃描到不動點，把「目標存在但自己也被判 keep」的鏈全部連鎖降級（見下面「一B/二B/
//     三B 沒有四B」與「四層鏈」兩組測試）。
//   * 冪等守門改成比對學年（前三碼）而非完整學期 id，防止「同一學年被推第二次」
//     （見「F4」那組測試）。
// - applyRolloverPlan_：套用前逐列驗證＋「全有全無」套用（取代舊版 validateRolloverRow_；
//   舊版逐列驗證、失敗列不中斷整批，正是事故的根因，新版任一列有問題就整批不寫）。
//   2026-08-13 再修一輪：
//   * 每一列只准採用 plan.action 本身或降級成 keep，不准「升級」（見「F2」那組測試——
//     否則 fromSemester===toSemester 這種 dy=0 的合法呼叫可以一次把全校導師清空）。
//   * 全批一致性檢查 R1（不准掉導師）／R2（不准同一位導師同時掛兩班），backstop 用
//     （見「F3」那組測試——vacate 與 inherit 是成對的，UI/API 都可能把它們拆開送）。
// - classNameForSemester_：歷史學期班名解析（nameHistory；席位式底下不會再有新的
//   nameHistory 條目，但既有資料與 undo 維護函式仍可能讀到，函式與測試都保留）。
// 函式就地從 dev/Code.gs 抽出（見 harness.js），改壞邏輯即紅燈。

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

function S() {
  return load([
    'parseClassGrade_', 'resolveDuration_', 'computeRolloverPlan_', 'cascadeDowngrade_', 'applyRolloverPlan_',
    'classNameForSemester_',
    // 依賴
    'fuseClassDisplayName_', 'deptShortName_', 'isValidClassName_', 'buildTutorHistoryEntry_',
    'tutorsDiffer_',
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

// ── computeRolloverPlan_（席位式：inherit/vacate/keep）───────────────────────

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

test('computeRolloverPlan_: 完整席位（四技一A~四技四A 各有不同導師）→ 二/三/四A 都是 inherit 且來源正確，一A 是 vacate；沒有任何一列改名或畢業（新模型沒有這兩個動作）', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
    mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const byId = {}; rows.forEach(function (r) { byId[r.classId] = r; });

  assert.equal(byId.c1.action, 'vacate');
  assert.equal(byId.c1.targetName, '四技二A');
  assert.equal(byId.c1.targetClassId, 'c2');
  assert.equal(byId.c1.graduating, false);
  assert.equal(byId.c1.uncertain, false);

  assert.equal(byId.c2.action, 'inherit');
  assert.equal(byId.c2.sourceClassId, 'c1');
  assert.deepEqual(byId.c2.sourceTutors, ['導師甲']);
  assert.equal(byId.c2.targetClassId, 'c3');
  assert.equal(byId.c2.uncertain, false);

  assert.equal(byId.c3.action, 'inherit');
  assert.equal(byId.c3.sourceClassId, 'c2');
  assert.deepEqual(byId.c3.sourceTutors, ['導師乙']);
  assert.equal(byId.c3.targetClassId, 'c4');

  assert.equal(byId.c4.action, 'inherit');
  assert.equal(byId.c4.sourceClassId, 'c3');
  assert.deepEqual(byId.c4.sourceTutors, ['導師丙']);
  // c4 沒有五A可去（GRADE_CHARS_ 排得出「四技五A」但系上沒有這個班）；duration 4 讓它落在
  // 畢業例外（graduating），所以 targetClassId 為 null 也不會被 gate 4／cascade 擋下。
  assert.equal(byId.c4.targetClassId, null);
  assert.equal(byId.c4.graduating, true);

  rows.forEach(function (r) { assert.ok(['inherit', 'vacate', 'keep'].indexOf(r.action) !== -1, '未知 action：' + r.action); });
});

test('computeRolloverPlan_: F1 迴歸——一B/二B/三B 但沒有四B（duration 4）→ 三列全部 keep+uncertain（cascade 連鎖降級），reason 能分辨「自己的目標不存在」與「目標不會接手」', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'b1', name: '四技一B', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'b2', name: '四技二B', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'b3', name: '四技三B', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const byId = {}; rows.forEach(function (r) { byId[r.classId] = r; });

  // 三B：gate 4 第一輪就擋下——它自己的目標「四技四B」根本不存在。
  assert.equal(byId.b3.action, 'keep');
  assert.equal(byId.b3.uncertain, true);
  assert.match(byId.b3.reason, /找不到學生要升上去的班「四技四B」/);

  // 二B：第一輪原本算出 inherit（目標三B「存在」），但 cascade 發現三B 其實不會接手 → 降級。
  assert.equal(byId.b2.action, 'keep');
  assert.equal(byId.b2.uncertain, true);
  assert.match(byId.b2.reason, /這次不會接手/);
  assert.equal(byId.b2.sourceClassId, null, '降級後不該再殘留一個「假裝會接手」的來源');

  // 一B：連鎖再往下傳一層——原本的 vacate 也要跟著降級，不然導師甲會憑空消失。
  assert.equal(byId.b1.action, 'keep');
  assert.equal(byId.b1.uncertain, true);
  assert.match(byId.b1.reason, /這次不會接手/);
});

test('computeRolloverPlan_: F1 迴歸——四層鏈條（一~四A 齊全，但四A 修業年限未知）→ 三A/二A/一A 連鎖全部 keep（證明有掃到不動點，不是只掃一輪）', () => {
  const s = S();
  // 全部用同一個（不在 DURATION_BY_PREFIX_ 表裡的）前綴「資管」，一~三A 用 day 制度
  // （durationYears:4，修業年限已知），四A 故意不掛制度、前綴又查不到表 → duration 未知。
  const classes = [
    mkCls({ id: 'c1', name: '資管一A', systemId: 'day', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '資管二A', systemId: 'day', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'c3', name: '資管三A', systemId: 'day', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
    mkCls({ id: 'c4', name: '資管四A', systemId: null, tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const byId = {}; rows.forEach(function (r) { byId[r.classId] = r; });

  assert.equal(byId.c4.duration, null);
  assert.equal(byId.c4.action, 'keep', '四A 自己的目標「資管五A」不存在，且 duration 未知不算畢業例外');
  // 這三班第一輪都會算出 inherit/vacate（各自的目標「存在」），要靠 cascade 反覆掃描
  // 三輪以上才會全部連鎖降級——只掃一輪的話二A/一A 還會誤判成會動。
  assert.equal(byId.c3.action, 'keep', 'cascade 沒掃到不動點就會漏掉這一列');
  assert.equal(byId.c2.action, 'keep', 'cascade 沒掃到不動點就會漏掉這一列');
  assert.equal(byId.c1.action, 'keep', 'cascade 沒掃到不動點就會漏掉這一列');
  [byId.c1, byId.c2, byId.c3].forEach(function (r) { assert.equal(r.uncertain, true); });
});

test('computeRolloverPlan_: 四技四A（duration 4，沒有四技五A，但整條來源鏈都正常交出導師）→ 照樣 inherit（畢業例外生效，不被去處守門擋下，也不被上游降級擋下）', () => {
  const s = S();
  // 二A／三A 都要有自己的來源（一A／二A）才會是 inherit（=會交出導師）——任何一環自己
  // 停在 keep，上游降級都會把四A 也連鎖擋下（見下一條「三A 找不到二A」的測試，那是
  // 三A 停在 keep、保留導師的情況）。這條要驗的是反過來：鏈條齊全時，畢業例外正常生效。
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
    mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1').filter(function (x) { return x.classId === 'c4'; })[0];
  assert.equal(r.action, 'inherit');
  assert.equal(r.sourceClassId, 'c3');
  // targetName 純粹是「算不算得出來」（GRADE_CHARS_ 1~7 範圍），與是否畢業無關——
  // 五年級字排得出來（四技五A），只是「畢業例外」讓 gate4 不要求這個班真的存在。
  assert.equal(r.targetName, '四技五A');
  assert.equal(r.graduating, true);
});

test('computeRolloverPlan_: F1 上游迴歸——三A 找不到二A（規則 6，保留導師）→ 四A 原本要 inherit 三A，也要降級成 keep，導師原封不動（正式資料骨架實跑抓到：同一位導師同時掛兩班）', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }), // 沒有二A，規則 6 → keep，丙留在三A
    mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const byId = {}; rows.forEach(function (r) { byId[r.classId] = r; });

  assert.equal(byId.c3.action, 'keep');
  assert.equal(byId.c3.uncertain, true);
  assert.match(byId.c3.reason, /找不到來源班/);
  assert.deepEqual(byId.c3.tutors, ['導師丙'], '三A 的導師原封不動（keep 本來就不動它）');

  // 四A 原本第一輪會算出 inherit（三A「存在」），但三A 其實不會交出導師（它自己 keep 住了）——
  // 若放任四A 照 inherit 執行，丙會同時出現在三A（沒被動）與四A（inherit 抄過去），變成
  // 同一位導師掛兩班。上游降級要把四A 也擋成 keep。
  assert.equal(byId.c4.action, 'keep');
  assert.equal(byId.c4.uncertain, true);
  assert.match(byId.c4.reason, /來源席位「四技三A」這次不會交出導師/);
  assert.equal(byId.c4.sourceClassId, null, '降級後不該再殘留一個「假裝會交出導師」的來源');
  // plain()：sourceTutors 是 cascadeDowngrade_（vm 抽出執行）內用陣列字面量重設的，
  // 跟這支測試檔不同 realm，deepEqual 直接比對空陣列會誤判失敗（見本檔其他 plain() 用法）。
  assert.deepEqual(plain(byId.c4.sourceTutors), []);
  assert.deepEqual(byId.c4.tutors, ['導師丁'], '四A 自己的導師原封不動——沒有被誰蓋掉，也沒有被誰複製走');
});

test('computeRolloverPlan_: F1 上下游交互——四層鏈中間斷掉（缺二A）→ 整條鏈收斂後全部 keep，沒有任何一列掉導師或重複掛導師', () => {
  const s = S();
  // 一A 自己的目標（二A）不存在 → 下游 gate 4 直接擋（keep，甲留在一A）。
  // 三A 自己的來源（二A）不存在 → 規則 6 直接擋（keep，丙留在三A）。
  // 四A 第一輪會算出 inherit 三A（存在），但三A 其實不會交出導師 → 上游降級（keep，丁留在四A）。
  // 三個方向（下游×2、上游×1）要在同一個不動點迴圈裡都收斂，才不會有列漏降。
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
    mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const byId = {}; rows.forEach(function (r) { byId[r.classId] = r; });

  assert.equal(byId.c1.action, 'keep');
  assert.deepEqual(byId.c1.tutors, ['導師甲']);
  assert.equal(byId.c3.action, 'keep');
  assert.deepEqual(byId.c3.tutors, ['導師丙']);
  assert.equal(byId.c4.action, 'keep');
  assert.deepEqual(byId.c4.tutors, ['導師丁']);
  // 沒有任何一列動——沒有掉導師（每班的原始導師都還在自己班上），也不可能重複（沒有
  // 任何一次複製發生）。
  rows.forEach(function (r) { assert.notEqual(r.action, 'inherit'); assert.notEqual(r.action, 'vacate'); });
});

test('computeRolloverPlan_: section 不齊——四技一B 有導師但系上沒有四技二B → keep+uncertain（防「導師悄悄消失」的迴歸測試）', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '四技一B' })];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'keep');
  assert.equal(r.uncertain, true);
  assert.match(r.reason, /四技二B/);
});

test('computeRolloverPlan_: duration 未知（未知 prefix、無制度）且找不到目標班 → keep+uncertain', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '資管三A', systemId: null })];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.duration, null);
  assert.equal(r.action, 'keep');
  assert.equal(r.uncertain, true);
});

test('computeRolloverPlan_: 家族班 keep 且 uncertain=false；導師姓名結尾恰為年級字（家族林大三）也不誤判為年級班', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '家族陳美惠' }),
    mkCls({ id: 'c2', name: '家族林大三' }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  rows.forEach(function (r) {
    assert.equal(r.action, 'keep');
    assert.equal(r.uncertain, false);
    assert.match(r.reason, /非年級班/);
  });
});

test('computeRolloverPlan_: 來源班存在但已停用 → 不算來源（keep+uncertain，不能讓停用班的導師悄悄復活接手）', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', active: false, tutors: [{ name: '舊導師', email: 'old@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }), // c2 的目標班，避免誤觸去處守門
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  assert.equal(rows.length, 2, '停用班本身不列入規劃');
  const r2 = rows.filter(function (r) { return r.classId === 'c2'; })[0];
  assert.equal(r2.action, 'keep');
  assert.equal(r2.uncertain, true);
  assert.match(r2.reason, /找不到來源班/);
});

test('computeRolloverPlan_: 來源班存在但目前沒有導師 → inherit 但標 uncertain（接手後本班也沒導師）', () => {
  const s = S();
  // c2 現在有導師（乙），一旦 inherit 就會被 c1 的（空）導師蓋掉——為了不讓 cascade 因為
  // 「乙沒人接手」而把 c2 也連鎖降級，補上 c4 讓 c3（c2 的目標）能正常 inherit（c4 是
  // 畢業例外，不需要自己的目標存在），這樣 c2→c3→c4 這條鏈才會完整不受干擾，乾淨地只驗
  // 「c2 從沒導師的 c1 接手」這一件事。
  // 這條也同時是「上游降級只在來源班有導師時才觸發」的守門測試：c1（c2 的來源）雖然
  // action 停在 keep（不會交出導師），但 c1 現在根本沒有導師可掉——cascade 的上游方向
  // 不該因此把 c2 也降級，接手一份空名單本來就不會造成重複。
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
    mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
  ];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1').filter(function (x) { return x.classId === 'c2'; })[0];
  assert.equal(r.action, 'inherit');
  assert.equal(r.sourceClassId, 'c1');
  assert.deepEqual(r.sourceTutors, []);
  assert.equal(r.uncertain, true);
  assert.match(r.reason, /沒有導師/);
});

test('computeRolloverPlan_: rolloverSemester === toId → keep + alreadyDone（冪等守門，不重複執行）', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '四技一A', rolloverSemester: '115-1' })];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1')[0];
  assert.equal(r.action, 'keep');
  assert.equal(r.alreadyDone, true);
  assert.match(r.reason, /115-1/);
});

test('computeRolloverPlan_: dy=2（跳過一學年執行）→ 來源是低兩個年級的席位', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
  ];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '116-2').filter(function (x) { return x.classId === 'c3'; })[0];
  assert.equal(r.sourceGrade, 1);
  assert.equal(r.sourceName, '四技一A');
  assert.equal(r.action, 'inherit');
  assert.equal(r.sourceClassId, 'c1');
});

test('computeRolloverPlan_: 停用與已刪除班級不納入規劃', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c_ok' }),
    mkCls({ id: 'c_inactive', active: false }),
    mkCls({ id: 'c_deleted', deleted: true }),
  ];
  const rows = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  assert.deepEqual(rows.map(function (r) { return r.classId; }), ['c_ok']);
});

// ── applyRolloverPlan_（全有全無）────────────────────────────────────────────

test('applyRolloverPlan_: 正常批次——導師正確搬移（含 ext/mobile 全欄位）、rolloverSemester 都寫上、history 只記實際變動、輸入 classes 不被就地修改', () => {
  const s = S();
  const classes = [
    // tutors 帶滿 ext（校內分機）/mobile（私人手機）——這是系辦助理逐筆填的名冊資料，
    // 接手時要原封不動搬過去，不能被 rollover 順手清掉。
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com', ext: '1234', mobile: '0912-345-678' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [] }),
  ];
  const before = JSON.parse(JSON.stringify(classes));
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'vacate' },
    { classId: 'c2', action: 'inherit' },
  ], opts);

  assert.equal(result.ok, true);
  const outById = {}; result.classes.forEach(function (c) { outById[c.id] = c; });
  // plain()：applyRolloverPlan_ 是從 dev/Code.gs 就地抽出、在隔離 vm context 執行的（見
  // harness.js），內部用陣列/物件字面量組出的 tutors 快照跟這支測試檔不同 realm，
  // deepEqual 直接比對會因為「結構相同但 realm 不同」誤判失敗——JSON 往返先正規化掉。
  assert.deepEqual(plain(outById.c1.tutors), []);
  assert.equal(outById.c1.rolloverSemester, '115-1');
  // 接手後四個欄位（name/email/ext/mobile）都要原封不動，不是只搬 name/email。
  assert.deepEqual(plain(outById.c2.tutors), [{ name: '導師甲', email: 'a@x.com', ext: '1234', mobile: '0912-345-678' }]);
  assert.equal(outById.c2.rolloverSemester, '115-1');
  assert.equal(result.applied.inherited, 1);
  assert.equal(result.applied.vacated, 1);
  assert.equal(result.applied.unchanged, 0);
  assert.equal(result.historyEntries.length, 2, '兩班的導師都真的變了，各記一筆');
  // 輸入不被就地修改
  assert.deepEqual(classes, before);
});

test('applyRolloverPlan_: 接手不可以吃掉分機/手機（助理填的名冊資料）——含舊鍵 phone 也要保留', () => {
  const s = S();
  const classes = [
    mkCls({
      id: 'c1', name: '四技一A',
      tutors: [
        { name: '導師甲', email: 'a@x.com', ext: '1234', mobile: '0912-345-678' },
        // 2026-08-11 之前的舊資料只有單一 phone 欄，還沒被 deptRosterUpsertClassAction_
        // 正規化過——搬移時不該替它「順手清洗」成 ext/mobile，原樣保留就好。
        { name: '導師乙', email: 'b@x.com', phone: '08-7703202' },
      ],
    }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [] }),
  ];
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'vacate' },
    { classId: 'c2', action: 'inherit' },
  ], opts);

  assert.equal(result.ok, true);
  const c2 = result.classes.filter(function (c) { return c.id === 'c2'; })[0];
  assert.deepEqual(plain(c2.tutors), [
    { name: '導師甲', email: 'a@x.com', ext: '1234', mobile: '0912-345-678' },
    { name: '導師乙', email: 'b@x.com', phone: '08-7703202' },
  ]);
});

test('applyRolloverPlan_: 全有全無——10 列中 1 列非法（action:advance 已不支援）→ ok:false，回傳 classes 與輸入逐位元相同（2026-08-11 事故的直接迴歸測試）', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [] }),
  ];
  for (let i = 3; i <= 10; i++) classes.push(mkCls({ id: 'c' + i, name: '家族班' + i + '號', tutors: [] }));
  const before = JSON.stringify(classes);
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const clientRows = [
    { classId: 'c1', action: 'advance' }, // 舊動作，新版不再支援，必須被擋下
    { classId: 'c2', action: 'inherit' }, // 這列本身合法
  ];
  for (let i = 3; i <= 10; i++) clientRows.push({ classId: 'c' + i, action: 'keep' });
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, clientRows, opts);

  assert.equal(result.ok, false);
  assert.equal(result.applied, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /invalid action: advance/);
  assert.equal(result.errors[0].classId, 'c1');
  assert.equal(JSON.stringify(result.classes), before, '合法的 c2 列也不准被寫入——整批放棄');
  assert.equal(JSON.stringify(classes), before, '輸入陣列本身也不能被動到');
});

test('applyRolloverPlan_: 套用順序無關——clientRows 反序送入，結果逐位元相同（證明導師從原始快照取，不會鏈式往上推）', () => {
  const s = S();
  function freshClasses() {
    return [
      mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
      mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
      mkCls({ id: 'c3', name: '四技三A', tutors: [{ name: '導師丙', email: 'c@x.com' }] }),
      mkCls({ id: 'c4', name: '四技四A', tutors: [{ name: '導師丁', email: 'd@x.com' }] }),
    ];
  }
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const classesA = freshClasses();
  const planA = s.computeRolloverPlan_(classesA, DEPTS, SYSTEMS, '114-2', '115-1');
  const forward = [
    { classId: 'c1', action: 'vacate' }, { classId: 'c2', action: 'inherit' },
    { classId: 'c3', action: 'inherit' }, { classId: 'c4', action: 'inherit' },
  ];
  const resultA = s.applyRolloverPlan_(classesA, planA, forward, opts);

  const classesB = freshClasses();
  const planB = s.computeRolloverPlan_(classesB, DEPTS, SYSTEMS, '114-2', '115-1');
  const reversed = forward.slice().reverse();
  const resultB = s.applyRolloverPlan_(classesB, planB, reversed, opts);

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(JSON.stringify(resultA.classes), JSON.stringify(resultB.classes));
  assert.equal(JSON.stringify(resultA.applied), JSON.stringify(resultB.applied));
  // 若導師是鏈式往上推（例如先套 c1→c2 就把 c2 的導師改成甲，再套 c2→c3 又把丙蓋成甲），
  // c4 最後會錯誤地變成導師乙／丙而不是丙——這裡直接斷言 c4 拿到的是原始 c3 的導師丙。
  const c4 = resultA.classes.filter(function (c) { return c.id === 'c4'; })[0];
  assert.deepEqual(plain(c4.tutors), [{ name: '導師丙', email: 'c@x.com' }]);
});

test('applyRolloverPlan_: alreadyDone 的班被指定 inherit → 整批中止', () => {
  const s = S();
  // c1 刻意不給導師：c2 已經 alreadyDone（plan.action 恆為 keep），若 c1 有導師，
  // F1 的 cascade 會發現 c1 的目標 c2「這次不會接手」而把 c1 也連鎖降級成 keep——
  // 那樣 c1 送 vacate 會先撞上新的「action 不符 plan」錯誤，蓋掉這裡真正要驗的
  // alreadyDone 錯誤。c1 沒有導師就不會被 cascade 摸到，維持這條測試只驗一件事。
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [], rolloverSemester: '115-1' }),
  ];
  const before = JSON.stringify(classes);
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'keep' },
    { classId: 'c2', action: 'inherit' },
  ], opts);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, 'c1 應該乾淨通過，只有 c2 這一列出錯');
  assert.match(result.errors[0].error, /already rolled over/);
  assert.equal(JSON.stringify(classes), before);
});

// ── F2：每一列只准降級成 keep，不准升級成別的動作 ─────────────────────────────
// 根因：舊版完全沒比對 client 傳來的 action 與鎖內重算後的 plan.action——admin 憑證直打
// API 就能在 fromSemester===toSemester（dy=0，兩個都是合法學期，requireValidSemester_ 只驗
// 存在）時，把每一列都送 vacate：dy=0 時 plan 全部是 keep 且 alreadyDone 恆為 false（規則 0
// 排在規則 1 前面），舊版的逐列驗證完全不會擋下這種「升級」，一次呼叫就能清空全校導師，
// 而且可以重複執行。

test('applyRolloverPlan_: F2——plan 判 keep 的列被送 vacate → 整批 abort（不准把 keep 升級成別的動作）', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '家族陳美惠' })]; // 家族班規則 2 一律 keep
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  assert.equal(plan[0].action, 'keep');
  const before = JSON.stringify(classes);
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [{ classId: 'c1', action: 'vacate' }], opts);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /action does not match plan \(keep\)/);
  assert.equal(JSON.stringify(classes), before);
});

test('applyRolloverPlan_: F2——plan 判 inherit 的列被送 keep → 允許（降級不算違規）', () => {
  const s = S();
  // c2 目前沒有導師，plan.action 穩定是 inherit（來源 c1 用 vacate 交出導師，不受上/下游
  // cascade 影響）；只送 c2 這一列（不連 c1 一起送），單獨把它降級成 keep 不該牽動任何
  // 其他列，也不會誤觸 R1/R2（那兩條只檢查「本批真的送進來」的列），乾淨驗證「降級合法」。
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [] }),
  ];
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const planC2 = plan.filter(function (p) { return p.classId === 'c2'; })[0];
  assert.equal(planC2.action, 'inherit');
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [{ classId: 'c2', action: 'keep' }], opts);
  assert.equal(result.ok, true);
  assert.equal(result.applied.kept, 1);
  assert.equal(result.applied.inherited, 0);
});

test('applyRolloverPlan_: F2——fromSemester===toSemester（dy=0）全列送 vacate → 整批 abort、classes 逐位元不變（2026-08-11 之後才踩到的新洞：憑證直打就能清空全校導師）', () => {
  const s = S();
  const classes = [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [{ name: '導師乙', email: 'b@x.com' }] }),
  ];
  const before = JSON.stringify(classes);
  // fromSemester === toSemester：dy=0，規則 0 排在規則 1（alreadyDone）前面，所以
  // 全部班都是普通的 keep（不是 alreadyDone），舊版的漏洞就是這裡完全不擋。
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '114-2');
  assert.ok(plan.every(function (p) { return p.action === 'keep' && p.alreadyDone === false; }));
  const opts = { fromSemester: '114-2', toSemester: '114-2', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'vacate' },
    { classId: 'c2', action: 'vacate' },
  ], opts);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  result.errors.forEach(function (e) { assert.match(e.error, /action does not match plan \(keep\)/); });
  assert.equal(JSON.stringify(result.classes), before);
  assert.equal(JSON.stringify(classes), before);
});

// ── F3：逐列合法 ≠ 整批自洽——vacate 與 inherit 是成對的，backstop 檢查 R1/R2 ──────
// F1 讓「預設 plan 全套用」自己不會產生會掉導師的組合，但 admin 仍可以在 UI 上把某一列
// 人工降級成 keep（F2 允許降級），或者 API 只送 plan 的一個子集——這兩種情況都可能把本來
// 成對的 vacate/inherit 拆開。R1/R2 是全部逐列驗證通過之後、真正套用之前的最後一關，
// 兩條都不該在「預設 plan 全套用、沒有任何人工降級」時觸發（那是 F1 該擋的），只在人工
// 介入把批次拆散時才會踩到。

function fullChainClasses() {
  return [
    mkCls({ id: 'c1', name: '四技一A', tutors: [{ name: '導師甲', email: 'a@x.com' }] }),
    mkCls({ id: 'c2', name: '四技二A', tutors: [] }), // 目前沒導師，接手後才有——方便單獨驗 R1/R2
  ];
}

test('applyRolloverPlan_: F3 R1——把接手那一列降級成 keep，來源列仍送 vacate → 整批 abort（沒有任何一列真的接手，導師會消失）', () => {
  const s = S();
  const classes = fullChainClasses();
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const before = JSON.stringify(classes);
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'vacate' }, // 合法：符合 plan
    { classId: 'c2', action: 'keep' },   // 人工降級：plan 原本是 inherit，降成 keep 合法（F2）
  ], opts);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /tutors would be dropped: c1/);
  assert.equal(JSON.stringify(classes), before);
});

test('applyRolloverPlan_: F3 R2——來源班那一列被降級成 keep，目標列仍送 inherit → 整批 abort（同一位導師會同時掛兩個班）', () => {
  const s = S();
  const classes = fullChainClasses();
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const before = JSON.stringify(classes);
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [
    { classId: 'c1', action: 'keep' },    // 人工降級：plan 原本是 vacate，降成 keep 合法（F2）
    { classId: 'c2', action: 'inherit' }, // 合法：符合 plan——但來源班 c1 現在留著沒動
  ], opts);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /source class kept while inheriting from it: c1/);
  assert.equal(JSON.stringify(classes), before);
});

test('applyRolloverPlan_: F3——只送 plan 的一個子集（單獨一列 vacate，接手的那列完全沒送）→ 整批 abort', () => {
  const s = S();
  const classes = fullChainClasses();
  const plan = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-1');
  const before = JSON.stringify(classes);
  const opts = { fromSemester: '114-2', toSemester: '115-1', by: 'admin@test.local', now: '2026-08-12T00:00:00.000Z' };
  const result = s.applyRolloverPlan_(classes, plan, [{ classId: 'c1', action: 'vacate' }], opts);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /tutors would be dropped: c1/);
  assert.equal(JSON.stringify(classes), before);
});

// ── F4：冪等守門比對學年，不是完整學期 id ─────────────────────────────────────
// 根因：舊版只認 c.rolloverSemester === toId 一模一樣。114-2→115-1 做完之後標記 '115-1'，
// 若又執行 114-2→115-2（toId 不同，dy 一樣是 1），舊版完全認不出「這個學年已經做過」，
// 會整批再往上推一格——而且預覽看起來完全正常（一堆 inherit），是很自然的誤操作。

test('computeRolloverPlan_: F4——rolloverSemester:"115-1" 的班在 114-2→115-2 也要判 alreadyDone（同一學年不能被推第二次）', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '四技一A', rolloverSemester: '115-1' })];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '114-2', '115-2')[0];
  assert.equal(r.action, 'keep');
  assert.equal(r.alreadyDone, true);
  assert.match(r.reason, /115-1/);
});

test('computeRolloverPlan_: F4——rolloverSemester:"115-1" 的班在 115-2→116-1 不是 alreadyDone（下一個學年正常放行）', () => {
  const s = S();
  const classes = [mkCls({ id: 'c1', name: '四技一A', rolloverSemester: '115-1', tutors: [] })];
  const r = s.computeRolloverPlan_(classes, DEPTS, SYSTEMS, '115-2', '116-1')[0];
  assert.equal(r.alreadyDone, false);
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
