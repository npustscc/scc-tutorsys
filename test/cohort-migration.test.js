// 班級 id 改用入學學年度的**一次性遷移**（planCohortMigration_，純函式）。
//
// 這是對正式資料的一次不可逆改寫，所以測的重點全在「不該動的東西一個都沒動」：
//   ① 家族班／海青班／共同指導：**一個欄位都不動**
//   ② 顯示名的年級字換成樣板之後，換回去必須等於原值；換不回去就不套樣板（寧可顯示舊值，
//      也不要顯示一個算錯的名字）——顯示名有人工調過的系所簡稱覆寫
//   ③ 新 id 撞名＝現在就有重複的班，必須中止而不是把兩筆併成一筆
//   ④ 獸醫系四技要補 graduationGrade=5，否則第五年會被四技的預設 4 年判成已畢業

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function S() {
  return load(['planCohortMigration_', 'parseClassGrade_'], {
    GRADE_CHARS_: ['一', '二', '三', '四', '五', '六', '七'],
  });
}
const YEAR = 115;

test('年級制：id 換成入學學年度，並存下 entryYear／prefix／section／樣板', () => {
  const s = S();
  const { classes, report } = s.planCohortMigration_([
    { id: '農園系_四技二A', name: '四技二A', displayName: '四農園二A', deptId: '農園系' },
  ], YEAR);
  const c = classes[0];
  assert.equal(c.id, '農園系_四技114A');
  assert.equal(c.entryYear, 114);
  assert.equal(c.prefix, '四技');
  assert.equal(c.section, 'A');
  assert.equal(c.displayTemplate, '四農園{G}A');
  assert.equal(c.previousId, '農園系_四技二A', '要留得下「以前叫什麼」');
  assert.equal(c.name, '四技二A', '存的 name 先不動（顯示層會算）');
  assert.equal(report.migrated, 1);
});

test('沒有班別的（碩一）與多字前綴的（四技進三）都對', () => {
  const s = S();
  const { classes } = s.planCohortMigration_([
    { id: '獸醫系_碩一', name: '碩一', displayName: '碩獸醫一A', deptId: '獸醫系' },
    { id: '生機系_四技進三', name: '四技進三', displayName: '四進生機三', deptId: '生機系' },
  ], YEAR);
  assert.equal(classes[0].id, '獸醫系_碩115');
  assert.equal(classes[0].section, '');
  assert.equal(classes[1].id, '生機系_四技進113');
  assert.equal(classes[1].prefix, '四技進', '「四技進」不可以被「四技」搶走');
});

test('🔒 非年級制（家族班／海青班／共同指導）一個欄位都不動', () => {
  const s = S();
  const input = [
    { id: '森林系_家族陳美惠', name: '家族陳美惠', displayName: '森林陳美惠家族', deptId: '森林系' },
    { id: '農園系_115海青班', name: '115海青班', displayName: '農園115海青班', deptId: '農園系' },
    { id: '木設系_三A四A共同指導', name: '三A四A共同指導', displayName: '木設共同指導', deptId: '木設系' },
  ];
  const before = JSON.stringify(input);
  const { classes, report } = s.planCohortMigration_(input, YEAR);
  assert.equal(JSON.stringify(classes), before, '這三筆必須原封不動');
  assert.equal(report.migrated, 0);
  assert.equal(report.skipped, 3);
});

test('🔒 軟刪除的班也不動（墓碑不該被改 id）', () => {
  const s = S();
  const input = [{ id: '獸醫系_四技五A', name: '四技五A', displayName: '四獸醫五A', deptId: '獸醫系', deleted: true }];
  assert.equal(JSON.stringify(s.planCohortMigration_(input, YEAR).classes), JSON.stringify(input));
});

test('🔒 顯示名的樣板換不回原值 → 不套樣板，並列進報告', () => {
  const s = S();
  // 顯示名裡沒有年級字（人工改過），套樣板會顯示出錯的名字
  const { classes, report } = s.planCohortMigration_([
    { id: 'X系_四技二A', name: '四技二A', displayName: 'X系日間部A班', deptId: 'X系' },
  ], YEAR);
  assert.equal(classes[0].displayTemplate, undefined, '換不回去就不要套');
  assert.equal(report.noTemplate.length, 1);
});

test('顯示名裡年級字出現兩次 → 取最後一個，且要能換回原值', () => {
  const s = S();
  const { classes } = s.planCohortMigration_([
    { id: 'A系_四技一A', name: '四技一A', displayName: '一同學園一A', deptId: 'A系' },
  ], YEAR);
  assert.equal(classes[0].displayTemplate, '一同學園{G}A');
  assert.equal(classes[0].displayTemplate.split('{G}').join('一'), '一同學園一A');
});

test('🔒 新 id 撞名 → 列進報告（呼叫端據此中止，不可以把兩筆併成一筆）', () => {
  const s = S();
  const { report } = s.planCohortMigration_([
    { id: '獸醫系_四技四A', name: '四技五A', displayName: '四獸醫五A', deptId: '獸醫系' },
    { id: '獸醫系_四技五A', name: '四技五A', displayName: '四獸醫五A', deptId: '獸醫系' },
  ], YEAR);
  assert.equal(report.collisions.length, 1);
  assert.deepEqual(report.collisions[0].from.sort(), ['獸醫系_四技五A', '獸醫系_四技四A'].sort());
});

