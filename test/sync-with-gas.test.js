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
  // 配對起來之後就不會被當成「兩邊各自新增」——但也不會同步內容（見下一條測試）。
  const p = planSync(local, remote, {});
  assert.deepEqual([p.createLocal, p.createRemote], [[], []]);
  assert.deepEqual([p.pull, p.push, p.conflict], [[], [], []]);
  assert.deepEqual(p.idMismatch, ['D_二B ↔ D_二B_2']);
});

test('🔒 靠班名配對起來的一對，絕不拿來同步內容——只避免徒勞的「新增」', () => {
  // 2026-08-18 實際災情：coma 的「獸醫系_四技五A」（導師林春福，剛填好分機與手機）被
  // 名字相同、其實是另一個班的一般版「獸醫系_四技四A」（導師林韋豪）整筆蓋掉，
  // 兩位導師的聯絡資料就這樣消失，畫面上完全看不出來。
  // id 不同＝「是不是同一個班」沒有證據，只有人能判斷。
  const local = { 'D_二B': C('二B', '1234') };
  const remote = { 'D_二B_2': C('二B', '9999') };
  const p = planSync(local, remote, { 'D_二B': C('二B') });
  assert.deepEqual(p.pull, [], '不可以把對方的內容拉下來蓋掉本機');
  assert.deepEqual(p.push, [], '也不可以把本機的推上去蓋掉對方');
  assert.deepEqual(p.createRemote, [], '但也不該再重複嘗試新增（那是配對的用意）');
  assert.deepEqual(p.idMismatch, ['D_二B ↔ D_二B_2'], '要報告出來讓人判斷');
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

test('🔒 配對要分兩趟：早一點的班用班名配走某個遠端班，不可以讓同 id 的班又配到它一次', () => {
  // 2026-08-18 實際發生：單趟掃描時同一個遠端班被配兩次，統計變成「本機 380、遠端 377、
  // 相同 380」這種不可能的數字，而真正沒配到的本機班被當成已同步、永遠不會被推上去。
  const local = { 'A_一': C('一'), 'D_二B': C('二B') };
  const remote = { 'D_二B': C('一'), 'Z_其他': C('九') };   // 遠端的 D_二B 名字其實是「一」
  const pairs = pairClasses(local, remote);
  const used = pairs.filter((p) => p.rid).map((p) => p.rid);
  assert.equal(new Set(used).size, used.length, '同一個遠端班被配了兩次：' + used.join('、'));
  // D_二B 應該以 id 配到 D_二B（id 優先），A_一 則沒有對象
  assert.equal(pairs.find((p) => p.lid === 'D_二B').rid, 'D_二B');
  assert.equal(pairs.find((p) => p.lid === 'A_一').rid, null);
});

// ── 衝突改由時間戳裁判（使用者 2026-08-19：不再讓人選版本，所以「後改的贏」）────────
// 這一組釘住兩件事：贏的是**後存檔的那一邊**、以及**沒有時間戳時絕不亂猜**。
// 亂猜的代價是靜靜地弄丟別人剛填的資料——2026-08-18 已經真的發生過一次（班名配對）。

test('兩邊都改過：快速版比較新 → 推上去，並記下被覆蓋的是一般版哪一版', () => {
  const base = { name: 'A', tutors: [{ name: '甲' }] };
  const plan = planSync(
    { X: { name: 'A', tutors: [{ name: '本機新' }] } },
    { X: { name: 'A', tutors: [{ name: '遠端舊' }] } },
    { X: base },
    { local: { X: '2026-08-19T10:00:00Z' }, remote: { X: '2026-08-19T09:00:00Z' } },
  );
  assert.deepEqual(plan.push, ['X']);
  assert.deepEqual(plan.conflict, []);
  assert.equal(plan.overwritten.length, 1);
  assert.equal(plan.overwritten[0].side, '一般版');
  assert.equal(plan.overwritten[0].at, '2026-08-19T09:00:00Z');
});

test('兩邊都改過：一般版比較新 → 拉下來', () => {
  const plan = planSync(
    { X: { name: 'A', tutors: [{ name: '本機' }] } },
    { X: { name: 'A', tutors: [{ name: '遠端' }] } },
    { X: { name: 'A', tutors: [] } },
    { local: { X: '2026-08-19T08:00:00Z' }, remote: { X: '2026-08-19T09:00:00Z' } },
  );
  assert.deepEqual(plan.pull, ['X']);
  assert.equal(plan.overwritten[0].side, '快速版');
});

test('🔒 判不出新舊（缺時間戳或同時間）→ 退回兩邊都不動，不准猜', () => {
  const args = (stamps) => planSync(
    { X: { name: 'A', tutors: [{ name: '本機' }] } },
    { X: { name: 'A', tutors: [{ name: '遠端' }] } },
    { X: { name: 'A', tutors: [] } }, stamps);
  for (const stamps of [
    undefined,
    { local: {}, remote: { X: '2026-08-19T09:00:00Z' } },   // 本機沒時間戳（舊匯入資料）
    { local: { X: '2026-08-19T09:00:00Z' }, remote: {} },   // 一般版還沒更新版本、不回時間戳
    { local: { X: '2026-08-19T09:00:00Z' }, remote: { X: '2026-08-19T09:00:00Z' } },
  ]) {
    const plan = args(stamps);
    assert.deepEqual(plan.conflict, ['X'], '判不出來卻自作主張搬了資料');
    assert.deepEqual(plan.push, []);
    assert.deepEqual(plan.pull, []);
    assert.deepEqual(plan.overwritten, []);
  }
});

test('🔒 時間戳只當裁判，不進內容比較：內容相同、時間不同 → 仍算相同', () => {
  const same = { name: 'A', displayName: 'A', tutors: [{ name: '甲' }] };
  const plan = planSync({ X: same }, { X: same }, { X: same },
    { local: { X: '2026-08-19T10:00:00Z' }, remote: { X: '2026-08-01T00:00:00Z' } });
  assert.equal(plan.same, 1);
  assert.deepEqual(plan.push.concat(plan.pull, plan.conflict, plan.overwritten), []);
});
