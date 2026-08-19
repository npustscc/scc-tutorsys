// 入學學年度模型（2026-08-19 使用者決策：方案 B）。
//
// 舊模型把「年級」存了兩份（id 裡一份、班名裡一份），每年靠升級把班名往上推——那是這個專案
// 最貴的災情來源。新模型只存**入學學年度**，年級與班名每次算。這裡測三件事：
//   ① 算得對（含 8/1 學年度邊界）
//   ② **沒有 entryYear 的班一律回存起來的名字**——家族班、海青班、還沒遷移的資料都靠這條，
//      所以這段程式可以在資料遷移之前先上線而不改變任何行為
//   ③ 畢業是算出來的（獸醫系四技五年要靠班級層級的 graduationGrade 覆寫）

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function S() {
  return load([
    'academicYearOf_', 'cohortGrade_', 'deriveClassName_', 'deriveClassDisplayName_',
    'cohortGraduated_', 'withDerivedNames_', 'resolveDuration_',
  ], {
    GRADE_CHARS_: ['一', '二', '三', '四', '五', '六', '七'],
    DURATION_BY_PREFIX_: { '四技': 4, '四技進': 4, '技優': 4, '產專': 4, '產訓': 4, '碩': 2, '碩專': 2, '博': 4 },
    AY_ROLL_MONTH_: 8,
    DERIVED_GRADE_TOKEN_: '{G}',
    Date: Date,
  });
}
const graded = (over) => Object.assign({
  id: '獸醫系_四技111A', deptId: '獸醫系', entryYear: 111, prefix: '四技', section: 'A',
  name: '四技五A', displayName: '四獸醫五A', displayTemplate: '四獸醫{G}A', systemId: 'day_college',
}, over || {});

// ── 學年度邊界（8/1 換）────────────────────────────────────────────────────────
test('學年度 8/1 換：7 月底還是上一個學年度', () => {
  const s = S();
  assert.equal(s.academicYearOf_(new Date('2026-08-01T00:00:00+08:00')), 115);
  assert.equal(s.academicYearOf_(new Date('2026-07-31T23:00:00+08:00')), 114);
  assert.equal(s.academicYearOf_(new Date('2027-03-01T00:00:00+08:00')), 115);
  assert.equal(s.academicYearOf_(new Date('2027-08-01T00:00:00+08:00')), 116);
});

// ── 年級與班名是算出來的 ───────────────────────────────────────────────────────
test('115 學年度：111 入學＝五年級，班名與顯示名都算出來', () => {
  const s = S();
  const c = graded();
  assert.equal(s.cohortGrade_(c, 115), 5);
  assert.equal(s.deriveClassName_(c, 115), '四技五A');
  assert.equal(s.deriveClassDisplayName_(c, 115), '四獸醫五A');
});

test('明年（116）同一筆自動變六年級——不需要任何升級動作', () => {
  const s = S();
  const c = graded();
  assert.equal(s.deriveClassName_(c, 116), '四技六A');
  assert.equal(s.deriveClassDisplayName_(c, 116), '四獸醫六A');
  assert.equal(c.name, '四技五A', '原物件不該被改動（投影是副本）');
});

test('沒有班別的班（碩一）也對', () => {
  const s = S();
  const c = graded({ prefix: '碩', section: '', entryYear: 115, name: '碩一', displayName: '碩獸醫一A', displayTemplate: '碩獸醫{G}A' });
  assert.equal(s.deriveClassName_(c, 115), '碩一');
  assert.equal(s.deriveClassName_(c, 116), '碩二');
});

// ── 相容性：這一條讓「先上線、後遷移」是安全的 ────────────────────────────────
test('🔒 沒有 entryYear（家族班／海青班／未遷移）→ 一律回存起來的名字，行為零改變', () => {
  const s = S();
  for (const c of [
    { name: '家族陳美惠', displayName: '森林陳美惠家族' },
    { name: '115海青班', displayName: '農園115海青班' },
    { name: '四技一A', displayName: '四農園一A' },              // 還沒遷移的年級班
    { name: '四技一A', displayName: '四農園一A', entryYear: 0 },
  ]) {
    assert.equal(s.deriveClassName_(c, 115), c.name);
    assert.equal(s.deriveClassDisplayName_(c, 115), c.displayName);
    assert.equal(s.withDerivedNames_(c, 115, null), c, '未遷移的資料應該原物件回傳，不做任何加工');
  }
});

test('超出一~七（畢業很久）→ 退回存起來的名字，不生出「四技八A」', () => {
  const s = S();
  const c = graded({ entryYear: 105 });     // 115 − 105 + 1 = 11 年級
  assert.equal(s.deriveClassName_(c, 115), '四技五A');
  assert.equal(s.deriveClassDisplayName_(c, 115), '四獸醫五A');
});

// ── 畢業是算出來的 ───────────────────────────────────────────────────────────
test('四技預設 4 年：112 入學在 115 是四年級（還沒畢業），116 就畢業了', () => {
  const s = S();
  const c = graded({ entryYear: 112, prefix: '四技', name: '四技四A' });
  assert.equal(s.cohortGraduated_(c, null, 115), false);
  assert.equal(s.cohortGraduated_(c, null, 116), true);
});

test('獸醫系四技五年：靠班級層級的 graduationGrade=5 覆寫，第五年還沒畢業', () => {
  const s = S();
  const vet = graded({ entryYear: 111, graduationGrade: 5 });
  assert.equal(s.cohortGraduated_(vet, null, 115), false, '五年級不該被當成畢業');
  assert.equal(s.cohortGraduated_(vet, null, 116), true);
  // 沒有覆寫的話會被四技的預設 4 年判成畢業——這就是為什麼遷移一定要順手填獸醫系
  assert.equal(s.cohortGraduated_(graded({ entryYear: 111 }), null, 115), true);
});

test('學制的 durationYears 優先於 prefix 預設，班級覆寫又優先於學制', () => {
  const s = S();
  const c = graded({ entryYear: 113, prefix: '碩' });        // 碩預設 2 年 → 115 是三年級＝已畢業
  assert.equal(s.cohortGraduated_(c, null, 115), true);
  assert.equal(s.cohortGraduated_(c, { durationYears: 3 }, 115), false, '學制說 3 年就不算畢業');
  assert.equal(s.cohortGraduated_(Object.assign({}, c, { graduationGrade: 4 }), { durationYears: 3 }, 115), false);
});

test('withDerivedNames_ 一次給出算好的 name／displayName／grade／graduated', () => {
  const s = S();
  const out = s.withDerivedNames_(graded({ graduationGrade: 5 }), 115, null);
  assert.equal(out.name, '四技五A');
  assert.equal(out.displayName, '四獸醫五A');
  assert.equal(out.grade, 5);
  assert.equal(out.graduated, false);
});
