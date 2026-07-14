// Excel 匯入 v2 純函式測試：resolveOrCreateCollege_/Dept_/System_（名稱比對 find-or-create，
// 停用一律 fail-closed 拒絕）、parseRequiredMeetingCountField_、importRosterRow_（整合）。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'findByNameExact_', 'resolveOrCreateCollege_', 'resolveOrCreateDept_', 'resolveOrCreateSystem_',
    'parseRequiredMeetingCountField_', 'buildImportTutors_', 'importRosterRow_',
    'isValidClassName_', 'isValidDeptName_', 'slugifyDeptId_', 'uniqueDeptId_', 'uniqueClassId_',
    'deptShortName_', 'fuseClassDisplayName_', 'tutorsDiffer_',  // importRosterRow_ 判斷導師異動（Ticket C）
  ]);
}

const NOW = '2026-07-08T00:00:00.000Z';

// ── resolveOrCreateCollege_ ──────────────────────────────────────────────────

test('resolveOrCreateCollege_: 空名稱 → college:null（列可不填學院）', () => {
  const S = makeSandbox();
  const r = S.resolveOrCreateCollege_('', []);
  assert.equal(r.ok, true);
  assert.equal(r.college, null);
});

test('resolveOrCreateCollege_: 名稱命中既有 → 不建新的；命中已停用 → fail-closed 拒絕', () => {
  const S = makeSandbox();
  const colleges = [{ id: 'col1', name: '管理學院', disabled: false }, { id: 'col2', name: '停用學院', disabled: true }];
  const hit = S.resolveOrCreateCollege_('管理學院', colleges);
  assert.equal(hit.ok, true);
  assert.equal(hit.college.id, 'col1');
  assert.equal(hit.colleges.length, 2, '命中既有不新增');

  const disabled = S.resolveOrCreateCollege_('停用學院', colleges);
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /disabled/);
});

test('resolveOrCreateCollege_: 全新名稱 → 建立新學院', () => {
  const S = makeSandbox();
  const r = S.resolveOrCreateCollege_('工學院', []);
  assert.equal(r.ok, true);
  assert.equal(r.college.name, '工學院');
  assert.equal(r.college.disabled, false);
  assert.equal(r.colleges.length, 1);
});

// ── resolveOrCreateDept_ ─────────────────────────────────────────────────────

test('resolveOrCreateDept_: 命中既有 active → 沿用；命中 inactive → fail-closed 拒絕', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }, { id: 'd2', name: '停用系', active: false }];
  assert.equal(S.resolveOrCreateDept_('資訊管理系', 'col1', departments).dept.id, 'd1');
  const disabled = S.resolveOrCreateDept_('停用系', 'col1', departments);
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /disabled/);
});

test('resolveOrCreateDept_: 全新 → 建立，帶入 collegeId', () => {
  const S = makeSandbox();
  const r = S.resolveOrCreateDept_('護理學系', 'col1', []);
  assert.equal(r.ok, true);
  assert.equal(r.dept.collegeId, 'col1');
  assert.equal(r.dept.active, true);
});

// ── resolveOrCreateSystem_ ───────────────────────────────────────────────────

test('resolveOrCreateSystem_: 空名稱 → system:null；命中已停用 → fail-closed', () => {
  const S = makeSandbox();
  assert.equal(S.resolveOrCreateSystem_('', []).system, null);
  const systems = [{ id: 'sys1', name: '舊制度', disabled: true }];
  const r = S.resolveOrCreateSystem_('舊制度', systems);
  assert.equal(r.ok, false);
});

test('resolveOrCreateSystem_: 全新 → 建立，requiredMeetingCount 預設 null（待 admin 補）', () => {
  const S = makeSandbox();
  const r = S.resolveOrCreateSystem_('博士', []);
  assert.equal(r.ok, true);
  assert.equal(r.system.requiredMeetingCount, null);
});

// ── parseRequiredMeetingCountField_ ──────────────────────────────────────────

test('parseRequiredMeetingCountField_: 空白/未填 → null；"0" → 0；數字字串 → 數字；非數字 → 拒絕', () => {
  const S = makeSandbox();
  assert.equal(S.parseRequiredMeetingCountField_('').value, null);
  assert.equal(S.parseRequiredMeetingCountField_(undefined).value, null);
  assert.equal(S.parseRequiredMeetingCountField_('  ').value, null);
  assert.equal(S.parseRequiredMeetingCountField_('0').value, 0);
  assert.equal(S.parseRequiredMeetingCountField_(0).value, 0);
  assert.equal(S.parseRequiredMeetingCountField_('4').value, 4);
  assert.equal(S.parseRequiredMeetingCountField_('abc').ok, false);
});

// ── importRosterRow_（整合）───────────────────────────────────────────────────

function baseRow(overrides) {
  return Object.assign({
    collegeName: '管理學院', deptName: '資訊管理系', systemName: '大學日間部',
    classNameRaw: '四技一A', classDisplayName: '', requiredMeetingCount: '',
    tutor1Name: '王老師', tutor1Email: 'wang@x.com', tutor2Name: '', tutor2Email: '',
  }, overrides || {});
}

