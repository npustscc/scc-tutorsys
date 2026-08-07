#!/usr/bin/env node
// scripts/promote.mjs — 把 dev/ 推行到正式版（跨平台，取代 CLAUDE.md 原本的 PowerShell Copy-Item 流程）。
//
//   node scripts/promote.mjs            → 預演（dry-run）：只印出會改什麼，不寫檔
//   node scripts/promote.mjs --apply    → 實際寫入 Code.gs / index.html，並跑守門員
//   node scripts/promote.mjs --check    → 只檢查「現有的 prod 檔有沒有殘留 dev 標記」（CI 用，不寫檔）
//
// 為什麼需要它（2026-08-07 建立的動機）：
//   promote 的本質是「複製 dev→prod，再把所有環境專屬差異換回 prod 的樣子」。
//   這份差異一共 13 處，但 CLAUDE.md 的人工流程只寫了其中 2 處（ROOT_FOLDER_ID、APPS_SCRIPT_URL），
//   check-env-constants.mjs 也只驗那 4 個常數。結果 2026-07-18 的 `a14d5b7` 推行時，
//   另外 10 處被 dev 版整批蓋掉且守門員全綠：正式版畫面掛「測試版」badge、<title> 是（測試版）、
//   登入通知信 subject/內文都寫「測試版」、doGet 回報 (DEV)（診斷標記報錯環境）、
//   Code.gs 開頭留著「此為測試版專用 GAS，只能存取 dev 資料夾」這種與事實相反的註解——
//   一路帶到線上三週沒被發現（更早的 `a91cb04` 也犯過同一類錯，當時只漏 doGet 標記一項）。
//   人工比對 13 處、每次推行都要做對，不是能長期靠紀律維持的事，所以改成機器做。
//
// 設計原則：**任何一條規則沒有剛好命中預期次數就中止**，絕不「找不到就跳過」——
//   靜默跳過正是上面那次事故的形狀。dev 端如果改了措辭導致規則失配，這裡會紅燈要求先更新規則，
//   寧可擋下推行，也不要推出一個「看起來成功、其實漏改」的正式版。

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 環境專屬常數（唯一事實來源；改這裡時 check-env-constants.mjs 會在推行後把關）──
const ENV = {
  ROOT_FOLDER_ID: {
    prod: '1ZwVwWEQ6bUWgS_5WpKP3NF0DTlSca7Ik',
    dev: '1y4vyMvVoVp-b4-ORLEJEOERDtmNasQVT',
  },
  APPS_SCRIPT_URL: {
    prod: 'https://script.google.com/macros/s/AKfycbxsMTiA4bzY5m72nyjd2V-wiJ2e-J5374jGbXOze2iKmZRTcUznesS5kWypY_0fGw8/exec',
    dev: 'https://script.google.com/macros/s/AKfycbypvwRn39uF4vsfSQHdNxCSrPhSEyCw7Sg0s6YUPdHC27OU_g4XCtcQZI7QIAnKhrbdkw/exec',
  },
};

