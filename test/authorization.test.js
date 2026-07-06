// 授權判斷測試：resolveActionableStage_ / recordApprove_ / recordReject_ / canViewRecord_
// 重點：錯誤角色、錯誤狀態一律拒絕；admin 可代為處理任何一關；director 只能動 pending_director。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'isClassTutor_',
    'resolveActionableStage_',
    'advanceOnTutorApproval_',
    'advanceOnDeptApproval_',
    'advanceOnDirectorApproval_',
    'applyRejection_',
    'recordApprove_',
    'recordReject_',
    'canViewRecord_',
  ]);
}

const NOW = '2026-07-06T00:00:00.000Z';
const classInfo = { id: 'c1', deptId: 'd1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
const deptInfo = { id: 'd1', headEmail: 'head@x.com' };

function baseRecord(status) {
  return {
    id: 'r1', classId: 'c1', deptId: 'd1', status: status,
    uploader: { email: 'student@gmail.com', name: 'S' },
    approvals: { tutor: [], dept: null, director: null },
    rejection: null, history: [],
  };
}

function rolesFor(overrides) {
  return Object.assign({ isAdmin: false, isDirector: false, deptHeadOf: [], tutorOf: [] }, overrides || {});
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
  const allRoles = rolesFor({ isDirector: true, deptHeadOf: ['d1'], tutorOf: ['c1'] });
  assert.equal(S.resolveActionableStage_(approved, classInfo, deptInfo, allRoles).ok, false);
  assert.equal(S.resolveActionableStage_(rejected, classInfo, deptInfo, allRoles).ok, false);
});

test('resolveActionableStage_: admin 可在 pending_tutor/pending_dept/pending_director 任一關代為處理，但不能動 approved/rejected', () => {
  const S = makeSandbox();
  const adminRoles = rolesFor({ isAdmin: true });
  assert.equal(S.resolveActionableStage_(baseRecord('pending_tutor'), classInfo, deptInfo, adminRoles).stage, 'tutor');
  assert.equal(S.resolveActionableStage_(baseRecord('pending_dept'), classInfo, deptInfo, adminRoles).stage, 'dept');
  assert.equal(S.resolveActionableStage_(baseRecord('pending_director'), classInfo, deptInfo, adminRoles).stage, 'director');
  assert.equal(S.resolveActionableStage_(baseRecord('approved'), classInfo, deptInfo, adminRoles).ok, false);
});

test('recordApprove_: 錯誤角色被拒（不會誤推進狀態）', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ isDirector: true }), 'director@x.com', 'Dir', NOW);
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('recordApprove_: 正確角色（導師）在 pending_tutor 可推進到 pending_dept', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', 'T', NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_dept');
  assert.equal(res.stage, 'tutor');
});

test('recordApprove_: 錯誤狀態被拒（例如已 approved 的紀錄不能再核）', () => {
  const S = makeSandbox();
  const record = baseRecord('approved');
  const res = S.recordApprove_(record, classInfo, deptInfo, rolesFor({ isAdmin: true }), 'admin@x.com', 'Admin', NOW);
  assert.equal(res.ok, false);
});

test('recordReject_: 必須填理由，理由為空拒絕', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', '   ', NOW);
  assert.equal(res.ok, false);
});

test('recordReject_: 錯誤角色被拒', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com', '理由', NOW);
  assert.equal(res.ok, false);
});

test('recordReject_: 正確角色且填理由 → 成功退件', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_dept');
  const res = S.recordReject_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] }), 'head@x.com', '內容不齊全', NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'rejected');
  assert.equal(res.record.rejection.reason, '內容不齊全');
  assert.equal(res.record.rejection.role, 'dept');
});

test('canViewRecord_: 上傳者本人、本班導師、本系系主任、admin/director 皆可見；無關人士不可見', () => {
  const S = makeSandbox();
  const record = baseRecord('pending_tutor');
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({}), 'student@gmail.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ tutorOf: ['c1'] }), 'tutor@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ deptHeadOf: ['d1'] }), 'head@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isAdmin: true }), 'admin@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({ isDirector: true }), 'director@x.com'), true);
  assert.equal(S.canViewRecord_(record, classInfo, deptInfo, rolesFor({}), 'stranger@gmail.com'), false);
});
