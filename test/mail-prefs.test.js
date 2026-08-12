// test/mail-prefs.test.js — 「其他收信信箱」的兩條規則（dev/Code.gs 的純函式）。
// 這組設定的失效模式是安靜的：設錯了不會有人收到錯誤訊息，只會有人「再也沒收到通知」，
// 而且從畫面上看不出來。所以規則本身要釘死。
//
//   mailTargetsForEntry_  — 把一筆名單攤成實際收件者清單
//   normalizeMailPrefs_   — 寫入前的驗證（格式、以及「不寄給登入信箱又沒填 alt」）

const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./harness');

const S = load(['mailTargetsForEntry_', 'normalizeMailPrefs_']);

// ── mailTargetsForEntry_：預設寄登入信箱、填了 alt 兩個都寄、勾了 noPrimary 只寄 alt ──

test('沒設定任何偏好 → 只寄登入信箱', () => {
  assert.deepEqual(S.mailTargetsForEntry_({ email: 'a@x.com' }), ['a@x.com']);
});

test('填了其他收信信箱 → 兩個都寄（登入信箱在前）', () => {
  assert.deepEqual(
    S.mailTargetsForEntry_({ email: 'a@x.com', altEmail: 'b@y.com' }),
    ['a@x.com', 'b@y.com'],
  );
});

test('勾了不寄登入信箱 → 只寄其他收信信箱', () => {
  assert.deepEqual(
    S.mailTargetsForEntry_({ email: 'a@x.com', altEmail: 'b@y.com', noPrimaryMail: true }),
    ['b@y.com'],
  );
});

test('alt 與登入信箱相同 → 不重複寄兩封', () => {
  assert.deepEqual(
    S.mailTargetsForEntry_({ email: 'a@x.com', altEmail: 'a@x.com' }),
    ['a@x.com'],
  );
});

test('noPrimaryMail 只認 true 本尊（字串 "false"／1 之類不算數）', () => {
  assert.deepEqual(S.mailTargetsForEntry_({ email: 'a@x.com', noPrimaryMail: 'false' }), ['a@x.com']);
  assert.deepEqual(S.mailTargetsForEntry_({ email: 'a@x.com', noPrimaryMail: 1 }), ['a@x.com']);
});

test('空白會被去掉：只有空白的 alt 不算填了', () => {
  assert.deepEqual(S.mailTargetsForEntry_({ email: ' a@x.com ', altEmail: '   ' }), ['a@x.com']);
});

test('entry 是 null／沒有 email → 空清單，不會炸', () => {
  assert.deepEqual(S.mailTargetsForEntry_(null), []);
  assert.deepEqual(S.mailTargetsForEntry_({}), []);
  assert.deepEqual(S.mailTargetsForEntry_({ altEmail: 'b@y.com' }), ['b@y.com']);
});

// ── normalizeMailPrefs_：寫入前的守門 ────────────────────────────────────────

test('沒填 alt、沒勾 noPrimary → 通過，並正規化成空字串／false', () => {
  assert.deepEqual(S.normalizeMailPrefs_({ email: 'a@x.com' }), { ok: true, altEmail: '', noPrimaryMail: false });
});

test('alt 一律轉小寫並去空白（比對與寄送才不會因大小寫分岔）', () => {
  assert.deepEqual(
    S.normalizeMailPrefs_({ email: 'a@x.com', altEmail: '  B@Y.COM ' }),
    { ok: true, altEmail: 'b@y.com', noPrimaryMail: false },
  );
});

test('alt 格式不對 → 擋下來', () => {
  for (const bad of ['not-an-email', 'a@b', 'a b@c.com', '@y.com', 'a@']) {
    const r = S.normalizeMailPrefs_({ email: 'a@x.com', altEmail: bad });
    assert.strictEqual(r.ok, false, bad + ' 應該被擋');
    assert.match(r.error, /其他收信信箱格式不正確/);
  }
});

test('alt 過長（>100）→ 擋下來', () => {
  const long = 'a'.repeat(95) + '@y.com';
  const r = S.normalizeMailPrefs_({ email: 'a@x.com', altEmail: long });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /過長/);
});

// 這一條是整組設定裡唯一會造成「靜默失聯」的組合：不寄登入信箱、又沒有替代信箱。
test('勾了不寄登入信箱卻沒填 alt → 擋下來（否則這個人從此收不到任何通知）', () => {
  const r = S.normalizeMailPrefs_({ email: 'a@x.com', noPrimaryMail: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /必須填其他收信信箱/);
  // 只有空白也一樣不算填了
  assert.strictEqual(S.normalizeMailPrefs_({ email: 'a@x.com', altEmail: '  ', noPrimaryMail: true }).ok, false);
});

test('勾了不寄登入信箱且有 alt → 通過', () => {
  assert.deepEqual(
    S.normalizeMailPrefs_({ email: 'a@x.com', altEmail: 'b@y.com', noPrimaryMail: true }),
    { ok: true, altEmail: 'b@y.com', noPrimaryMail: true },
  );
});

// 守門通過的設定，攤開來必定至少有一個收件者——兩個函式合起來才是完整的不變量。
test('凡是通過守門的設定，收件者都不會是空的', () => {
  const cases = [
    { email: 'a@x.com' },
    { email: 'a@x.com', altEmail: 'b@y.com' },
    { email: 'a@x.com', altEmail: 'b@y.com', noPrimaryMail: true },
    { email: 'a@x.com', altEmail: 'A@X.COM' },
  ];
  for (const c of cases) {
    const p = S.normalizeMailPrefs_(c);
    assert.strictEqual(p.ok, true, JSON.stringify(c));
    const targets = S.mailTargetsForEntry_({ email: c.email, altEmail: p.altEmail, noPrimaryMail: p.noPrimaryMail });
    assert.ok(targets.length > 0, '收件者不該是空的：' + JSON.stringify(c));
  }
});