// ── prod/dev 差異全表 ──
// 抽自「最後一次正確 promote」`a780b61` 的 diff（Code.gs 8 處、index.html 5 處）。
// count = 這段 dev 文字在 dev 檔裡預期出現幾次；實際次數不符即中止。
const FILES = [
  {
    dev: 'dev/Code.gs',
    prod: 'Code.gs',
    rules: [
      {
        what: '檔首環境註記',
        dev: '// Code.gs — 導師資訊系統 SCC Drive Proxy（測試版）',
        prodText: '// Code.gs — 導師資訊系統 SCC Drive Proxy（正式版）',
      },
      {
        what: '檔首警語（測試版說「只能存取 dev 資料夾」，留在正式版是反話）',
        dev: '// ⚠️ 此為測試版專用 GAS，只能存取 dev 資料夾，不可存取正式版資料。',
        prodText: '// ⚠️ 此為正式版專用 GAS，只能存取正式版資料夾，不可存取 dev 資料。',
      },
      {
        what: 'ROOT_FOLDER_ID（環境常數，帶錯整版無法登入）',
        dev: `const ROOT_FOLDER_ID = '${ENV.ROOT_FOLDER_ID.dev}';  // dev 資料夾`,
        prodText: `const ROOT_FOLDER_ID = '${ENV.ROOT_FOLDER_ID.prod}';  // 正式版 Drive 根資料夾`,
      },
      {
        what: 'ALLOWED_ROOTS 白名單註解',
        dev: '// 白名單：只允許 dev 資料夾（',
        prodText: '// 白名單：只允許正式版資料夾（',
      },
      {
        what: 'ALLOWED_ROOTS label',
        dev: "ALLOWED_ROOTS[ROOT_FOLDER_ID] = { label: 'dev' };",
        prodText: "ALLOWED_ROOTS[ROOT_FOLDER_ID] = { label: 'prod' };",
      },
      {
        what: 'doGet service 標記（診斷用，報錯環境會誤導 POST→GET 降級的判讀）',
        dev: "service: 'SCC Tutor System Drive Proxy (DEV)'",
        prodText: "service: 'SCC Tutor System Drive Proxy (PROD)'",
      },
      {
        what: '登入通知信內文環境欄',
        dev: "'環境：測試版',",
        prodText: "'環境：正式版',",
      },
      {
        what: '登入通知信 subject',
        dev: "subject: '【屏科大導師資訊系統】登入通知（測試版）',",
        prodText: "subject: '【屏科大導師資訊系統】登入通知（正式版）',",
      },
    ],
  },
  {
    dev: 'dev/index.html',
    prod: 'index.html',
    rules: [
      {
        what: '頁面 <title>',
        dev: '<title>導師資訊系統（測試版）</title>',
        prodText: '<title>導師資訊系統</title>',
      },
      {
        what: '「測試版」badge（登入頁 h1 與登入後 app-title 各一）',
        dev: '導師資訊系統<span class="env-badge">測試版</span>',
        prodText: '導師資訊系統',
        count: 2,
      },
      {
        what: '前端 SPA 檔首註記',
        dev: '// 導師資訊系統（測試版）— 前端 SPA',
        prodText: '// 導師資訊系統（正式版）— 前端 SPA',
      },
      {
        what: 'APPS_SCRIPT_URL（環境常數，帶錯整版無法登入）',
        dev: `const APPS_SCRIPT_URL = '${ENV.APPS_SCRIPT_URL.dev}';`,
        prodText: `const APPS_SCRIPT_URL = '${ENV.APPS_SCRIPT_URL.prod}';`,
      },
      {
        what: 'ROOT_FOLDER_ID（環境常數，帶錯整版無法登入）',
        dev: `const ROOT_FOLDER_ID  = '${ENV.ROOT_FOLDER_ID.dev}';`,
        prodText: `const ROOT_FOLDER_ID  = '${ENV.ROOT_FOLDER_ID.prod}';`,
      },
    ],
  },
];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CHECK = args.includes('--check');
const unknown = args.filter((a) => !['--apply', '--check'].includes(a));
if (unknown.length) {
  console.error(`未知參數：${unknown.join(' ')}\n用法：node scripts/promote.mjs [--apply|--check]`);
  process.exit(2);
}
if (APPLY && CHECK) {
  console.error('--apply 與 --check 不能同時使用。');
  process.exit(2);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const occurrences = (hay, needle) => hay.split(needle).length - 1;

// ─────────────────────────────────────────────────────────────
// --check：檢查已 commit 的 prod 檔有沒有殘留 dev 標記。
// 這是補上守門員的盲區——check-env-constants 只驗 4 個常數，
// 漏改措辭/標記類的 10 處它一律綠燈放行。
// ─────────────────────────────────────────────────────────────
if (CHECK) {
  let bad = 0;
  for (const f of FILES) {
    const prodText = read(f.prod);
    for (const r of f.rules) {
      const n = occurrences(prodText, r.dev);
      if (n > 0) {
        console.error(`✗ [${f.prod}] 殘留 dev 版內容 ×${n}：${r.what}`);
        console.error(`    找到：${r.dev.slice(0, 90)}`);
        bad++;
      }
    }
  }
  if (bad) {
    console.error(`\n正式版檔案殘留 ${bad} 處 dev 內容——推行時漏改了。`);
    console.error('修法：node scripts/promote.mjs --apply（會把 dev 完整推行並套用全部 13 處差異）');
    process.exit(1);
  }
  console.log(`✓ 正式版檔案沒有殘留 dev 標記（檢查 ${FILES.reduce((n, f) => n + f.rules.length, 0)} 條規則）`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────
// 推行：複製 dev→prod，逐條套用差異，每條都必須命中預期次數。
// ─────────────────────────────────────────────────────────────
console.log(APPLY ? '=== 推行到正式版（--apply，會寫檔）===\n' : '=== 推行預演（dry-run，不寫檔；要實際執行請加 --apply）===\n');

// 前置：工作樹若已有未 commit 的變更，推行後的 diff 會混在一起，難以複核。
try {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'Code.gs', 'index.html'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  if (dirty) {
    console.warn('⚠ Code.gs / index.html 已有未 commit 的變更，推行後的 diff 會與它們混在一起：');
    console.warn(dirty.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  }
} catch (_) { /* 非 git 環境或 git 不可用時不擋 */ }

const outputs = [];
let failed = false;

for (const f of FILES) {
  let text = read(f.dev);
  const before = read(f.prod);
  console.log(`── ${f.dev} → ${f.prod} ──`);

  for (const r of f.rules) {
    const expect = r.count ?? 1;
    const n = occurrences(text, r.dev);
    if (n !== expect) {
      console.error(`  ✗ ${r.what}：在 ${f.dev} 找到 ${n} 次，預期 ${expect} 次`);
      console.error(`      規則文字：${r.dev.slice(0, 90)}`);
      failed = true;
      continue;
    }
    text = text.split(r.dev).join(r.prodText);
    console.log(`  ✓ ${r.what}（${expect} 處）`);
  }

  // 套用後複驗：prod 內容不該再出現任何 dev 端文字。
  for (const r of f.rules) {
    const left = occurrences(text, r.dev);
    if (left > 0) {
      console.error(`  ✗ 套用後仍殘留 dev 內容 ×${left}：${r.what}`);
      failed = true;
    }
  }

  const changed = text !== before;
  console.log(`  ${changed ? '→ 內容有變動' : '→ 內容與現有正式版相同（無變動）'}\n`);
  outputs.push({ path: f.prod, text, changed });
}

if (failed) {
  console.error('推行中止：上面有規則沒有命中預期次數，一個字都沒寫入。');
  console.error('通常原因是 dev 端改了那段措辭——請同步更新本檔的 FILES 規則表後重跑。');
  process.exit(1);
}

if (!APPLY) {
  const n = outputs.filter((o) => o.changed).length;
  console.log(n === 0
    ? '預演結果：正式版已經是最新狀態，推行不會產生任何變動。'
    : `預演結果：${n} 個檔案會變動。確認無誤後執行 node scripts/promote.mjs --apply`);
  process.exit(0);
}

for (const o of outputs) {
  writeFileSync(join(ROOT, o.path), o.text);
  console.log(`已寫入 ${o.path}`);
}

// 寫檔後立刻跑既有守門員（環境常數 prod≠dev），紅燈就是不能 push。
console.log('\n── 執行 scripts/check-env-constants.mjs ──');
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-env-constants.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  });
  process.stdout.write(out);
} catch (e) {
  process.stdout.write(e.stdout || '');
  process.stderr.write(e.stderr || '');
  console.error('\n環境常數守門員紅燈——請勿 push。');
  process.exit(1);
}

console.log('\n推行完成。接下來：');
console.log('  1. git diff 複核（應只有環境差異，不應有非預期的功能變動）');
console.log('  2. node --test test/*.test.js');
console.log('  3. git add Code.gs index.html dev/Code.gs dev/index.html && git commit && git push origin master');
console.log('  4. node scripts/deploy-onprem.mjs prod');
