// sanitizeRecordForViewer_（actualBy 只有 admin/staffLead/staffAssistant/director 看得到）
// 與四類宣導關鍵字自動偵測（detectTopics_/mergeTopicsOnEdit_/canSetTopics_/applySetTopics_）。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load([
    'sanitizeRecordForViewer_', 'sanitizeRecordsForViewer_',
    'detectTopics_', 'mergeTopicsOnEdit_', 'canSetTopics_', 'applySetTopics_',
  ]);
}

function rolesFor(overrides) {
  return Object.assign({
    isAdmin: false, isDirector: false, isStaffLead: false, isStaffAssistant: false,
  }, overrides || {});
}

function recordWithActualBy() {
  return {
    id: 'r1', type: 'meeting', status: 'pending_director',
    approvals: {
      tutor: [{ email: 't@x.com', name: 'T', at: 'now' }],
      dept: { email: 'head@x.com', name: 'Head', at: 'now' },
      staffLead: { email: 'lead@x.com', name: 'Lead', at: 'now', actualBy: 'assistant@x.com' },
      director: null,
    },
    rejection: null,
    history: [
      { action: 'staffLead_approve', by: 'lead@x.com', at: 'now', actualBy: 'assistant@x.com' },
      { action: 'submit', by: 's@x.com', at: 'now' },
    ],
  };
}

// ── sanitizeRecordForViewer_ ────────────────────────────────────────────────

test('sanitizeRecordForViewer_: 非授權角色（導師/系主任/提交者）看不到 actualBy', () => {
  const S = makeSandbox();
  const rec = recordWithActualBy();
  const sanitized = S.sanitizeRecordForViewer_(rec, rolesFor({}));
  assert.equal(sanitized.approvals.staffLead.actualBy, undefined);
  assert.equal(sanitized.approvals.staffLead.name, 'Lead', '掛名的主責姓名仍保留');
  assert.equal(sanitized.history[0].actualBy, undefined);
  // 原始物件不被就地修改
  assert.equal(rec.approvals.staffLead.actualBy, 'assistant@x.com');
});

test('sanitizeRecordForViewer_: admin/director/staffLead/staffAssistant 都看得到 actualBy', () => {
  const S = makeSandbox();
  const rec = recordWithActualBy();
  [{ isAdmin: true }, { isDirector: true }, { isStaffLead: true }, { isStaffAssistant: true }].forEach((r) => {
    const sanitized = S.sanitizeRecordForViewer_(rec, rolesFor(r));
    assert.equal(sanitized.approvals.staffLead.actualBy, 'assistant@x.com', JSON.stringify(r));
  });
});

test('sanitizeRecordForViewer_: rejection.actualBy 同樣被隱藏', () => {
  const S = makeSandbox();
  const rec = Object.assign(recordWithActualBy(), {
    rejection: { by: 'lead@x.com', name: 'Lead', role: 'staffLead', reason: '缺附件', at: 'now', actualBy: 'assistant@x.com' },
  });
  const sanitized = S.sanitizeRecordForViewer_(rec, rolesFor({}));
  assert.equal(sanitized.rejection.actualBy, undefined);
  assert.equal(sanitized.rejection.reason, '缺附件');
});

test('sanitizeRecordForViewer_: 沒有 actualBy 的紀錄原樣通過；null 安全', () => {
  const S = makeSandbox();
  assert.equal(S.sanitizeRecordForViewer_(null, rolesFor({})), null);
  const plain = { id: 'r2', approvals: { tutor: [], dept: null, staffLead: null, director: null }, history: [] };
  const sanitized = S.sanitizeRecordForViewer_(plain, rolesFor({}));
  assert.deepEqual(sanitized, plain);
});

test('sanitizeRecordsForViewer_: 陣列版本逐筆套用', () => {
  const S = makeSandbox();
  const list = [recordWithActualBy(), recordWithActualBy()];
  const out = S.sanitizeRecordsForViewer_(list, rolesFor({}));
  assert.equal(out.length, 2);
  out.forEach((r) => assert.equal(r.approvals.staffLead.actualBy, undefined));
});

// ── 四類宣導關鍵字自動偵測 ────────────────────────────────────────────────────

const KEYWORD_RULES = {
  traffic: { label: '交通安全宣導', keywords: ['交通安全', '酒駕'] },
  gender:  { label: '性平宣導', keywords: ['性平', '性騷擾'] },
  smoking: { label: '菸害防制宣導', keywords: ['菸害', '戒菸'] },
  fraud:   { label: '防詐騙宣導', keywords: ['詐騙', '防詐'] },
};

test('detectTopics_: 掃描表單所有文字欄位，命中關鍵字則 checked+auto 皆 true', () => {
  const S = makeSandbox();
  const form = { topic: '交通安全宣導講座', discussion: '無', others: '' };
  const topics = S.detectTopics_(form, KEYWORD_RULES);
  assert.deepEqual(topics.traffic, { checked: true, auto: true });
  assert.deepEqual(topics.gender, { checked: false, auto: true });
  assert.deepEqual(topics.smoking, { checked: false, auto: true });
  assert.deepEqual(topics.fraud, { checked: false, auto: true });
});

