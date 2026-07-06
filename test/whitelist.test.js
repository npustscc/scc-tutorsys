// 上傳白名單判斷測試：isUploadAllowed_
// 規則：導師本人永遠可上傳；白名單為空 = 不限；白名單非空時，非導師必須在名單內。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load(['isUploadAllowed_', 'isClassTutor_']);
}

test('classInfo 不存在 → 一律拒絕', () => {
  const S = makeSandbox();
  assert.equal(S.isUploadAllowed_(null, 'a@x.com'), false);
});

test('導師本人永遠可上傳，即使白名單非空且不含自己', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], uploadWhitelist: ['other@x.com'] };
  assert.equal(S.isUploadAllowed_(classInfo, 't@x.com'), true);
});

test('白名單為空陣列 → 不限，任何人皆可上傳', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [], uploadWhitelist: [] };
  assert.equal(S.isUploadAllowed_(classInfo, 'anyone@gmail.com'), true);
});

test('白名單未設定（undefined）→ 視同空 → 不限', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [] };
  assert.equal(S.isUploadAllowed_(classInfo, 'anyone@gmail.com'), true);
});

test('白名單非空：名單內帳號允許', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [], uploadWhitelist: ['ok@gmail.com'] };
  assert.equal(S.isUploadAllowed_(classInfo, 'ok@gmail.com'), true);
});

test('白名單非空：非名單、非導師帳號拒絕', () => {
  const S = makeSandbox();
  const classInfo = { id: 'c1', tutors: [{ email: 't@x.com', name: 'T' }], uploadWhitelist: ['ok@gmail.com'] };
  assert.equal(S.isUploadAllowed_(classInfo, 'stranger@gmail.com'), false);
});
