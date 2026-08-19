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
// 比較用的投影**刻意不含 advisees**：一般版的後端還不認識這個欄位，納入比較的話
// 每一輪都會把「遠端沒有」讀成「遠端清空了」，於是本機的值被反覆清掉。
// 等一般版的後端也支援了（Code.gs 已改、待 clasp push），把 advisees 加進來就會開始同步。
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

// 配對兩邊的班級（純函式）。**先用 id 配，配不到的再用「系所＋班名」配**。
//
// 為什麼需要第二把鑰匙：同一個班可能在兩邊各自被建立過，而 id 是由系所＋班名衍生的、
// 撞名時會自動加 `_2`——於是同一個「四技二B」在一邊是 `農企系_四技二B`、另一邊是
// `農企系_四技二B_2`。只用 id 配的話它們會被當成「兩邊各有一個對方沒有的班」，
// 於是每一輪都嘗試新增、每一輪都被對方以「class name already exists」拒絕，永遠不會收斂
// （2026-08-18 實際發生兩次）。
//
// 順序很重要：**id 優先**。反過來（名字優先）會把「改名」誤判成「刪一個、加一個」，
// 而改名是很常見的操作。
export function pairClasses(localById, remoteById) {
  const nameKey = (c) => (c ? String(c.deptId || '') + '\u0000' + String(c.name || '') : '');
  const pairs = [];
  const usedRemote = new Set();
  const leftover = [];

  // **第一趟只做 id 配對**，第二趟才用班名補。分兩趟不是為了好看：單趟掃描時，
  // 排在前面的本機班可能用「班名」先把某個遠端班配走，而稍後那個**同 id** 的本機班
  // 又會再配到它一次——同一個遠端班被配兩次，統計就會出現「本機 380、遠端 377、相同 380」
  // 這種不可能的數字，而那 3 個沒被真正配到的本機班會被當成已同步（2026-08-18 實際發生）。
  for (const lid of Object.keys(localById).sort()) {
    if (remoteById[lid]) { pairs.push({ lid: lid, rid: lid }); usedRemote.add(lid); }
    else leftover.push(lid);
  }
  for (const lid of leftover) {
    const want = nameKey(localById[lid]);
    const rid = Object.keys(remoteById).find((k) => !usedRemote.has(k) && nameKey(remoteById[k]) === want);
    if (rid) { pairs.push({ lid: lid, rid: rid, viaName: true }); usedRemote.add(rid); }
    else pairs.push({ lid: lid, rid: null });
  }
  for (const rid of Object.keys(remoteById).sort()) {
    if (!usedRemote.has(rid)) pairs.push({ lid: null, rid: rid });
  }
  return pairs;
}

// 衝突的裁判（純函式）：兩邊都改過同一筆時，**時間戳比較新的那一邊留下**。
// 使用者 2026-08-19：「不會讓他們選擇一般版或快速版，所以應該從時間戳記判斷哪一筆比較新」。
//
// 為什麼這比原本的「兩邊都不動」好：使用者不再知道自己打的是哪一邊，所以「凍結等人來看」
// 對他而言只是「我改的東西沒生效」而已，而且他不會知道要去看報告。後改的贏至少符合直覺。
// 代價是**舊的那筆會被覆蓋**，所以被蓋掉的內容一定要進報告與通知信（呼叫端負責）。
//
// 判不出來時（任一邊沒有時間戳、或兩邊一樣）**退回凍結**：沒有證據就不要猜，
// 猜錯是靜靜地弄丟別人剛填的資料。舊資料多半沒有 updatedAt（都是匯入來的、沒人編輯過），
// 而真的發生衝突＝兩邊都被人編輯過＝兩邊都會有時間戳，所以這個退路實務上很少用到。
export function resolveByTimestamp(localAt, remoteAt) {
  const l = String(localAt || ''), r = String(remoteAt || '');
  if (!l || !r || l === r) return 'freeze';
  return l > r ? 'push' : 'pull';       // ISO 8601 字串可以直接字典序比較
}