test('detectTopics_: 完全無命中 → 四類皆 false/auto:true；空 form 不噴錯', () => {
  const S = makeSandbox();
  const topics = S.detectTopics_({}, KEYWORD_RULES);
  Object.keys(topics).forEach((k) => assert.deepEqual(topics[k], { checked: false, auto: true }));
});

test('mergeTopicsOnEdit_: auto:true 的項目重新掃描覆蓋；auto:false（人工鎖定）的項目維持原狀', () => {
  const S = makeSandbox();
  const existing = {
    traffic: { checked: true, auto: true },   // 自動勾選，會被重新掃描覆蓋
    gender:  { checked: true, auto: false },  // 人工鎖定，不受影響
    smoking: { checked: false, auto: true },
    fraud:   { checked: false, auto: true },
  };
  // 新表單不再含交通關鍵字、但含防詐關鍵字
  const merged = S.mergeTopicsOnEdit_(existing, { topic: '防詐騙宣導' }, KEYWORD_RULES);
  assert.deepEqual(merged.traffic, { checked: false, auto: true }, 'auto 項目應依新表單重新計算');
  assert.deepEqual(merged.gender, { checked: true, auto: false }, '人工鎖定不受自動掃描影響');
  assert.deepEqual(merged.fraud, { checked: true, auto: true });
});

test('canSetTopics_: 只有 staffLead/已綁定助理/director/admin 可調整', () => {
  const S = makeSandbox();
  assert.equal(S.canSetTopics_(rolesFor({ isStaffLead: true })), true);
  assert.equal(
    S.canSetTopics_(rolesFor({ isStaffAssistant: true, assistantLead: { email: 'lead@x.com', name: '主責' } })),
    true, '已綁定助理可調整');
  assert.equal(S.canSetTopics_(rolesFor({ isStaffAssistant: true, assistantLead: null })), false,
    '綁定失效的助理不可調整（fail-closed，與 resolveActionableStage_ 一致）');
  assert.equal(S.canSetTopics_(rolesFor({ isDirector: true })), true);
  assert.equal(S.canSetTopics_(rolesFor({ isAdmin: true })), true);
  assert.equal(S.canSetTopics_(rolesFor({})), false, '導師/系主任/一般學生不可調整');
  assert.equal(S.canSetTopics_(null), false);
});

test('applySetTopics_: 手動調整後 auto 變 false（人工鎖定），未知鍵忽略，history 記錄', () => {
  const S = makeSandbox();
  const record = {
    topics: {
      traffic: { checked: false, auto: true }, gender: { checked: false, auto: true },
      smoking: { checked: false, auto: true }, fraud: { checked: false, auto: true },
    },
    history: [],
  };
  const updated = S.applySetTopics_(record, { traffic: { checked: true }, unknownKey: { checked: true } }, 'lead@x.com', null, 'now');
  assert.deepEqual(updated.topics.traffic, { checked: true, auto: false });
  assert.equal(updated.topics.unknownKey, undefined, '未知鍵忽略，不新增鍵');
  assert.equal(updated.history[0].action, 'setTopics');
  assert.equal(updated.history[0].by, 'lead@x.com');
  assert.equal(updated.history[0].actualBy, null, '主責本人動作 actualBy 為 null');
});

test('applySetTopics_: 助理代主責調整 → by 掛主責、actualBy 記助理；sanitize 後非學諮端看不到', () => {
  const S = makeSandbox();
  const record = {
    topics: { traffic: { checked: false, auto: true } },
    history: [],
  };
  const updated = S.applySetTopics_(record, { traffic: { checked: true } }, 'lead@x.com', 'assistant@x.com', 'now');
  assert.equal(updated.history[0].by, 'lead@x.com', '對外顯示掛綁定主責');
  assert.equal(updated.history[0].actualBy, 'assistant@x.com', '真實動作者為助理');
  const sanitized = S.sanitizeRecordForViewer_(updated, rolesFor({}));
  assert.equal(sanitized.history[0].actualBy, undefined, '非學諮端角色看不到 actualBy');
});

test('sanitizeRecordForViewer_: staffLead 關的 editLog.by 對非學諮端隱藏；其他關的 editLog.by 保留', () => {
  const S = makeSandbox();
  const record = {
    approvals: {}, history: [],
    editLog: [
      { by: 'assistant@x.com', roleStage: 'staffLead', at: 't1', changedFields: ['topic'] },
      { by: 'tutor@x.com', roleStage: 'tutor', at: 't2', changedFields: ['date'] },
    ],
  };
  const sanitized = S.sanitizeRecordForViewer_(record, rolesFor({}));
  assert.equal(sanitized.editLog[0].by, undefined, 'staffLead 關編輯者身分（可能是助理）隱藏');
  assert.deepEqual(sanitized.editLog[0].changedFields, ['topic'], '改了什麼欄位仍可見');
  assert.equal(sanitized.editLog[1].by, 'tutor@x.com', '非 staffLead 關不受影響');
  const privileged = S.sanitizeRecordForViewer_(record, rolesFor({ isStaffLead: true }));
  assert.equal(privileged.editLog[0].by, 'assistant@x.com', '學諮端看得到真實編輯者');
});
