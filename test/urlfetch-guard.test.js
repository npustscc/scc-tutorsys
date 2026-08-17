// 自架 host 的 UrlFetchApp 放行清單。
//
// 這道防漏檢查的用途：自架環境的 Drive I/O 全部由儲存 seam 接管，**任何真的打出去的 HTTP
// 都代表有一條路沒被接管**（把本機資料寫去 Drive，或反過來讀 Drive 蓋掉本機）。所以預設一律 throw。
//
// 2026-08-17 開了唯一一個例外：Google 的 tokeninfo。入口搬到 GitHub Pages、後端在執行期切換之後，
// 使用者在 Pages 上用 Google 登入、idToken 送來這台驗，verifyIdToken_ 非打 Google 不可。
// 原本連它一起擋，於是 Pages 一切到自架後端每個人都拿到 Unauthorized。
//
// 這裡測的是**那個例外沒有開太大**：只認 https://oauth2.googleapis.com/tokeninfo 這個
// origin + path，用解析後的 URL 比對而不是字串前綴（前綴比對會被 oauth2.googleapis.com.evil.tw 騙過）。
// 全部離線可測——真的打 Google 那一趟在 server/scripts/smoke.mjs。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHost } = require('../server/gas-host.js');

function withHost(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorsys-guard-'));
  try {
    const host = createHost({
      gsFile: 'dev/Code.gs',
      dataDir: dir,
      rootFolderId: '1y4vyMvVoVp-b4-ORLEJEOERDtmNasQVT',
    });
    return fn(host.sandbox.UrlFetchApp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BLOCKED = [
  ['Drive REST（最重要的那個——漏掉就是資料寫錯地方）', 'https://www.googleapis.com/drive/v3/files'],
  ['像 Google 的釣魚網域（字串前綴比對會被這個騙過）', 'https://oauth2.googleapis.com.evil.tw/tokeninfo?id_token=x'],
  ['明文 http', 'http://oauth2.googleapis.com/tokeninfo?id_token=x'],
  ['同網域但別的 path', 'https://oauth2.googleapis.com/token'],
  ['用 .. 想繞出 tokeninfo', 'https://oauth2.googleapis.com/tokeninfo/../token'],
  ['子網域', 'https://evil.oauth2.googleapis.com/tokeninfo'],
  ['帶帳密的 URL', 'https://oauth2.googleapis.com@evil.tw/tokeninfo'],
  ['完全不是網址', 'not-a-url'],
];

test('🔒 放行清單以外的 URL 一律 throw（Drive REST、釣魚網域、明文、其他 path）', () => {
  withHost((U) => {
    for (const [why, url] of BLOCKED) {
      assert.throws(() => U.fetch(url), /不應被呼叫/, why + '：' + url);
    }
  });
});

test('🔒 放行判斷用解析後的 URL，不是字串前綴', () => {
  withHost((U) => {
    // 這兩個都以合法 origin 開頭，只有第一個是真的 tokeninfo；第二個必須被擋。
    assert.throws(() => U.fetch('https://oauth2.googleapis.com.evil.tw/tokeninfo'), /不應被呼叫/);
    assert.throws(() => U.fetch('https://oauth2.googleapis.com/tokeninfoX'), /不應被呼叫/);
  });
});
