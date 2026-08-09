#!/usr/bin/env node
// scripts/build-migration-json.mjs — 從自架實例的 store 產出給 GAS 用的 migration.json。
//
// 用法：node scripts/build-migration-json.mjs [--instance dev|prod] [--out <檔案>]
//
// 產物餵給 GAS 端的 maintenanceImportFromDriveJson()：把檔案上傳到該環境的 Drive 根資料夾，
// 在 GAS 編輯器執行那支零參數函式即可。這條路不需要任何 Drive OAuth 憑證
// （comanage 上沒有 creds.json），也不必為了一次性搬運在 doPost 開一個常駐端點。
//
// **只搬名冊類資料**：colleges / departments / tutorSystems / semesters / classes
// ＋ config.deptAssistants（系辦助理白名單）。刻意不搬：
//   - records_*.json（各環境的紀錄各自獨立，混在一起會讓核章狀態錯亂）
//   - sessions/props/users（憑證與密鑰，永遠不跨環境）
//   - audit_log（稽核軌跡屬於該環境，搬過去等於偽造歷史）
//
// ⚠️ 產物含導師姓名/email/電話等個資，且 repo 是公開的——預設輸出到 repo 外的暫存路徑，
// 不要放進版本控制。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const get = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const instance = get('--instance', 'dev');
const out = get('--out', `/tmp/migration-${instance}.json`);
const SSH_HOST = get('--host', 'scc-server');
const STORE = `~/scc-tutor-${instance}/server/data/store`;

const FILES = ['colleges.json', 'departments.json', 'tutorSystems.json', 'semesters.json', 'classes.json'];

function readRemote(name) {
  // 用 base64 過一手，避免中文/換行在 ssh 管線上被動到
  const b64 = execFileSync('ssh', [SSH_HOST, `base64 -w0 ${STORE}/${name}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

const files = {};
for (const name of FILES) {
  try {
    const data = readRemote(name);
    if (!Array.isArray(data)) throw new Error('內容不是陣列');
    files[name] = data;
    console.log(`  ✓ ${name}：${data.length} 筆`);
  } catch (e) {
    console.log(`  ✗ ${name}：${e.message}（略過）`);
  }
}

let deptAssistants = [];
try {
  const config = readRemote('config.json');
  deptAssistants = (config.deptAssistants || []).filter((a) => a && a.deleted !== true);
  console.log(`  ✓ config.deptAssistants：${deptAssistants.length} 筆`);
} catch (e) {
  console.log(`  ✗ config.deptAssistants：${e.message}`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: `${SSH_HOST}:${STORE}`,
  files,
  deptAssistants,
};
fs.writeFileSync(out, JSON.stringify(payload, null, 2), { mode: 0o600 });
const mb = (fs.statSync(out).size / 1048576).toFixed(2);
console.log(`\n已寫出 ${out}（${mb} MB）`);
console.log('下一步：把這個檔案上傳到目標環境的 Drive 根資料夾，改名為 migration.json，');
console.log('       再到 GAS 編輯器執行零參數函式 maintenanceImportFromDriveJson。');
