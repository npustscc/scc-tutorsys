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
    // accessMode:'open' ＝ 全域登入閘門（2026-08-17）之前的行為。這支 smoke 的主體是
    // 導師上傳→核章的完整流程，而閘門預設就是把導師擋在門外——不開的話下面十幾項全部
    // 驗不到。**閘門本身不是靠這裡驗的**：純函式在 test/access-gate.test.js，
    // 自架軌 /login 這條路徑則由下面第 10a-0 項專門測（那項會把它切回 restricted）。
    settings: { accessMode: 'open' },
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
    // 白名單刻意混一個 '*'：config.js 必須把它丟掉（見第 19 項）。
    'ALLOWED_ORIGINS=https://npustscc.github.io,*',
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

    // 5b. 帳號只打 @ 之前那段也能登入（resolveLoginEmail_）；local-part 對不上的一律失敗。
    r = await login(base, 'admin', 'adminpass123');
    check('5b 只打 local-part 也能登入', r.success === true && r.data.email === 'admin@test.local', JSON.stringify(r));
    r = await login(base, 'nosuchlocalpart', 'adminpass123');
    check('5c 不存在的 local-part → 帳號或密碼錯誤', r.success === false && r.error === '帳號或密碼錯誤', JSON.stringify(r));

    // 5d. 改密碼：新密碼政策擋弱密碼、目前密碼錯要擋、成功後舊密碼失效新密碼可用。
    const chpw = async function (body) {
      const res = await fetch(base + '/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    };
    r = await chpw({ email: 'admin@test.local', currentPassword: 'adminpass123', newPassword: '1234' });
    check('5d 新密碼太短 → 被政策擋下', r.success === false && /至少/.test(r.error || ''), JSON.stringify(r));
    r = await chpw({ email: 'admin@test.local', currentPassword: 'adminpass123', newPassword: '12345678' });
    check('5e 新密碼純數字 → 被政策擋下', r.success === false && /只有數字/.test(r.error || ''), JSON.stringify(r));
    r = await chpw({ email: 'admin@test.local', currentPassword: 'WRONG', newPassword: 'brandnewpass1' });
    check('5f 目前密碼錯 → 拒絕', r.success === false && /目前密碼錯誤/.test(r.error || ''), JSON.stringify(r));
    await sleep(1600); // 上一步算一次失敗，避免觸發節流影響後續
    r = await chpw({ email: 'admin@test.local', currentPassword: 'adminpass123', newPassword: 'brandnewpass1' });
    check('5g 改密碼成功', r.success === true, JSON.stringify(r));
    r = await login(base, 'admin@test.local', 'adminpass123');
    check('5h 舊密碼失效', r.success === false, JSON.stringify(r));
    await sleep(1600);
    r = await login(base, 'admin@test.local', 'brandnewpass1');
    check('5i 新密碼可登入，且 mustChangePassword 已清除',
      r.success === true && r.data.mustChangePassword === false, JSON.stringify(r));
    const adminToken2 = r.data && r.data.sessionToken;

    // 5j. /admin/accounts：admin 可列出、非 admin 一律 admin only、壞 token 一律拒絕。
    const acct = async function (body) {
      const res = await fetch(base + '/admin/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    };
    r = await acct({ op: 'list', sessionToken: adminToken2 });
    check('5j admin 可列出系辦助理帳號', r.success === true && Array.isArray(r.data.accounts), JSON.stringify(r).slice(0, 200));
    r = await acct({ op: 'list', sessionToken: 'garbage.token' });
    check('5k 壞 token 打 /admin/accounts → 拒絕', r.success === false, JSON.stringify(r));
    r = await acct({ op: 'createOrReset', email: 'notinwhitelist@test.local', sessionToken: adminToken2 });
    // 名單外的 email 不給發帳號。斷言只看「被拒絕」與「錯誤提到名單」，不綁死措辭——
    // 2026-08-18 加了校安人員之後訊息從「不在系辦助理白名單內」改成「不在系辦助理或校安人員
    // 名單內」，綁死字串的斷言就會在行為完全正確的情況下紅燈。
    check('5l 不在名單內的 email 不給建帳號', r.success === false && /名單/.test(r.error || ''), JSON.stringify(r));

    // 5m–5r. 系辦助理換 email：白名單（走 /exec）與登入帳號（走 /admin/accounts）是兩份資料，
    // 自架軌的帳號活在 users.json，doPost 那一側碰不到——所以這條路只有在這裡驗得到。
    const asAdmin = function (extra) {
      return Object.assign({ rootFolderId: rootFolderId, sessionToken: adminToken2 }, extra);
    };
    r = await call(base, asAdmin({
      action: 'adminUpsertDeptAssistant',
      deptAssistant: { email: 'rn-old@test.local', name: '換人測試', ext: '5511', deptIds: ['農園系'] },
    }));
    check('5m 建立系辦助理白名單', r.success === true, JSON.stringify(r).slice(0, 200));
    r = await acct({ op: 'createOrReset', email: 'rn-old@test.local', sessionToken: adminToken2 });
    check('5n 建立本機帳號（初始密碼＝分機）', r.success === true, JSON.stringify(r).slice(0, 200));
    r = await login(base, 'rn-old@test.local', '5511');
    check('5o 舊 email 登得進去（換 email 前的基準）', r.success === true, JSON.stringify(r).slice(0, 200));
    r = await call(base, asAdmin({
      action: 'adminRenameDeptAssistant', fromEmail: 'rn-old@test.local', toEmail: 'rn-new@test.local',
    }));
    check('5p 換 email：白名單整筆搬過去',
      r.success === true && (r.data.deptAssistants || []).some(function (a) {
        return a.email === 'rn-new@test.local' && a.deleted !== true && (a.deptIds || []).join() === '農園系';
      }) && !(r.data.deptAssistants || []).some(function (a) {
        return a.email === 'rn-old@test.local' && a.deleted !== true;
      }), JSON.stringify(r).slice(0, 300));
    r = await acct({ op: 'delete', email: 'rn-old@test.local', sessionToken: adminToken2 });
    check('5q 刪掉舊 email 的本機帳號', r.success === true && r.data.deleted === true, JSON.stringify(r));
    r = await acct({ op: 'delete', email: 'rn-old@test.local', sessionToken: adminToken2 });
    check('5q2 重複刪除 → 冪等回 deleted:false，不是錯誤', r.success === true && r.data.deleted === false, JSON.stringify(r));
    r = await acct({ op: 'delete', email: 'rn-old@test.local', sessionToken: 'garbage.token' });
    check('5q3 🔒 壞 token 打 delete → 拒絕', r.success === false, JSON.stringify(r));
    r = await login(base, 'rn-old@test.local', '5511');
    check('5r 🔒 換完 email 後舊密碼登不進去', r.success === false, JSON.stringify(r).slice(0, 200));

    // 5s–5x. 墓碑區（已刪除項目）。上面那段換 email 剛好留下一個真的墓碑
    // （rn-old@ 帶 renamedTo），正好用來驗「換名的墓碑不准還原」——那正是 2026-08-19
    // 事故的形狀：同步把已換名的舊信箱復活，同一個人有兩個有效帳號。
    r = await call(base, asAdmin({ action: 'adminListDeleted' }));
    const tombs = (r.data && r.data.entries) || [];
    const rnOld = tombs.filter(function (x) { return x.id === 'rn-old@test.local'; })[0];
    check('5s 墓碑區列得出換 email 留下的舊信箱',
      r.success === true && !!rnOld && rnOld.kind === 'deptAssistant', JSON.stringify(r).slice(0, 300));
    check('5t 墓碑帶得出「換名到誰」', !!rnOld && rnOld.renamedTo === 'rn-new@test.local', JSON.stringify(rnOld));
    check('5u 🔒 墓碑區不含有效項目',
      !tombs.some(function (x) { return x.id === 'rn-new@test.local'; }), JSON.stringify(tombs).slice(0, 200));
    r = await call(base, asAdmin({ action: 'adminRestoreDeleted', kind: 'deptAssistant', id: 'rn-old@test.local' }));
    check('5v 🔒 換名的墓碑不准還原（接手那筆還有效）',
      r.success === false && /換名/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
    r = await call(base, {
      rootFolderId: rootFolderId, sessionToken: 'garbage.token',
      action: 'adminListDeleted',
    });
    // /exec 對壞 token 的既有慣例是回 success:true 帶 data.error（前端靠它觸發重新登入），
    // 不是 success:false——所以這裡驗的是「有錯誤、而且一筆墓碑都沒吐出來」。
    check('5w 🔒 壞 token 看不到墓碑區',
      !!(r.data && r.data.error) && !(r.data && r.data.entries), JSON.stringify(r).slice(0, 160));
    r = await call(base, asAdmin({ action: 'adminRestoreDeleted', kind: 'class', id: '不存在的班' }));
    check('5x 🔒 還原不存在的東西 → 明確拒絕', r.success === false, JSON.stringify(r).slice(0, 160));
    await sleep(1600); // 上一步算一次登入失敗，避免節流影響後續

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

    // 10a-0. 全域登入閘門在**自架軌的 /login 這條路徑**上真的有效（2026-08-17）。
    // 這條路不經過 doPost，所以 Code.gs 的 dispatcher 閘門碰不到它；漏掉這一段的話
    // 「關閉一般入口」在自架軌等於沒做，而且畫面上完全看不出來。
    // 做法是把 config.json 切回 restricted 跑兩次登入，驗完再切回 open 讓後面的流程照跑
    // （settings 是每個請求現讀的，不必重啟服務）。
    {
      const cfgPath = path.join(dataDir, 'store', 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.settings = {};                                   // 缺 accessMode ＝ restricted
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));

      r = await login(base, 'wang@test.local', 'wangpass123');
      check('10a-0 閘門關閉時導師帳號被擋（密碼是對的）',
        r.success === false && /僅開放/.test(String(r.error || '')), JSON.stringify(r));

      r = await login(base, 'admin@test.local', 'brandnewpass1');   // 第 5g 項改過的密碼
      check('10a-1 閘門關閉時管理員照樣進得來',
        r.success === true && !!(r.data && r.data.sessionToken), JSON.stringify(r));

      cfg.settings = { accessMode: 'open' };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    }

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

    // ── 19. 跨來源存取白名單（「Pages 當入口、後端可切換」用；見 corsHeaders_）─────
    // 這是這個服務唯一對外開的縫，所以四個方向都要釘：白名單內放行、白名單外不放行、
    // 沒帶 Origin 不放行、以及**其他路徑一律不開**（/login 帶著白名單 origin 也不能有頭）。
    const ALLOWED = 'https://npustscc.github.io';
    const acao = (r) => r.headers.get('access-control-allow-origin');
    const base2b = 'http://127.0.0.1:' + handle2.port;

    let cr = await fetch(base2b + '/healthz', { headers: { Origin: ALLOWED } });
    check('19a 白名單內的 origin → 回應帶 Allow-Origin（且是完整比對不是 *）',
      acao(cr) === ALLOWED && (cr.headers.get('vary') || '').includes('Origin'),
      'acao=' + acao(cr) + ' vary=' + cr.headers.get('vary'));

    cr = await fetch(base2b + '/healthz', { headers: { Origin: 'https://evil.example.com' } });
    check('19b 白名單外的 origin → 沒有 Allow-Origin', acao(cr) === null, 'acao=' + acao(cr));

    cr = await fetch(base2b + '/healthz');
    check('19c 沒帶 Origin → 沒有 Allow-Origin', acao(cr) === null, 'acao=' + acao(cr));

    cr = await fetch(base2b + '/exec', {
      method: 'POST', headers: { Origin: ALLOWED, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'payload=' + encodeURIComponent(JSON.stringify({ action: 'ping', rootFolderId: rootFolderId })),
    });
    check('19d /exec 也在白名單範圍內（前端所有 API 都走這條）', acao(cr) === ALLOWED, 'acao=' + acao(cr));

    cr = await fetch(base2b + '/login', {
      method: 'POST', headers: { Origin: ALLOWED, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.local', password: 'x' }),
    });
    check('19e /login 不開 CORS（自架站自己的登入頁在用，不該被別的來源打）',
      acao(cr) === null, 'acao=' + acao(cr));

    check('19f 白名單裡的 "*" 被丟掉，沒有進到設定裡',
      config.allowedOrigins.length === 1 && config.allowedOrigins[0] === ALLOWED,
      JSON.stringify(config.allowedOrigins));

    // 20. Google tokeninfo 這條路真的通得到（Pages 當入口之後，Google 登入靠它）。
    // 阻擋清單的部分在 test/urlfetch-guard.test.js（離線可測）；這裡驗的是**真的打得出去**——
    // 那正是 2026-08-17 壞掉的地方（host 把它跟 Drive REST 一起擋，於是 Pages 一切到自架
    // 後端就每個人都 Unauthorized，而畫面上只看得到「Unauthorized」四個字）。
    // 需要外網。假 token 預期回 4xx；回 0 代表連不出去，那就是這條路壞了。
    try {
      const probe = handle2.host.sandbox.UrlFetchApp.fetch(
        'https://oauth2.googleapis.com/tokeninfo?id_token=smoke-not-a-real-token');
      check('20 Google tokeninfo 打得出去（Google 登入靠這條）',
        probe.getResponseCode() >= 400 && probe.getResponseCode() < 500,
        'HTTP ' + probe.getResponseCode() + '（0 = 連不出去）');
    } catch (e) {
      check('20 Google tokeninfo 打得出去（Google 登入靠這條）', false, e.message);
    }

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
