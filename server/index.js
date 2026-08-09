// server/index.js — tutorsys 自架 Node 後端進入點（node server/index.js）
//
// 單一 http server，同源提供 API 與前端靜態檔（不開 CORS）：
//   POST /exec     GAS doPost 代理（application/x-www-form-urlencoded，payload=<JSON>；
//                  也接受 query string 帶 payload，同 GAS 行為，供 curl 探測）
//   GET  /exec     GAS doGet 代理
//   POST /login    本地帳密登入 → 換發 session（自架環境不支援 Google 登入，
//                  區網 IP origin 對 Google OAuth 而言不是合法 origin）
//   GET  /healthz  存活探測
//   GET  /*        靜態服務 PUBLIC_DIR（build-public.js 產出），'/' → login.html
//
// 這是安全邊界程式碼：所有驗證判斷 fail-closed；任何 log 不得輸出 token、密碼、
// base64 內容——只記時間、方法、路徑、（/exec 時）action 名、狀態碼。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHost } = require('./gas-host');
const { createMailer } = require('./mailer');
const { loadConfig } = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MAX_EXEC_BODY_BYTES = 30 * 1024 * 1024; // 30MB（附件走 base64，比一般 JSON 大得多）
const MAX_LOGIN_BODY_BYTES = 1024 * 1024;      // 1MB 綽綽有餘，帳密欄位不會大
const FAIL_THRESHOLD = 5;                       // 連續失敗達此門檻才開始節流

function readBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function logLine(method, urlPath, status, extra) {
  const parts = [new Date().toISOString(), method, urlPath, String(status)];
  if (extra) parts.push(extra);
  console.log(parts.join(' '));
}

// ── scrypt 密碼雜湊：格式 scrypt$N$r$p$saltHex$keyHex ─────────────────────────
const SCRYPT_KEYLEN = 32;
function scryptDerive_(password, salt, N, r, p) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: N, r: r, p: p, maxmem: 256 * N * r });
}
function verifyPassword_(password, hashStr) {
  const parts = String(hashStr || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!N || !r || !p) return false;
  let salt, key;
  try {
    salt = Buffer.from(parts[4], 'hex');
    key = Buffer.from(parts[5], 'hex');
  } catch (e) { return false; }
  try {
    const derived = scryptDerive_(password, salt, N, r, p);
    return derived.length === key.length && crypto.timingSafeEqual(derived, key);
  } catch (e) { return false; }
}
// 固定的假雜湊（模組載入時算一次、之後重複使用）：查無帳號時仍照樣跑一次 scrypt 驗證，
// 拉平「帳號不存在」與「密碼錯誤」之間的回應時間差。這個雜湊不對應任何真實密碼，
// 驗證必然失敗，純粹是為了燒掉跟真實路徑等量的 CPU 時間。
const DUMMY_HASH = 'scrypt$16384$8$1$' + crypto.randomBytes(16).toString('hex') + '$' + crypto.randomBytes(32).toString('hex');

