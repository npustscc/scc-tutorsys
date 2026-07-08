// 核章狀態機測試：涵蓋班會紀錄 4 關（pending_tutor → pending_dept → pending_staffLead →
// pending_director → approved）與導生活動紀錄 2 關（pending_staffLead → pending_director →
// approved，跳過導師/系主任）的完整推進路徑、雙導師 any/all 兩種模式、導師本人上傳視同已核章、
// 退件一律退回導師、退件重送只有該班導師可動且從該類型第一關重跑。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'isClassTutor_',
    'chainForType_',
    'initialStatusForType_',
    'buildNewRecord_',
    'advanceOnTutorApproval_',
    'advanceOnDeptApproval_',
    'advanceOnStaffLeadApproval_',
    'advanceOnDirectorApproval_',
    'applyRejection_',
    'canResubmit_',
    'applyResubmit_',
    'recordResubmit_',
  ]);
}

const NOW = '2026-07-06T00:00:00.000Z';

function studentInput(overrides) {
  return Object.assign({
    id: 'r1', type: 'meeting', semester: '114-2', classId: 'c1', deptId: 'd1',
    uploader: { email: 'student@gmail.com', name: 'S', studentId: 'B1234567', isTutor: false },
    form: { topic: '第一次班會' }, attachments: [],
  }, overrides || {});
}

test('chainForType_ / initialStatusForType_：meeting 4 關起於 tutor；activity 2 關起於 staffLead', () => {
  const S = makeSandbox();
  assert.deepEqual(S.chainForType_('meeting'), ['tutor', 'dept', 'staffLead', 'director']);
  assert.deepEqual(S.chainForType_('activity'), ['staffLead', 'director']);
  assert.equal(S.initialStatusForType_('meeting'), 'pending_tutor');
  assert.equal(S.initialStatusForType_('activity'), 'pending_staffLead');
});

test('meeting 全流程：pending_tutor → pending_dept → pending_staffLead → pending_director → approved', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };

  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  assert.equal(record.status, 'pending_tutor');
  assert.equal(record.approvals.tutor.length, 0);

  record = S.advanceOnTutorApproval_(record, classInfo, 'tutor@x.com', 'T', NOW);
  assert.equal(record.status, 'pending_dept');

  record = S.advanceOnDeptApproval_(record, 'head@x.com', 'Head', NOW);
  assert.equal(record.status, 'pending_staffLead');
  assert.deepEqual(record.approvals.dept, { email: 'head@x.com', name: 'Head', at: NOW });

  record = S.advanceOnStaffLeadApproval_(record, 'lead@x.com', 'Lead', null, NOW);
  assert.equal(record.status, 'pending_director');
  assert.deepEqual(record.approvals.staffLead, { email: 'lead@x.com', name: 'Lead', at: NOW });

  record = S.advanceOnDirectorApproval_(record, 'director@x.com', 'Dir', NOW);
  assert.equal(record.status, 'approved');
  assert.deepEqual(record.approvals.director, { email: 'director@x.com', name: 'Dir', at: NOW });

  assert.deepEqual(record.history.map((h) => h.action),
    ['submit', 'tutor_approve', 'dept_approve', 'staffLead_approve', 'director_approve']);
});

test('advanceOnStaffLeadApproval_：助理代主責時 approvals 記 actualBy，history 也記', () => {
  const S = makeSandbox();
  const record = { status: 'pending_staffLead', approvals: { tutor: [], dept: null, staffLead: null, director: null }, history: [] };
  const result = S.advanceOnStaffLeadApproval_(record, 'lead@x.com', 'Lead', 'assistant@x.com', NOW);
  assert.equal(result.approvals.staffLead.actualBy, 'assistant@x.com');
  assert.equal(result.approvals.staffLead.name, 'Lead');
  assert.equal(result.history[0].actualBy, 'assistant@x.com');
});

test('activity 全流程：pending_staffLead → pending_director → approved（跳過導師/系主任）', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const input = studentInput({ type: 'activity', uploader: { email: 'student@gmail.com', name: 'S', studentId: '', isTutor: false } });
  let record = S.buildNewRecord_(input, classInfo, NOW);
  assert.equal(record.status, 'pending_staffLead');

  // 就算上傳者是導師本人，activity 也不會自動跳過 staffLead（advanceOnTutorApproval_ 對 activity 是 no-op）。
  const tutorInput = studentInput({ type: 'activity', uploader: { email: 'tutor@x.com', name: 'T', studentId: '', isTutor: true } });
  const tutorRecord = S.buildNewRecord_(tutorInput, classInfo, NOW);
  assert.equal(tutorRecord.status, 'pending_staffLead', 'activity 沒有導師關，不受 isTutor 影響');

  record = S.advanceOnStaffLeadApproval_(record, 'lead@x.com', 'Lead', null, NOW);
  assert.equal(record.status, 'pending_director');
  record = S.advanceOnDirectorApproval_(record, 'director@x.com', 'Dir', NOW);
  assert.equal(record.status, 'approved');
});

test('導師本人上傳（單導師班）：視同已核章，直接進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const input = studentInput({ uploader: { email: 'tutor@x.com', name: 'T', studentId: '', isTutor: true } });
  const record = S.buildNewRecord_(input, classInfo, NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 1);
  assert.equal(record.approvals.tutor[0].email, 'tutor@x.com');
});

