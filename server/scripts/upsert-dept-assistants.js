#!/usr/bin/env node
// server/scripts/upsert-dept-assistants.js — 從 JSON 批次建立/更新系辦助理白名單。
//
// 用法：
//   node server/scripts/upsert-dept-assistants.js --file <名單.json>          # 預演（不寫檔）
//   node server/scripts/upsert-dept-assistants.js --file <名單.json> --apply   # 實際寫入
//   （可加 --as <adminEmail> 指定以誰的身分寫，預設用 Code.gs 的 BOOTSTRAP_ADMINS[0]）
//
// 為什麼要有這支：白名單的正式入口是 adminUpsertDeptAssistant，而那個 action 需要 admin
// **登入後的 session token**。要在伺服器上批次灌 37 個系所的名單，若走 HTTP 就得把管理員
// 密碼放進指令列或環境變數——沒必要。這支直接在本機以 node:vm 載入同一份 Code.gs
// （手法同 server/index.js），呼叫 adminUpsertDeptAssistantAction_ 本尊：
//   - 同一條驗證路徑（deptIds 必須是現存且啟用的系所，錯一個就整筆拒絕）
//   - 同一份稽核紀錄（appendAuditLog_ 照寫，by = --as 指定的管理員）
//   - 不需要密碼、不經過網路
// 授權邊界沒有被繞過：能在伺服器上跑這支的人本來就能直接改 <DATA_DIR>/store/config.json。
//
// 併發：本機 LockService 是 no-op stub，這支與線上服務同時寫 config.json 會互相覆蓋
// （2026-07-09 那一系列事故的形狀）。所以 --apply 前請先停服務，跑完再起——
// 與 scripts/migrate-*.mjs 的既有做法一致。
//
// 輸入 JSON：陣列，每列 { deptId, name, email, ext?, title?, note? }。
// 同一個 email 出現在多列 → deptIds 自動合併成一筆（白名單以 email 為鍵）。

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');
const { createHost } = require('../gas-host');

function parseArgs(argv) {
  const out = { file: null, apply: false, as: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--as') out.as = argv[++i];
  }
  return out;
}

function mergeByEmail(rows) {
  const byEmail = new Map();
  rows.forEach(function (r, i) {
    const email = String((r && r.email) || '').trim().toLowerCase();
    if (!email) throw new Error('第 ' + (i + 1) + ' 列缺 email');
    const deptId = String((r && r.deptId) || '').trim();
    if (!deptId) throw new Error('第 ' + (i + 1) + ' 列缺 deptId（' + email + '）');
    if (!byEmail.has(email)) {
      byEmail.set(email, { email: email, name: String(r.name || '').trim(), ext: String(r.ext || '').trim(), deptIds: [] });
    }
    const e = byEmail.get(email);
    if (e.deptIds.indexOf(deptId) === -1) e.deptIds.push(deptId);
  });
  return Array.from(byEmail.values());
}

function run(argv) {
  const args = parseArgs(argv);
  if (!args.file) throw new Error('用法：node server/scripts/upsert-dept-assistants.js --file <名單.json> [--apply] [--as <adminEmail>]');

  const config = loadConfig({});
  const host = createHost({ gsFile: config.gsFile, dataDir: config.dataDir, sendMail: null });
  const ctx = { root: host.rootFolderId };
  const admins = host.sandbox.BOOTSTRAP_ADMINS || [];
  const asEmail = args.as || admins[0];
  if (!asEmail) throw new Error('找不到管理員身分：Code.gs 的 BOOTSTRAP_ADMINS 是空的，請用 --as 指定');

  const rows = JSON.parse(fs.readFileSync(path.resolve(args.file), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('JSON 最外層必須是陣列');
  const entries = mergeByEmail(rows);

  console.log('[upsert-dept-assistants] 資料列 ' + rows.length + ' → 合併後 ' + entries.length + ' 筆（以 email 為鍵）');
  console.log('[upsert-dept-assistants] 身分：' + asEmail + '｜資料目錄：' + config.dataDir);
  console.log('[upsert-dept-assistants] 模式：' + (args.apply ? '實際寫入（--apply）' : '預演（不寫檔）'));

  // 預演也要能看出哪幾筆會被拒——用與 action 相同的驗證函式先跑一遍。
  const departments = host.sandbox.readJsonSafe_('departments.json', ctx, []);
  let planOk = 0;
  const planBad = [];
  entries.forEach(function (e) {
    const chk = host.sandbox.normalizeDeptAssistantDeptIds_(e.deptIds, departments);
    if (chk.ok) planOk++; else planBad.push({ email: e.email, error: chk.error });
  });
  console.log('  預檢：可寫入 ' + planOk + ' 筆、會被拒 ' + planBad.length + ' 筆');
  planBad.forEach(function (b) { console.log('    ✗ ' + b.email + '：' + b.error); });

  if (!args.apply) {
    console.log('[upsert-dept-assistants] 預演結束，未寫入任何資料。加 --apply 才會真的寫。');
    return { applied: 0, failed: planBad.length, dryRun: true };
  }

  let ok = 0;
  const failed = [];
  entries.forEach(function (e) {
    try {
      host.sandbox.adminUpsertDeptAssistantAction_({ deptAssistant: e }, ctx, asEmail);
      ok++;
    } catch (err) {
      failed.push({ email: e.email, error: err.message });
    }
  });
  console.log('[upsert-dept-assistants] 完成：成功 ' + ok + ' 筆、失敗 ' + failed.length + ' 筆');
  failed.forEach(function (f) { console.log('    ✗ ' + f.email + '：' + f.error); });
  return { applied: ok, failed: failed.length, dryRun: false };
}

module.exports = { run, mergeByEmail };

if (require.main === module) {
  try {
    const res = run(process.argv.slice(2));
    process.exit(res.failed > 0 ? 1 : 0);
  } catch (e) {
    console.error('[upsert-dept-assistants] ' + e.message);
    process.exit(1);
  }
}
