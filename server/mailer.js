// server/mailer.js — 零依賴 SMTP 寄信模組（Gmail SMTPS 465，隱式 TLS）。
//
// 設計取捨：
// - 只支援「隱式 TLS」（連上就是 TLS，Gmail smtp.gmail.com:465），不做 STARTTLS 升級
//   （587）——少一個協商步驟就少一種降級攻擊面，Gmail 兩者都收。
// - AUTH LOGIN + Gmail 應用程式密碼（帳號需開兩步驟驗證後產生 app password）。
// - 未設定 SMTP_USER/SMTP_PASS → enabled=false，send() 直接回 {status:'logged-only'}，
//   行為等同過去「只落地 mails.jsonl 稽核」的模式；設定後才真的寄。
// - send() 內部以 promise chain 串行化：同時多封信也只開一條連線、一封一封寄，
//   避免對 Gmail 開出並發連線（配額與濫用偵測都不友善）。
// - 寄信結果（sent/error）append 到 mails.jsonl（kind:'smtp-result'），與 gas-host
//   落的原始稽核行（誰、何時、什麼主旨）互補成完整郵件軌跡。
// - 這是安全邊界程式碼：任何 log/稽核不得輸出密碼；收件人過白名單 regex 防
//   CRLF/SMTP 命令注入；主旨/寄件人名稱含任何非可印 ASCII（含控制字元）一律走
//   RFC 2047 encoded-word（base64）編碼，不可能夾帶換行進 header。
//
// 測試 seam：opts.connectFn 可注入替代連線（test/mailer.test.js 用 node:net 起假
// SMTP server 驗證完整對話），正式路徑用 node:tls。

const tls = require('node:tls');
const fs = require('node:fs');

const RECIPIENT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// RFC 2047 encoded-word。純可印 ASCII（不含 '=?'）原樣輸出；否則以 code point 切塊
// （每塊 8 字，避免單一 encoded-word 超過 75 字元上限，也不會切斷 surrogate pair）、
// 各自編成 =?UTF-8?B?...?=，以「CRLF + 空格」摺行銜接。
function encodeHeaderWord_(text) {
  const s = String(text || '');
  if (/^[\x20-\x7e]*$/.test(s) && s.indexOf('=?') === -1) return s;
  const cps = Array.from(s);
  const chunks = [];
  for (let i = 0; i < cps.length; i += 8) {
    chunks.push('=?UTF-8?B?' + b64(cps.slice(i, i + 8).join('')) + '?=');
  }
  return chunks.join('\r\n ');
}

