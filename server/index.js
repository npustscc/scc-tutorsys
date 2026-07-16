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
    const email = String((body && body.email) || '').trim().toLowerCase();
    const password = String((body && body.password) || '');
    const ip = req.socket.remoteAddress || '';
    const key = ip + '|' + email;
    const now = Date.now();
    const rec = failMap.get(key);

    if (rec && rec.count >= FAIL_THRESHOLD && now < rec.blockedUntil) {
      logLine('POST', '/login', 200, 'throttled');
      return sendJson(res, 200, { success: false, error: '嘗試次數過多，請稍後再試' });
    }

    const users = readUsersSync_(config.dataDir);
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
      data: { sessionToken: result.sessionToken, exp: result.exp, email: result.email, name: entry.name || '' },
    });
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

module.exports = { startServer };

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
