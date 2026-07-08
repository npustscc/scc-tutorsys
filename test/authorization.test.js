// 授權判斷測試：resolveActionableStage_ / recordApprove_ / recordReject_ / canViewRecord_ /
// resolveApproverIdentity_。重點：錯誤角色、錯誤狀態一律拒絕；admin 可代為處理任何一關；
// director 只能動 pending_director；staffLead 關可由主責本人或「已綁定」助理代為動作，
// 助理代動作時掛名主責、actualBy 記真實助理身分。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'isClassTutor_',
    'stageFromStatus_',
    'resolveActionableStage_',
    'resolveApproverIdentity_',
    'advanceOnTutorApproval_',
    'advanceOnDeptApproval_',
    'advanceOnStaffLeadApproval_',
    'advanceOnDirectorApproval_',
    'formFieldsForType_',
    'sanitizeFormFields_',
    'applyFormEdit_',
    'applyRejection_',
    'recordApprove_',
    'recordReject_',
    'canViewRecord_',
  ], {
    MEETING_FORM_FIELDS_: [
      'date', 'topic', 'chair', 'recorder', 'attendance',
      'chairReport', 'discussion', 'resolutions', 'tutorRemarks', 'extempore', 'others',
    ],
    ACTIVITY_FORM_FIELDS_: ['date', 'topic', 'summary', 'attendance'],
  });
}

const NOW = '2026-07-06T00:00:00.000Z';
const classInfo = { id: 'c1', deptId: 'd1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
const deptInfo = { id: 'd1', headEmail: 'head@x.com' };

function baseRecord(status, type) {
  return {
    id: 'r1', type: type || 'meeting', classId: 'c1', deptId: 'd1', status: status,
    uploader: { email: 'student@gmail.com', name: 'S' },
    form: { topic: '第一次班會', date: '2026-01-01' },
    approvals: { tutor: [], dept: null, staffLead: null, director: null },
    rejection: null, editLog: [], history: [],
  };
}

function rolesFor(overrides) {
  return Object.assign({
    isAdmin: false, isDirector: false, isStaffLead: false, isStaffAssistant: false, assistantLead: null,
    deptHeadOf: [], tutorOf: [],
  }, overrides || {});
}

test('resolveActionableStage_: pending_tutor 只有本班導師可動作', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] })).ok, true);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['other'] })).ok, false);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ isDirector: true })).ok, false, '主任不能跳關動導師關');
});

test('resolveActionableStage_: pending_dept 只有本系系主任可動作', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] })).ok, true);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['other'] })).ok, false);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] })).ok, false, '導師不能跳關動系主任關');
});

test('resolveActionableStage_: pending_staffLead 主責本人可動作；一般助理（未綁定）不可', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_staffLead');
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ isStaffLead: true })).ok, true);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ isStaffAssistant: true, assistantLead: null })).ok, false, '未綁定（或綁定的主責已停用）的助理不可代為動作');
  assert.equal(
    S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ isStaffAssistant: true, assistantLead: { email: 'lead@x.com', name: 'Lead' } })).ok,
    true, '已綁定的助理可代為動作'
  );
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] })).ok, false, '系主任不能跳關動主責關');
});

test('resolveActionableStage_: pending_director 只有 director 可動作', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_director');
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ isDirector: true })).ok, true);
  assert.equal(S.resolveActionableStage_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] })).ok, false, '系主任不能跳關動主任關');
});

test('resolveActionableStage_: 已 approved / rejected 的紀錄任何非 admin 角色都不能再動作', () => {
  const S = makeSandbox();
  const approved = baseRecord('approved');
  const rejected = baseRecord('rejected');
  const allRoles = rolesFor({ isDirector: true, deptHeadOf: ['d1'], tutorOf: ['c1'], isStaffLead: true });
  assert.equal(S.resolveActionableStage_(approved, classInfo, deptInfo, allRoles).ok, false);
  assert.equal(S.resolveActionableStage_(rejected, classInfo, deptInfo, allRoles).ok, false);
});

test('resolveActionableStage_: admin 可在任一 pending 關代為處理，但不能動 approved/rejected', () => {
  const S = makeSandbox();
  const adminRoles = rolesFor({ isAdmin: true });
  assert.equal(S.resolveActionableStage_(baseRecord('pending_tutor'), classInfo, deptInfo, adminRoles).stage, 'tutor');
  assert.equal(S.resolveActionableStage_(baseRecord('pending_dept'), classInfo, deptInfo, adminRoles).stage, 'dept');
  assert.equal(S.resolveActionableStage_(baseRecord('pending_staffLead'), classInfo, deptInfo, adminRoles).stage, 'staffLead');
  assert.equal(S.resolveActionableStage_(baseRecord('pending_director'), classInfo, deptInfo, adminRoles).stage, 'director');
  assert.equal(S.resolveActionableStage_(baseRecord('approved'), classInfo, deptInfo, adminRoles).ok, false);
});

