// test/mailer.test.js — server/mailer.js 零依賴 SMTP 客戶端的單元測試。
// 用 node:net 起一個假 SMTP server（明文，靠 mailer 的 connectFn 測試 seam 注入，
// 正式路徑走 node:tls 不在此測），驗證完整對話：AUTH LOGIN 憑證、信封收件人、
// RFC 2047 主旨編碼、base64 內文、稽核落地、錯誤與拒收路徑。

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMailer } = require('../server/mailer');

// ── 假 SMTP server ────────────────────────────────────────────────────────────
// opts.authFail=true 時對密碼回 535。回傳 { port, state, close }；
// state.connections 計連線數、state.sessions 每連線一筆 { user, pass, from, rcpts, data, cmds }。
function startFakeSmtp(opts) {
  opts = opts || {};
  const state = { connections: 0, sessions: [] };
  const server = net.createServer(function (socket) {
    state.connections++;
    const sess = { user: null, pass: null, from: null, rcpts: [], data: null, cmds: [] };
    state.sessions.push(sess);
    let buf = '';
    let mode = 'cmd'; // cmd | auth-user | auth-pass | data
    let dataLines = [];
    socket.on('error', function () { /* 客戶端提早斷線不炸測試 */ });
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', function (d) {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (mode === 'data') {
          if (line === '.') {
            sess.data = dataLines.join('\r\n');
            mode = 'cmd';
            socket.write('250 2.0.0 OK queued\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }
        if (mode === 'auth-user') {
          sess.user = Buffer.from(line, 'base64').toString('utf8');
          mode = 'auth-pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
          continue;
        }
        if (mode === 'auth-pass') {
          sess.pass = Buffer.from(line, 'base64').toString('utf8');
          mode = 'cmd';
          socket.write(opts.authFail ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 accepted\r\n');
          continue;
        }
        sess.cmds.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake greets you\r\n250 AUTH LOGIN\r\n'); // multiline，測續行處理
        } else if (upper === 'AUTH LOGIN') {
          mode = 'auth-user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM:')) {
          sess.from = line.slice(10).trim();
          socket.write('250 2.1.0 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          sess.rcpts.push(line.slice(8).trim());
          socket.write('250 2.1.5 OK\r\n');
        } else if (upper === 'DATA') {
          mode = 'data';
          dataLines = [];
          socket.write('354 go ahead\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('500 unrecognized\r\n');
        }
      }
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        port: server.address().port,
        state: state,
        close: function () { return new Promise(function (r) { server.close(function () { r(); }); }); },
      });
    });
  });
}

function makeMailer(port, extra) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-test-'));
  const auditPath = path.join(tmpDir, 'mails.jsonl');
  const mailer = createMailer(Object.assign({
    user: 'sender@example.edu.tw',
    pass: 'app-password-123',
    fromName: '導師資訊系統',
    auditPath: auditPath,
    timeoutMs: 5000,
    connectFn: function (onConnect) { return net.connect({ port: port, host: '127.0.0.1' }, onConnect); },
  }, extra || {}));
  return { mailer: mailer, auditPath: auditPath };
}

function readAudit(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}

// 解 RFC 2047 =?UTF-8?B?...?=（含摺行）回原字串
function decodeHeaderWords(v) {
  return v.replace(/\r\n\s/g, '').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, function (m, b) {
    return Buffer.from(b, 'base64').toString('utf8');
  });
}

