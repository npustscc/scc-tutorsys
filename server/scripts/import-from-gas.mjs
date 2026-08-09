#!/usr/bin/env node
// server/scripts/import-from-gas.mjs — 把 GAS 收集端的名冊拉回校內自架站（決策 6 的 importer）。
//
// 用法（在自架實例目錄下跑；預設 dry-run）：
//   node server/scripts/import-from-gas.mjs
//   node server/scripts/import-from-gas.mjs --apply
//
// 設定放 server/.env（0600，與 SMTP 密碼同一個模式）：
//   GAS_EXEC_URL=https://script.google.com/macros/s/xxx/exec
//   GAS_ROOT_FOLDER_ID=1ZwVw...
//   GAS_ADMIN_EMAIL=npust.scc@heartnpust.tw
//   GAS_ADMIN_PASSWORD=（maintenanceCreateAdminAccount 產生的那組）
//
// ── 為什麼是這個形狀 ────────────────────────────────────────────────────────────
// 走 GAS 的網頁 API 而不是 Drive REST：Drive 那條路需要另一組 OAuth 憑證與同意流程，
// 而 GAS 這條路用的是既有的授權邊界（admin 才拿得到全系所資料），憑證就是一組帳密。
//
// **這是獨立排程腳本，不是對外服務的行程。** server/ 裡 UrlFetchApp／driveGet_ 一律 throw
// 的 fail-closed 設計不動——處理網頁請求的行程永遠沒有對外能力，就算請求處理出漏，
// 攻擊者也沒有把個資送出去的管道。
//
// ── 合併策略（重要）────────────────────────────────────────────────────────────
// 收集端是**名冊**的權威，校內端是**紀錄**的權威。所以只覆蓋名冊欄位，其餘一律保留：
//   覆蓋：name / displayName / deptId / systemId / requiredMeetingOverride /
//         graduatedSemester / active / tutors（含 phone）
//   保留：suggestedTutors / uploadWhitelist / dualApprovalMode / nameHistory /
//         createdAt 等本地欄位——deptRosterGet 是投影，沒有這些欄位，
//         直接整筆覆寫會把它們清空，紀錄與核章的關聯也會跟著壞掉。
// 本地有、收集端沒有的班級**不刪**：那可能是收集端還沒同步到的資料，
// 刪掉就是不可逆的資料遺失；改為列在報告裡讓人判斷。

import fs from 'node:fs';
import path from 'node:path';

// ── 純函式：合併名冊（可單元測試，不碰 I/O）──────────────────────────────────
const ROSTER_FIELDS = ['name', 'displayName', 'deptId', 'systemId', 'requiredMeetingOverride', 'graduatedSemester', 'active'];

export function mergeClasses(localClasses, remoteClasses) {
  const byId = new Map((localClasses || []).map((c) => [c.id, c]));
  const report = { updated: [], created: [], unchanged: [], localOnly: [] };
  const out = (localClasses || []).slice();

  for (const r of (remoteClasses || [])) {
    const local = byId.get(r.id);
    if (!local) {
      out.push({
        id: r.id, name: r.name, deptId: r.deptId, systemId: r.systemId || null,
        displayName: r.displayName || r.name,
        requiredMeetingOverride: r.requiredMeetingOverride === undefined ? null : r.requiredMeetingOverride,
        graduatedSemester: r.graduatedSemester || null,
        tutors: (r.tutors || []).map((t) => ({ name: t.name || '', email: t.email || '', phone: t.phone || '' })),
        suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: r.active !== false,
      });
      report.created.push(r.id);
      continue;
    }
    const before = JSON.stringify([ROSTER_FIELDS.map((f) => local[f]), local.tutors]);
    for (const f of ROSTER_FIELDS) {
      if (r[f] !== undefined) local[f] = r[f];
    }
    local.tutors = (r.tutors || []).map((t) => ({ name: t.name || '', email: t.email || '', phone: t.phone || '' }));
    const after = JSON.stringify([ROSTER_FIELDS.map((f) => local[f]), local.tutors]);
    (before === after ? report.unchanged : report.updated).push(r.id);
  }

  const remoteIds = new Set((remoteClasses || []).map((c) => c.id));
  for (const c of (localClasses || [])) {
    if (!remoteIds.has(c.id) && c.deleted !== true) report.localOnly.push(c.id);
  }
  return { classes: out, report };
}