test('importRosterRow_: 全新學院/系所/制度/班級 → 全部建立，displayName 用 fuseClassDisplayName_ 自動融合', () => {
  const S = makeSandbox();
  const r = S.importRosterRow_(baseRow(), [], [], [], [], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.college.name, '管理學院');
  assert.equal(r.dept.name, '資訊管理系');
  assert.equal(r.dept.collegeId, r.college.id);
  assert.equal(r.system.name, '大學日間部');
  assert.equal(r.cls.name, '四技一A');
  assert.equal(r.cls.systemId, r.system.id);
  assert.equal(r.cls.displayName, '四資訊管理一A');
  assert.equal(r.cls.requiredMeetingOverride, null);
  assert.deepEqual(r.cls.tutors, [{ name: '王老師', email: 'wang@x.com' }]);
  assert.equal(r.classCreated, true);
});

test('importRosterRow_: classDisplayName 有填 → 覆蓋自動融合值', () => {
  const S = makeSandbox();
  const r = S.importRosterRow_(baseRow({ classDisplayName: '自訂顯示名' }), [], [], [], [], NOW);
  assert.equal(r.cls.displayName, '自訂顯示名');
});

test('importRosterRow_: 應繳份數 "0" → 免繳（requiredMeetingOverride:0）', () => {
  const S = makeSandbox();
  const r = S.importRosterRow_(baseRow({ requiredMeetingCount: '0' }), [], [], [], [], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.cls.requiredMeetingOverride, 0);
});

test('importRosterRow_: 命中已停用系所 → fail-closed 拒絕（防重打同名繞過停用，既有安全規則不可退化）', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: false }];
  const r = S.importRosterRow_(baseRow(), [], departments, [], [], NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /department disabled/);
});

test('importRosterRow_: 命中已停用學院/制度 → 各自 fail-closed 拒絕', () => {
  const S = makeSandbox();
  const colleges = [{ id: 'col1', name: '管理學院', disabled: true }];
  const r1 = S.importRosterRow_(baseRow(), colleges, [], [], [], NOW);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /college disabled/);

  const tutorSystems = [{ id: 'sys1', name: '大學日間部', disabled: true }];
  const r2 = S.importRosterRow_(baseRow(), [], [], tutorSystems, [], NOW);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /tutorSystem disabled/);
});

test('importRosterRow_: 命中已停用班級 → fail-closed 拒絕', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }];
  const classes = [{ id: 'd1_x', name: '四技一A', deptId: 'd1', active: false }];
  const r = S.importRosterRow_(baseRow(), [], departments, [], classes, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /class disabled/);
});

// ── 軟刪除（deleted:true）：Ticket B ─────────────────────────────────────────

test('importRosterRow_: 命中已刪除學院/系所/導師制度 → 各自 fail-closed 拒絕（active/disabled 仍為未停用也一樣拒絕）', () => {
  const S = makeSandbox();
  const colleges = [{ id: 'col1', name: '管理學院', disabled: false, deleted: true }];
  const r1 = S.importRosterRow_(baseRow(), colleges, [], [], [], NOW);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /college disabled/);

  const departments = [{ id: 'd1', name: '資訊管理系', active: true, deleted: true }];
  const r2 = S.importRosterRow_(baseRow(), [], departments, [], [], NOW);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /department disabled/);

  const tutorSystems = [{ id: 'sys1', name: '大學日間部', disabled: false, deleted: true }];
  const r3 = S.importRosterRow_(baseRow(), [], [], tutorSystems, [], NOW);
  assert.equal(r3.ok, false);
  assert.match(r3.error, /tutorSystem disabled/);
});

test('importRosterRow_: 命中已刪除班級（active 仍為 true）→ fail-closed 拒絕', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }];
  const classes = [{ id: 'd1_x', name: '四技一A', deptId: 'd1', active: true, deleted: true }];
  const r = S.importRosterRow_(baseRow(), [], departments, [], classes, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /class disabled/);
});

test('importRosterRow_: 班級已存在（同 dept+name）→ 更新而非新建，tutors/displayName/requiredMeetingOverride 套用本列', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }];
  const classes = [{
    id: 'd1_x', name: '四技一A', deptId: 'd1', systemId: null, displayName: '舊顯示名',
    requiredMeetingOverride: null, tutors: [{ name: '舊導師', email: 'old@x.com' }],
    suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true,
  }];
  const r = S.importRosterRow_(baseRow({ requiredMeetingCount: '3' }), [], departments, [], classes, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.classCreated, false);
  assert.equal(r.cls.id, 'd1_x');
  assert.deepEqual(r.cls.tutors, [{ name: '王老師', email: 'wang@x.com' }]);
  assert.equal(r.cls.requiredMeetingOverride, 3);
  assert.equal(r.cls.displayName, '舊顯示名', 'classDisplayName 未填時沿用既有 displayName');
});

