// 六類實體「軟刪除」共用邏輯測試：applyUpsertDeleteFields_（Ticket B）。
// 涵蓋：entry.deleted===true → 蓋墓碑（deletedAt/deletedBy 一律由後端算，不信任 client 帶的值）；
// 未設/false → 清空墓碑欄位（管理員誤刪的復原後門）；既有欄位保留（merge 語意）。

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

function S() { return load(['applyUpsertDeleteFields_']); }

const NOW = '2026-07-14T03:00:00.000Z';
const ADMIN = 'admin@x.com';

test('entry.deleted===true → 蓋上刪除墓碑，既有欄位保留', () => {
  const s = S();
  const existing = { id: 'c1', name: '資管系', headEmail: 'head@x.com', active: true };
  const out = s.applyUpsertDeleteFields_(existing, { id: 'c1', deleted: true }, ADMIN, NOW);
  assert.equal(out.deleted, true);
  assert.equal(out.deletedAt, NOW);
  assert.equal(out.deletedBy, ADMIN);
  // 既有欄位不受影響（entry 只帶 id/deleted，其餘沿用 existing）
  assert.equal(out.name, '資管系');
  assert.equal(out.headEmail, 'head@x.com');
  assert.equal(out.active, true);
});

test('entry 夾帶偽造的 deletedAt/deletedBy → 一律被後端算的值覆蓋，不信任 client', () => {
  const s = S();
  const existing = { id: 'c1', name: '資管系' };
  const forged = { id: 'c1', deleted: true, deletedAt: '2000-01-01T00:00:00.000Z', deletedBy: 'attacker@evil.com' };
  const out = s.applyUpsertDeleteFields_(existing, forged, ADMIN, NOW);
  assert.equal(out.deletedAt, NOW);
  assert.equal(out.deletedBy, ADMIN);
});

test('entry.deleted 未設 → 正常 upsert，且明確清空墓碑欄位（deleted:false，無 deletedAt/deletedBy）', () => {
  const s = S();
  const existing = { id: 'c1', name: '資管系', active: true };
  const out = s.applyUpsertDeleteFields_(existing, { id: 'c1', name: '資管系（改名）' }, ADMIN, NOW);
  assert.equal(out.deleted, false);
  assert.equal('deletedAt' in out, false);
  assert.equal('deletedBy' in out, false);
  assert.equal(out.name, '資管系（改名）');
});

test('entry.deleted===false 且 existing 已是墓碑 → 允許覆寫回未刪除（誤刪復原後門，見 Ticket B 設計）', () => {
  const s = S();
  const existing = { id: 'c1', name: '資管系', deleted: true, deletedAt: '2026-01-01T00:00:00.000Z', deletedBy: 'someone@x.com' };
  const out = s.applyUpsertDeleteFields_(existing, { id: 'c1', deleted: false }, ADMIN, NOW);
  assert.equal(out.deleted, false);
  assert.equal('deletedAt' in out, false);
  assert.equal('deletedBy' in out, false);
});

test('existing 為空物件（新建項目時 idx===-1）→ 正常運作，不噴錯', () => {
  const s = S();
  const out = s.applyUpsertDeleteFields_({}, { id: 'new1', name: '新學院' }, ADMIN, NOW);
  assert.equal(out.deleted, false);
  assert.equal(out.name, '新學院');
});
