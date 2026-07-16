#!/usr/bin/env node
// server/scripts/create-user.js — 建立或更新本地登入帳號（server/data/users.json）。
// 用法：node server/scripts/create-user.js <email> <password> [name]
//
// 密碼以 scrypt（N=16384 r=8 p=1，32-byte 金鑰、16-byte 隨機 salt）雜湊後存檔，
// 格式：scrypt$N$r$p$saltHex$keyHex。email 一律轉小寫、去頭尾空白，作為 users.json 主鍵。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../config');

function atomicWriteFileSync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, { mode: 0o600 }); // users.json 含密碼雜湊，0600（rename 保留權限位）
  fs.renameSync(tmp, filePath);
}

function hashPassword(password) {
  const N = 16384, r = 8, p = 1, keylen = 32;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, keylen, { N: N, r: r, p: p, maxmem: 256 * N * r });
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt.toString('hex') + '$' + key.toString('hex');
}

function run(argv, opts) {
  opts = opts || {};
  const email = String(argv[0] || '').trim().toLowerCase();
  const password = argv[1];
  const name = argv[2] || '';
  if (!email || !password) {
    throw new Error('用法：node server/scripts/create-user.js <email> <password> [name]');
  }
  const config = opts.config || loadConfig({ envPath: opts.envPath, repoRoot: opts.repoRoot });
  const usersPath = path.join(config.dataDir, 'users.json');

  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')) || {}; } catch (e) { users = {}; }
  const existed = !!users[email];
  const prevName = (users[email] && users[email].name) || '';
  users[email] = { name: name || prevName, hash: hashPassword(password), disabled: false };
  atomicWriteFileSync(usersPath, JSON.stringify(users, null, 2));

  console.log((existed ? '已更新 ' : '已建立 ') + email);
  return { existed: existed, usersPath: usersPath };
}

module.exports = { run, hashPassword };

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (e) {
    console.error('[create-user] ' + e.message);
    process.exit(1);
  }
}
