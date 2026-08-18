#!/usr/bin/env node
// server/scripts/sync-with-gas.mjs — 一般版（GAS／Drive）與快速版（自架）**雙向**同步名冊。
//
// 用法（在自架實例目錄下跑；預設 dry-run）：
//   node server/scripts/sync-with-gas.mjs
//   node server/scripts/sync-with-gas.mjs --apply
// 設定沿用 import-from-gas 的那四個（server/.env 的 GAS_EXEC_URL / GAS_ROOT_FOLDER_ID /
// GAS_ADMIN_EMAIL / GAS_ADMIN_PASSWORD）。
//
// ── 為什麼不是「兩邊互相蓋過去」──────────────────────────────────────────────
// 使用者 2026-08-18 要求兩邊都保持可寫並且同步。單純互抄有一個必然的失敗模式：
// 同一筆在兩邊都改過時，後跑的那一邊會**安靜地**蓋掉另一邊，沒有人會發現。
//
// 所以這裡做的是**三方比對**：除了兩邊的現況，還存一份「上次同步完成時的樣子」
// （<DATA_DIR>/sync-baseline.json）。有了它就分得出「是誰改的」：
//   只有本機變 → 推上去          只有遠端變 → 拉下來
//   兩邊都變且不一樣 → **衝突：兩邊都不動**，列在報告裡讓人決定（這是刻意的：
//                      自動挑一邊就是回到「安靜蓋掉」，那正是要避免的事）
//   兩邊都變成一樣   → 不用做事，只更新 baseline
//
// **第一次跑**（還沒有 baseline）時，如果兩邊本來就有差異，會拒絕動作並要求先人工對齊
// （用 import-from-gas 或在畫面上處理）——沒有 baseline 就無從判斷誰是新的，
// 這時候猜一邊等於擲骰子決定誰的工作被丟掉。
//
// **不會刪除任何東西**：一邊有、另一邊沒有的班級，只會「新增到另一邊」或列在報告裡，
// 永遠不刪。跨系統的刪除同步是不可逆操作，值不得為了自動化冒這個險。
//
// 範圍：**班級名冊**（名稱、顯示名、導師與其分機/手機、啟用狀態…）。
// 系所的正式全名、系辦助理／校安人員／管理員名單要推上 GAS 需要 GAS 端的 admin 權限，
// 而 importer 帳號是 deptAssistant——見檔尾「還沒做的部分」。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROSTER_FIELDS = ['name', 'displayName', 'deptId', 'systemId', 'requiredMeetingOverride', 'graduatedSemester', 'active'];

// 兩邊的資料形狀不同（本機是完整紀錄、遠端是投影），一律折成同一個可比較的形狀再比。
// 缺欄位補 null、tutors 只留名冊欄位並把舊的 phone 折進 mobile——不正規化的話第一次比對
// 會把幾百筆全報成「有變動」，真正的變動就被雜訊淹掉（import-from-gas 踩過同一個坑）。
export function projectClass(c) {
  if (!c) return null;
  const out = {};
  ROSTER_FIELDS.forEach(function (f) { out[f] = c[f] === undefined ? null : c[f]; });
  out.tutors = (c.tutors || []).map(function (t) {
    return {
      name: (t && t.name) || '', email: (t && t.email) || '',
      ext: (t && t.ext) || '', mobile: (t && (t.mobile || t.phone)) || '',
    };
  });
  return out;
}
const key = (o) => JSON.stringify(o);

