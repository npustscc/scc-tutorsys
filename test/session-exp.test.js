// 自建 Session Token 測試（dev/Code.gs）
// - nextTaipeiMidnightEpochSec_：純算術，直接抽測。
// - issueSessionToken_ / verifySessionToken_：以 extraGlobals mock GAS 的 Utilities
//   （HMAC 用 node:crypto）與 PropertiesService，驗證 roundtrip、竄改偵測、過期、
//   以及 SESSION_SECRET 未設置時的 fail-closed 行為。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { load } = require('./harness');

// ── nextTaipeiMidnightEpochSec_（純算術）──────────────────────────────────────

const S = load(['nextTaipeiMidnightEpochSec_']);

test('台北白天中段 12:00 → 當日 24:00', () => {
  assert.equal(
    S.nextTaipeiMidnightEpochSec_(Date.parse('2026-07-08T12:00:00+08:00')),
    Date.parse('2026-07-09T00:00:00+08:00') / 1000
  );
});

test('台北 23:59:59 → 隔日 00:00（只差 1 秒）', () => {
  assert.equal(
    S.nextTaipeiMidnightEpochSec_(Date.parse('2026-07-08T23:59:59+08:00')),
    Date.parse('2026-07-09T00:00:00+08:00') / 1000
  );
});

test('恰為台北 00:00:00 → 24 小時後（不是當下）', () => {
  const nowMs = Date.parse('2026-07-08T00:00:00+08:00');
  assert.equal(S.nextTaipeiMidnightEpochSec_(nowMs), nowMs / 1000 + 86400);
});

test('UTC 日界：UTC 17:00 = 台北隔日 01:00 → 台北再下一個午夜', () => {
  // 2026-07-08T17:00:00Z = 台北 2026-07-09 01:00 → 下一個台北午夜是 07-10 00:00
  assert.equal(
    S.nextTaipeiMidnightEpochSec_(Date.parse('2026-07-08T17:00:00Z')),
    Date.parse('2026-07-10T00:00:00+08:00') / 1000
  );
});

// ── issueSessionToken_ / verifySessionToken_（mock Utilities / PropertiesService）──

// GAS 的 computeHmacSha256Signature 回傳 signed byte 陣列（-128..127），
// base64EncodeWebSafe 接受字串或 byte 陣列——mock 兩種輸入都要處理（b & 255 轉回 0..255）。
function toBuffer(d) {
  return Array.isArray(d) ? Buffer.from(d.map((b) => b & 255)) : Buffer.from(String(d), 'utf8');
}
const UtilitiesMock = {
  base64EncodeWebSafe: (d) => toBuffer(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  base64DecodeWebSafe: (s) =>
    Array.from(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
  computeHmacSha256Signature: (v, k) =>
    Array.from(crypto.createHmac('sha256', k).update(v, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
  newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes.map((b) => b & 255)).toString('utf8') }),
  getUuid: () => crypto.randomUUID(),
};

// props = 可變的 Script Properties 內容（SESSION_SECRET / SESSION_REVOKED_BEFORE），
// 供註銷測試在簽發後修改；CacheService 用簡單記憶體 map 模擬（含 remove 清快取語意）。
function makeSession(secret, props) {
  props = props || {};
  if (secret !== undefined) props.SESSION_SECRET = secret;
  const cache = {};
  return load(
    ['getSessionSecret_', 'issueSessionToken_', 'verifySessionToken_',
     'sessionRevokedBeforeMap_', 'sessionRevokeAllDevices_', 'nextTaipeiMidnightEpochSec_'],
    {
      Utilities: UtilitiesMock,
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (k in props ? props[k] : null),
          setProperty: (k, v) => { props[k] = String(v); },
        }),
      },
      CacheService: {
        getScriptCache: () => ({
          get: (k) => (k in cache ? cache[k] : null),
          put: (k, v) => { cache[k] = String(v); },
          remove: (k) => { delete cache[k]; },
        }),
      },
      LockService: {
        getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
      },
    }
  );
}

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';

test('roundtrip：簽發後驗證回原 email，exp 為未來的台北午夜整點', () => {
  const T = makeSession(SECRET);
  const issued = T.issueSessionToken_('a@b.com');
  assert.equal(T.verifySessionToken_(issued.token), 'a@b.com');
  assert.ok(issued.exp > Math.floor(Date.now() / 1000));
  assert.equal((issued.exp + 8 * 3600) % 86400, 0); // 台北時間整日界
});

test('竄改 payload（換 email）→ null', () => {
  const T = makeSession(SECRET);
  const issued = T.issueSessionToken_('a@b.com');
  const forgedPayload = UtilitiesMock.base64EncodeWebSafe(
    JSON.stringify({ e: 'evil@b.com', iat: 0, exp: issued.exp })
  );
  const forged = forgedPayload + '.' + issued.token.split('.')[1];
  assert.equal(T.verifySessionToken_(forged), null);
});

