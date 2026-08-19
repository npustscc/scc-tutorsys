#!/usr/bin/env node
// server/scripts/migrate-cohort-ids.mjs — 班級 id 改用入學學年度的一次性遷移（自架端）。
//
//   node server/scripts/migrate-cohort-ids.mjs              # 預演（預設）
//   node server/scripts/migrate-cohort-ids.mjs --apply      # 實際寫入
//   node server/scripts/migrate-cohort-ids.mjs --apply --also-remote   # 連一般版一起改
//
// 規則與報告都來自 Code.gs 的 planCohortMigration_／migrateCohortIdsCore_ 本尊——
// **刻意不在這裡重寫一份**：兩邊算出不同的 id 就是災難，而那種不一致很難被看見。
//
// ⚠️ 這是不可逆的改寫（雖然會先備份）。做之前：停掉同步 timer、請助理暫停編輯。
//   sudo systemctl stop scc-tutor-sync.timer
// 做完之後：重建同步基準（id 全變了，舊基準必須丟掉），再把 timer 開回來。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(path.join(process.cwd(), 'server/x.js'));
const { loadConfig } = require_(path.join(process.cwd(), 'server/config.js'));
const { createHost } = require_(path.join(process.cwd(), 'server/gas-host.js'));

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    out[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim();
  }
  return out;
}

function printReport(where, r) {
  console.log('  [' + where + '] 遷移 ' + r.migrated + '｜不動（非年級制）' + r.skipped +
    '｜已遷移過 ' + (r.alreadyMigrated || 0) + '｜獸醫系補五年制 ' + r.vetFixed);
  // 以 classId 為鍵的其他資料（導師異動歷程等）也會跟著改。**一定要印出來**：
  // 漏了它不會有任何錯誤訊息，畫面只會安靜地顯示「沒有紀錄」。
  const refs = r.refsRemapped || {};
  const refKeys = Object.keys(refs);
  console.log('    連帶改鍵：' + (refKeys.length
    ? refKeys.map((f) => f + ' ' + refs[f] + ' 筆').join('、')
    : '（沒有以 classId 為鍵的資料需要改）'));
  if (r.collisions.length) {
    console.log('    ⚠️ 新 id 撞名 ' + r.collisions.length + ' 組（遷移會中止）：');
    r.collisions.slice(0, 5).forEach((c) => console.log('       ' + c.newId + ' ← ' + c.from.join('、')));
  }
  if (r.noTemplate.length) {
    console.log('    ⚠️ 顯示名套不上樣板（會沿用存起來的顯示名）' + r.noTemplate.length + ' 筆：');
    r.noTemplate.slice(0, 5).forEach((x) => console.log('       ' + x));
  }
  (r.idChanges || []).slice(0, 5).forEach((x) => console.log('    ' + x));
  if ((r.idChanges || []).length > 5) console.log('    …其餘 ' + (r.idChanges.length - 5) + ' 筆');
}

const apply = process.argv.includes('--apply');
const alsoRemote = process.argv.includes('--also-remote');
const cwd = process.cwd();
const config = loadConfig({});
const host = createHost({ gsFile: config.gsFile, dataDir: config.dataDir, sendMail: null });
const ctx = { root: host.rootFolderId };
const actor = 'npust.scc@heartnpust.tw';   // 頂層 const 拿不到 BOOTSTRAP_ADMINS，明確指定
const year = host.sandbox.academicYearOf_();

console.log('[migrate] 學年度 ' + year + '（一年級＝' + year + ' 入學）｜模式：' +
  (apply ? '實際寫入（--apply）' : '預演') + (alsoRemote ? '｜含一般版' : ''));

// 先備份本機 classes.json（腳本自己備，不依賴排程）
if (apply) {
  const p = path.join(config.dataDir, 'store', 'classes.json');
  const bak = p + '.bak-cohort-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, bak);
  console.log('[migrate] 已備份 ' + path.basename(bak));
}

const local = host.sandbox.migrateCohortIdsCore_({ year: year, apply: apply }, ctx, actor);
printReport('快速版', local.report);

if (alsoRemote) {
  const env = readEnv(path.join(cwd, 'server/.env'));
  const call = async (payload) => {
    const res = await fetch(env.GAS_EXEC_URL, {
      method: 'POST', body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    const j = await res.json();
    if (j && j.success === false) throw new Error(j.error || 'GAS 回應失敗');
    return (j && j.data) || {};
  };
  const token = (await call({
    action: 'localLogin', rootFolderId: env.GAS_ROOT_FOLDER_ID,
    email: env.GAS_ADMIN_EMAIL, password: env.GAS_ADMIN_PASSWORD,
  })).sessionToken;
  // **兩邊用同一個 year**：讓自架端算出來的入學學年度與一般版一致。
  // 不傳的話兩邊各自取「現在的學年度」，跨過 8/1 那一刻執行就會差一屆。
  const r = await call({
    action: 'migrateCohortIds', rootFolderId: env.GAS_ROOT_FOLDER_ID, sessionToken: token,
    year: year, apply: apply,
  });
  printReport('一般版', r.report);
}

console.log(apply
  ? '\n[migrate] 完成。**接下來一定要重建同步基準**（id 全變了）：\n' +
    '  rm -f ' + path.join(config.dataDir, 'sync-baseline.json') + '\n' +
    '  node server/scripts/sync-with-gas.mjs --apply    # 第一次跑會重新建立基準\n' +
    '  sudo systemctl start scc-tutor-sync.timer'
  : '\n[migrate] 預演結束，未寫入。確認數字無誤後加 --apply（建議一併 --also-remote）。');