test('resolveApproverIdentity_：主責本人動作 → approver 是自己，actualBy null；已綁定助理代動 → approver 是主責身分，actualBy 是助理', () => {
  const S = makeSandbox();
  const leadSelf = S.resolveApproverIdentity_('staffLead', rolesFor({ isStaffLead: true }), 'lead@x.com', 'Lead');
  assert.deepEqual(leadSelf, { email: 'lead@x.com', name: 'Lead', actualBy: null });

  const assistantRoles = rolesFor({ isStaffAssistant: true, assistantLead: { email: 'lead@x.com', name: 'Lead' } });
  const viaAssistant = S.resolveApproverIdentity_('staffLead', assistantRoles, 'assistant@x.com', 'Assistant');
  assert.deepEqual(viaAssistant, { email: 'lead@x.com', name: 'Lead', actualBy: 'assistant@x.com' });

  // 非 staffLead 關（例如 director）不套用掛名邏輯，一律動作者本人。
  const directorSelf = S.resolveApproverIdentity_('director', rolesFor({ isDirector: true }), 'dir@x.com', 'Dir');
  assert.deepEqual(directorSelf, { email: 'dir@x.com', name: 'Dir', actualBy: null });
});

test('recordApprove_: 錯誤角色被拒（不會誤推進狀態）', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ isDirector: true }), 'director@x.com', 'Dir', null, NOW);
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('recordApprove_: 正確角色（導師）在 pending_tutor 可推進到 pending_dept', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', 'T', null, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_dept');
  assert.equal(res.stage, 'tutor');
});

test('recordApprove_: staffLead 關由已綁定助理核准 → approvals.staffLead 顯示主責身分、actualBy 是助理', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_staffLead');
  const assistantRoles = rolesFor({ isStaffAssistant: true, assistantLead: { email: 'lead@x.com', name: 'Lead' } });
  const res = S.recordApprove_(record, classInfo, deptInfo, assistantRoles, 'assistant@x.com', 'Assistant', null, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_director');
  assert.equal(res.record.approvals.staffLead.email, 'lead@x.com');
  assert.equal(res.record.approvals.staffLead.name, 'Lead');
  assert.equal(res.record.approvals.staffLead.actualBy, 'assistant@x.com');
});

test('recordApprove_: 錯誤狀態被拒（例如已 approved 的紀錄不能再核）', () => {
  const S = makeSandbox();
  const record = baseRecord('approved');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ isAdmin: true }), 'admin@x.com', 'Admin', null, NOW);
  assert.equal(res.ok, false);
});

test('recordApprove_: 帶 updatedForm → 白名單過濾後套用、append editLog，核准照常推進（不重跑已過關卡）', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  record.form = { topic: '舊主題', date: '2026-01-01', evilKey: 'x' };
  const res = S.recordApprove_(
    record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] }), 'head@x.com', 'Head',
    { topic: '新主題', evilKey: 'y' }, NOW
  );
  assert.equal(res.ok, true);
  assert.equal(res.record.form.topic, '新主題');
  assert.equal(res.record.form.evilKey, 'x', '不在白名單的欄位不可被 updatedForm 修改');
  assert.equal(res.record.status, 'pending_staffLead');
  assert.equal(res.record.editLog.length, 1);
  assert.deepEqual(res.record.editLog[0].changedFields, ['topic']);
  assert.equal(res.record.editLog[0].roleStage, 'dept');
});

test('recordReject_: 必須填理由，理由為空拒絕', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', 'T', '   ', null, NOW);
  assert.equal(res.ok, false);
});

test('recordReject_: 錯誤角色被拒', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', 'T', '理由', null, NOW);
  assert.equal(res.ok, false);
});

test('recordReject_: 正確角色且填理由 → 成功退件（一律 status=rejected）', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] }), 'head@x.com', 'Head', '內容不齊全', null, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'rejected');
  assert.equal(res.record.rejection.reason, '內容不齊全');
  assert.equal(res.record.rejection.role, 'dept');
});

test('recordReject_: staffLead 關由助理代動作 → rejection.actualBy 記助理', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_staffLead');
  const assistantRoles = rolesFor({ isStaffAssistant: true, assistantLead: { email: 'lead@x.com', name: 'Lead' } });
  const res = S.recordReject_(record, classInfo, deptInfo, assistantRoles, 'assistant@x.com', 'Assistant', '缺附件', null, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.rejection.by, 'lead@x.com');
  assert.equal(res.record.rejection.actualBy, 'assistant@x.com');
});

test('canViewRecord_: 上傳者本人、本班導師、本系系主任、admin/director/staffLead/staffAssistant 皆可見；無關人士不可見', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({}), 'student@gmail.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] }), 'head@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isAdmin: true }), 'admin@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isDirector: true }), 'director@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isStaffLead: true }), 'lead@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isStaffAssistant: true }), 'assistant@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({}), 'stranger@gmail.com'), false);
});
