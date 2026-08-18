// 名單同步的兩個專用通道（2026-08-18）。
//
// 這一組的重點是**權限切得剛好夠用**，因為同步帳號的密碼存在自架端的 .env 裡：
//   ① 只有 importer 這個服務帳號叫得動（其他人一律 forbidden，即使是 admin——
//      admin 本來就有正規的 adminUpsert* 可用，不需要走這條）
//   ② 那個帳號被停用時這兩個通道一起失效（fail-closed）
//   ③ **只准寫 deptAssistants 與 safetyOfficers**。users 的 role:'admin' 直接是管理員，
//      而 staffLeads 命中時 resolveRoles_ 會同時給 isAdmin——開放寫入等於留下
//      「憑一組存在檔案裡的密碼把自己變成管理員」這條路。

const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

function makeSandbox() {
  return load(['requireSyncService_'], { IMPORTER_ACCOUNT_EMAIL_: 'importer@heartnpust.tw' });
}
const IMPORTER = 'importer@heartnpust.tw';

test('只有同步服務帳號叫得動（連 admin 都不行——它有正規的 action 可用）', () => {
  const S = makeSandbox();
  assert.doesNotThrow(() => S.requireSyncService_({ email: IMPORTER, deptAssistantOf: ['農園系'] }));
  assert.throws(() => S.requireSyncService_({ email: 'boss@x.com', isAdmin: true, deptAssistantOf: ['農園系'] }), /forbidden/);
  assert.throws(() => S.requireSyncService_({ email: '', deptAssistantOf: ['農園系'] }), /forbidden/);
  assert.throws(() => S.requireSyncService_(null), /forbidden/);
});

test('email 比對不分大小寫（設定檔可能大小寫不同）', () => {
  const S = makeSandbox();
  assert.doesNotThrow(() => S.requireSyncService_({ email: 'Importer@HeartNPUST.tw', deptAssistantOf: ['農園系'] }));
});

test('🔒 這個帳號被停用（deptAssistantOf 空）→ 兩個通道一起失效', () => {
  const S = makeSandbox();
  assert.throws(() => S.requireSyncService_({ email: IMPORTER, deptAssistantOf: [] }), /forbidden/);
  assert.throws(() => S.requireSyncService_({ email: IMPORTER }), /forbidden/);
});

test('🔒 可寫清單只有兩份，users／staffLeads／staffAssistants 不在裡面', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dev', 'Code.gs'), 'utf8');
  const m = /const SYNC_WRITABLE_LISTS_ = (\[[^\]]*\])/.exec(src);
  assert.ok(m, '找不到 SYNC_WRITABLE_LISTS_');
  const writable = JSON.parse(m[1].replace(/'/g, '"'));
  assert.deepEqual(writable.sort(), ['deptAssistants', 'safetyOfficers']);
  for (const forbidden of ['users', 'staffLeads', 'staffAssistants']) {
    assert.equal(writable.includes(forbidden), false,
      forbidden + ' 不可寫——它等於可以把自己變成管理員');
  }
});