test('雙導師 any 模式：任一位導師核章即進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'any',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  assert.equal(record.status, 'pending_tutor');

  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 1);
});

test('雙導師 all 模式：需要兩位都核章才進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  assert.equal(record.status, 'pending_tutor', '只有一位核章，all 模式仍應停在 pending_tutor');

  record = S.advanceOnTutorApproval_(record, classInfo, 't2@x.com', 'T2', NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 2);
});

test('同一位導師重複核章是冪等的', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  assert.equal(record.status, 'pending_tutor');
  assert.equal(record.approvals.tutor.length, 1);
  assert.equal(record.history[record.history.length - 1].action, 'tutor_approve_noop');
});

test('advanceOnTutorApproval_ 對非 pending_tutor 狀態是 no-op', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = { status: 'pending_dept', approvals: { tutor: [], dept: null, staffLead: null, director: null }, history: [] };
  const result = S.advanceOnTutorApproval_(record, classInfo, 't@x.com', 'T', NOW);
  assert.equal(result, record);
});

test('任何一關退件一律 status=rejected，理由/角色/actualBy 記錄正確', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  const rejected = S.applyRejection_(record, 't@x.com', 'T', null, 'tutor', '內容不完整', NOW);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.rejection, { by: 't@x.com', name: 'T', role: 'tutor', reason: '內容不完整', at: NOW });
  assert.equal(rejected.history[rejected.history.length - 1].action, 'reject');

  const rejectedByAssistant = S.applyRejection_(record, 'lead@x.com', 'Lead', 'assistant@x.com', 'staffLead', '缺附件', NOW);
  assert.equal(rejectedByAssistant.rejection.actualBy, 'assistant@x.com');
});

test('canResubmit_：一律退回導師——只有該班導師（不論是不是原上傳者）能重送，且須 rejected 狀態', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  assert.equal(S.canResubmit_(null, classInfo, 'tutor@x.com').ok, false);
  assert.equal(S.canResubmit_({ status: 'pending_tutor' }, classInfo, 'tutor@x.com').ok, false, '非 rejected 狀態不可重送');
  assert.equal(S.canResubmit_({ status: 'rejected' }, classInfo, 'student@gmail.com').ok, false, '非導師（即使是原上傳者）不可重送');
  assert.equal(S.canResubmit_({ status: 'rejected' }, classInfo, 'tutor@x.com').ok, true, '該班導師可重送，不要求是原上傳者');
});

test('退件重送（meeting）：導師（非原上傳者）修改後重送 → 回 pending_tutor 並立即視同已核章（重跑）', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW); // 學生上傳，pending_tutor
  record = S.advanceOnTutorApproval_(record, classInfo, 'tutor@x.com', 'T', NOW); // pending_dept
  record = S.applyRejection_(record, 'head@x.com', 'Head', null, 'dept', '請補附件', NOW);
  assert.equal(record.status, 'rejected');

  const res = S.recordResubmit_(record, classInfo, 'tutor@x.com', 'T', { topic: '修改後內容' }, [{ fileId: 'f2' }], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_dept', '導師重送重跑 tutor 關，單導師直接進 pending_dept');
  assert.equal(res.record.rejection, null);
  assert.equal(res.record.form.topic, '修改後內容');
  assert.ok(res.record.history.length > record.history.length, 'history 應累加而非清空');
});

test('退件重送（activity）：沒有導師關，重跑後直接回 pending_staffLead', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const input = studentInput({ type: 'activity', uploader: { email: 'student@gmail.com', name: 'S', studentId: '', isTutor: false } });
  let record = S.buildNewRecord_(input, classInfo, NOW); // pending_staffLead
  record = S.applyRejection_(record, 'lead@x.com', 'Lead', null, 'staffLead', '缺出席狀況', NOW);

  const res = S.recordResubmit_(record, classInfo, 'tutor@x.com', 'T', { summary: '補齊了' }, [], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_staffLead');
});

test('退件重送：非導師不可重送（即使是原上傳者）', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.applyRejection_(record, 'tutor@x.com', 'T', null, 'tutor', '理由', NOW);
  const res = S.recordResubmit_(record, classInfo, 'student@gmail.com', 'S', {}, [], NOW);
  assert.equal(res.ok, false);
});

test('退件重送：紀錄不是 rejected 狀態不可重送', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = S.buildNewRecord_(studentInput(), classInfo, NOW); // pending_tutor
  const res = S.recordResubmit_(record, classInfo, 'tutor@x.com', 'T', {}, [], NOW);
  assert.equal(res.ok, false);
});

test('雙導師 all 班：重送者是導師 1，仍需導師 2 核章才能進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't2@x.com', 'T2', NOW); // pending_dept
  record = S.applyRejection_(record, 'head@x.com', 'Head', null, 'dept', '退回', NOW);

  const res = S.recordResubmit_(record, classInfo, 't1@x.com', 'T1', {}, [], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_tutor', '重跑後 approvals 清空，all 模式需重新湊滿兩位核章');
  assert.equal(res.record.approvals.tutor.length, 1);
});
