// 資安強化純函式測試：
// - isValidSemesterId_（semester 白名單驗證，防 Drive query 注入與垃圾檔）
// - sanitizeClassesForViewer_（uploadWhitelist 只給該班導師/admin 看）
// - isAttachmentInFolder_（附件歸屬驗證骨架，防任意 fileId 外洩）

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

const SEMESTERS = [
  { id: '114-1', label: '114 上', isCurrent: false },
  { id: '114-2', label: '114 下', isCurrent: true },
];

// ── isValidSemesterId_ ────────────────────────────────────────────────────────

test('isValidSemesterId_: 合法學期（格式正確且存在於 semesters.json）', () => {
  const S = load(['isValidSemesterId_']);
  assert.equal(S.isValidSemesterId_('114-2', SEMESTERS), true);
  assert.equal(S.isValidSemesterId_('114-1', SEMESTERS), true);
});

test('isValidSemesterId_: 格式錯誤一律拒絕', () => {
  const S = load(['isValidSemesterId_']);
  assert.equal(S.isValidSemesterId_('1142', SEMESTERS), false);
  assert.equal(S.isValidSemesterId_('114-2x', SEMESTERS), false);
  assert.equal(S.isValidSemesterId_('14-2', SEMESTERS), false);
  assert.equal(S.isValidSemesterId_('114-22', SEMESTERS), false);
  assert.equal(S.isValidSemesterId_('', SEMESTERS), false);
});

test('isValidSemesterId_: 單引號注入字串被格式檢查擋下', () => {
  const S = load(['isValidSemesterId_']);
  // 這類字串若被串進 Drive 搜尋 q（"name='records_" + semester + ".json'"）會逃逸引號注入查詢
  assert.equal(S.isValidSemesterId_("114-2' or name contains 'config", SEMESTERS), false);
  assert.equal(S.isValidSemesterId_("' and trashed=false or '1'='1", SEMESTERS), false);
});

test('isValidSemesterId_: 格式正確但不存在於 semesters.json → 拒絕', () => {
  const S = load(['isValidSemesterId_']);
  assert.equal(S.isValidSemesterId_('999-9', SEMESTERS), false);
});

test('isValidSemesterId_: 非字串（null/undefined/number/object）→ 拒絕', () => {
  const S = load(['isValidSemesterId_']);
  assert.equal(S.isValidSemesterId_(null, SEMESTERS), false);
  assert.equal(S.isValidSemesterId_(undefined, SEMESTERS), false);
  assert.equal(S.isValidSemesterId_(1142, SEMESTERS), false);
  assert.equal(S.isValidSemesterId_({ id: '114-2' }, SEMESTERS), false);
});

test('isValidSemesterId_: semesters 為空/未提供 → 拒絕（fail-closed）', () => {
  const S = load(['isValidSemesterId_']);
  assert.equal(S.isValidSemesterId_('114-2', []), false);
  assert.equal(S.isValidSemesterId_('114-2', null), false);
});

// ── sanitizeClassesForViewer_ ─────────────────────────────────────────────────

const CLASSES = [
  { id: 'c1', name: '資管一甲', tutors: [{ email: 't1@x.com', name: 'T1' }], uploadWhitelist: ['a@gmail.com', 'b@gmail.com'], active: true },
  { id: 'c2', name: '資管一乙', tutors: [{ email: 't2@x.com', name: 'T2' }], uploadWhitelist: [], active: true },
  { id: 'c3', name: '資管二甲', tutors: [{ email: 't3@x.com', name: 'T3' }], active: true },  // 無 whitelist 欄位
];

function rolesFor(overrides) {
  return Object.assign({ isAdmin: false, isDirector: false, deptHeadOf: [], tutorOf: [] }, overrides || {});
}

test('sanitizeClassesForViewer_: admin 看得到所有班的 uploadWhitelist', () => {
  const S = load(['sanitizeClassesForViewer_']);
  const out = S.sanitizeClassesForViewer_(CLASSES, rolesFor({ isAdmin: true }));
  assert.deepEqual(out[0].uploadWhitelist, ['a@gmail.com', 'b@gmail.com']);
  assert.deepEqual(out[1].uploadWhitelist, []);
});