test('importRosterRow_: 同批多列共享同一新建學院/系所/制度（fold 語意，不重複建立）', () => {
  const S = makeSandbox();
  const row1 = baseRow({ classNameRaw: '四技一A' });
  const row2 = baseRow({ classNameRaw: '四技一B' });
  const r1 = S.importRosterRow_(row1, [], [], [], [], NOW);
  assert.equal(r1.ok, true);
  const r2 = S.importRosterRow_(row2, r1.colleges, r1.departments, r1.tutorSystems, r1.classes, NOW);
  assert.equal(r2.ok, true);
  assert.equal(r2.college.id, r1.college.id, '第二列命中第一列剛建立的學院，不重複建立');
  assert.equal(r2.dept.id, r1.dept.id);
  assert.equal(r2.system.id, r1.system.id);
  assert.equal(r2.classes.length, 2, '兩個不同班級都建立');
});

test('importRosterRow_: 班級名稱/系所名稱不合法一律拒絕（注入字元擋在入口）', () => {
  const S = makeSandbox();
  assert.equal(S.importRosterRow_(baseRow({ classNameRaw: "A'B" }), [], [], [], [], NOW).ok, false);
  assert.equal(S.importRosterRow_(baseRow({ deptName: "bad'name" }), [], [], [], [], NOW).ok, false);
});

// ── requiredMeetingOverride 保留語意（Ticket E bug fix）─────────────────────

test('importRosterRow_: 既有班的應繳覆寫——本列空白/undefined/null → 保留既有值；帶數字（含 0）→ 設定', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }];
  function cls() {
    return [{ id: 'd1_x', name: '四技一A', deptId: 'd1', systemId: null, displayName: '顯示名',
      requiredMeetingOverride: 3, tutors: [{ name: '王老師', email: 'wang@x.com' }],
      suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true }];
  }
  // 空字串（Excel 空白）→ 保留 3（舊版 bug：會洗回 null）
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: '' }), [], departments, [], cls(), NOW).cls.requiredMeetingOverride, 3);
  // undefined（v3 前端空白送 undefined）→ 保留 3
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: undefined }), [], departments, [], cls(), NOW).cls.requiredMeetingOverride, 3);
  // null（防呆）→ 保留 3
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: null }), [], departments, [], cls(), NOW).cls.requiredMeetingOverride, 3);
  // 帶數字 → 設定
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: '2' }), [], departments, [], cls(), NOW).cls.requiredMeetingOverride, 2);
  // 帶 0（免繳）→ 設定 0，不被當成「未帶」
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: 0 }), [], departments, [], cls(), NOW).cls.requiredMeetingOverride, 0);
});

test('importRosterRow_: 新班的應繳覆寫——空白 → null（新班無既有值）；帶數字 → 設定', () => {
  const S = makeSandbox();
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: '' }), [], [], [], [], NOW).cls.requiredMeetingOverride, null);
  assert.equal(S.importRosterRow_(baseRow({ requiredMeetingCount: '5' }), [], [], [], [], NOW).cls.requiredMeetingOverride, 5);
});

// ── 導師歷史（Ticket C）：tutorsChanged / previousTutors 回傳欄位 ────────────

test('importRosterRow_: 新班有導師 → tutorsChanged:true、previousTutors 空；新班無導師 → tutorsChanged:false', () => {
  const S = makeSandbox();
  const r1 = S.importRosterRow_(baseRow(), [], [], [], [], NOW);
  assert.equal(r1.tutorsChanged, true);
  assert.deepEqual(r1.previousTutors, []);

  const r2 = S.importRosterRow_(baseRow({ tutor1Name: '', tutor1Email: '' }), [], [], [], [], NOW);
  assert.equal(r2.ok, true);
  assert.equal(r2.tutorsChanged, false);
});

test('importRosterRow_: 既有班名單相同 → tutorsChanged:false；名單不同 → true 且 previousTutors 為舊名單', () => {
  const S = makeSandbox();
  const departments = [{ id: 'd1', name: '資訊管理系', active: true }];
  function cls(tutors) {
    return [{ id: 'd1_x', name: '四技一A', deptId: 'd1', systemId: null, displayName: '舊顯示名',
      requiredMeetingOverride: null, tutors: tutors, suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true }];
  }
  // 本列導師與既有完全相同 → 無異動
  const same = S.importRosterRow_(baseRow(), [], departments, [], cls([{ name: '王老師', email: 'wang@x.com' }]), NOW);
  assert.equal(same.ok, true);
  assert.equal(same.tutorsChanged, false);

  // 本列導師不同 → 異動，previousTutors 為舊名單
  const diff = S.importRosterRow_(baseRow(), [], departments, [], cls([{ name: '舊導師', email: 'old@x.com' }]), NOW);
  assert.equal(diff.ok, true);
  assert.equal(diff.tutorsChanged, true);
  assert.deepEqual(diff.previousTutors, [{ name: '舊導師', email: 'old@x.com' }]);

  // 本列未填導師（沿用既有名單）→ 無異動
  const keep = S.importRosterRow_(baseRow({ tutor1Name: '', tutor1Email: '' }), [], departments, [], cls([{ name: '舊導師', email: 'old@x.com' }]), NOW);
  assert.equal(keep.ok, true);
  assert.equal(keep.tutorsChanged, false);
  assert.deepEqual(keep.cls.tutors, [{ name: '舊導師', email: 'old@x.com' }]);
});
