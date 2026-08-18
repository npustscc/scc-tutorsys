// 雙向同步的三方比對（planSync）。
//
// 使用者 2026-08-18 要求「兩邊都可寫且同步」。單純互抄的必然失敗模式是：同一筆在兩邊都改過時，
// 後跑的那邊安靜地蓋掉另一邊。這裡測的就是那個模式**不會發生**——兩邊都改過一律判為衝突、
// 兩邊都不動，讓人去決定。其餘三種情況（只有一邊改、都沒改、只有一邊有）各自走對的方向。

const test = require('node:test');
const assert = require('node:assert');
const { planSync, projectClass } = require('node:module')
  .createRequire(__filename)('../server/scripts/sync-with-gas.mjs');

const C = (name, ext) => ({ name: name, displayName: name, deptId: 'D', systemId: null,
  requiredMeetingOverride: null, graduatedSemester: null, active: true,
  tutors: [{ name: '甲', email: '', ext: ext || '', mobile: '' }] });

test('兩邊一樣 → 什麼都不做', () => {
  const p = planSync({ a: C('一') }, { a: C('一') }, { a: C('一') });
  assert.equal(p.same, 1);
  assert.deepEqual([p.pull, p.push, p.conflict], [[], [], []]);
});

test('只有遠端改 → 拉下來', () => {
  const p = planSync({ a: C('一') }, { a: C('一', '6608') }, { a: C('一') });
  assert.deepEqual(p.pull, ['a']);
  assert.deepEqual(p.push, []);
});

test('只有本機改 → 推上去', () => {
  const p = planSync({ a: C('一', '1234') }, { a: C('一') }, { a: C('一') });
  assert.deepEqual(p.push, ['a']);
  assert.deepEqual(p.pull, []);
});

test('🔒 兩邊都改且不一樣 → 判為衝突，兩邊都不動（不可以自動挑一邊）', () => {
  const p = planSync({ a: C('一', '1111') }, { a: C('一', '2222') }, { a: C('一') });
  assert.deepEqual(p.conflict, ['a']);
  assert.deepEqual([p.pull, p.push], [[], []], '衝突時不該產生任何寫入動作');
});

test('兩邊都改但改成一樣 → 不算衝突，也不用做事', () => {
  const p = planSync({ a: C('一', '9') }, { a: C('一', '9') }, { a: C('一') });
  assert.equal(p.same, 1);
  assert.deepEqual(p.conflict, []);
});

test('只有一邊有 → 新增到另一邊，永遠不刪', () => {
  const p1 = planSync({}, { a: C('一') }, {});
  assert.deepEqual(p1.createLocal, ['a']);
  const p2 = planSync({ a: C('一') }, {}, {});
  assert.deepEqual(p2.createRemote, ['a']);
  // baseline 有、兩邊都沒有（＝被刪了）→ 不產生任何動作，更不會去刪另一邊
  const p3 = planSync({}, {}, { a: C('一') });
  assert.deepEqual([p3.pull, p3.push, p3.conflict, p3.createLocal, p3.createRemote], [[], [], [], [], []]);
});

test('🔒 沒有同步基準又兩邊不同 → 列進 missingBaseline，不猜', () => {
  const p = planSync({ a: C('一', '1') }, { a: C('一', '2') }, {});
  assert.deepEqual(p.missingBaseline, ['a']);
  assert.deepEqual([p.pull, p.push, p.conflict], [[], [], []]);
});

test('projectClass：舊的 phone 折進 mobile、缺欄位補 null（否則第一次比對整批誤判有變動）', () => {
  const a = projectClass({ name: 'x', deptId: 'D', tutors: [{ name: '甲', phone: '0912' }] });
  const b = projectClass({ name: 'x', deptId: 'D', displayName: undefined, systemId: undefined,
    tutors: [{ name: '甲', mobile: '0912', ext: '' }] });
  assert.deepEqual(a, b);
  assert.equal(a.displayName, null);
});