// 名單（系辦助理／校安人員）的既有列怎麼對齊（純函式）。
//
// 2026-08-18 的事故就發生在這個縫：舊版把本機整份推上一般版，蓋掉別人剛改好的分機；
// 修成「只補對面缺的整筆」之後不再蓋人，但**既有列從此永遠不會互相追上**——
// 兩邊各自漂移了好幾天沒有人發現，而使用者實際打開的是快速版，看到的是舊分機，
// 於是全校的初始密碼都是錯的。
//
// 規則跟班級一致：內容不同就比 updatedAt，**後改的贏**；判不出來（缺戳或同時間）
// 就兩邊都不動、只回報。ROW_IGNORE 裡的欄位不參與比較，否則同一份內容會因為戳不同
// 而永遠互推。
const ROW_IGNORE = ['updatedAt', 'updatedBy'];
export function rowContent(row) {
  const out = {};
  Object.keys(row || {}).filter((k) => !ROW_IGNORE.includes(k)).sort()
    .forEach((k) => { out[k] = row[k]; });
  return JSON.stringify(out);
}
export function planListSync(localRows, remoteRows) {
  const plan = { pull: [], push: [], undecided: [] };
  const byEmail = (rows) => new Map((rows || [])
    .filter((r) => r && r.email)
    .map((r) => [String(r.email).toLowerCase(), r]));
  const L = byEmail(localRows), R = byEmail(remoteRows);
  for (const [email, l] of L) {
    const r = R.get(email);
    if (!r) continue;                                  // 對面沒有 → 走既有的「新增」那條路
    if (rowContent(l) === rowContent(r)) continue;
    const verdict = resolveByTimestamp(l.updatedAt, r.updatedAt);
    if (verdict === 'push') plan.push.push(email);
    else if (verdict === 'pull') plan.pull.push({ email, row: r });
    else plan.undecided.push(email);
  }
  return plan;
}

// 三方比對（純函式，可單元測試）。回傳要做的動作，不碰任何 I/O。
// 基準以**本機 id** 為鍵（本機 id 是這一端的穩定識別）。
export function planSync(localById, remoteById, baselineById, stamps, tombstones) {
  const at = stamps || { local: {}, remote: {} };
  // 本機已刪除的班（`deleted:true`）。**沒有這份名單，刪除看起來就跟「從來沒有過」一樣**，
  // 於是每一輪都會把它當成「那邊有、這邊沒有」再接回來一次（2026-08-19 資管系實際發生）。
  const gone = tombstones instanceof Set ? tombstones : new Set(tombstones || []);
  const plan = {
    pull: [], push: [], conflict: [], createLocal: [], createRemote: [], deletedHere: [],
    same: 0, missingBaseline: [], idMismatch: [], overwritten: [],
    // 本機 id → 一般版 id 的對照。名字配對出來的那些兩邊 id 不同，**推送必須用對方的 id**，
    // 拿本機 id 去打會得到 class not found。
    ridOf: {},
  };
  for (const { lid, rid, viaName } of pairClasses(localById, remoteById)) {
    const l = lid ? localById[lid] : null;
    const r = rid ? remoteById[rid] : null;
    const b = (lid && baselineById[lid] !== undefined) ? baselineById[lid] : null;
    if (lid && rid) plan.ridOf[lid] = rid;
    if (viaName) {
      plan.idMismatch.push(lid + ' ↔ ' + rid);
      // **靠班名配對起來的一對，只用來避免徒勞的「新增」，絕不拿來同步內容。**
      // 2026-08-18 實際災情：coma 的「獸醫系_四技五A」（導師林春福，剛填好分機與手機）
      // 被名字相同、但其實是**另一個班**的一般版「獸醫系_四技四A」（導師林韋豪）整筆蓋掉，
      // 那兩位導師的聯絡資料就這樣消失，而畫面上完全看不出來。
      // id 不同就代表「這兩筆是不是同一個班」沒有證據，只有人能判斷——所以只報告，不搬資料。
      continue;
    }

    if (l && r && key(l) === key(r)) { plan.same++; continue; }
    if (l && !r) { plan.createRemote.push(lid); continue; }
    if (r && !l) {
      // 這邊刪掉了、那邊還在 → **不要接回來**。也不主動去刪那邊（跨系統的刪除是不可逆
      // 動作，要由人決定），只列出來讓人處理。
      if (gone.has(rid)) { plan.deletedHere.push(rid); continue; }
      plan.createLocal.push(rid); continue;
    }

    if (b === null) { plan.missingBaseline.push(lid); continue; }   // 沒有基準，不猜
    const lChanged = key(l) !== key(b);
    const rChanged = key(r) !== key(b);
    if (lChanged && rChanged) {
      // 兩邊都改過：交給時間戳裁判，判不出來才凍結。
      const verdict = resolveByTimestamp(at.local[lid], at.remote[rid]);
      if (verdict === 'push') { plan.push.push(lid); plan.overwritten.push({ side: '一般版', id: rid, at: at.remote[rid] }); }
      else if (verdict === 'pull') { plan.pull.push(lid); plan.overwritten.push({ side: '快速版', id: lid, at: at.local[lid] }); }
      else plan.conflict.push(lid + (viaName ? '（一般版 id：' + rid + '）' : ''));
    }
    else if (lChanged) plan.push.push(lid);
    else if (rChanged) plan.pull.push(lid);
  }
  return plan;
}

