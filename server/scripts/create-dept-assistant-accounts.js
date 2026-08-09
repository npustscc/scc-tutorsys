#!/usr/bin/env node
// server/scripts/create-dept-assistant-accounts.js — 依系辦助理白名單批次建立本機登入帳號。
//
// 用法：
//   node server/scripts/create-dept-assistant-accounts.js                # 預演（不寫檔）
//   node server/scripts/create-dept-assistant-accounts.js --apply        # 實際建立
//   node server/scripts/create-dept-assistant-accounts.js --apply --reset # 連已存在的帳號一起重設
//   node server/scripts/create-dept-assistant-accounts.js --apply --only a@x.tw,b@x.tw  # 只處理這幾筆
//
// 帳號＝白名單的 email，**初始密碼＝白名單的校內分機（多支時取第一支）**，並標記 mustChangePassword
// （登入頁會邀請改密碼，使用者可選「稍後再做」）。沒填分機的略過——不替人發明密碼。
//
// ⚠️ 初始密碼是 4 碼分機、而且全校查得到，等於「先讓人進得來」而不是安全機制。
// 這個設計只在區網、且尚未有真實手機資料的階段成立；上線收個資前必須：
//   ①確認大家都改過密碼（後台「系辦助理帳號」頁看得到誰還在用初始密碼）②或直接接 SSO。
//
// 預設不覆蓋已存在的帳號（避免把已經改好密碼的人打回分機）；要重設請明確加 --reset。
// 併發：與 upsert-dept-assistants.js 同——跑 --apply 前先停服務。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../config');
const { createHost } = require('../gas-host');
const { initialPasswordFromExt_ } = require('../index');

function hashPassword(password) {
  const N = 16384, r = 8, p = 1, keylen = 32;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, keylen, { N: N, r: r, p: p, maxmem: 256 * N * r });
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt.toString('hex') + '$' + key.toString('hex');
}

function atomicWriteFileSync(filePath, content) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function run(argv) {
  const apply = argv.indexOf('--apply') !== -1;
  const reset = argv.indexOf('--reset') !== -1;
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx === -1 ? null : String(argv[onlyIdx + 1] || '').split(',')
    .map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  const config = loadConfig({});
  const host = createHost({ gsFile: config.gsFile, dataDir: config.dataDir, sendMail: null });
  const ctx = { root: host.rootFolderId };
  const cfg = host.sandbox.readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const assistants = (cfg.deptAssistants || []).filter(function (a) { return a && a.deleted !== true; });

  const usersPath = path.join(config.dataDir, 'users.json');
  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersPath, 'utf8')) || {}; } catch (e) { users = {}; }

  const plan = { create: [], reset: [], skipExisting: [], skipNoExt: [] };
  assistants.forEach(function (a) {
    const email = String(a.email || '').trim().toLowerCase();
    const ext = String(a.ext || '').trim();
    if (!email) return;
    if (only && only.indexOf(email) === -1) return;
    if (!initialPasswordFromExt_(ext)) { plan.skipNoExt.push(email); return; }
    // --only 指名的就是要處理，視同 reset（不然已存在的會被當成「略過」而什麼都沒做）
    if (users[email]) { ((reset || only) ? plan.reset : plan.skipExisting).push(email); return; }
    plan.create.push(email);
  });

  console.log('[create-dept-assistant-accounts] 白名單 ' + assistants.length + ' 筆｜資料目錄 ' + config.dataDir);
  console.log('  新建 ' + plan.create.length + '｜重設 ' + plan.reset.length +
    '｜略過(已有帳號) ' + plan.skipExisting.length + '｜略過(白名單沒填分機) ' + plan.skipNoExt.length);
  plan.skipNoExt.forEach(function (e) { console.log('    - 沒分機，略過：' + e); });
  if (!apply) {
    console.log('[create-dept-assistant-accounts] 預演結束，未寫入。加 --apply 才會真的建立。');
    return { created: 0, dryRun: true, plan: plan };
  }

  const targets = plan.create.concat(plan.reset);
  targets.forEach(function (email) {
    const a = assistants.filter(function (x) { return String(x.email || '').toLowerCase() === email; })[0];
    users[email] = Object.assign({}, users[email] || {}, {
      name: a.name || '', hash: hashPassword(initialPasswordFromExt_(a.ext)),
      disabled: false, mustChangePassword: true,
    });
  });
  atomicWriteFileSync(usersPath, JSON.stringify(users, null, 2));
  console.log('[create-dept-assistant-accounts] 完成：寫入 ' + targets.length + ' 個帳號（初始密碼＝各自分機，已標記須改密碼）');
  return { created: targets.length, dryRun: false, plan: plan };
}

module.exports = { run };

if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (e) {
    console.error('[create-dept-assistant-accounts] ' + e.message);
    process.exit(1);
  }
}
