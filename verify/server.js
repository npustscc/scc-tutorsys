// verify/server.js — 端到端驗證用本機伺服器
//   http://127.0.0.1:8788  POST /exec   → GAS doPost（e.parameter.payload，同 proxyCall 的
//                                          URLSearchParams 形狀；見 dev/index.html proxyCall 與
//                                          dev/Code.gs doPost 開頭）；加 600ms 人工延遲讓按鈕
//                                          pending 態可觀察；CORS 全開。
//                          GET  /mint?email=x → 鑄造合法 session token（驅動器/探針用）
//                          GET  /mails        → MailApp 寄件證據
//                          GET  /state?path=x → dump in-memory store（證據）
//   http://127.0.0.1:8787  static  → serve repo 根目錄（/dev/index.html）
// 單獨啟動：node verify/server.js；或由 verify/drive.mjs 以 startServers() 內嵌啟動。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createEmulator } = require('./gas-emulator');

const REPO_ROOT = path.join(__dirname, '..');
const EXEC_DELAY_MS = 600;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

function startServers(opts) {
  opts = opts || {};
  const em = createEmulator(opts);

  const api = http.createServer(async function (req, res) {
    cors(res);
    const url = new URL(req.url, 'http://127.0.0.1:8788');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && url.pathname === '/exec') {
      const raw = await readBody(req);
      // proxyCall 送 URLSearchParams（application/x-www-form-urlencoded）：payload=<JSON 字串>
      let payload = new URLSearchParams(raw).get('payload');
      if (!payload) { try { payload = JSON.parse(raw).payload; } catch (e) {} }
      await new Promise(function (r) { setTimeout(r, EXEC_DELAY_MS); });
      let body;
      try {
        body = em.exec(payload || '');
      } catch (e) {
        body = JSON.stringify({ success: false, error: 'emulator crash: ' + e.message });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/mint') {
      const issued = em.mint(url.searchParams.get('email') || 'admin@test.local');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(issued));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/mails') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(em.sentMails));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      const p = url.searchParams.get('path');
      const data = p ? (em.store.has(p) ? em.store.get(p) : null) : Array.from(em.store.keys());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  const statics = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1:8787');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/dev/index.html';
    const file = path.join(REPO_ROOT, rel);
    if (!file.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, function (err, buf) {
      if (err) { res.writeHead(404); res.end('not found: ' + rel); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  api.listen(8788, '127.0.0.1');
  statics.listen(8787, '127.0.0.1');
  console.log('[verify] api    http://127.0.0.1:8788  (POST /exec, GET /mint /mails /state)');
  console.log('[verify] static http://127.0.0.1:8787/dev/index.html');

  return {
    em: em,
    close: function () { api.close(); statics.close(); },
  };
}

module.exports = { startServers };

if (require.main === module) startServers();