// 找出「同一個系、同一個班名」的其他本機班（含自己）。同名重複是同步永遠不會收斂的根因，
// 報告要指名道姓，不然看的人只會看到一句「class name already exists」而無從下手。
export function duplicateNameIds(localFullById, id) {
  const me = localFullById[id];
  if (!me) return [];
  return Object.keys(localFullById).filter(function (k) {
    const c = localFullById[k];
    return c && c.deptId === me.deptId && c.name === me.name;
  }).sort();
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

  // GAS 偶發會回一頁 HTML 錯誤頁而不是 JSON（2026-08-19 這一輪就是這樣整輪失敗，
  // 前端 proxyCall 早就有同樣的重試）。**只重試「傳輸層沒談成」**——回得出 JSON 但
  // success:false 是後端的判斷，重試只會重複做一樣的事。
  const call = async (payload, attempt) => {
    attempt = attempt || 1;
    let text;
    try {
      const res = await fetch(env.GAS_EXEC_URL, {
        method: 'POST', body: new URLSearchParams({ payload: JSON.stringify(payload) }),
      });
      text = await res.text();
    } catch (e) {
      text = null;
      if (attempt >= 3) throw e;
    }
    let j = null;
    if (text != null) { try { j = JSON.parse(text); } catch (e) { j = null; } }
    if (j == null) {
      if (attempt >= 3) {
        throw new Error('GAS 回的不是 JSON（多半是它自己的錯誤頁）：' + String(text || '').slice(0, 120));
      }
      console.log('[sync] GAS 回應異常，' + (attempt * 4) + " 秒後重試（第 " + attempt + ' 次）');
      await new Promise((r) => setTimeout(r, attempt * 4000));
      return call(payload, attempt + 1);
    }
    if (j.success === false) throw new Error(j.error || 'GAS 回應失敗');
    return j.data || {};
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

  // 衝突的裁判材料：兩邊各自的最後編輯時間（不進內容比較，只在衝突時用）。
  const stamps = { local: {}, remote: {} };
  Object.keys(localFull).forEach((k) => { stamps.local[k] = localFull[k].updatedAt || localFull[k].createdAt || ''; });
  (remote.classes || []).forEach((c) => { stamps.remote[c.id] = c.updatedAt || c.createdAt || ''; });

  // 墓碑：本機被刪掉的班（含它們的 id），交給 planSync 才不會每輪把它們接回來。
  const tombstones = new Set(localRaw.filter((c) => c && c.deleted === true).map((c) => c.id));

  const plan = planSync(localById, remoteById, baseline, stamps, tombstones);
  console.log('[sync] 本機 ' + Object.keys(localById).length + ' 班、一般版 ' + Object.keys(remoteById).length + ' 班、相同 ' + plan.same);
  const show = (label, ids) => { if (ids.length) console.log('  ' + label + ' ' + ids.length + '：' + ids.slice(0, 8).join('、') + (ids.length > 8 ? ' …' : '')); };
  show('一般版→快速版（只有那邊改）', plan.pull);
  show('快速版→一般版（只有這邊改）', plan.push);
  show('⚠️ 衝突且判不出新舊（兩邊都不動，需人工看）', plan.conflict);
  if (plan.overwritten.length) {
    console.log('  ⚠️ 兩邊都改過、由時間戳判定覆蓋 ' + plan.overwritten.length + ' 筆（較舊的那一邊被蓋掉）：');
    plan.overwritten.forEach(function (o) { console.log('     ' + o.id + '：覆蓋掉' + o.side + ' ' + (o.at || '（無時間）') + ' 的版本'); });
  }
  show('一般版有、這邊沒有 → 新增到這邊', plan.createLocal);
  show('這邊已刪除、一般版還在（不接回來，也不自動刪那邊）', plan.deletedHere);
  show('這邊有、一般版沒有 → 新增到那邊', plan.createRemote);
  show('⚠️ 沒有同步基準、無法判斷（先人工對齊）', plan.missingBaseline);
  show('兩邊 id 不同、靠班名配對起來的（**只避免重複新增，不同步內容**，請人工確認是不是同一班）', plan.idMismatch);
  // 同名重複會讓其中一筆永遠配不到對象、每輪都嘗試新增又被拒。先列出來。
  const dupGroups = {};
  Object.keys(localFull).forEach(function (k) {
    const c = localFull[k];
    if (!c) return;
    const key2 = String(c.deptId) + ' / ' + String(c.name);
    (dupGroups[key2] = dupGroups[key2] || []).push(k);
  });
  const dups = Object.keys(dupGroups).filter(function (k) { return dupGroups[k].length > 1; });
  if (dups.length) {
    console.log('  ⚠️ 本機有同名重複的班（同步永遠不會收斂，請留一筆）：');
    dups.forEach(function (k) { console.log('     ' + k + ' → ' + dupGroups[k].join('、')); });
  }

  if (firstRun && (plan.pull.length || plan.push.length || plan.conflict.length || plan.missingBaseline.length)) {
    console.log('\n[sync] 這是第一次跑（還沒有同步基準），但兩邊已經有差異——**不動作**。');
    console.log('       請先用 import-from-gas 或在畫面上把兩邊對齊，再跑一次建立基準。');
    process.exitCode = 1;
    return;
  }
  // ── 名單（主責／助理／管理員／系辦助理／校安人員）────────────────────────────
  // 走 GAS 上的兩個專用通道。**users／staffLeads／staffAssistants 只拉不推**——那三份
  // 等於管理員權限，寫入的路留著就是把「憑一組存在 .env 的密碼變成管理員」這條路留著。
  // 所以：那三份以一般版為準（拉下來覆蓋本機）；deptAssistants／safetyOfficers 才雙向。
  try {
    const remoteLists = (await call({
      action: 'syncGetConfigLists', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token,
    })).lists || {};
    const cfgPath = path.join(storeDir, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const cnt = (v) => Array.isArray(v) ? v.filter((x) => x && !x.deleted).length : Object.keys(v || {}).length;
    const pulledLists = [];
    for (const k of ['users', 'staffLeads', 'staffAssistants']) {
      const before = JSON.stringify(cfg[k] || (k === 'users' ? {} : []));
      const after = JSON.stringify(remoteLists[k] || (k === 'users' ? {} : []));
      if (before !== after) {
        cfg[k] = remoteLists[k];
        pulledLists.push(k + '（' + cnt(remoteLists[k]) + '）');
      }
    }
    if (pulledLists.length) {
      if (apply) {
        fs.copyFileSync(cfgPath, cfgPath + '.bak-sync-' + new Date().toISOString().replace(/[:.]/g, '-'));
        const tmp = cfgPath + '.tmp-' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, cfgPath);
      }
      console.log('  名單（一般版→快速版，只拉不推）：' + pulledLists.join('、') + (apply ? '' : '（預演，未寫入）'));
    }
    // 可雙向的兩份：**兩個方向都要補**。只推不拉的話，一般版上新增的系辦助理永遠不會出現在
    // 快速版——而快速版才是使用者實際會打開的那一個。
    const pulledRows = [];
    for (const k of ['deptAssistants', 'safetyOfficers']) {
      const localRows = (cfg[k] || []);
      const localEmails = new Set(localRows.map((x) => String((x && x.email) || '').toLowerCase()));
      const missing = (remoteLists[k] || []).filter((x) => x && !x.deleted &&
        !localEmails.has(String(x.email || '').toLowerCase()));
      if (!missing.length) continue;
      cfg[k] = localRows.concat(missing);
      pulledRows.push(k + '（' + missing.length + '）');
    }
    if (pulledRows.length) {
      if (apply) {
        const tmp2 = cfgPath + '.tmp2-' + process.pid;
        fs.writeFileSync(tmp2, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        fs.renameSync(tmp2, cfgPath);
      }
      console.log('  名單（一般版→快速版，新增）：' + pulledRows.join('、') + (apply ? '' : '（預演，未寫入）'));
    }

    // 既有列的內容對齊（後改的贏）。缺這一段，兩邊的分機／姓名會各自漂移到天荒地老。
    const listPushRows = {};
    for (const k of ['deptAssistants', 'safetyOfficers']) {
      const lp = planListSync(cfg[k] || [], remoteLists[k] || []);
      if (lp.pull.length) {
        const rows = cfg[k] || [];
        lp.pull.forEach(function (hit) {
          const i = rows.findIndex((x) => String((x && x.email) || '').toLowerCase() === hit.email);
          if (i !== -1) rows[i] = Object.assign({}, hit.row);
        });
        cfg[k] = rows;
        if (apply) {
          const tmp4 = cfgPath + '.tmp4-' + process.pid;
          fs.writeFileSync(tmp4, JSON.stringify(cfg, null, 2), { mode: 0o600 });
          fs.renameSync(tmp4, cfgPath);
        }
        console.log('  名單（一般版→快速版，那邊比較新）：' + k + ' ' + lp.pull.length + ' 筆：' +
          lp.pull.map((x) => x.email).slice(0, 6).join('、') + (apply ? '' : '（預演，未寫入）'));
      }
      if (lp.push.length) {
        const byEmail = new Map((cfg[k] || []).map((x) => [String((x && x.email) || '').toLowerCase(), x]));
        listPushRows[k] = lp.push.map((e) => byEmail.get(e)).filter(Boolean);
        console.log('  名單（快速版→一般版，這邊比較新）：' + k + ' ' + lp.push.length + ' 筆：' +
          lp.push.slice(0, 6).join('、'));
      }
      if (lp.undecided.length) {
        console.log('  ⚠️ 名單內容兩邊不同、判不出新舊（都不動）：' + k + ' ' +
          lp.undecided.length + ' 筆：' + lp.undecided.slice(0, 8).join('、'));
      }
    }

    // 本機有、遠端沒有的推上去（整份送，GAS 端逐筆走既有的 upsert action）
    const pushLists = Object.assign({}, listPushRows);
    for (const k of ['deptAssistants', 'safetyOfficers']) {
      const localRows = (cfg[k] || []).filter((x) => x && !x.deleted);
      const remoteRows = (remoteLists[k] || []).filter((x) => x && !x.deleted);
      const remoteByEmail = new Set(remoteRows.map((x) => String(x.email || '').toLowerCase()));
      const missing = localRows.filter((x) => !remoteByEmail.has(String(x.email || '').toLowerCase()));
      if (missing.length) pushLists[k] = (pushLists[k] || []).concat(missing);
    }
    if (Object.keys(pushLists).length) {
      const n = Object.keys(pushLists).map((k) => k + ' ' + pushLists[k].length).join('、');
      if (apply) {
        const r = await call({
          action: 'syncPutConfigLists', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token, lists: pushLists,
        });
        console.log('  名單（快速版→一般版）：' + JSON.stringify(r.applied) +
          (r.rejected && r.rejected.length ? '，被拒 ' + r.rejected.length + ' 筆' : ''));
        // 只印數字沒有用——看的人需要知道「為什麼」才處理得了。
        (r.rejected || []).slice(0, 8).forEach((x) => console.log('     ' + x));
        if ((r.rejected || []).length > 8) console.log('     …其餘 ' + (r.rejected.length - 8) + ' 筆同類');
      } else {
        console.log('  名單（快速版→一般版，預演）：' + n);
      }
    }
  } catch (e) {
    // 名單同步失敗不該讓班級同步的結果報廢（一般版還沒部署新版時就會走到這裡）。
    console.log('  ⚠️ 名單同步略過：' + e.message);
  }

  if (!apply) { console.log('\n[sync] 預演結束，未寫入。加 --apply 才會真的同步。'); return; }

  // ① 拉下來（含新增到本機）：改本機檔案
  const pulled = plan.pull.concat(plan.createLocal);
  if (pulled.length) {
    const next = localRaw.slice();
    for (const id of pulled) {
      // id 可能是本機 id（pull）或一般版 id（createLocal）；前者要換成配對到的一般版 id。
      const rid = plan.ridOf[id] || id;
      const r = remote.classes.find((c) => c.id === rid);
      const idx = next.findIndex((c) => c && c.id === id);
      if (idx === -1) next.push(Object.assign({ id: id }, r));
      else {
        const merged = Object.assign({}, next[idx]);
        ROSTER_FIELDS.forEach((f) => { merged[f] = r[f] === undefined ? null : r[f]; });
        // 輔導人數：**遠端是空的就保留本機的值**（依姓名對）。
        // 一般版的後端還不認識這個欄位，會把它靜靜丟掉；若照著遠端寫回去，
        // 助理在快速版填好的數字會在下一輪同步被清成空的（實際會發生，不是理論風險）。
        const localByName = {};
        (next[idx].tutors || []).forEach((t) => { if (t && t.name) localByName[t.name] = t; });
        merged.tutors = (r.tutors || []).map((t) => {
          const remoteAdv = t.advisees != null ? String(t.advisees) : '';
          const keep = localByName[t.name || ''];
          return {
            name: t.name || '', email: t.email || '', ext: t.ext || '', mobile: t.mobile || '',
            advisees: remoteAdv !== '' ? remoteAdv : ((keep && keep.advisees != null) ? String(keep.advisees) : ''),
          };
        });
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
          id: plan.createRemote.includes(id) ? undefined : (plan.ridOf[id] || id),
          deptId: c.deptId, name: c.name, displayName: c.displayName || c.name,
          tutors: (c.tutors || []).map((t) => ({ name: t.name || '', email: t.email || '',
            ext: t.ext || '', mobile: t.mobile || t.phone || '', advisees: t.advisees != null ? String(t.advisees) : '' })),
        },
      });
      pushed.push(id);
    } catch (e) {
      // 「class name already exists」的真正原因（2026-08-18 查證，先前的猜測是錯的）：
      // **本機同一個系有兩筆同名的班**，其中一筆已經用 id 跟遠端配上了，另一筆就配不到對象，
      // 於是被當成「要新增」，而遠端當然說那個名字已經有人用了。
      // 來源是舊式的「改名升級」（把班名往上移一屆、id 沒動），後來有人又補建了 id 正確的班。
      // 這種要由人決定留哪一筆——所以只報告、不自動處理。
      const dupIds = duplicateNameIds(localFull, id);
      const hint = /already exists/.test(e.message) && dupIds.length
        ? '（本機這個系有兩筆同名的班：' + dupIds.join('、') + '，請留一筆）' : '';
      failed.push(id + '：' + e.message + hint);
    }
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
    nextBaseline[id] = pulled.includes(id) ? remoteById[plan.ridOf[id] || id] : localById[id];
  });
  plan.createLocal.forEach((id) => { nextBaseline[id] = remoteById[id]; });
  fs.writeFileSync(baselinePath, JSON.stringify({ at: new Date().toISOString(), classes: nextBaseline }, null, 2), { mode: 0o600 });
  console.log('[sync] 完成（同步基準 ' + Object.keys(nextBaseline).length + ' 班）' +
    (plan.conflict.length ? '；**有 ' + plan.conflict.length + ' 筆衝突未處理**' : ''));

  // ── 稽核：把另一邊的軌跡拉過來，兩邊合成一張表 ─────────────────────────────
  // 使用者實際踩到的問題：助理在一般版填手機，快速版的稽核頁完全看不到那個人。
  // 只拉不推——各自的稽核就是各自的事實，推上去等於在對方的紀錄裡插入我這邊的內容。
  try {
    const a = await call({ action: 'syncGetAudit', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token });
    const n = (a.changes || []).length + (a.views || []).length + (a.sessions || []).length;
    if (apply) {
      const p2 = path.join(storeDir, 'audit_remote.json');
      const tmp3 = p2 + '.tmp-' + process.pid;
      fs.writeFileSync(tmp3, JSON.stringify({
        at: new Date().toISOString(), source: '一般版',
        changes: a.changes || [], views: a.views || [], sessions: a.sessions || [],
      }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp3, p2);
    }
    console.log('  稽核（一般版→快速版）：' + n + ' 筆' + (apply ? '' : '（預演，未寫入）'));
  } catch (e) {
    console.log('  ⚠️ 稽核同步略過：' + e.message);
  }

  await notifyIfChanged({
    dataDir, env, cwd,
    conflicts: plan.conflict,
    pushFailed: failed,
    overwritten: apply ? plan.overwritten : [],
  });
  if (plan.conflict.length) process.exitCode = 2;
}

