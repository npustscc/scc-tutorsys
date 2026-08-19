// 自架端「本機帳號只有一份」的接縫（2026-08-19 災情修復）。
//
// 災情：食品系助理改了密碼之後登不進去，管理員按「重設為分機」也登不進去。
// 根因是自架端同時存在兩套帳號系統：
//   /login 與 /admin/accounts → server/data/users.json，scrypt
//   /exec 的 localLogin（Code.gs）→ store/localAccounts.json，PBKDF2＋pepper
// 入口搬到 Pages 之後登入表單打的是 /exec，於是「重設寫到 A 檔、登入讀 B 檔」。
//
// 這裡用真的 host（node:vm 載入 Code.gs 本體）驗接縫：兩條路必須看到同一份帳號、同一種雜湊。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHost } = require('../server/gas-host.js');
const { hashPassword_ } = require('../server/password.js');

function withHost(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorsys-seam-'));
  try {
    const host = createHost({ gsFile: 'dev/Code.gs', dataDir: dir, sendMail: null });
    return fn(host, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const usersOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));

test('🔒 Code.gs 讀 localAccounts.json ＝ 讀 users.json（同一份帳號）', () => {
  withHost((host, dir) => {
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({
      'fose@mail.npust.edu.tw': { name: '食品系系辦', hash: hashPassword_('7040'), disabled: false, mustChangePassword: true },
    }));
    const got = host.sandbox.readJsonSafe_('localAccounts.json', {}, {});
    assert.ok(got['fose@mail.npust.edu.tw'], 'localLogin 看不到 users.json 裡的帳號');
    assert.equal(got['fose@mail.npust.edu.tw'].name, '食品系系辦');
  });
});

test('🔒 Code.gs 寫 localAccounts.json ＝ 寫進 users.json，而且是 0600', () => {
  withHost((host, dir) => {
    host.sandbox.writeJsonPath_('localAccounts.json', { 'a@x.com': { hash: 'h' } }, {});
    assert.ok(usersOf(dir)['a@x.com'], '寫到別的檔案去了');
    const mode = fs.statSync(path.join(dir, 'users.json')).mode & 0o777;
    assert.equal(mode, 0o600, '含密碼雜湊的檔案權限應該是 0600，實際 ' + mode.toString(8));
  });
});

test('🔒 雜湊統一成 scrypt：/login 產的雜湊，Code.gs 那條路驗得過', () => {
  withHost((host) => {
    const h = hashPassword_('e2e-pass-1234');
    assert.equal(host.sandbox.verifyPasswordGas_('e2e-pass-1234', h), true, '兩套雜湊沒有對齊');
    assert.equal(host.sandbox.verifyPasswordGas_('wrong', h), false);
  });
});

test('🔒 反過來也要成立：Code.gs 產的雜湊，/login 那支驗得過', () => {
  withHost((host) => {
    const { verifyPassword_ } = require('../server/password.js');
    const h = host.sandbox.hashPasswordGas_('another-pass-1');
    assert.equal(verifyPassword_('another-pass-1', h), true);
  });
});

test('端到端：走 Code.gs 的 localLogin，用 users.json 裡的密碼登入得了', () => {
  withHost((host, dir) => {
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({
      'fose@mail.npust.edu.tw': { name: '食品系系辦', hash: hashPassword_('7040'), disabled: false },
    }));
    // localLogin 驗完密碼還會過一次全域登入閘門，所以這個帳號必須真的有角色
    // （這一步不是 bug，是設計：不發 session 給進不來的人）。
    host.sandbox.writeJsonPath_('config.json', {
      users: {}, settings: {},
      deptAssistants: [{ email: 'fose@mail.npust.edu.tw', name: '食品系系辦', deptIds: ['食品系'] }],
    }, {});
    host.sandbox.writeJsonPath_('departments.json', [{ id: '食品系', name: '食品系', active: true }], {});
    const ok = host.sandbox.localLoginAction_({ email: 'fose@mail.npust.edu.tw', password: '7040' }, {});
    assert.ok(ok && ok.sessionToken, '登不進去：' + JSON.stringify(ok));
    const bad = host.sandbox.localLoginAction_({ email: 'fose@mail.npust.edu.tw', password: 'wrong' }, {});
    assert.ok(bad && bad.error, '錯密碼竟然過了');
  });
});