// 三方比對（純函式，可單元測試）。回傳要做的動作，不碰任何 I/O。
export function planSync(localById, remoteById, baselineById) {
  const ids = Array.from(new Set(Object.keys(localById).concat(Object.keys(remoteById))));
  const plan = { pull: [], push: [], conflict: [], createLocal: [], createRemote: [], same: 0, missingBaseline: [] };
  for (const id of ids.sort()) {
    const l = localById[id] || null;
    const r = remoteById[id] || null;
    const b = baselineById[id] === undefined ? null : baselineById[id];

    if (l && r && key(l) === key(r)) { plan.same++; continue; }
    if (l && !r) { plan.createRemote.push(id); continue; }
    if (r && !l) { plan.createLocal.push(id); continue; }

    if (b === null) { plan.missingBaseline.push(id); continue; }   // 沒有基準，不猜
    const lChanged = key(l) !== key(b);
    const rChanged = key(r) !== key(b);
    if (lChanged && rChanged) plan.conflict.push(id);
    else if (lChanged) plan.push.push(id);
    else if (rChanged) plan.pull.push(id);
  }
  return plan;
}

// ── 以下是 I/O 與流程 ─────────────────────────────────────────────────────────
function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const cwd = process.cwd();
  const env = readEnv(path.join(cwd, 'server/.env'));
  for (const k of ['GAS_EXEC_URL', 'GAS_ROOT_FOLDER_ID', 'GAS_ADMIN_EMAIL', 'GAS_ADMIN_PASSWORD']) {
    if (!env[k]) throw new Error('server/.env 缺 ' + k);
  }
  const dataDir = path.resolve(cwd, env.DATA_DIR || 'server/data');
  const storeDir = path.join(dataDir, 'store');
  const baselinePath = path.join(dataDir, 'sync-baseline.json');

  const call = async (payload) => {
    const res = await fetch(env.GAS_EXEC_URL, {
      method: 'POST', body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    const j = await res.json();
    if (j && j.success === false) throw new Error(j.error || 'GAS 回應失敗');
    return (j && j.data) || {};
  };
  const login = await call({
    action: 'localLogin', rootFolderId: env.GAS_ROOT_FOLDER_ID,
    email: env.GAS_ADMIN_EMAIL, password: env.GAS_ADMIN_PASSWORD,
  });
  if (!login.sessionToken) throw new Error('登入 GAS 失敗：' + JSON.stringify(login).slice(0, 160));
  const token = login.sessionToken;
  console.log('[sync] 已以 ' + env.GAS_ADMIN_EMAIL + ' 登入一般版');

  const remote = await call({ action: 'deptRosterGet', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token });
  const localRaw = JSON.parse(fs.readFileSync(path.join(storeDir, 'classes.json'), 'utf8'));

  const localById = {}, remoteById = {}, localFull = {};
  localRaw.filter((c) => c && c.deleted !== true).forEach((c) => { localById[c.id] = projectClass(c); localFull[c.id] = c; });
  (remote.classes || []).forEach((c) => { remoteById[c.id] = projectClass(c); });

  let baseline = {};
  let firstRun = false;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).classes || {}; }
  catch (e) { firstRun = true; }

  const plan = planSync(localById, remoteById, baseline);
  console.log('[sync] 本機 ' + Object.keys(localById).length + ' 班、一般版 ' + Object.keys(remoteById).length + ' 班、相同 ' + plan.same);
  const show = (label, ids) => { if (ids.length) console.log('  ' + label + ' ' + ids.length + '：' + ids.slice(0, 8).join('、') + (ids.length > 8 ? ' …' : '')); };
  show('一般版→快速版（只有那邊改）', plan.pull);
  show('快速版→一般版（只有這邊改）', plan.push);
  show('⚠️ 衝突（兩邊都改過，兩邊都不動）', plan.conflict);
  show('一般版有、這邊沒有 → 新增到這邊', plan.createLocal);
  show('這邊有、一般版沒有 → 新增到那邊', plan.createRemote);
  show('⚠️ 沒有同步基準、無法判斷（先人工對齊）', plan.missingBaseline);

  if (firstRun && (plan.pull.length || plan.push.length || plan.conflict.length || plan.missingBaseline.length)) {
    console.log('\n[sync] 這是第一次跑（還沒有同步基準），但兩邊已經有差異——**不動作**。');
    console.log('       請先用 import-from-gas 或在畫面上把兩邊對齊，再跑一次建立基準。');
    process.exitCode = 1;
    return;
  }
  if (!apply) { console.log('\n[sync] 預演結束，未寫入。加 --apply 才會真的同步。'); return; }

  // ① 拉下來（含新增到本機）：改本機檔案
  const pulled = plan.pull.concat(plan.createLocal);
  if (pulled.length) {
    const next = localRaw.slice();
    for (const id of pulled) {
      const r = remote.classes.find((c) => c.id === id);
      const idx = next.findIndex((c) => c && c.id === id);
      if (idx === -1) next.push(Object.assign({ id: id }, r));
      else {
        const merged = Object.assign({}, next[idx]);
        ROSTER_FIELDS.forEach((f) => { merged[f] = r[f] === undefined ? null : r[f]; });
        merged.tutors = (r.tutors || []).map((t) => ({ name: t.name || '', email: t.email || '', ext: t.ext || '', mobile: t.mobile || '' }));
        next[idx] = merged;
      }
    }
    const p = path.join(storeDir, 'classes.json');
    fs.copyFileSync(p, p + '.bak-sync-' + new Date().toISOString().replace(/[:.]/g, '-'));
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, p);
    console.log('  已更新本機 ' + pulled.length + ' 班');
  }

  // ② 推上去：逐筆呼叫 deptRosterUpsertClass（importer 是掛滿所有系的 deptAssistant，寫得動）
  const pushed = [];
  const failed = [];
  for (const id of plan.push.concat(plan.createRemote)) {
    const c = localFull[id];
    if (!c) continue;
    try {
      await call({
        action: 'deptRosterUpsertClass', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token,
        class: {
          id: plan.createRemote.includes(id) ? undefined : id,
          deptId: c.deptId, name: c.name, displayName: c.displayName || c.name,
          tutors: (c.tutors || []).map((t) => ({ name: t.name || '', email: t.email || '', ext: t.ext || '', mobile: t.mobile || t.phone || '' })),
        },
      });
      pushed.push(id);
    } catch (e) { failed.push(id + '：' + e.message); }
  }
  if (pushed.length) console.log('  已推上一般版 ' + pushed.length + ' 班');
  if (failed.length) { console.log('  ⚠️ 推送失敗 ' + failed.length + ' 筆：'); failed.slice(0, 8).forEach((f) => console.log('     ' + f)); }

  // ③ 更新基準：**只把這一輪真的處理完的納入**。衝突與推送失敗的維持舊基準，
  //    下一輪才會再被認出來（把它們寫進基準等於宣告「已同步」，那是說謊）。
  const nextBaseline = Object.assign({}, baseline);
  Object.keys(localById).forEach((id) => {
    if (plan.conflict.includes(id)) return;
    if (failed.some((f) => f.startsWith(id + '：'))) return;
    if (plan.missingBaseline.includes(id)) return;
    nextBaseline[id] = pulled.includes(id) ? remoteById[id] : localById[id];
  });
  plan.createLocal.forEach((id) => { nextBaseline[id] = remoteById[id]; });
  fs.writeFileSync(baselinePath, JSON.stringify({ at: new Date().toISOString(), classes: nextBaseline }, null, 2), { mode: 0o600 });
  console.log('[sync] 完成（同步基準 ' + Object.keys(nextBaseline).length + ' 班）' +
    (plan.conflict.length ? '；**有 ' + plan.conflict.length + ' 筆衝突未處理**' : ''));

  await notifyIfChanged({
    dataDir, env, cwd,
    conflicts: plan.conflict,
    pushFailed: failed,
  });
  if (plan.conflict.length) process.exitCode = 2;
}

