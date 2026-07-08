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
};

function makeSession(secret) {
  return load(
    ['getSessionSecret_', 'issueSessionToken_', 'verifySessionToken_', 'nextTaipeiMidnightEpochSec_'],
    {
      Utilities: UtilitiesMock,
      PropertiesService: {
        getScriptProperties: () => ({ getProperty: (k) => (k === 'SESSION_SECRET' ? secret : null) }),
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