test('完整寄信對話：AUTH 憑證、收件人、主旨編碼、base64 內文、稽核', async function () {
  const srv = await startFakeSmtp();
  const { mailer, auditPath } = makeMailer(srv.port);
  const subject = '【屏科大導師資訊系統】登入通知（測試版）';
  const body = '您好：\n偵測到您的帳號於 2026-07-16 10:00:00 登入。\n若非本人操作請立即聯繫管理者。';
  const result = await mailer.send({ to: 'tutor@example.edu.tw', subject: subject, body: body });
  await srv.close();

  assert.strictEqual(result.status, 'sent');
  const sess = srv.state.sessions[0];
  assert.strictEqual(sess.user, 'sender@example.edu.tw');
  assert.strictEqual(sess.pass, 'app-password-123');
  assert.strictEqual(sess.from, '<sender@example.edu.tw>');
  assert.deepStrictEqual(sess.rcpts, ['<tutor@example.edu.tw>']);

  const raw = sess.data;
  const headerEnd = raw.indexOf('\r\n\r\n');
  assert.ok(headerEnd > 0, '訊息應有 header/body 分界');
  const headers = raw.slice(0, headerEnd);
  const bodyB64 = raw.slice(headerEnd + 4).replace(/\r\n/g, '');
  assert.ok(headers.indexOf('Content-Transfer-Encoding: base64') !== -1);
  assert.ok(headers.indexOf('Content-Type: text/plain; charset=UTF-8') !== -1);
  assert.ok(headers.indexOf('To: tutor@example.edu.tw') !== -1);
  const subjectLine = /Subject: ((?:.|\r\n\s)+?)\r\n[A-Z]/.exec(headers + '\r\nX');
  assert.ok(subjectLine, '應有 Subject header');
  assert.strictEqual(decodeHeaderWords(subjectLine[1]), subject);
  assert.ok(decodeHeaderWords(headers).indexOf('導師資訊系統 <sender@example.edu.tw>') !== -1, 'From 應含寄件人名稱');
  assert.strictEqual(Buffer.from(bodyB64, 'base64').toString('utf8'), body);

  const audit = readAudit(auditPath);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].kind, 'smtp-result');
  assert.strictEqual(audit[0].status, 'sent');
  assert.strictEqual(audit[0].to, 'tutor@example.edu.tw');
});

test('逗號分隔多收件人 → 逐一 RCPT TO', async function () {
  const srv = await startFakeSmtp();
  const { mailer } = makeMailer(srv.port);
  const result = await mailer.send({ to: 'a@example.com, b@example.org', subject: 'hi', body: 'x' });
  await srv.close();
  assert.strictEqual(result.status, 'sent');
  assert.deepStrictEqual(srv.state.sessions[0].rcpts, ['<a@example.com>', '<b@example.org>']);
  assert.ok(srv.state.sessions[0].data.indexOf('To: a@example.com, b@example.org') !== -1);
});

test('非法收件人（CRLF 注入嘗試）→ 直接拒絕，連線都不開', async function () {
  const srv = await startFakeSmtp();
  const { mailer, auditPath } = makeMailer(srv.port);
  const result = await mailer.send({ to: 'a@example.com>\r\nRCPT TO:<evil@x.com', subject: 's', body: 'b' });
  await srv.close();
  assert.strictEqual(result.status, 'error');
  assert.ok(/invalid recipient/.test(result.error));
  assert.strictEqual(srv.state.connections, 0);
  const audit = readAudit(auditPath);
  assert.strictEqual(audit[0].status, 'error');
});

test('未設定帳密 → logged-only，不嘗試連線', async function () {
  const srv = await startFakeSmtp();
  const { mailer } = makeMailer(srv.port, { user: '', pass: '' });
  assert.strictEqual(mailer.enabled, false);
  const result = await mailer.send({ to: 'a@example.com', subject: 's', body: 'b' });
  await srv.close();
  assert.strictEqual(result.status, 'logged-only');
  assert.strictEqual(srv.state.connections, 0);
});

test('AUTH 失敗（535）→ status error 且錯誤訊息帶 SMTP 回應、不外拋', async function () {
  const srv = await startFakeSmtp({ authFail: true });
  const { mailer, auditPath } = makeMailer(srv.port);
  const result = await mailer.send({ to: 'a@example.com', subject: 's', body: 'b' });
  await srv.close();
  assert.strictEqual(result.status, 'error');
  assert.ok(result.error.indexOf('535') !== -1);
  assert.strictEqual(readAudit(auditPath)[0].status, 'error');
});

test('連續兩封信串行寄送，各自成功', async function () {
  const srv = await startFakeSmtp();
  const { mailer } = makeMailer(srv.port);
  const results = await Promise.all([
    mailer.send({ to: 'a@example.com', subject: '一', body: '1' }),
    mailer.send({ to: 'b@example.com', subject: '二', body: '2' }),
  ]);
  await srv.close();
  assert.deepStrictEqual(results.map(function (r) { return r.status; }), ['sent', 'sent']);
  assert.strictEqual(srv.state.sessions.length, 2);
  assert.deepStrictEqual(srv.state.sessions[0].rcpts, ['<a@example.com>']);
  assert.deepStrictEqual(srv.state.sessions[1].rcpts, ['<b@example.com>']);
});
