#!/usr/bin/env node
// server/scripts/smoke.mjs — 自足冒煙測試（node server/scripts/smoke.mjs）。
// 全部走真 HTTP（fetch 打 in-process 啟動的 server），退出碼定生死：綠燈 exit 0。
//
// 種子資料抄自 verify/gas-emulator.js 的 seed 內容（同一套人物設定：admin@test.local
// 為 admin、wang@test.local 為「農園系_四技一A」的導師），差異是這裡種到暫存 DATA_DIR
// 的 store/ 檔案系統，並額外用 create-user.js 建立本地帳密（自架環境不支援 Google 登入，
// 一律走 /login 本地帳密換 session）。
//
// dev/Code.gs、dev/index.html 全程只被「讀取」，不會被本腳本修改。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import serverIndexModule from '../index.js';
import buildPublicModule from './build-public.js';
import createUserModule from './create-user.js';
import configModule from '../config.js';

const { startServer } = serverIndexModule;
const { run: buildPublic } = buildPublicModule;
const { run: createUser } = createUserModule;
const { loadConfig } = configModule;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + '  ←  ' + String(detail).slice(0, 400)); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function call(base, payload) {
  const res = await fetch(base + '/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
  return res.json();
}
async function login(base, email, password) {
  const res = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  });
  return res.json();
}

function writeJson_(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj));
}

