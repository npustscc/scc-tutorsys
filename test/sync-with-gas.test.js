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

// ── 兩邊 id 不同、但其實是同一個班 ───────────────────────────────────────────
// id 是由「系所＋班名」衍生的，撞名時自動加 `_2`。所以同一個「四技二B」可能在一邊是
// 農企系_四技二B、另一邊是 農企系_四技二B_2。只用 id 配對的話會被當成「兩邊各有一個
// 對方沒有的班」，每輪都嘗試新增、每輪都被對方以 class name already exists 拒絕，
// 永遠不收斂——2026-08-18 在正式版上實際發生兩次。
const { pairClasses } = require('node:module').createRequire(__filename)('../server/scripts/sync-with-gas.mjs');

test('id 配不到時用「系所＋班名」配對，不當成兩邊各自新增', () => {
  const local = { 'D_二B': C('二B') };
  const remote = { 'D_二B_2': C('二B') };
  const pairs = pairClasses(local, remote);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].lid, pairs[0].rid, pairs[0].viaName], ['D_二B', 'D_二B_2', true]);
  // 內容相同 → 不該產生任何動作，也不該報成新增
  const p = planSync(local, remote, {});
  assert.equal(p.same, 1);
  assert.deepEqual([p.createLocal, p.createRemote], [[], []]);
  assert.deepEqual(p.idMismatch, ['D_二B ↔ D_二B_2']);
});

test('名字配對成功時，ridOf 要指出「推去哪個 id」（拿本機 id 去打會 class not found）', () => {
  const local = { 'D_二B': C('二B', '1234') };
  const remote = { 'D_二B_2': C('二B') };
  const p = planSync(local, remote, { 'D_二B': C('二B') });
  assert.deepEqual(p.push, ['D_二B']);
  assert.equal(p.ridOf['D_二B'], 'D_二B_2');
});

test('🔒 id 優先於名字：改名要被認成「同一筆改了名」，不是「刪一個加一個」', () => {
  const local = { 'D_x': Object.assign(C('新名'), {}) };
  const remote = { 'D_x': C('舊名'), 'D_y': C('新名') };
  const pairs = pairClasses(local, remote);
  const forX = pairs.find((x) => x.lid === 'D_x');
  assert.equal(forX.rid, 'D_x', 'D_x 應該配到同 id 的 D_x，而不是名字相同的 D_y');
  assert.ok(!forX.viaName);
});

test('一邊有、另一邊完全沒有（連同名的都沒有）→ 才算新增', () => {
  const p1 = planSync({ 'D_a': C('a') }, {}, {});
  assert.deepEqual(p1.createRemote, ['D_a']);
  const p2 = planSync({}, { 'D_b': C('b') }, {});
  assert.deepEqual(p2.createLocal, ['D_b']);
});