test('竄改/截斷簽章 → null；缺 "." → null', () => {
  const T = makeSession(SECRET);
  const issued = T.issueSessionToken_('a@b.com');
  const parts = issued.token.split('.');
  assert.equal(T.verifySessionToken_(parts[0] + '.' + parts[1].slice(0, -2) + 'xx'), null);
  assert.equal(T.verifySessionToken_(parts[0] + '.' + parts[1].slice(0, -4)), null);
  assert.equal(T.verifySessionToken_(parts[0]), null);
  assert.equal(T.verifySessionToken_(''), null);
  assert.equal(T.verifySessionToken_(null), null);
});

test('過期 token（正確簽章）→ null', () => {
  const T = makeSession(SECRET);
  const payloadB64 = UtilitiesMock.base64EncodeWebSafe(
    JSON.stringify({ e: 'a@b.com', iat: 0, exp: Math.floor(Date.now() / 1000) - 10 })
  );
  const sigB64 = UtilitiesMock.base64EncodeWebSafe(
    UtilitiesMock.computeHmacSha256Signature(payloadB64, SECRET)
  );
  assert.equal(T.verifySessionToken_(payloadB64 + '.' + sigB64), null);
});

test('別把密鑰簽的 token 拿去驗另一把密鑰（dev/prod 隔離）→ null', () => {
  const A = makeSession(SECRET);
  const B = makeSession('another-secret-entirely-different-0000000000000000000000000000');
  const issued = A.issueSessionToken_('a@b.com');
  assert.equal(B.verifySessionToken_(issued.token), null);
});

test('SESSION_SECRET 未設置 → verifySessionToken_ fail-closed 回 null', () => {
  const T = makeSession(null);
  assert.equal(T.verifySessionToken_('whatever.sig'), null);
});

test('SESSION_SECRET 未設置 → issueSessionToken_ throw', () => {
  const T = makeSession(null);
  assert.throws(() => T.issueSessionToken_('a@b.com'), /SESSION_SECRET/);
});

// ── 登出即註銷（全部裝置）：revokedBefore 機制 ────────────────────────────────

test('每個 token 都有唯一 jti，並回傳 iat', () => {
  const T = makeSession(SECRET);
  const a = T.issueSessionToken_('a@b.com');
  const b = T.issueSessionToken_('a@b.com');
  assert.ok(a.jti && b.jti && a.jti !== b.jti, 'jti 應唯一');
  assert.ok(a.iat > 0);
});

test('sessionRevokeAllDevices_ 後，先前簽發的 token（不分裝置）全部失效', () => {
  const props = {};
  const T = makeSession(SECRET, props);
  const t1 = T.issueSessionToken_('a@b.com');
  const t2 = T.issueSessionToken_('a@b.com');   // 模擬另一台裝置
  assert.equal(T.verifySessionToken_(t1.token), 'a@b.com');
  // iat 以「秒」為粒度，確保註銷時間戳 > 簽發秒（同一秒內 iat < rb 不成立）
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    T.sessionRevokeAllDevices_('a@b.com');
    assert.equal(T.verifySessionToken_(t1.token), null, '本裝置 token 應失效');
    assert.equal(T.verifySessionToken_(t2.token), null, '其他裝置 token 也應失效');
  } finally { Date.now = realNow; }
});

test('註銷只影響該帳號；其他帳號的 token 不受影響', () => {
  const props = {};
  const T = makeSession(SECRET, props);
  const victim = T.issueSessionToken_('a@b.com');
  const other = T.issueSessionToken_('c@d.com');
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    T.sessionRevokeAllDevices_('a@b.com');
    assert.equal(T.verifySessionToken_(victim.token), null);
    assert.equal(T.verifySessionToken_(other.token), 'c@d.com');
  } finally { Date.now = realNow; }
});

test('註銷後重新登入（rb 之後簽發）的 token 有效', () => {
  const props = {};
  const T = makeSession(SECRET, props);
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    T.sessionRevokeAllDevices_('a@b.com');
    Date.now = () => realNow() + 4000;  // 再過 2 秒重新登入
    const fresh = T.issueSessionToken_('a@b.com');
    assert.equal(T.verifySessionToken_(fresh.token), 'a@b.com');
  } finally { Date.now = realNow; }
});

test('SESSION_REVOKED_BEFORE 內容毀損（非 JSON）→ 視同空 map，不擋合法 token', () => {
  const props = { SESSION_REVOKED_BEFORE: 'not-json{{{' };
  const T = makeSession(SECRET, props);
  const issued = T.issueSessionToken_('a@b.com');
  assert.equal(T.verifySessionToken_(issued.token), 'a@b.com');
});