export function mergeDepartments(localDepts, remoteDepts) {
  const byId = new Map((localDepts || []).map((d) => [d.id, d]));
  const out = (localDepts || []).slice();
  const report = { updated: [], created: [] };
  for (const r of (remoteDepts || [])) {
    const local = byId.get(r.id);
    if (!local) {
      out.push({ id: r.id, name: r.name, collegeId: r.collegeId || null, headEmail: '', headName: '', active: true });
      report.created.push(r.id);
    } else if (local.name !== r.name || (local.collegeId || null) !== (r.collegeId || null)) {
      local.name = r.name;
      local.collegeId = r.collegeId || null;
      report.updated.push(r.id);
    }
  }
  return { departments: out, report };
}

// ── 以下為 I/O 與流程（直接執行時才跑）────────────────────────────────────────
function parseEnv(envPath) {
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

// GAS 的 /exec 會回 302 到 googleusercontent，body 在轉址那一段。fetch 預設會跟隨並保留結果。
async function gasCall(execUrl, payloadObj) {
  const res = await fetch(execUrl, {
    method: 'POST',
    body: new URLSearchParams({ payload: JSON.stringify(payloadObj) }),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('GAS 回應 ' + res.status);
  const json = await res.json();
  if (json && json.success === false) throw new Error(json.error || 'GAS 呼叫失敗');
  const data = (json && json.data) || {};
  if (data.error) throw new Error(data.error);
  return data;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const env = parseEnv(path.join(repoRoot, 'server', '.env'));
  const need = ['GAS_EXEC_URL', 'GAS_ROOT_FOLDER_ID', 'GAS_ADMIN_EMAIL', 'GAS_ADMIN_PASSWORD'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error('server/.env 缺少：' + missing.join(', '));
  const dataDir = path.isAbsolute(env.DATA_DIR || '') ? env.DATA_DIR : path.join(repoRoot, env.DATA_DIR || 'server/data');
  const storeDir = path.join(dataDir, 'store');

  console.log('[import-from-gas] 來源：' + env.GAS_EXEC_URL);
  const login = await gasCall(env.GAS_EXEC_URL, {
    action: 'localLogin', rootFolderId: env.GAS_ROOT_FOLDER_ID,
    email: env.GAS_ADMIN_EMAIL, password: env.GAS_ADMIN_PASSWORD,
  });
  if (!login.sessionToken) throw new Error('登入失敗（沒拿到 sessionToken）');
  console.log('[import-from-gas] 已以 ' + login.email + ' 登入');

  const roster = await gasCall(env.GAS_EXEC_URL, {
    action: 'deptRosterGet', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: login.sessionToken,
  });
  console.log('[import-from-gas] 取得 ' + (roster.departments || []).length + ' 個系所、' +
    (roster.classes || []).length + ' 個班級');
  const withPhone = (roster.classes || []).reduce((n, c) => n + (c.tutors || []).filter((t) => t.phone).length, 0);
  console.log('[import-from-gas] 其中有電話的導師：' + withPhone + ' 位');

  const readLocal = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8')); } catch (e) { return fallback; }
  };
  const cm = mergeClasses(readLocal('classes.json', []), roster.classes || []);
  const dm = mergeDepartments(readLocal('departments.json', []), roster.departments || []);

  console.log('\n班級：更新 ' + cm.report.updated.length + '、新增 ' + cm.report.created.length +
    '、無變動 ' + cm.report.unchanged.length + '、僅存在於本地 ' + cm.report.localOnly.length);
  if (cm.report.localOnly.length) console.log('  僅存在於本地（不會刪除，請人工確認）：' + cm.report.localOnly.slice(0, 10).join('、') + (cm.report.localOnly.length > 10 ? ' …' : ''));
  console.log('系所：更新 ' + dm.report.updated.length + '、新增 ' + dm.report.created.length);

  if (!apply) {
    console.log('\n[import-from-gas] 預演結束，未寫入。加 --apply 才會真的寫。');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const [name, content] of [['classes.json', cm.classes], ['departments.json', dm.departments]]) {
    const p = path.join(storeDir, name);
    try { fs.copyFileSync(p, p + '.bak-gasimport-' + stamp); } catch (e) { /* 原本沒有就不用備份 */ }
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
    fs.renameSync(tmp, p);
    console.log('  已寫入 ' + name);
  }
  console.log('[import-from-gas] 完成（備份字尾 .bak-gasimport-' + stamp + '）');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[import-from-gas] ' + e.message); process.exit(1); });
}