function seedStore(dataDir) {
  const storeDir = path.join(dataDir, 'store');
  writeJson_(path.join(storeDir, 'semesters.json'), [
    { id: '114-1', label: '114 學年度第 1 學期', quotaMeeting: 5, quotaActivity: 1, isCurrent: false },
    { id: '114-2', label: '114 學年度第 2 學期', quotaMeeting: 5, quotaActivity: 1, isCurrent: true },
  ]);
  writeJson_(path.join(storeDir, 'config.json'), {
    users: { 'admin@test.local': { name: '測試管理員', role: 'admin' } },
    staffLeads: [{ email: 'lead@test.local', name: '測試主責', disabled: false }],
    staffAssistants: [],
    settings: {},
  });
  writeJson_(path.join(storeDir, 'colleges.json'), [
    { id: '農學院', name: '農學院', order: 0, disabled: false },
    { id: '獸醫學院', name: '獸醫學院', order: 1, disabled: false },
  ]);
  writeJson_(path.join(storeDir, 'departments.json'), [
    { id: '農園系', name: '農園系', headEmail: 'head@test.local', headName: '測試系主任', collegeId: '農學院', active: true },
    { id: '獸醫系', name: '獸醫系', headEmail: '', headName: '', collegeId: '獸醫學院', active: true },
  ]);
  writeJson_(path.join(storeDir, 'classes.json'), [
    {
      id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college', displayName: '四農園一A',
      requiredMeetingOverride: null, graduationGrade: null, tutors: [{ name: '王小明', email: 'wang@test.local' }],
      suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    },
    {
      id: '獸醫系_四技四A', name: '四技四A', deptId: '獸醫系', systemId: 'day_college', displayName: '四獸醫四A',
      requiredMeetingOverride: null, graduationGrade: 5, tutors: [{ name: '林獸醫', email: 'vet@test.local' }],
      suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    },
  ]);
  writeJson_(path.join(storeDir, 'records_114-2.json'), { records: [] });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorsys-smoke-'));
  const dataDir = path.join(tmpRoot, 'data');
  const publicDir = path.join(tmpRoot, 'public');
  const envPath = path.join(tmpRoot, '.env');

  console.log('[smoke] 暫存目錄：' + tmpRoot);

  fs.writeFileSync(envPath, [
    'PORT=0',
    'BIND=127.0.0.1',
    'GS_FILE=' + path.join(REPO_ROOT, 'dev', 'Code.gs'),
    'FRONTEND_FILE=' + path.join(REPO_ROOT, 'dev', 'index.html'),
    'SERVER_ORIGIN=http://127.0.0.1:0',
    'DATA_DIR=' + dataDir,
    'PUBLIC_DIR=' + publicDir,
    'LOGIN_THROTTLE_MS=1500',
    '',
  ].join('\n'));

  // 驗證 config.js 的 .env 解析本身也能跑（不是只靠手動組物件繞過去）。
  const config = loadConfig({ envPath: envPath });
  check('0 loadConfig 解析 .env 成功', config.port === 0 && config.loginThrottleMs === 1500, JSON.stringify(config));

  seedStore(dataDir);
  createUser(['admin@test.local', 'adminpass123', '測試管理員'], { config: config });
  createUser(['wang@test.local', 'wangpass123', '王小明'], { config: config });

  const handle = await startServer(config);
  const base = 'http://127.0.0.1:' + handle.port;
  const rootFolderId = handle.host.rootFolderId;
  console.log('[smoke] server ' + base + '（rootFolderId=' + rootFolderId + '）');

  // build-public：以實際埠號重建 SERVER_ORIGIN，跑一次產出 public/index.html + login.html
  // （公用於下面第 17 項）。
  const builtConfig = Object.assign({}, config, { serverOrigin: base });
  const built = buildPublic({ config: builtConfig });
  check('0b build-public 產出檔案', fs.existsSync(path.join(publicDir, 'index.html')) && fs.existsSync(path.join(publicDir, 'login.html')), JSON.stringify(built));

  try {
    // 1. GET /exec → success:true、data.via === 'doGet'。
    let r = await fetch(base + '/exec').then(function (res) { return res.json(); });
    check('1 GET /exec → doGet', r.success === true && r.data && r.data.via === 'doGet', JSON.stringify(r));

    // 2. GET /healthz → ok。
    r = await fetch(base + '/healthz').then(function (res) { return res.json(); });
    check('2 GET /healthz', r && r.ok === true, JSON.stringify(r));

    // 3. POST /login 錯密碼 → 帳號或密碼錯誤。
    r = await login(base, 'admin@test.local', 'wrong-password-1');
    check('3 錯密碼 → 帳號或密碼錯誤', r.success === false && r.error === '帳號或密碼錯誤', JSON.stringify(r));

    // 4. 連錯 5 次後正確密碼也被節流擋 → 等 1.6s 後成功。
    for (let i = 2; i <= 5; i++) {
      await login(base, 'admin@test.local', 'wrong-password-' + i);
    }
    r = await login(base, 'admin@test.local', 'adminpass123'); // 第 6 次（密碼正確）：應仍被節流擋下
    check('4a 連錯 5 次後即使密碼正確也被節流', r.success === false && r.error === '嘗試次數過多，請稍後再試', JSON.stringify(r));
    await sleep(1600);
    r = await login(base, 'admin@test.local', 'adminpass123'); // 節流窗口過後：應成功
    check('4b 節流窗口過後恢復可登入', r.success === true, JSON.stringify(r));

    // 5. 登入成功 → 有 sessionToken、exp 為未來、data.name 正確。
    const adminToken = r.data && r.data.sessionToken;
    const nowSec = Math.floor(Date.now() / 1000);
    check('5 登入成功取得 token/exp/name', !!adminToken && Number(r.data.exp) > nowSec && r.data.name === '測試管理員', JSON.stringify(r));

    // 6. ping（sessionToken）→ email 正確。
    r = await call(base, { action: 'ping', rootFolderId: rootFolderId, sessionToken: adminToken });
    check('6 ping 帶 sessionToken', r.success === true && r.data.email === 'admin@test.local', JSON.stringify(r));

    // 7. bootstrap → success，admin@test.local 的 roles.isAdmin === true。
    r = await call(base, { action: 'bootstrap', rootFolderId: rootFolderId, sessionToken: adminToken });
    check('7 bootstrap → roles.isAdmin', r.success === true && r.data.roles && r.data.roles.isAdmin === true, JSON.stringify(r).slice(0, 300));

    // 8. 竄改 token 簽章 → 'Session expired'。
    const tamperedToken = adminToken.split('.')[0] + '.' + 'tampered-signature-xxxxx';
    r = await call(base, { action: 'ping', rootFolderId: rootFolderId, sessionToken: tamperedToken });
    check('8 竄改簽章 → Session expired', r.success === true && r.data.error === 'Session expired', JSON.stringify(r));

    // 9. 帶 sessionToken 打 sessionStart → 'sessionStart requires idToken'。
    r = await call(base, { action: 'sessionStart', rootFolderId: rootFolderId, sessionToken: adminToken });
    check('9 帶 sessionToken 打 sessionStart', r.success === true && r.data.error === 'sessionStart requires idToken', JSON.stringify(r));

    // 10. 亂湊 idToken → 'Unauthorized'（驗證 UrlFetchApp 防漏 throw 被 verifyIdToken_ 吃掉、fail-closed）。
    r = await call(base, { action: 'ping', rootFolderId: rootFolderId, idToken: 'not-a-real-jwt-garbage' });
    check('10 亂湊 idToken → Unauthorized', r.success === true && r.data.error === 'Unauthorized', JSON.stringify(r));

    // 導師 wang@test.local 另開一個 session（在第 15 項登出 admin 之前先開好，
    // 用來在第 16 項證明「未受影響的另一帳號 session」在重啟後仍然有效）。
    r = await login(base, 'wang@test.local', 'wangpass123');
    check('10b wang 登入成功', r.success === true && !!(r.data && r.data.sessionToken), JSON.stringify(r));
    const wangToken = r.data.sessionToken;

    // 11. recordSubmit（導師 wang@test.local，班 農園系_四技一A，type meeting）→ success。
    // 註：對照 dev/Code.gs recordSubmitAction_/buildNewRecord_ 後發現，後端並未對表單欄位
    // 做「必填」檢查（只有核章關編輯時的 sanitizeFormFields_ 白名單過濾，提交當下的 form
    // 是整包收下），因此這裡填滿 MEETING_FORM_FIELDS_ 只是模擬真實使用情境，並非契約要求。
    r = await call(base, {
      action: 'recordSubmit', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', classId: '農園系_四技一A', type: 'meeting',
      uploader: { name: '王小明' },
      form: {
        date: '2026-07-16', topic: '期中導生座談', chair: '王小明', recorder: '王小明',
        attendance: '25/28', chairReport: '（略）',
      },
    });
    check('11 recordSubmit 成功', r.success === true && r.data && r.data.record && r.data.record.id, JSON.stringify(r).slice(0, 300));
    const recordId1 = r.data.record.id;

    // 12. recordGetMine → 剛那筆在列。
    r = await call(base, { action: 'recordGetMine', rootFolderId: rootFolderId, sessionToken: wangToken, semester: '114-2' });
    const hasRecord1 = r.success === true && Array.isArray(r.data.records) && r.data.records.some(function (x) { return x.id === recordId1; });
    check('12 recordGetMine 含剛送出的紀錄', hasRecord1, JSON.stringify(r).slice(0, 300));

    // 13. uploadAttachment（小 base64）→ 得 fileId；downloadAttachment 對上傳者本人 → base64 一致。
    // downloadAttachmentAction_ 要求 fileId 必須實際掛在該筆紀錄的 attachments 上（見
    // dev/Code.gs downloadAttachmentAction_ 的 hasFile 檢查），所以要先 uploadAttachment
    // 拿到 fileId，再用它送出一筆新紀錄，才能對這筆紀錄下載。
    const attContent = Buffer.from('hello-smoke-attachment').toString('base64');
    r = await call(base, {
      action: 'uploadAttachment', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', classId: '農園系_四技一A', fileName: 'note.txt', mimeType: 'text/plain', base64Data: attContent,
    });
    check('13a uploadAttachment 取得 fileId', r.success === true && !!(r.data && r.data.fileId), JSON.stringify(r));
    const fileId1 = r.data.fileId;

    r = await call(base, {
      action: 'recordSubmit', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', classId: '農園系_四技一A', type: 'meeting',
      uploader: { name: '王小明' },
      form: { date: '2026-07-16', topic: '含附件測試', chair: '王小明', recorder: '王小明', attendance: '25/28' },
      attachments: [{ fileId: fileId1 }],
    });
    check('13b 帶附件的 recordSubmit 成功', r.success === true && r.data && r.data.record && r.data.record.id, JSON.stringify(r).slice(0, 300));
    const recordId2 = r.data.record.id;

    r = await call(base, {
      action: 'downloadAttachment', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', recordId: recordId2, fileId: fileId1,
    });
    check('13c downloadAttachment 內容一致', r.success === true && r.data && r.data.base64 === attContent, JSON.stringify(r).slice(0, 200));

    // 14. 對別班偽 fileId 下載 → 被拒（assertAttachmentsBelong_ fail-closed）。
    // 先以同一位 wang（本系統上傳白名單為空即不限帳號）替「別班」（獸醫系_四技四A）
    // 上傳一個合法附件，取得 fileId2；接著直接改寫 recordId2 存檔內容，把 fileId2
    // 「偽造」成掛在 recordId2（實際屬於農園系_四技一A）上——模擬 Code.gs 註解所說的
    // 「record.attachments 混入未經第一層驗證的 fileId」情境，藉此測第二層防線
    // assertAttachmentsBelong_ 是否仍會攔下。
    r = await call(base, {
      action: 'uploadAttachment', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', classId: '獸醫系_四技四A', fileName: 'other-class.txt', mimeType: 'text/plain',
      base64Data: Buffer.from('other-class-file').toString('base64'),
    });
    check('14a 為別班上傳附件成功（供偽造情境用）', r.success === true && !!(r.data && r.data.fileId), JSON.stringify(r));
    const fileId2 = r.data.fileId;

    const recPath = path.join(dataDir, 'store', 'records_114-2.json');
    const recData = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    const target = recData.records.find(function (x) { return x.id === recordId2; });
    target.attachments.push({ fileId: fileId2 });
    fs.writeFileSync(recPath, JSON.stringify(recData));

    r = await call(base, {
      action: 'downloadAttachment', rootFolderId: rootFolderId, sessionToken: wangToken,
      semester: '114-2', recordId: recordId2, fileId: fileId2,
    });
    check(
      '14b 偽造跨班 fileId 下載 → 被拒',
      r.success === false && typeof r.error === 'string' && r.error.indexOf('does not belong') !== -1,
      JSON.stringify(r)
    );

    // 15. sessionLogout 後（等 1.1s，iat 秒精度）舊 token → 'Session expired'。
    // 只登出 admin 這個帳號；wangToken 是另一個帳號的 session，不受影響（見第 16 項）。
    await sleep(1100);
    await call(base, { action: 'sessionLogout', rootFolderId: rootFolderId, sessionToken: adminToken });
    r = await call(base, { action: 'ping', rootFolderId: rootFolderId, sessionToken: adminToken });
    check('15 sessionLogout 後舊 token → Session expired', r.success === true && r.data.error === 'Session expired', JSON.stringify(r));

    // 16. 資料持久化：關 server → 重啟同 DATA_DIR → 不重登入，用第 10b 步（早於第 15 步登出）
    // 開的 wangToken → 仍可 ping、recordGetMine 資料還在。
    // 埠號刻意重新用 0（隨機挑一個新的）而非沿用 handle.port：Node 內建 fetch（undici）
    // 對同一 origin 會做連線池重用，若舊伺服器關閉後立刻在「同一個埠號」重新監聽，
    // 會撿到指向舊 socket 的殘留連線而 ECONNRESET——這是 client 端連線池的行為，
    // 不是 server 的 bug，用新埠號即可繞開，且不影響「重啟後資料仍在」這個驗證目的。
    await handle.close();
    const handle2 = await startServer(Object.assign({}, config, { port: 0 }));
    const base2 = 'http://127.0.0.1:' + handle2.port;

    r = await call(base2, { action: 'ping', rootFolderId: rootFolderId, sessionToken: wangToken });
    check('16a 重啟後舊帳號（未登出）token 仍可 ping', r.success === true && r.data.email === 'wang@test.local', JSON.stringify(r));

    r = await call(base2, { action: 'recordGetMine', rootFolderId: rootFolderId, sessionToken: wangToken, semester: '114-2' });
    const persisted = r.success === true && Array.isArray(r.data.records) &&
      r.data.records.some(function (x) { return x.id === recordId1; }) &&
      r.data.records.some(function (x) { return x.id === recordId2; });
    check('16b 重啟後紀錄資料仍在', persisted, JSON.stringify(r).slice(0, 300));

    // 17. GET /（build-public 先跑進暫存 PUBLIC_DIR）→ 200 且內容含 __ENV_LABEL__ 已替換、
    // login.html 無殘留佔位；public/index.html 內 APPS_SCRIPT_URL 已指向本機 origin 且恰好一次。
    const loginRes = await fetch(base2 + '/');
    const loginText = await loginRes.text();
    check(
      '17a GET / 回 login.html 且環境標籤已替換、無殘留佔位',
      loginRes.status === 200 && loginText.indexOf('測試版') !== -1 &&
        loginText.indexOf('__ENV_LABEL__') === -1 && loginText.indexOf('__ROOT_FOLDER_ID__') === -1,
      'status=' + loginRes.status
    );

    const indexRes = await fetch(base2 + '/index.html');
    const indexText = await indexRes.text();
    const appsScriptUrlHits = (indexText.match(/const APPS_SCRIPT_URL = '/g) || []).length;
    check(
      '17b public/index.html 的 APPS_SCRIPT_URL 已指向本機 origin 且恰好一次',
      indexRes.status === 200 && appsScriptUrlHits === 1 && indexText.indexOf("APPS_SCRIPT_URL = '" + base + "/exec';") !== -1,
      'hits=' + appsScriptUrlHits
    );

    // 18. 路徑穿越：GET /../server/.env 之類 → 404/403。
    // 用 %2e%2e 而非字面 '..'，避免 fetch() 自己的 URL 正規化在送出前就把 '..' 吃掉，
    // 確保是伺服器端的防護邏輯真正被觸發（見 server/index.js serveStatic 註解）。
    const traversalRes = await fetch(base2 + '/%2e%2e/%2e%2e/server/.env');
    check('18 路徑穿越被擋（404/403）', traversalRes.status === 404 || traversalRes.status === 403, 'status=' + traversalRes.status);

    await handle2.close();
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 清理失敗不影響結果判定 */ }
  }

  console.log('\n=== 冒煙結果：' + pass + ' pass / ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('[smoke] 執行中發生未預期例外：' + (e && e.stack || e));
  if (e && e.cause) console.error('[smoke] cause: ' + (e.cause.stack || e.cause));
  process.exit(1);
});
