#!/usr/bin/env node
// 環境常數守門員：確認 prod（Code.gs / index.html / .clasp.json）與 dev（dev/ 底下同名檔案）
// 的環境專屬常數（Drive 根資料夾 ID、GAS 部署 URL、GAS scriptId）彼此不相同。
//
// 為什麼需要它：promote 時用 Copy-Item dev→prod 會把 dev 的環境專屬常數一起帶進正式版，
// 兩者必須成對改回 prod 值，缺一都會讓正式版完全無法登入（rootFolderId 不在白名單）。
// 這是 scc-infosys 2026-07-03 事故的教訓：人工比對曾漏改其中一個常數，
// 造成正式版打到測試版後端、全面 Unauthorized。
//
// 目前状态（scaffold 階段）：GAS scriptId / Drive 根資料夾 ID / 部署 URL 都還是
// `__XXX__` 形式的 placeholder（步驟 4 由使用者填入實際值），因此本腳本對 placeholder
// 狀態只警告、不視為失敗——CI 現階段應該是綠燈。等實際值填入後，才會真正比對
// dev/prod 是否相同（相同就是事故重演，直接 fail）。
//
// 用法：node scripts/check-env-constants.mjs      → 綠燈 exit 0（含警告）；比對失敗 exit 1
// 建議：每次 promote（Copy-Item 後、git push 前）必跑，無 ✗ 才能推。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function load(relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8');
  } catch (e) {
    return null;
  }
}

function readConstFromJs(text, name) {
  const m = text.match(new RegExp("const\\s+" + name + "\\s*=\\s*'([^']*)'"));
  return m ? m[1] : null;
}

function readJsonField(text, field) {
  try {
    const obj = JSON.parse(text);
    return obj[field] !== undefined && obj[field] !== null ? String(obj[field]) : null;
  } catch (e) {
    return null;
  }
}

function isPlaceholder(v) {
  return typeof v === 'string' && /^__.+__$/.test(v);
}

let failed = false;
let warned = false;

// 「dev 必須不同於 prod」的常數清單：一邊是實作用（Code.gs / .clasp.json），
// 一邊是前端要打的部署 URL（index.html）——兩邊都要各自檢查一次。
const PAIRS = [
  {
    label: 'GAS scriptId (.clasp.json)',
    prodFile: '.clasp.json', devFile: 'dev/.clasp.json',
    extract: (t) => readJsonField(t, 'scriptId'),
  },
  {
    label: 'Drive 根資料夾 ID (Code.gs)',
    prodFile: 'Code.gs', devFile: 'dev/Code.gs',
    extract: (t) => readConstFromJs(t, 'ROOT_FOLDER_ID'),
  },
  {
    label: 'Drive 根資料夾 ID (index.html)',
    prodFile: 'index.html', devFile: 'dev/index.html',
    extract: (t) => readConstFromJs(t, 'ROOT_FOLDER_ID'),
  },
  {
    label: 'GAS 部署 URL (index.html APPS_SCRIPT_URL)',
    prodFile: 'index.html', devFile: 'dev/index.html',
    extract: (t) => readConstFromJs(t, 'APPS_SCRIPT_URL'),
  },
];

for (const pair of PAIRS) {
  const prodText = load(pair.prodFile);
  const devText = load(pair.devFile);
  if (prodText === null || devText === null) {
    console.error(`✗ [${pair.label}] 讀不到檔案：${pair.prodFile} 或 ${pair.devFile}`);
    failed = true;
    continue;
  }
  const prodVal = pair.extract(prodText);
  const devVal = pair.extract(devText);
  if (prodVal === null || devVal === null) {
    console.error(`✗ [${pair.label}] 找不到常數（prod=${prodVal} dev=${devVal}）`);
    failed = true;
    continue;
  }

  const prodPlaceholder = isPlaceholder(prodVal);
  const devPlaceholder = isPlaceholder(devVal);

  if (prodPlaceholder && devPlaceholder) {
    console.warn(`⚠ [${pair.label}] prod/dev 都還是 placeholder，尚未填入實際值（步驟 4 待辦）：prod=${prodVal} dev=${devVal}`);
    warned = true;
    continue;
  }
  if (prodPlaceholder || devPlaceholder) {
    console.warn(`⚠ [${pair.label}] 只有一邊已填入實際值，另一邊仍是 placeholder：prod=${prodVal} dev=${devVal}`);
    warned = true;
    continue;
  }
  if (prodVal === devVal) {
    console.error(`✗ [${pair.label}] prod 與 dev 相同值——這正是 scc-infosys 2026-07-03 事故的模式（漏改其中一個環境常數）：${prodVal}`);
    failed = true;
    continue;
  }
  console.log(`✓ [${pair.label}] prod=${prodVal} dev=${devVal}（相異，正確）`);
}

// CLIENT_ID：prod/dev 預期「相同」（同一個 GCP OAuth Client，沿用 scc-infosys 的設定），
// 只檢查不是 placeholder、且兩邊一致，不比對相異。
{
  const prodHtml = load('index.html');
  const devHtml = load('dev/index.html');
  if (prodHtml === null || devHtml === null) {
    console.error('✗ [CLIENT_ID] 讀不到 index.html 或 dev/index.html');
    failed = true;
  } else {
    const prodCid = readConstFromJs(prodHtml, 'CLIENT_ID');
    const devCid = readConstFromJs(devHtml, 'CLIENT_ID');
    if (!prodCid || !devCid) {
      console.error('✗ [CLIENT_ID] 找不到常數');
      failed = true;
    } else if (isPlaceholder(prodCid) || isPlaceholder(devCid)) {
      console.warn(`⚠ [CLIENT_ID] 仍是 placeholder，尚未填入：prod=${prodCid} dev=${devCid}`);
      warned = true;
    } else if (prodCid !== devCid) {
      console.error(`✗ [CLIENT_ID] prod 與 dev 不同——預期兩者共用同一個 OAuth Client：prod=${prodCid} dev=${devCid}`);
      failed = true;
    } else {
      console.log(`✓ [CLIENT_ID] prod/dev 相同（預期行為，共用同一 OAuth Client）：${prodCid}`);
    }
  }
}

if (failed) {
  console.error('\n環境常數檢查失敗 —— 請勿 push/promote。');
  process.exit(1);
}
if (warned) {
  console.log('\n環境常數檢查通過，但仍有 placeholder 尚未填入實際值（步驟 4 待辦，不阻擋 CI）。');
} else {
  console.log('\n環境常數全部正確 ✅');
}
process.exit(0);