// 衝突／推送失敗要寄信通知——不然它只留在 journal，而沒有人會主動去看 journal。
//
// **只在「這一批問題跟上次通知的不一樣」時才寄**。每 5 分鐘一輪，同一筆衝突若每輪都寄，
// 一天就是 288 封，收信的人三天後就會把它整條規則丟進垃圾桶——那等於沒有通知。
// 問題全部排除時另外寄一封「已排除」，讓人知道可以不用再管了（只寄一次）。
async function notifyIfChanged({ dataDir, env, cwd, conflicts, pushFailed }) {
  const statePath = path.join(dataDir, 'sync-alert-state.json');
  const signature = JSON.stringify({ c: conflicts.slice().sort(), f: pushFailed.slice().sort() });
  let last = '';
  try { last = JSON.parse(fs.readFileSync(statePath, 'utf8')).signature || ''; } catch (e) { last = ''; }
  const clean = !conflicts.length && !pushFailed.length;
  if (signature === last) return;                       // 狀況沒變，不重複打擾
  if (clean && !last) { return; }                        // 一直都正常，不需要報平安

  const to = (env.SYNC_ALERT_TO || env.SMTP_USER || '').trim();
  if (!to) { console.log('[sync] 沒有設定通知收件者（SYNC_ALERT_TO／SMTP_USER），略過通知'); return; }
  const require_ = createRequire(path.join(cwd, 'server/x.js'));
  let mailer;
  try {
    const { createMailer } = require_(path.join(cwd, 'server/mailer.js'));
    mailer = createMailer({
      host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465),
      user: env.SMTP_USER, pass: env.SMTP_PASS, fromName: env.MAIL_FROM_NAME,
      auditPath: path.join(dataDir, 'mails.jsonl'),
    });
  } catch (e) { console.log('[sync] 寄信模組載入失敗，略過通知：' + e.message); return; }
  if (!mailer.enabled) { console.log('[sync] 未設定 SMTP，略過通知'); return; }

  const lines = clean
    ? ['先前回報的名冊同步問題已經全部排除，兩邊目前一致。', '', '（此信由系統自動寄出，不需回覆）']
    : [
        '一般版與快速版的名冊同步遇到需要人處理的狀況：', '',
        conflicts.length
          ? '【衝突】同一個班在兩邊都被改過，內容不一樣。系統**兩邊都沒有動**，等人決定要留哪一邊：\n  ' +
            conflicts.join('\n  ') +
            '\n\n處理方式：到其中一邊把它改成正確的內容並存檔（另一邊不要動），下一輪同步就會自動對齊。'
          : '',
        pushFailed.length
          ? '\n【推送失敗】這些班改不上一般版：\n  ' + pushFailed.join('\n  ') +
            '\n\n最常見的原因是同步帳號沒有掛到那個系所（新增系所之後要讓它的系所清單跟上）。'
          : '',
        '', '同步每 5 分鐘跑一次；問題排除後會再寄一封通知。', '（此信由系統自動寄出，不需回覆）',
      ];
  try {
    await mailer.send({
      to: to,
      // 標題只列**真的有**的那幾類。寫成「衝突 0、推送失敗 6」看起來像系統在自言自語，
      // 而收件者只從標題判斷要不要點開。
      subject: clean ? '【導師名冊系統】同步問題已排除' :
        '【導師名冊系統】名冊同步需要處理（' +
        [conflicts.length ? '衝突 ' + conflicts.length : '', pushFailed.length ? '推送失敗 ' + pushFailed.length : '']
          .filter(Boolean).join('、') + '）',
      body: lines.filter(function (x) { return x !== ''; }).join('\n'),
    });
    console.log('[sync] 已寄出通知給 ' + to);
  } catch (e) { console.log('[sync] 通知寄送失敗（不影響同步結果）：' + e.message); }
  fs.writeFileSync(statePath, JSON.stringify({ at: new Date().toISOString(), signature: signature }, null, 2), { mode: 0o600 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('[sync] 失敗：' + e.message); process.exit(1); });
}

// ── 還沒做的部分（需要 GAS 端的 admin 權限）────────────────────────────────────
// 系所正式全名、系辦助理／校安人員／管理員名單、稽核紀錄都只在快速版這邊。要推上一般版
// 得用 adminBulkApplyDeptSheet / adminUpsertDeptAssistant 這類 admin only 的 action，
// 而 importer 帳號是 deptAssistant。做法：在一般版的後台把 importer 設成管理員，
// 這支就能一併同步那些名單。
