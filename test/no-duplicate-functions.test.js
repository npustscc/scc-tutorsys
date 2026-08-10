// 守門：Code.gs／index.html 裡不得有同名的頂層函式定義。
//
// 為什麼需要這條：JavaScript 的後定義會**靜默覆蓋**前面的同名函式。2026-08-10 我改寫
// maintenanceResetLocalAccounts 時只插入新版、忘了刪舊版，於是 GAS 一直執行舊的逐筆版——
// 使用者眼中就是「你說修好了，但它還是跑三分鐘」。沒有任何錯誤訊息，測試也全綠，
// 因為兩份都語法正確、而測試載入的是先定義的那份（harness 抽第一個匹配）。
//
// 這種 bug 的成本全落在使用者身上（等待、重試、懷疑自己操作錯），而偵測成本只有這支測試。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function topLevelFunctionNames(src) {
  // 只抓「行首」的 function 宣告＝頂層函式；縮排過的是巢狀/內部函式，同名無妨。
  const names = [];
  const re = /^function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

function duplicatesOf(names) {
  const seen = new Map();
  names.forEach(function (n) { seen.set(n, (seen.get(n) || 0) + 1); });
  return Array.from(seen.entries()).filter(function (e) { return e[1] > 1; });
}

for (const rel of ['dev/Code.gs', 'Code.gs']) {
  test(rel + ' 沒有重複的頂層函式定義', () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const dups = duplicatesOf(topLevelFunctionNames(src));
    assert.deepEqual(dups, [],
      '同名頂層函式會靜默覆蓋，實際執行到的是最後一份：' +
      dups.map(function (d) { return d[0] + '×' + d[1]; }).join('、'));
  });
}

for (const rel of ['dev/index.html', 'index.html']) {
  test(rel + ' 的內嵌 JS 沒有重複的頂層函式定義', () => {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(m, '找不到內嵌 <script> 區塊');
    const dups = duplicatesOf(topLevelFunctionNames(m[1]));
    assert.deepEqual(dups, [],
      '同名頂層函式會靜默覆蓋：' + dups.map(function (d) { return d[0] + '×' + d[1]; }).join('、'));
  });
}
