// server/password.js — 自架端的密碼雜湊（scrypt）。
//
// 為什麼要獨立成一個模組（2026-08-19）：這套雜湊原本只寫在 server/index.js 裡，
// 而 gas-host 載入的 Code.gs 有**它自己的一套**（hashPasswordGas_／verifyPasswordGas_，
// PBKDF2＋Script Properties 的 pepper）。於是自架端同時存在兩套密碼系統：
//   /login 與 /admin/accounts 走這一套（寫 users.json）
//   /exec 的 localLogin 走 Code.gs 那一套（讀 store/localAccounts.json）
// 入口搬到 Pages 之後，登入表單是打 /exec ——**管理員重設密碼寫進 users.json，
// 使用者登入卻去讀 localAccounts.json**，於是「重設了還是登不進去」（2026-08-19 實際災情）。
// 拆出來讓 gas-host 也能用同一套，自架端從此只有一份帳號、一種雜湊。
//
// 格式：scrypt$N$r$p$saltHex$keyHex

const crypto = require('node:crypto');

const SCRYPT_KEYLEN = 32;

function scryptDerive_(password, salt, N, r, p) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: N, r: r, p: p, maxmem: 256 * N * r });
}

function verifyPassword_(password, hashStr) {
  const parts = String(hashStr || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!N || !r || !p) return false;
  let salt, key;
  try {
    salt = Buffer.from(parts[4], 'hex');
    key = Buffer.from(parts[5], 'hex');
  } catch (e) { return false; }
  try {
    const derived = scryptDerive_(password, salt, N, r, p);
    return derived.length === key.length && crypto.timingSafeEqual(derived, key);
  } catch (e) { return false; }
}

// 產雜湊（參數同 create-user.js：scrypt N=16384 r=8 p=1、32-byte 金鑰、16-byte 隨機 salt）。
function hashPassword_(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = scryptDerive_(password, salt, N, r, p);
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt.toString('hex') + '$' + key.toString('hex');
}

// 固定的假雜湊（模組載入時算一次）：查無帳號時仍照樣跑一次 scrypt，拉平「帳號不存在」
// 與「密碼錯誤」之間的回應時間差。不對應任何真實密碼。
const DUMMY_HASH = 'scrypt$16384$8$1$' + crypto.randomBytes(16).toString('hex') + '$' + crypto.randomBytes(32).toString('hex');

module.exports = { hashPassword_, verifyPassword_, DUMMY_HASH };
