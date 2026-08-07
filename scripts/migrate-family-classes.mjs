#!/usr/bin/env node
// scripts/migrate-family-classes.mjs — 一次性（idempotent）修復：把 scc-tutor-dev 上「塌成一班」
// 的家族班改名為帶導師姓名的唯一班名，讓修好的匯入器在使用者重新上傳名冊時能補齊其餘家族班。
//
//   node scripts/migrate-family-classes.mjs            # dry-run（預設，只印差異，不寫入）
//   node scripts/migrate-family-classes.mjs --apply     # 實際寫入（會停/起 scc-tutor-dev）
//
// 背景（2026-08-07 實查）：家族班的班級身分應該是「每位家族導師各自一班」，但
// `114-2導師名單上傳範例.xlsx` 的班名欄 61 列全填「家族」。匯入以 (deptId, 班名) 認班 →
// 同系所有家族列撞在同一班；而匯入「Excel 視為權威、直接覆寫 tutors」，後一列蓋掉前一列，
// 最後每系只剩名冊最後那一列那位導師。dev 實查：61 列 → 8 班，其餘 53 位導師從未進入系統。
// 匯入器已於 `65eb488` 修正（familyClassNameForImport_ 把班名補成「家族＋姓名」）。
//
// 為什麼是「改名」而不是「刪掉重建」：
//   1. 那 8 個班各自都還留著 1 位導師，改名即可保住它，不必刪任何資料——零刪除、零遺失。
//   2. 重建 61 班等於在腳本裡重寫一套匯入邏輯，將來一定跟 Code.gs 分岔。缺的 53 班應該由
//      使用者重新上傳同一份 Excel、走修好的正式路徑產生（順便實地驗證修正本身）。
//   3. 刪除版還有個副作用：系統對軟刪班級是 fail-closed 的（匯入命中已刪除班級 → 拒絕該列），
//      名冊裡沒填導師姓名的家族列重匯時會被擋成 'class disabled' 而不是正常處理。
//
// 只改 classes.json 的 `name` 與 `displayName` 兩個欄位。班級 `id` 一律不動，所以 records 的
// classId 關聯、tutorHistory 的 classId 都不受影響（`name` 沒有任何東西引用它做外鍵）。
//
// displayName 不自己拼——透過 test/harness.js 從 dev/Code.gs 抽出 fuseClassDisplayName_ 本尊產生，
// 保證與匯入時的自動套用邏輯永遠一致，不會分岔（比照 migrate-display-name-canonical.mjs）。
//
// 前置檢查（不成立就中止，一個字都不寫）：
//   - store 內沒有 records_*.json。改名本身不斷 classId，但若已有歷史紀錄，正確做法是同時
//     append nameHistory 讓 classNameForSemester_ 查得到舊學期的班名；本腳本的前提是
//     「舊班名『家族』從來不是有效班名、也沒有任何學期的紀錄用過它」，所以不寫 nameHistory。
//   - 改名後的班名不得與同系所既有班級撞名（會產生兩個相同身分的班級）。
//   - 拿不到導師姓名的目標一律略過不動（不發明班名），並列出來要求人工處理。
//
// 安全寫入：比照 migrate-display-name-canonical.mjs——LockService 在自架環境是 no-op，外部程序
// 直接覆寫 classes.json 會與正在處理中的請求 lost update，因此 --apply 一律 systemctl stop →
// 讀改寫 → 驗證 JSON 與筆數 → systemctl start → healthz（打 .env 實際的 BIND，不寫死 loopback）。

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load } = require('../test/harness.js');

const APPLY = process.argv.includes('--apply');
const INSTANCE = 'scc-tutor-dev';
const INSTANCE_DIR = '~/scc-tutor-dev';
const STORE_DIR = INSTANCE_DIR + '/server/data/store';
const HEALTHZ_PORT = 8790;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function ssh(script, opts = {}) {
  return sh('ssh', ['scc-server', script], opts);
}