// 衝突／推送失敗要寄信通知——不然它只留在 journal，而沒有人會主動去看 journal。
//
// **只在「這一批問題跟上次通知的不一樣」時才寄**。每 5 分鐘一輪，同一筆衝突若每輪都寄，
// 一天就是 288 封，收信的人三天後就會把它整條規則丟進垃圾桶——那等於沒有通知。
// 問題全部排除時另外寄一封「已排除」，讓人知道可以不用再管了（只寄一次）。
async function notifyIfChanged({ dataDir, env, cwd, conflicts, pushFailed, overwritten }) {
  overwritten = overwritten || [];
  const statePath = path.join(dataDir, 'sync-alert-state.json');
  const signature = JSON.stringify({
    c: conflicts.slice().sort(), f: pushFailed.slice().sort(),
    o: overwritten.map(function (x) { return x.id + '@' + (x.at || ''); }).sort(),
  });
  let last = '';
  try { last = JSON.parse(fs.readFileSync(statePath, 'utf8')).signature || ''; } catch (e) { last = ''; }
  const clean = !conflicts.length && !pushFailed.length && !overwritten.length;
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
        overwritten.length
          ? '\n【已依時間戳自動覆蓋】同一個班在兩邊都被改過，系統留下**比較晚存檔**的那一版，' +
            '較早的那一版已被覆蓋。若被覆蓋的才是對的，請重新輸入一次：\n  ' +
            overwritten.map(function (o) { return o.id + '（覆蓋掉' + o.side + ' ' + (o.at || '無時間') + ' 的版本）'; }).join('\n  ')
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
        [conflicts.length ? '衝突 ' + conflicts.length : '',
         overwritten.length ? '自動覆蓋 ' + overwritten.length : '',
         pushFailed.length ? '推送失敗 ' + pushFailed.length : '']
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