test('獸醫系四技補 graduationGrade=5；已經有值的不覆蓋；別系不補', () => {
  const s = S();
  const { classes, report } = s.planCohortMigration_([
    { id: '獸醫系_四技四A', name: '四技五A', displayName: '四獸醫五A', deptId: '獸醫系' },
    { id: '獸醫系_四技三B', name: '四技四B', displayName: '四獸醫四B', deptId: '獸醫系', graduationGrade: 6 },
    { id: '獸醫系_碩一', name: '碩一', displayName: '碩獸醫一A', deptId: '獸醫系' },
    { id: '農園系_四技一A', name: '四技一A', displayName: '四農園一A', deptId: '農園系' },
  ], YEAR);
  assert.equal(classes[0].graduationGrade, 5);
  assert.equal(classes[1].graduationGrade, 6, '已經有值不該被覆蓋');
  assert.equal(classes[2].graduationGrade, undefined, '碩士不是五年制');
  assert.equal(classes[3].graduationGrade, undefined, '別系不補');
  assert.equal(report.vetFixed, 1);
});

test('遷移是幂等的：同一份資料跑第二次，id 與欄位都不再變動', () => {
  const s = S();
  const once = s.planCohortMigration_([
    { id: '農園系_四技二A', name: '四技二A', displayName: '四農園二A', deptId: '農園系' },
  ], YEAR).classes;
  const twice = s.planCohortMigration_(once, YEAR).classes;
  assert.equal(twice[0].id, once[0].id);
  assert.equal(twice[0].entryYear, once[0].entryYear);
  assert.equal(twice[0].displayTemplate, once[0].displayTemplate);
});

test('🔒 已經遷移過的班一律跳過——明年再跑一次不可以用過期的 name 反推', () => {
  const s = S();
  // 這筆是 114 屆（entryYear=114），但存起來的 name 還是遷移當時的「四技二A」。
  // 到了 116 學年再跑一次，若照 name 反推會算成 115 屆——差一屆，而且畫面上看不出來。
  const migrated = {
    id: '農園系_四技114A', name: '四技二A', displayName: '四農園二A', deptId: '農園系',
    entryYear: 114, prefix: '四技', section: 'A', displayTemplate: '四農園{G}A',
  };
  const { classes, report } = s.planCohortMigration_([migrated], 116);
  assert.equal(classes[0].entryYear, 114, '入學學年度被改掉了');
  assert.equal(classes[0].id, '農園系_四技114A', 'id 被改掉了');
  assert.equal(report.alreadyMigrated, 1);
  assert.equal(report.migrated, 0);
});

// ── 換鍵時「以 classId 為鍵的其他資料」要一起改 ──────────────────────────────
// 正式資料的 tutorHistory.json 有 339 筆導師異動歷程全靠 classId 找班。只改 classes.json 的話，
// 遷移後每個年級制班級的歷程都查不到，而畫面只會顯示「沒有紀錄」、沒有任何地方會報錯。
// 跟上面同一組依賴（planCohortMigration_ 需要 parseClassGrade_ 與 GRADE_CHARS_）
const R = load(['remapClassIdRefs_', 'planCohortMigration_', 'parseClassGrade_'], {
  GRADE_CHARS_: ['一', '二', '三', '四', '五', '六', '七'],
});

test('歷程的 classId 跟著改過去，其他欄位一個都不動', () => {
  const rows = [
    { classId: '農園系_四技一A', classNameAtTime: '四技一A', changeType: 'replace', at: '2026-08-01', tutors: [{ name: '甲' }] },
    { classId: '森林系_家族陳美惠', classNameAtTime: '家族陳美惠' },
  ];
  const res = R.remapClassIdRefs_(rows, { '農園系_四技一A': '農園系_四技115A' });
  assert.equal(res.changed, 1);
  assert.equal(res.rows[0].classId, '農園系_四技115A');
  assert.equal(res.rows[0].classNameAtTime, '四技一A', '「當時的名字」是歷史事實，不該被改');
  assert.equal(res.rows[0].changeType, 'replace');
  assert.deepEqual(res.rows[0].tutors, [{ name: '甲' }]);
  assert.equal(res.rows[1].classId, '森林系_家族陳美惠', '不在對照表裡的一個字都不動');
});

test('沒有 classId 或對照表為空時原樣回傳，不算改動', () => {
  const rows = [{ note: '沒有 classId' }, { classId: 'X' }];
  assert.equal(R.remapClassIdRefs_(rows, {}).changed, 0);
  assert.equal(R.remapClassIdRefs_(rows, null).changed, 0);
  assert.equal(R.remapClassIdRefs_(null, { X: 'Y' }).rows.length, 0);
});

test('🔒 遷移計畫要吐出可用的 old→new 對照表（不只是給人看的字串）', () => {
  const classes = [
    { id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college', displayName: '四農園一A' },
    { id: '森林系_家族陳美惠', name: '家族陳美惠', deptId: '森林系' },
  ];
  const plan = R.planCohortMigration_(classes, 115);
  assert.equal(plan.report.idMap['農園系_四技一A'], '農園系_四技115A');
  assert.ok(!('森林系_家族陳美惠' in plan.report.idMap), '非年級制不該進對照表');
  // 對照表與人看的清單要對得上，不然報告會說謊
  assert.equal(Object.keys(plan.report.idMap).length, plan.report.idChanges.length);
});

test('對照表接得上歷程：計畫算出來的 map 直接餵進去就能改對', () => {
  const classes = [{ id: '農園系_四技二A', name: '四技二A', deptId: '農園系', systemId: 'day_college', displayName: '四農園二A' }];
  const plan = R.planCohortMigration_(classes, 115);
  const res = R.remapClassIdRefs_([{ classId: '農園系_四技二A' }], plan.report.idMap);
  assert.equal(res.rows[0].classId, '農園系_四技114A');
});