function readUsersSync_(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

// 產雜湊（參數同 create-user.js：scrypt N=16384 r=8 p=1、32-byte 金鑰、16-byte 隨機 salt）。
function hashPassword_(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = scryptDerive_(password, salt, N, r, p);
  return 'scrypt$' + N + '$' + r + '$' + p + '$' + salt.toString('hex') + '$' + key.toString('hex');
}

// 登入帳號可以只打 @ 之前那段（系辦助理不必每次打完整 email）。
// 規則：輸入含 '@' → 原樣當 email；不含 '@' → 在現有帳號裡找 local-part 相同的，
// **剛好一個**才算數。多個相同 local-part（例如 a@x.tw 與 a@y.tw 同時存在）→ 視為查無帳號，
// 不猜、也不隨便挑一個——猜錯就是把密碼送去驗證另一個人的帳號。
// 回傳「解析後的 email」，查無對應時原樣回傳輸入值，讓後續走既有的假雜湊路徑（時間差已拉平）。
function resolveLoginEmail_(users, input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  if (!raw || raw.indexOf('@') !== -1) return raw;
  const hits = Object.keys(users || {}).filter(function (e) {
    return String(e).toLowerCase().split('@')[0] === raw;
  });
  return hits.length === 1 ? hits[0] : raw;
}

// users.json 含密碼雜湊 → 0600，且用 tmp+rename 原子寫（同 create-user.js 的做法）。
function writeUsersSync_(dataDir, users) {
  const p = path.join(dataDir, 'users.json');
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// 初始密碼＝分機。名冊上有「7829/7803」「7759或7752」這種一人多分機的寫法，
// 整串當密碼沒人打得出來（使用者 2026-08-09 實際卡在這裡），所以取**第一支數字**。
// ext 欄位本身保留原文（兩支都是有用的聯絡資訊），只有密碼取第一支。
function initialPasswordFromExt_(ext) {
  const m = String(ext == null ? '' : ext).match(/\d+/);
  return m ? m[0] : '';
}

// 新密碼規則：至少 8 字，且不能與初始密碼（分機）同形——初始密碼是 4 碼分機，
// 全校可查，等於沒有密碼，所以改密碼時一定要離開那個形狀。
const MIN_PASSWORD_LEN = 8;
function validateNewPassword_(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < MIN_PASSWORD_LEN) return '新密碼至少 ' + MIN_PASSWORD_LEN + ' 個字元';
  if (s.length > 200) return '新密碼過長';
  // 全數字一律擋（不是只擋短的）——初始密碼是 4 碼分機，換成 8 碼數字並沒有離開那個形狀。
  if (/^\d+$/.test(s)) return '新密碼不能只有數字（分機那種形式全校查得到）';
  return null;
}

function startServer(config) {
  const mailer = createMailer({
    host: config.smtpHost, port: config.smtpPort,
    user: config.smtpUser, pass: config.smtpPass,
    fromName: config.mailFromName,
    auditPath: path.join(config.dataDir, 'mails.jsonl'),
  });
  console.log('[server] 寄信模式：' + (mailer.enabled
    ? 'SMTP 真寄（' + config.smtpHost + ':' + config.smtpPort + '，帳號 ' + config.smtpUser + '）'
    : '僅落地稽核 mails.jsonl（未設定 SMTP_USER/SMTP_PASS）'));
  const host = createHost({ gsFile: config.gsFile, dataDir: config.dataDir, sendMail: mailer.enabled ? mailer.send : null });

  // 登入節流：in-memory per (ip + email)，連續失敗達 FAIL_THRESHOLD 次後，
  // loginThrottleMs 內一律回節流訊息（不透露剩餘秒數、也不再嘗試驗證密碼）。
  // 重啟即清空——伺服器重啟本身就是一種「稍後再試」，不需要跨重啟持久化節流狀態。
  const failMap = new Map(); // key: ip + '|' + email  →  { count, blockedUntil }

  function handleLogin(req, res, bodyStr) {
    let body;
    try { body = JSON.parse(bodyStr || '{}'); } catch (e) { body = {}; }
    const password = String((body && body.password) || '');
    const ip = req.socket.remoteAddress || '';
    const users = readUsersSync_(config.dataDir);
    // 允許只打 @ 之前那段（見 resolveLoginEmail_）。節流的 key 用解析後的 email，
    // 這樣「打 plant」與「打 plant@mail.npust.edu.tw」共用同一個失敗計數，繞不掉。
    const email = resolveLoginEmail_(users, (body && body.email) || '');
    const key = ip + '|' + email;
    const now = Date.now();
    const rec = failMap.get(key);

    if (rec && rec.count >= FAIL_THRESHOLD && now < rec.blockedUntil) {
      logLine('POST', '/login', 200, 'throttled');
      return sendJson(res, 200, { success: false, error: '嘗試次數過多，請稍後再試' });
    }

    const entry = email ? users[email] : null;
    // 查無帳號 → 仍對固定假雜湊跑一次 scrypt（見 DUMMY_HASH 註解），拉平時間差；
    // disabled 帳號 → 用它真正的雜湊驗證（時間路徑與正常帳號一致），但結果一律視為失敗。
    const hashToCheck = (entry && entry.hash) ? entry.hash : DUMMY_HASH;
    const passwordOk = verifyPassword_(password, hashToCheck);
    const accountOk = !!entry && entry.disabled !== true;

    if (!accountOk || !passwordOk) {
      const next = { count: (rec ? rec.count : 0) + 1, blockedUntil: 0 };
      if (next.count >= FAIL_THRESHOLD) next.blockedUntil = now + config.loginThrottleMs;
      failMap.set(key, next);
      logLine('POST', '/login', 200, 'fail');
      return sendJson(res, 200, { success: false, error: '帳號或密碼錯誤' });
    }

    failMap.delete(key);
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    let result;
    try {
      result = host.sessionStart(email, ua, ip);
    } catch (e) {
      logLine('POST', '/login', 200, 'sessionStart error');
      return sendJson(res, 200, { success: false, error: 'server error: ' + e.message });
    }
    logLine('POST', '/login', 200, 'ok');
    return sendJson(res, 200, {
      success: true,
      data: {
        sessionToken: result.sessionToken, exp: result.exp, email: result.email, name: entry.name || '',
        // 初始密碼（系辦助理＝校內分機）尚未換掉 → 登入頁提示改密碼；使用者可選「稍後再做」。
        mustChangePassword: entry.mustChangePassword === true,
      },
    });
  }

  // ── 改密碼（自助）────────────────────────────────────────────────────────────
  // 要帶「目前密碼」而不是只認 session token：session token 存在 localStorage，
  // 拿到 token 的人不該就能把密碼換掉把本人鎖在外面。驗證路徑與 /login 完全相同
  // （含假雜湊拉平時間差、共用同一份失敗節流），成功後清掉 mustChangePassword。
  function handleChangePassword(req, res, bodyStr) {
    let body;
    try { body = JSON.parse(bodyStr || '{}'); } catch (e) { body = {}; }
    const email = resolveLoginEmail_(readUsersSync_(config.dataDir), (body && body.email) || '');
    const current = String((body && body.currentPassword) || '');
    const next = String((body && body.newPassword) || '');
    const ip = req.socket.remoteAddress || '';
    const key = ip + '|' + email;
    const now = Date.now();
    const rec = failMap.get(key);

    if (rec && rec.count >= FAIL_THRESHOLD && now < rec.blockedUntil) {
      logLine('POST', '/change-password', 200, 'throttled');
      return sendJson(res, 200, { success: false, error: '嘗試次數過多，請稍後再試' });
    }
    const policyErr = validateNewPassword_(next);
    if (policyErr) {
      logLine('POST', '/change-password', 200, 'policy');
      return sendJson(res, 200, { success: false, error: policyErr });
    }

    const users = readUsersSync_(config.dataDir);
    const entry = email ? users[email] : null;
    const hashToCheck = (entry && entry.hash) ? entry.hash : DUMMY_HASH;
    const passwordOk = verifyPassword_(current, hashToCheck);
    const accountOk = !!entry && entry.disabled !== true;
    if (!accountOk || !passwordOk) {
      const n = { count: (rec ? rec.count : 0) + 1, blockedUntil: 0 };
      if (n.count >= FAIL_THRESHOLD) n.blockedUntil = now + config.loginThrottleMs;
      failMap.set(key, n);
      logLine('POST', '/change-password', 200, 'fail');
      return sendJson(res, 200, { success: false, error: '帳號或目前密碼錯誤' });
    }
    if (current === next) {
      return sendJson(res, 200, { success: false, error: '新密碼不能與目前密碼相同' });
    }

    failMap.delete(key);
    // 重讀一次再寫，縮小與 admin 端同時改同一份 users.json 的覆寫窗口。
    const fresh = readUsersSync_(config.dataDir);
    const target = fresh[email] || entry;
    fresh[email] = Object.assign({}, target, {
      hash: hashPassword_(next), mustChangePassword: false, passwordChangedAt: new Date().toISOString(),
    });
    writeUsersSync_(config.dataDir, fresh);
    logLine('POST', '/change-password', 200, 'ok');
    return sendJson(res, 200, { success: true, data: { changed: true } });
  }

  // ── 管理端：系辦助理的登入帳號 ───────────────────────────────────────────────
  // 這一層（本機帳密）活在 server/ 而不是 Code.gs 裡，所以走 /exec 的 action 管不到它，
  // 另開 /admin/accounts 端點。授權完全沿用 Code.gs 本尊：session token 過
  // verifySessionToken_，再用 resolveRoles_ 判 isAdmin——不另立一套判斷，免得兩邊漂移。
  // 回應**永遠不含 hash**，只回「有沒有帳號、是否停用、是否還在用初始密碼」。
  function requireAdminBySession_(body) {
    const token = String((body && body.sessionToken) || '');
    // verifySessionToken_ 直接回 email 字串（驗不過回 null），不是 {ok,email} 物件。
    const verifiedEmail = host.sandbox.verifySessionToken_(token);
    if (!verifiedEmail) return { ok: false, error: 'Session expired' };
    const v = { email: verifiedEmail };
    const ctx = { root: host.rootFolderId };
    const cfg = host.sandbox.readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = host.sandbox.readJsonSafe_('departments.json', ctx, []);
    const classes = host.sandbox.readJsonSafe_('classes.json', ctx, []);
    const roles = host.sandbox.resolveRoles_(v.email, cfg, departments, classes);
    if (!roles || !roles.isAdmin) return { ok: false, error: 'admin only' };
    return { ok: true, email: v.email, config: cfg };
  }

  function handleAdminAccounts(req, res, bodyStr) {
    let body;
    try { body = JSON.parse(bodyStr || '{}'); } catch (e) { body = {}; }
    const auth = requireAdminBySession_(body);
    if (!auth.ok) {
      logLine('POST', '/admin/accounts', 200, auth.error);
      return sendJson(res, 200, { success: false, error: auth.error });
    }
    const op = String((body && body.op) || 'list');
    const users = readUsersSync_(config.dataDir);

    // list：把系辦助理白名單與本機帳號對起來，回「誰還沒有帳號、誰還在用初始密碼」。
    if (op === 'list') {
      const assistants = (auth.config.deptAssistants || []).filter(function (a) { return a && a.deleted !== true; });
      const rows = assistants.map(function (a) {
        const u = users[String(a.email || '').toLowerCase()];
        return {
          email: a.email, name: a.name || '', ext: a.ext || '', deptIds: a.deptIds || [],
          assistantDisabled: a.disabled === true,
          hasAccount: !!u,
          accountDisabled: !!u && u.disabled === true,
          mustChangePassword: !!u && u.mustChangePassword === true,
          passwordChangedAt: (u && u.passwordChangedAt) || null,
        };
      });
      return sendJson(res, 200, { success: true, data: { accounts: rows } });
    }

    const targetEmail = String((body && body.email) || '').trim().toLowerCase();
    if (!targetEmail) return sendJson(res, 200, { success: false, error: 'email required' });

    // create/reset：以指定密碼（預設＝白名單裡的分機）建立或重設，並標記 mustChangePassword。
    if (op === 'createOrReset') {
      const assistant = (auth.config.deptAssistants || []).filter(function (a) {
        return a && a.deleted !== true && String(a.email || '').toLowerCase() === targetEmail;
      })[0];
      if (!assistant) return sendJson(res, 200, { success: false, error: '這個 email 不在系辦助理白名單內' });
      const pw = String((body && body.password) || initialPasswordFromExt_(assistant.ext) || '').trim();
      if (!pw) return sendJson(res, 200, { success: false, error: '沒有可用的初始密碼（白名單沒填分機），請手動指定' });
      const fresh = readUsersSync_(config.dataDir);
      fresh[targetEmail] = Object.assign({}, fresh[targetEmail] || {}, {
        name: assistant.name || '', hash: hashPassword_(pw), disabled: false, mustChangePassword: true,
      });
      writeUsersSync_(config.dataDir, fresh);
      logLine('POST', '/admin/accounts', 200, 'createOrReset ' + targetEmail);
      return sendJson(res, 200, { success: true, data: { email: targetEmail, usedExtAsPassword: !(body && body.password) } });
    }

    // enable/disable：停用即無法登入（驗證路徑照跑，結果一律失敗，見 handleLogin）。
    if (op === 'setDisabled') {
      const fresh = readUsersSync_(config.dataDir);
      if (!fresh[targetEmail]) return sendJson(res, 200, { success: false, error: '這個 email 沒有本機帳號' });
      fresh[targetEmail] = Object.assign({}, fresh[targetEmail], { disabled: (body && body.disabled) === true });
      writeUsersSync_(config.dataDir, fresh);
      logLine('POST', '/admin/accounts', 200, 'setDisabled ' + targetEmail);
      return sendJson(res, 200, { success: true, data: { email: targetEmail, disabled: (body && body.disabled) === true } });
    }

    return sendJson(res, 200, { success: false, error: 'unknown op: ' + op });
  }

  function handleExecPost(req, res, bodyStr, urlObj) {
    let payload = new URLSearchParams(bodyStr).get('payload');
    if (!payload) payload = urlObj.searchParams.get('payload');
    let actionName = 'unknown';
    try { actionName = JSON.parse(payload || '{}').action || 'unknown'; } catch (e) { /* 保留 'unknown'，不印 payload 內容 */ }
    let out;
    try {
      out = host.exec(payload || '');
    } catch (e) {
      // 形狀同 dev/Code.gs doPost 的 catch：{success:false, error:...}。
      out = JSON.stringify({ success: false, error: 'server error: ' + e.message });
    }
    logLine('POST', '/exec', 200, 'action=' + actionName);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(out);
  }

  function handleExecGet(req, res, urlObj) {
    const q = {};
    urlObj.searchParams.forEach(function (v, k) { q[k] = v; });
    let out;
    try {
      out = host.doGet(q);
    } catch (e) {
      out = JSON.stringify({ success: false, error: 'server error: ' + e.message });
    }
    logLine('GET', '/exec', 200);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(out);
  }

  // 路徑穿越防護：resolve 後必須落在 PUBLIC_DIR 內（或恰好等於 PUBLIC_DIR 本身）。
  // 整段包 try/catch：畸形 percent-encoding 會讓 decodeURIComponent 丟 URIError、
  // 含 NUL byte 的路徑會讓 fs.readFile 同步丟 ERR_INVALID_ARG_VALUE——不接住的話
  // 一個畸形請求就能打死整個 process（fail-closed 回 400，不是 crash）。
  function serveStatic(req, res, urlObj) {
    let target;
    try {
      let rel = decodeURIComponent(urlObj.pathname);
      if (rel === '' || rel === '/') rel = '/login.html';
      if (rel.indexOf('\0') !== -1) throw new Error('NUL byte in path');
      const base = path.resolve(config.publicDir);
      target = path.resolve(base, '.' + rel); // '.' + '/xxx' → './xxx'，相對 base 解析
      if (target !== base && !target.startsWith(base + path.sep)) {
        logLine(req.method, urlObj.pathname, 403);
        res.writeHead(403); res.end('forbidden');
        return;
      }
    } catch (e) {
      logLine(req.method, urlObj.pathname, 400);
      res.writeHead(400); res.end('bad request');
      return;
    }
    fs.readFile(target, function (err, buf) {
      if (err) {
        logLine(req.method, urlObj.pathname, 404);
        res.writeHead(404); res.end('not found');
        return;
      }
      logLine(req.method, urlObj.pathname, 200);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  const server = http.createServer(function (req, res) {
    let urlObj;
    try {
      urlObj = new URL(req.url, 'http://' + (req.headers.host || (config.bind + ':' + config.port)));
    } catch (e) {
      res.writeHead(400); res.end('bad request'); return;
    }
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      logLine('GET', '/healthz', 200);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/exec') {
      return handleExecGet(req, res, urlObj);
    }
    if (req.method === 'POST' && pathname === '/exec') {
      readBody(req, MAX_EXEC_BODY_BYTES).then(function (bodyStr) {
        handleExecPost(req, res, bodyStr, urlObj);
      }).catch(function (e) {
        logLine('POST', '/exec', 413, e.message);
        res.writeHead(413); res.end('payload too large');
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/login') {
      readBody(req, MAX_LOGIN_BODY_BYTES).then(function (bodyStr) {
        handleLogin(req, res, bodyStr);
      }).catch(function (e) {
        logLine('POST', '/login', 400, e.message);
        res.writeHead(400); res.end('bad request');
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/change-password') {
      readBody(req, MAX_LOGIN_BODY_BYTES).then(function (bodyStr) {
        handleChangePassword(req, res, bodyStr);
      }).catch(function (e) {
        logLine('POST', '/change-password', 400, e.message);
        res.writeHead(400); res.end('bad request');
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/admin/accounts') {
      readBody(req, MAX_LOGIN_BODY_BYTES).then(function (bodyStr) {
        handleAdminAccounts(req, res, bodyStr);
      }).catch(function (e) {
        logLine('POST', '/admin/accounts', 400, e.message);
        res.writeHead(400); res.end('bad request');
      });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, urlObj);
    }
    logLine(req.method, pathname, 404);
    res.writeHead(404); res.end('not found');
  });

  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(config.port, config.bind, function () {
      const addr = server.address();
      console.log('[server] listening on http://' + config.bind + ':' + addr.port + '（dataDir=' + config.dataDir + '）');
      resolve({
        server: server,
        host: host,
        port: addr.port,
        close: function () { return new Promise(function (r) { server.close(function () { r(); }); }); },
      });
    });
  });
}

module.exports = { startServer, initialPasswordFromExt_, resolveLoginEmail_, validateNewPassword_ };

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error('[server] 設定錯誤：' + e.message);
    process.exit(1);
  }
  startServer(config).catch(function (e) {
    console.error('[server] 啟動失敗：' + e.message);
    process.exit(1);
  });
}
