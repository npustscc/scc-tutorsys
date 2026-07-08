// fuseClassDisplayName_（displayName 自動融合建議值）、resolveRequiredMeetingCount_
// （應繳份數解析：override/制度預設/免繳0/保底預設）、overviewStats_（統計總表彙總純函式）。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'deptShortName_', 'fuseClassDisplayName_',
    'resolveRequiredMeetingCount_',
    'overviewStats_',
  ], { DEFAULT_REQUIRED_MEETING_COUNT_: 4 });
}

test('deptShortName_: 去尾字「系」；單一「系」字或不以系結尾則原樣保留', () => {
  const S = makeSandbox();
  assert.equal(S.deptShortName_('資訊管理系'), '資訊管理');
  assert.equal(S.deptShortName_('企業管理系'), '企業管理');
  assert.equal(S.deptShortName_('系'), '系', '單字「系」不去尾（避免變空字串）');
  assert.equal(S.deptShortName_('護理學系'), '護理學');
  assert.equal(S.deptShortName_(''), '');
});

test('fuseClassDisplayName_: 四技一A → 四+系簡+一A', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('四技一A', '資訊管理系', null), '四資訊管理一A');
});

test('fuseClassDisplayName_: 四技進一A → 進四+系簡+一A（優先於「四技」規則）', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('四技進一A', '資訊管理系', null), '進四資訊管理一A');
});

test('fuseClassDisplayName_: 碩一 → 碩+系簡+一；碩專一B → 碩專+系簡+一B（優先於「碩」規則）', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('碩一', '資訊管理系', null), '碩資訊管理一');
  assert.equal(S.fuseClassDisplayName_('碩專一B', '資訊管理系', null), '碩專資訊管理一B');
});

test('fuseClassDisplayName_: 博一 → 博+系簡+一', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('博一', '資訊管理系', null), '博資訊管理一');
});

test('fuseClassDisplayName_: 家族 → 系簡+家族(導師名)；未帶導師名則不含括號', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('家族', '資訊管理系', null, '王小明'), '資訊管理家族(王小明)');
  assert.equal(S.fuseClassDisplayName_('家族', '資訊管理系', null), '資訊管理家族');
});

test('fuseClassDisplayName_: 技優/產訓/產專/海青等已知前綴 → 前綴保留、系簡插入其後', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('技優一A', '資訊管理系', null), '技優資訊管理一A');
  assert.equal(S.fuseClassDisplayName_('產訓一B', '護理學系', null), '產訓護理學一B');
  assert.equal(S.fuseClassDisplayName_('海青一', '資訊管理系', null), '海青資訊管理一');
});

test('fuseClassDisplayName_: 完全無法判別 → 直接「系簡+原名」', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('特殊班XYZ', '資訊管理系', null), '資訊管理特殊班XYZ');
});

test('fuseClassDisplayName_: 空 className → 只回系簡', () => {
  const S = makeSandbox();
  assert.equal(S.fuseClassDisplayName_('', '資訊管理系', null), '資訊管理');
  assert.equal(S.fuseClassDisplayName_('  ', '資訊管理系', null), '資訊管理');
});

// ── resolveRequiredMeetingCount_ ─────────────────────────────────────────────

const SYSTEMS = [
  { id: 'day_college', name: '大學日間部', requiredMeetingCount: 4, disabled: false },
  { id: 'family', name: '家族', requiredMeetingCount: 2, disabled: false },
  { id: 'old_sys', name: '舊制度', requiredMeetingCount: 6, disabled: true },
];

test('resolveRequiredMeetingCount_: requiredMeetingOverride 為數字（含 0）→ 優先套用', () => {
  const S = makeSandbox();
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'day_college', requiredMeetingOverride: 0 }, SYSTEMS), 0, '0＝本學期免繳');
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'day_college', requiredMeetingOverride: 2 }, SYSTEMS), 2);
});

test('resolveRequiredMeetingCount_: override 為 null/undefined → 查 tutorSystem 的 requiredMeetingCount', () => {
  const S = makeSandbox();
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'day_college', requiredMeetingOverride: null }, SYSTEMS), 4);
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'family' }, SYSTEMS), 2);
});

test('resolveRequiredMeetingCount_: 制度已停用 → 視同查無制度，用保底預設', () => {
  const S = makeSandbox();
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'old_sys' }, SYSTEMS), 4);
});

test('resolveRequiredMeetingCount_: systemId 對不到任何制度 / classInfo 為 null → 保底預設', () => {
  const S = makeSandbox();
  assert.equal(S.resolveRequiredMeetingCount_({ systemId: 'ghost' }, SYSTEMS), 4);
  assert.equal(S.resolveRequiredMeetingCount_(null, SYSTEMS), 4);
});

// ── overviewStats_ ───────────────────────────────────────────────────────────

test('overviewStats_: 依 學院→系所→班級 分組，回傳彙總數字與宣導日期，不含紀錄內文', () => {
  const S = makeSandbox();
  const colleges = [{ id: 'col1', name: '管理學院' }];
  const departments = [{ id: 'd1', name: '資訊管理系', collegeId: 'col1' }];
  const classes = [
    { id: 'c1', deptId: 'd1', name: '四技一A', displayName: '四資管一A', tutors: [{ name: '王導師' }], active: true, requiredMeetingOverride: null },
    { id: 'c2', deptId: 'd1', name: '停用班', active: false }, // 已停用，排除
  ];
  const tutorSystems = [{ id: 'sys1', name: '大學日間部', requiredMeetingCount: 4, disabled: false }];
  const records = [
    { classId: 'c1', type: 'meeting', status: 'approved', form: { date: '2026-03-01' }, topics: { traffic: { checked: true }, gender: { checked: false }, smoking: { checked: false }, fraud: { checked: false } } },
    { classId: 'c1', type: 'meeting', status: 'pending_dept', form: { date: '2026-04-01' }, topics: { traffic: { checked: false }, gender: { checked: false }, smoking: { checked: false }, fraud: { checked: false } } },
    { classId: 'c1', type: 'activity', status: 'approved', form: { date: '2026-05-01' } },
    { classId: 'c2', type: 'meeting', status: 'approved', form: { date: '2026-06-01' } }, // 他班（已停用班級亦不會出現在 rows）
  ];

  const rows = S.overviewStats_(colleges, departments, classes, tutorSystems, records, null);
  assert.equal(rows.length, 1, '停用班級不出現在總表');
  const row = rows[0];
  assert.equal(row.college, '管理學院');
  assert.equal(row.dept, '資訊管理系');
  assert.equal(row.displayName, '四資管一A');
  assert.deepEqual(row.tutors, ['王導師']);
  assert.equal(row.required, 4);
  assert.equal(row.submittedCount, 2);
  assert.equal(row.approvedCount, 1);
  assert.equal(row.pendingCount, 1);
  assert.deepEqual(row.topics.traffic, { checked: true, dates: ['2026-03-01'] });
  assert.deepEqual(row.topics.gender, { checked: false, dates: [] });
  assert.deepEqual(row.activity, { submitted: true, date: '2026-05-01', approved: true });
});

test('overviewStats_: 沒有任何紀錄的班級 → 全 0，activity.submitted=false；沒有 college 的系所 college=null', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系' }]; // 無 collegeId
  const classes = [{ id: 'c1', deptId: 'd1', name: 'A', displayName: 'A', tutors: [], active: true }];
  const rows = S.overviewStats_([], departments, classes, [], [], null);
  assert.equal(rows[0].college, null);
  assert.equal(rows[0].submittedCount, 0);
  assert.equal(rows[0].activity.submitted, false);
  assert.equal(rows[0].activity.date, null);
});
