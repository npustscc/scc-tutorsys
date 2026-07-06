// 核章狀態機測試：涵蓋 pending_tutor → pending_dept → pending_director → approved 的
// 完整推進路徑、雙導師 any/all 兩種模式、導師本人上傳視同已核章、退件、退件重送重跑。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'isClassTutor_',
    'buildNewRecord_',
    'advanceOnTutorApproval_',
    'advanceOnDeptApproval_',
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

test('單導師班：學生上傳 → pending_tutor；導師核章 → pending_dept；系主任核章 → pending_director；主任核章 → approved', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };

  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  assert.equal(record.status, 'pending_tutor');
  assert.equal(record.approvals.tutor.length, 0);

  record = S.advanceOnTutorApproval_(record, classInfo, 'tutor@x.com', 'T', NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 1);

  record = S.advanceOnDeptApproval_(record, 'head@x.com', 'Head', NOW);
  assert.equal(record.status, 'pending_director');
  assert.deepEqual(record.approvals.dept, { email: 'head@x.com', name: 'Head', at: NOW });

  record = S.advanceOnDirectorApproval_(record, 'director@x.com', 'Dir', NOW);
  assert.equal(record.status, 'approved');
  assert.deepEqual(record.approvals.director, { email: 'director@x.com', name: 'Dir', at: NOW });

  // history 累加：submit, tutor_approve, dept_approve, director_approve
  assert.deepEqual(record.history.map((h) => h.action), ['submit', 'tutor_approve', 'dept_approve', 'director_approve']);
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

test('雙導師 any 模式：導師 1 本人上傳直接進 pending_dept（略過導師 2 核章）', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'any',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  const input = studentInput({ uploader: { email: 't1@x.com', name: 'T1', studentId: '', isTutor: true } });
  const record = S.buildNewRecord_(input, classInfo, NOW);
  assert.equal(record.status, 'pending_dept');
});

test('雙導師 all 模式：需要兩位都核章才進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  assert.equal(record.status, 'pending_tutor');

  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  assert.equal(record.status, 'pending_tutor', '只有一位核章，all 模式仍應停在 pending_tutor');
  assert.equal(record.approvals.tutor.length, 1);

  record = S.advanceOnTutorApproval_(record, classInfo, 't2@x.com', 'T2', NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 2);
});

test('雙導師 all 模式：導師 1 本人上傳仍停在 pending_tutor，等導師 2 核章才進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  const input = studentInput({ uploader: { email: 't1@x.com', name: 'T1', studentId: '', isTutor: true } });
  let record = S.buildNewRecord_(input, classInfo, NOW);
  assert.equal(record.status, 'pending_tutor');
  assert.equal(record.approvals.tutor.length, 1);

  record = S.advanceOnTutorApproval_(record, classInfo, 't2@x.com', 'T2', NOW);
  assert.equal(record.status, 'pending_dept');
  assert.equal(record.approvals.tutor.length, 2);
});

test('同一位導師重複核章是冪等的（不會重複計入 approvals.tutor，也不會提早在 all 模式推進）', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't1@x.com', 'T1', NOW); // 重複核章
  assert.equal(record.status, 'pending_tutor');
  assert.equal(record.approvals.tutor.length, 1);
  assert.equal(record.history[record.history.length - 1].action, 'tutor_approve_noop');
});

test('advanceOnTutorApproval_ 對非 pending_tutor 狀態是 no-op（不會誤推進已在其他關卡的紀錄）', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = { status: 'pending_dept', approvals: { tutor: [], dept: null, director: null }, history: [] };
  const result = S.advanceOnTutorApproval_(record, classInfo, 't@x.com', 'T', NOW);
  assert.equal(result, record); // 原樣傳回，未修改
});

test('三關都可退件：導師關退件', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  const rejected = S.applyRejection_(record, 't@x.com', 'tutor', '內容不完整', NOW);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.rejection, { by: 't@x.com', role: 'tutor', reason: '內容不完整', at: NOW });
  assert.equal(rejected.history[rejected.history.length - 1].action, 'reject');
});