test('sanitizeClassesForViewer_: 導師只看得到自己班的 uploadWhitelist，其他班被過濾成 hasWhitelist', () => {
  const S = load(['sanitizeClassesForViewer_']);
  const out = S.sanitizeClassesForViewer_(CLASSES, rolesFor({ tutorOf: ['c1'] }));
  // 自己的班：原樣保留
  assert.deepEqual(out[0].uploadWhitelist, ['a@gmail.com', 'b@gmail.com']);
  // 別人的班：uploadWhitelist 移除，改回 hasWhitelist
  assert.equal(out[1].uploadWhitelist, undefined);
  assert.equal(out[1].hasWhitelist, false);  // c2 白名單為空 = 沒有限制名單
});

test('sanitizeClassesForViewer_: 一般學生/系主任/director 全部班都拿不到 uploadWhitelist，只有 hasWhitelist', () => {
  const S = load(['sanitizeClassesForViewer_']);
  [rolesFor({}), rolesFor({ deptHeadOf: ['d1'] }), rolesFor({ isDirector: true })].forEach(function (roles) {
    const out = S.sanitizeClassesForViewer_(CLASSES, roles);
    out.forEach(function (c) { assert.equal(c.uploadWhitelist, undefined); });
    assert.equal(out[0].hasWhitelist, true);   // c1 有非空白名單
    assert.equal(out[1].hasWhitelist, false);  // c2 空白名單
    assert.equal(out[2].hasWhitelist, false);  // c3 未設定
  });
});

test('sanitizeClassesForViewer_: tutors email/姓名保留（上傳表單與核章顯示需要）；不改動原陣列', () => {
  const S = load(['sanitizeClassesForViewer_']);
  const out = S.sanitizeClassesForViewer_(CLASSES, rolesFor({}));
  assert.deepEqual(out[0].tutors, [{ email: 't1@x.com', name: 'T1' }]);
  // 原始資料不被就地修改（回傳的是 copy）
  assert.deepEqual(CLASSES[0].uploadWhitelist, ['a@gmail.com', 'b@gmail.com']);
});

test('sanitizeClassesForViewer_: roles 為 null/undefined → 一律過濾（fail-closed）', () => {
  const S = load(['sanitizeClassesForViewer_']);
  const out = S.sanitizeClassesForViewer_(CLASSES, null);
  assert.equal(out[0].uploadWhitelist, undefined);
  assert.equal(out[0].hasWhitelist, true);
});

// ── isAttachmentInFolder_ ─────────────────────────────────────────────────────

test('isAttachmentInFolder_: parents 命中預期資料夾 → true', () => {
  const S = load(['isAttachmentInFolder_']);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['folderA'] }, 'folderA'), true);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['x', 'folderA'] }, 'folderA'), true);
});

test('isAttachmentInFolder_: parents 未命中（任意外部 fileId 的攻擊情境）→ false', () => {
  const S = load(['isAttachmentInFolder_']);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['someoneElsesFolder'] }, 'folderA'), false);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: [] }, 'folderA'), false);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1' }, 'folderA'), false);  // 無 parents 欄位
});

test('isAttachmentInFolder_: 已進垃圾桶的檔案 → false', () => {
  const S = load(['isAttachmentInFolder_']);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['folderA'], trashed: true }, 'folderA'), false);
});

test('isAttachmentInFolder_: metadata 缺失（查不到檔案）或預期資料夾為 null（資料夾不存在）→ false（fail-closed）', () => {
  const S = load(['isAttachmentInFolder_']);
  assert.equal(S.isAttachmentInFolder_(null, 'folderA'), false);
  assert.equal(S.isAttachmentInFolder_(undefined, 'folderA'), false);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['folderA'] }, null), false);
  assert.equal(S.isAttachmentInFolder_({ id: 'f1', parents: ['folderA'] }, ''), false);
});