const S = load(['deptShortName_', 'fuseClassDisplayName_']);

// ── 讀取現況 ───────────────────────────────────────────────────────────────────
console.log('[migrate] 讀取 ' + INSTANCE + ' 的 store ...');
const listing = ssh('ls ' + STORE_DIR).trim().split('\n').map((s) => s.trim()).filter(Boolean);
const recordFiles = listing.filter((f) => /^records_.*\.json$/.test(f));
console.log('[migrate] store 檔案：' + listing.join(', '));

const classes = JSON.parse(ssh('cat ' + STORE_DIR + '/classes.json'));
const departments = JSON.parse(ssh('cat ' + STORE_DIR + '/departments.json'));
const deptById = {};
departments.forEach((d) => { if (d) deptById[d.id] = d; });

if (recordFiles.length) {
  console.error('[migrate] ✗ store 內有紀錄檔：' + recordFiles.join(', '));
  console.error('          已有歷史紀錄時，改名應同時 append nameHistory 讓 classNameForSemester_');
  console.error('          查得到舊學期班名。本腳本的前提（舊班名從未被任何學期的紀錄使用）不成立，中止。');
  process.exit(1);
}

const targets = classes.filter((c) => c && c.name === '家族');
console.log('[migrate] 班級總數：' + classes.length + '　待改名（name === "家族"）：' + targets.length);

if (!targets.length) {
  console.log('[migrate] 沒有 name === "家族" 的班級——已經修過或本來就沒問題（idempotent），結束。');
  process.exit(0);
}

// ── 規劃 ───────────────────────────────────────────────────────────────────────
const plan = [];
const skipped = [];
const collisions = [];

targets.forEach((c) => {
  const dept = deptById[c.deptId];
  const deptName = dept ? dept.name : null;
  const who = ((c.tutors || [])[0] || {}).name;
  const tutorName = String(who || '').trim();
  if (!tutorName) {
    skipped.push({ id: c.id, displayName: c.displayName, reason: '班上沒有導師姓名，無法產生唯一班名' });
    return;
  }
  const newName = '家族' + tutorName;
  const newDisplayName = S.fuseClassDisplayName_(newName, deptName, 'family', tutorName);
  const clash = classes.filter(function (o) {
    return o && o.id !== c.id && o.deptId === c.deptId && o.name === newName;
  })[0];
  if (clash) {
    collisions.push({ id: c.id, newName: newName, clashWith: clash.id });
    return;
  }
  plan.push({ id: c.id, deptName: deptName, tutorName: tutorName,
    beforeName: c.name, afterName: newName,
    beforeDisplay: c.displayName, afterDisplay: newDisplayName });
});

console.log('\n[migrate] --- 改名計畫（' + plan.length + ' 筆）---');
plan.forEach((p) => {
  console.log('  ' + p.id);
  console.log('      name:        ' + p.beforeName + '  ->  ' + p.afterName);
  console.log('      displayName: ' + p.beforeDisplay + '  ->  ' + p.afterDisplay);
});
if (skipped.length) {
  console.log('\n[migrate] --- 略過、需人工處理（' + skipped.length + ' 筆）---');
  skipped.forEach((s) => console.log('  ' + s.id + '　displayName=' + s.displayName + '　' + s.reason));
}
if (collisions.length) {
  console.error('\n[migrate] ✗ 改名後會與同系所既有班級撞名（' + collisions.length + ' 筆）：');
  collisions.forEach((x) => console.error('  ' + x.id + ' -> ' + x.newName + ' 已被 ' + x.clashWith + ' 佔用'));
  console.error('[migrate] 撞名會產生兩個相同身分 (deptId, name) 的班級，中止，未寫入。');
  process.exit(1);
}
if (!plan.length) {
  console.log('[migrate] 沒有可改名的目標，結束（未寫入）。');
  process.exit(0);
}

