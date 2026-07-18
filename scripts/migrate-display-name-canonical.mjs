#!/usr/bin/env node
// scripts/migrate-display-name-canonical.mjs — 一次性（idempotent）遷移：把 scc-tutor-dev 上
// 既有 classes.json 的 displayName 收斂到全校 canonical 系所簡稱／碩士班班別字母規則
// （2026-07-18 使用者逐條裁決；規則實作於 dev/Code.gs 的 normalizeClassDisplayName_ 及其
// 輔助函式 classDisplayNameDeptOverride_ / isProtectedClassForDisplayNameNormalization_）。
//
//   node scripts/migrate-display-name-canonical.mjs            # dry-run（預設，只印差異，不寫入）
//   node scripts/migrate-display-name-canonical.mjs --apply     # 實際寫入（會停/起 scc-tutor-dev）
//
// 本腳本不重新實作正規化規則——透過 test/harness.js 直接從 dev/Code.gs 原始碼抽出上述函式在
// Node vm 執行，保證遷移結果與程式匯入時的自動套用邏輯永遠一致，不會分岔。
//
// 範圍：只動 scc-tutor-dev 實例（prod 尚未有 114-2 資料，明確不動；日後 prod 部署新程式碼後，
// 匯入/後續操作會自然套用同一套規則，不需要對 prod 另外遷移）。只改 classes.json 的 displayName
// 欄位——deptId/name/systemId 一律不動，班級身分 (deptId, name) 與 records 的 classId 關聯完全
// 不受影響，功能零影響。
//
// 安全寫入：server/README.md「已知限制」——LockService 在自架環境是 no-op，doPost 全程同步
// 執行，但那只保證「同一 Node 程序內」的請求不會交錯；本腳本是外部程序，若在服務仍運行時
// 直接覆寫 classes.json，會有與某個正在處理中的請求 lost update 的風險（例如某系主任剛好在
// 匯入名冊或後台編輯班級）。因此 --apply 模式一律先 systemctl stop scc-tutor-dev（服務離線，
// 不會再有任何寫入請求）→ 讀檔轉換 → 寫回 → 驗證 JSON 合法 → systemctl start → healthz 確認，
// 全程沒有並發寫入視窗。

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load } = require('../test/harness.js');

const APPLY = process.argv.includes('--apply');
const INSTANCE = 'scc-tutor-dev';
const STORE_DIR = '~/scc-tutor-dev/server/data/store';
const HEALTHZ_PORT = 8790;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function sshCat(remotePath) {
  return sh('ssh', ['scc-server', 'cat ' + remotePath]);
}

// 直接沿用 dev/Code.gs 的正規化函式（避免遷移腳本與正式規則分岔，見檔頭說明）。
const S = load([
  'deptShortName_',
  'classDisplayNameDeptOverride_',
  'isProtectedClassForDisplayNameNormalization_',
  'normalizeClassDisplayName_',
]);

console.log('[migrate] 讀取 ' + INSTANCE + ' 現有 classes.json / departments.json ...');
const classes = JSON.parse(sshCat(STORE_DIR + '/classes.json'));
const departments = JSON.parse(sshCat(STORE_DIR + '/departments.json'));
const deptById = {};
departments.forEach((d) => { if (d) deptById[d.id] = d; });

const diffs = [];
const unmatched = [];
let unchangedCount = 0;

const nextClasses = classes.map((c) => {
  if (!c) return c;
  const dept = deptById[c.deptId];
  const deptName = dept ? dept.name : null;
  const result = S.normalizeClassDisplayName_(c.displayName, deptName, c.systemId, c.name);
  if (!result.matched) {
    unmatched.push({ id: c.id, deptName, systemId: c.systemId, name: c.name, displayName: c.displayName });
  }
  if (result.changed) {
    diffs.push({ id: c.id, deptName, systemId: c.systemId, before: c.displayName, after: result.value });
    return Object.assign({}, c, { displayName: result.value });
  }
  unchangedCount++;
  return c;
});

console.log('[migrate] 總班級數：' + classes.length);
console.log('[migrate] 會變動：' + diffs.length + '　本來就符合：' + unchangedCount + '　需人工複核（找不到預期簡稱子字串）：' + unmatched.length);
console.log('[migrate] --- before -> after（全部 ' + diffs.length + ' 筆變動）---');
diffs.forEach((d) => console.log('  ' + d.before + '  ->  ' + d.after + '   [' + d.systemId + ']  (' + d.id + ')'));
if (unmatched.length) {
  console.log('[migrate] --- 需人工複核（覆寫理論上適用，但找不到子字串，原樣保留）---');
  unmatched.forEach((u) => console.log('  ' + u.id + '  displayName=' + u.displayName + '  dept=' + u.deptName));
}

if (!APPLY) {
  console.log('[migrate] dry-run 完成，未寫入。確認無誤後加 --apply 才會實際更新 ' + INSTANCE + '（會停/起服務）。');
  process.exit(0);
}

if (diffs.length === 0) {
  console.log('[migrate] 沒有需要變動的項目（idempotent）：不需停服務，結束。');
  process.exit(0);
}

console.log('[migrate] 停止 ' + INSTANCE + ' ...');
sh('ssh', ['scc-server', 'sudo systemctl stop ' + INSTANCE]);

let wrote = false;
try {
  const payload = JSON.stringify(nextClasses, null, 2);
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  // 先寫暫存檔、用 node -e 驗證是合法 JSON 且筆數不變，才 mv 覆蓋正式檔——避免半寫或壞檔。
  const remoteWriteScript = [
    'set -e',
    'TMP=$(mktemp)',
    'base64 -d > "$TMP"',
    'node -e "const d=JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\')); if(!Array.isArray(d)||d.length!==' + classes.length + ') { throw new Error(\'sanity check failed: length=\'+d.length); } console.log(\'OK \'+d.length)" "$TMP"',
    'mv "$TMP" ' + STORE_DIR + '/classes.json',
  ].join('\n');
  const out = execFileSync('ssh', ['scc-server', remoteWriteScript], { input: b64, encoding: 'utf8' });
  console.log('[migrate] 寫回結果：' + out.trim());
  wrote = true;
} finally {
  console.log('[migrate] 啟動 ' + INSTANCE + ' ...');
  sh('ssh', ['scc-server', 'sudo systemctl start ' + INSTANCE]);
  try {
    const health = sh('ssh', ['scc-server', 'sleep 2; curl -sf http://127.0.0.1:' + HEALTHZ_PORT + '/healthz > /dev/null && echo HEALTHZ_OK']);
    console.log('[migrate] ' + health.trim());
  } catch (e) {
    console.error('[migrate] healthz 檢查失敗——服務可能沒起來，上 scc-server 看 journalctl -u ' + INSTANCE);
    throw e;
  }
}

if (wrote) {
  console.log('[migrate] 完成：' + diffs.length + ' 筆 displayName 已收斂為全校 canonical 簡稱。');
}
