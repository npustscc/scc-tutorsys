// 稽核瀏覽軌跡（2026-08-18）的正規化。
//
// 這條通道是**任何登入者都能觸發**的寫入，所以正規化本身就是防線：
//   ① 事件名只收白名單——開放任意字串等於讓稽核表變成使用者可控的內容，而看的人會信它。
//   ② by 一律用已驗證的 email 覆蓋，絕不看參數（否則甲可以偽造成乙的軌跡）。
//   ③ 每個欄位都有長度上限（檔案是整檔讀寫，塞長字串就是拖慢每一次寫入）。
// 筆數上限與「為什麼跟 audit_log.json 分開存」見 dev/Code.gs 那一段註解。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load(['normalizeAuditView_'], {
    AUDIT_VIEW_ACTIONS_: ['viewPage', 'viewDeptRoster', 'viewMobile', 'exportRoster', 'viewAdminTab'],
  });
}
const NOW = '2026-08-18T01:00:00.000Z';

test('白名單內的事件 → 收下，欄位都在', () => {
  const S = makeSandbox();
  const r = S.normalizeAuditView_(
    { auditAction: 'viewDeptRoster', page: 'deptroster', deptId: '森林系', detail: '18 班' },
    'a@x.com', NOW);
  assert.deepEqual(r, {
    at: NOW, by: 'a@x.com', action: 'viewDeptRoster',
    page: 'deptroster', deptId: '森林系', detail: '18 班',
  });
});

test('🔒 白名單外的事件名一律不收（含空值與亂填）', () => {
  const S = makeSandbox();
  for (const a of ['', '  ', 'deleteEverything', 'viewPageX', null, undefined, 123, {}]) {
    assert.equal(S.normalizeAuditView_({ auditAction: a }, 'a@x.com', NOW), null, String(a));
  }
  assert.equal(S.normalizeAuditView_({}, 'a@x.com', NOW), null);
  assert.equal(S.normalizeAuditView_(null, 'a@x.com', NOW), null);
});

test('🔒 by 永遠是已驗證的 email，參數裡塞 by／email 都無效（不能偽造成別人）', () => {
  const S = makeSandbox();
  const r = S.normalizeAuditView_(
    { auditAction: 'viewPage', by: 'victim@x.com', email: 'victim@x.com', at: '1999-01-01' },
    'attacker@x.com', NOW);
  assert.equal(r.by, 'attacker@x.com');
  assert.equal(r.at, NOW, '時間也不收參數（否則可以偽造時序）');
});

test('欄位長度上限：page 40／deptId 40／detail 120，超過就截斷不是拒絕', () => {
  const S = makeSandbox();
  const r = S.normalizeAuditView_({
    auditAction: 'viewMobile',
    page: 'p'.repeat(200), deptId: 'd'.repeat(200), detail: 'x'.repeat(500),
  }, 'a@x.com', NOW);
  assert.equal(r.page.length, 40);
  assert.equal(r.deptId.length, 40);
  assert.equal(r.detail.length, 120);
});

test('缺欄位不炸，補成空字串（前端不同畫面帶的欄位不一樣）', () => {
  const S = makeSandbox();
  const r = S.normalizeAuditView_({ auditAction: 'exportRoster' }, 'a@x.com', NOW);
  assert.deepEqual([r.page, r.deptId, r.detail], ['', '', '']);
});