// 組 RFC 5322 訊息。內文一律 base64（每 76 字元斷行）：base64 字母表不含 '.'，
// 不可能產生裸 ".\r\n" 行，免做 dot-stuffing，也天然免疫內文注入 header。
function buildMessage_(fromUser, fromName, toList, subject, body) {
  const fromHeader = fromName
    ? encodeHeaderWord_(fromName) + ' <' + fromUser + '>'
    : fromUser;
  const headers = [
    'From: ' + fromHeader,
    'To: ' + toList.join(', '),
    'Subject: ' + encodeHeaderWord_(subject),
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = b64(body).replace(/(.{76})/g, '$1\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + encodedBody;
}

function createMailer(opts) {
  opts = opts || {};
  const host = opts.host || 'smtp.gmail.com';
  const port = opts.port ? Number(opts.port) : 465;
  const user = String(opts.user || '');
  const pass = String(opts.pass || '');
  const fromName = String(opts.fromName || '');
  const auditPath = opts.auditPath || null;
  const timeoutMs = opts.timeoutMs || 20000;
  const connectFn = opts.connectFn || function (onConnect) {
    return tls.connect({ host: host, port: port, servername: host }, onConnect);
  };
  const enabled = !!(user && pass);

  function audit_(entry) {
    if (!auditPath) return;
    try {
      fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) {
      console.error('[mailer] mails.jsonl 寫入失敗：' + e.message);
    }
  }

  // 單封信的完整 SMTP 對話。任何非預期回應/逾時/連線中斷 → reject（由 send() 統一
  // 落稽核與 log，絕不外拋進請求處理路徑）。
  function sendOnce_(msg) {
    const toList = String((msg && msg.to) || '').split(',')
      .map(function (s) { return s.trim(); }).filter(Boolean);
    if (!toList.length) return Promise.reject(new Error('no recipients'));
    for (let i = 0; i < toList.length; i++) {
      if (!RECIPIENT_RE.test(toList[i])) {
        return Promise.reject(new Error('invalid recipient: ' + toList[i]));
      }
    }
    const subject = String((msg && msg.subject) || '');
    const body = String((msg && msg.body) || '');

    return new Promise(function (resolve, reject) {
      let settled = false;
      let waiter = null; // 目前等待中的回應處理器（對話嚴格串行，同時最多一個）
      let lineBuf = '';
      const socket = connectFn(function () { /* 連上即等 220 greeting */ });
      const timer = setTimeout(function () {
        fail(new Error('SMTP timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);

      function fail(e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch (err) { /* noop */ }
        reject(e);
      }
      // 成功收尾走優雅關閉（end = flush 完寫入佇列才送 FIN），確保 QUIT 送達對端；
      // destroy 會直接丟棄待送資料、對端讀到 ECONNRESET。
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.end(); } catch (err) { /* noop */ }
        resolve();
      }

      socket.on('error', fail);
      socket.on('close', function () { if (!settled) fail(new Error('SMTP connection closed unexpectedly')); });
      socket.on('data', function (d) {
        lineBuf += d.toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          const m = /^(\d{3})([ -]?)/.exec(line);
          if (!m) continue;
          if (m[2] === '-') continue; // multiline 回應的續行（如 EHLO 的 250-），等最後一行
          const w = waiter; waiter = null;
          if (w) w(Number(m[1]), line);
        }
      });

      function expect(codes) {
        return new Promise(function (res, rej) {
          waiter = function (code, line) {
            if (codes.indexOf(code) !== -1) res(code);
            else rej(new Error('SMTP unexpected response: ' + line));
          };
        });
      }
      function cmd(line, codes) { socket.write(line + '\r\n'); return expect(codes); }

      expect([220])
        .then(function () { return cmd('EHLO scc-tutorsys', [250]); })
        .then(function () { return cmd('AUTH LOGIN', [334]); })
        .then(function () { return cmd(b64(user), [334]); })
        .then(function () { return cmd(b64(pass), [235]); })
        .then(function () { return cmd('MAIL FROM:<' + user + '>', [250]); })
        .then(function () {
          return toList.reduce(function (p, r) {
            return p.then(function () { return cmd('RCPT TO:<' + r + '>', [250, 251]); });
          }, Promise.resolve());
        })
        .then(function () { return cmd('DATA', [354]); })
        .then(function () {
          return cmd(buildMessage_(user, fromName, toList, subject, body) + '\r\n.', [250]);
        })
        .then(function () { socket.write('QUIT\r\n'); done(); })
        .catch(fail);
    });
  }

  // 對外介面：串行佇列 + 統一結果形狀（永不 reject）。
  let chain = Promise.resolve();
  function send(msg) {
    if (!enabled) return Promise.resolve({ status: 'logged-only' });
    const run = chain.then(function () {
      return sendOnce_(msg).then(
        function () {
          audit_({ at: new Date().toISOString(), kind: 'smtp-result', to: (msg && msg.to) || '', subject: (msg && msg.subject) || '', status: 'sent' });
          return { status: 'sent' };
        },
        function (e) {
          audit_({ at: new Date().toISOString(), kind: 'smtp-result', to: (msg && msg.to) || '', subject: (msg && msg.subject) || '', status: 'error', error: e.message });
          // log 前去掉控制字元：to 是不可信輸入，不淨化的話一筆非法收件人就能偽造多行 log
          console.error(('[mailer] 寄信失敗 to=' + ((msg && msg.to) || '') + '：' + e.message).replace(/[\r\n\t]+/g, ' '));
          return { status: 'error', error: e.message };
        }
      );
    });
    chain = run.then(function () {}, function () {});
    return run;
  }

  return { enabled: enabled, send: send };
}

module.exports = { createMailer };