test('退件重送：原上傳者（非導師）修改後重送 → 回 pending_tutor，approvals/rejection 清空，history 累加不清空', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.advanceOnTutorApproval_(record, classInfo, 't@x.com', 'T', NOW); // pending_dept
  record = S.applyRejection_(record, 'head@x.com', 'dept', '請補附件', NOW);
  assert.equal(record.status, 'rejected');

  const res = S.recordResubmit_(record, classInfo, 'student@gmail.com', 'S', { topic: '修改後內容' }, [{ fileId: 'f2' }], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_tutor');
  assert.deepEqual(res.record.approvals, { tutor: [], dept: null, director: null });
  assert.equal(res.record.rejection, null);
  assert.equal(res.record.form.topic, '修改後內容');
  assert.ok(res.record.history.length > record.history.length, 'history 應累加而非清空');
});

test('退件重送：非原上傳者不可重送', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  let record = S.buildNewRecord_(studentInput(), classInfo, NOW);
  record = S.applyRejection_(record, 't@x.com', 'tutor', '理由', NOW);
  const res = S.recordResubmit_(record, classInfo, 'someone-else@gmail.com', 'X', {}, [], NOW);
  assert.equal(res.ok, false);
});

test('退件重送：紀錄不是 rejected 狀態不可重送', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const record = S.buildNewRecord_(studentInput(), classInfo, NOW); // pending_tutor
  const res = S.recordResubmit_(record, classInfo, 'student@gmail.com', 'S', {}, [], NOW);
  assert.equal(res.ok, false);
});

test('退件重送「重跑」：重送者本人是導師 → 立刻視同已核章那關（單導師直接進 pending_dept）', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 'tutor@x.com', name: 'T' }], dualApprovalMode: 'any' };
  const input = studentInput({ uploader: { email: 'tutor@x.com', name: 'T', studentId: '', isTutor: true } });
  let record = S.buildNewRecord_(input, classInfo, NOW); // pending_dept（导师自传）
  record = S.applyRejection_(record, 'head@x.com', 'dept', '退回', NOW);

  const res = S.recordResubmit_(record, classInfo, 'tutor@x.com', 'T', { topic: '改過了' }, [], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_dept', '導師重送應重跑同一套自動核章邏輯，直接回到 pending_dept');
});

test('雙導師 all 班：重送者是導師 1，仍需導師 2 核章才能進 pending_dept', () => {
  const S = makeSandbox();
  const classInfo = {
    id: 'c1', dualApprovalMode: 'all',
    tutors: [{ email: 't1@x.com', name: 'T1' }, { email: 't2@x.com', name: 'T2' }],
  };
  // 原上傳者本人就是導師 1（recordResubmit_ 只允許原上傳者重送，見 canResubmit_）。
  const input = studentInput({ uploader: { email: 't1@x.com', name: 'T1', studentId: '', isTutor: true } });
  let record = S.buildNewRecord_(input, classInfo, NOW); // all 模式：仍停在 pending_tutor
  record = S.advanceOnTutorApproval_(record, classInfo, 't2@x.com', 'T2', NOW); // pending_dept
  record = S.applyRejection_(record, 'head@x.com', 'dept', '退回', NOW);

  const res = S.recordResubmit_(record, classInfo, 't1@x.com', 'T1', {}, [], NOW);
  assert.equal(res.ok, true);
  assert.equal(res.record.status, 'pending_tutor', '重跑後 approvals 清空，all 模式需重新湊滿兩位核章');
  assert.equal(res.record.approvals.tutor.length, 1);
});

test('canResubmit_ 各分支：找不到紀錄 / 非 rejected / 非原上傳者 / 允許', () => {
  const S = makeSandbox();
  assert.equal(S.canResubmit_(null, 'a@x.com').ok, false);
  assert.equal(S.canResubmit_({ status: 'pending_tutor', uploader: { email: 'a@x.com' } }, 'a@x.com').ok, false);
  assert.equal(S.canResubmit_({ status: 'rejected', uploader: { email: 'a@x.com' } }, 'b@x.com').ok, false);
  assert.equal(S.canResubmit_({ status: 'rejected', uploader: { email: 'a@x.com' } }, 'a@x.com').ok, true);
});