const planById = {};
plan.forEach((p) => { planById[p.id] = p; });
const nextClasses = classes.map((c) => {
  const p = c && planById[c.id];
  return p ? Object.assign({}, c, { name: p.afterName, displayName: p.afterDisplay }) : c;
});
const expectedRemainingFamily = skipped.length;

if (!APPLY) {
  console.log('\n[migrate] dry-run 完成，未寫入。確認無誤後加 --apply（會停/起 ' + INSTANCE + '）。');
  process.exit(0);
}

console.log('\n[migrate] 停止 ' + INSTANCE + ' ...');
sh('ssh', ['scc-server', 'sudo systemctl stop ' + INSTANCE]);

let wrote = false;
try {
  const b64 = Buffer.from(JSON.stringify(nextClasses, null, 2), 'utf8').toString('base64');
  // 先寫暫存檔並驗證（合法 JSON、筆數不變、殘留的「家族」班數等於預期），才 mv 覆蓋正式檔。
  const remoteWriteScript = [
    'set -e',
    'TMP=$(mktemp)',
    'base64 -d > "$TMP"',
    'node -e "const d=JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\'));'
      + ' if(!Array.isArray(d)||d.length!==' + classes.length + ')'
      + ' { throw new Error(\'sanity: length=\'+d.length); }'
      + ' const f=d.filter(c=>c&&c.name===\'家族\').length;'
      + ' if(f!==' + expectedRemainingFamily + ')'
      + ' { throw new Error(\'sanity: 殘留家族班=\'+f+\' 預期=' + expectedRemainingFamily + '\'); }'
      + ' console.log(\'OK \'+d.length+\' 筆，殘留家族班 \'+f)" "$TMP"',
    'cp ' + STORE_DIR + '/classes.json ' + STORE_DIR + '/classes.json.bak-family-migrate',
    'mv "$TMP" ' + STORE_DIR + '/classes.json',
  ].join('\n');
  const out = execFileSync('ssh', ['scc-server', remoteWriteScript], { input: b64, encoding: 'utf8' });
  console.log('[migrate] 寫回結果：' + out.trim());
  console.log('[migrate] 原檔已備份為 classes.json.bak-family-migrate');
  wrote = true;
} finally {
  console.log('[migrate] 啟動 ' + INSTANCE + ' ...');
  sh('ssh', ['scc-server', 'sudo systemctl start ' + INSTANCE]);
  try {
    const health = ssh([
      'sleep 2',
      'BIND_ADDR="$(grep -E "^BIND=" ' + INSTANCE_DIR + '/server/.env | cut -d= -f2- | tr -d "[:space:]")"',
      'BIND_ADDR="${BIND_ADDR:-127.0.0.1}"',
      'curl -sf "http://$BIND_ADDR:' + HEALTHZ_PORT + '/healthz" > /dev/null && echo HEALTHZ_OK',
    ].join('\n'));
    console.log('[migrate] ' + health.trim());
  } catch (e) {
    console.error('[migrate] healthz 檢查失敗——服務可能沒起來，上 scc-server 看 journalctl -u ' + INSTANCE);
    throw e;
  }
}

if (wrote) {
  console.log('\n[migrate] 完成：' + plan.length + ' 個家族班已改名為帶導師姓名的唯一班名。');
  console.log('[migrate] 接下來必須做這一步，否則那些系所仍只有 1 位家族導師：');
  console.log('  1. 開 http://192.168.100.123:8790/ 以 admin 登入');
  console.log('  2. 到「匯入」上傳同一份 114-2 導師名單');
  console.log('     （Drive：00Claude_Working_Directory/scc-tutorsys/114-2導師名單上傳範例.xlsx）');
  console.log('  3. 差異預覽應顯示新增 53 個家族班；已改名的 ' + plan.length + ' 個會是「更新」而非新增');
  console.log('  4. 匯入後家族班總數應為 61（原本 8）');
}
