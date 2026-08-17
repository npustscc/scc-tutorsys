#!/usr/bin/env node
// scripts/deploy-onprem.mjs — 一鍵部署到自架實例。
//
//   node scripts/deploy-onprem.mjs [dev|prod] [--host coma|scc-server]
//
// 部署的是 **GitHub 上的 master**，不是本機工作樹：腳本先確認本機沒有漏 push 的
// commit，再對該實例做 git pull → build-public → systemctl restart → healthz 驗證，
// 最後比對遠端 HEAD 與本機 HEAD 一致才算成功（exit 0）。
//
// **兩台主機（2026-08-17 起）**：
//   coma（預設）——服務跑在獨立 unix 使用者 scc-tutor 底下、家目錄 /srv/scc-tutor，
//     指令用 `sudo -u scc-tutor` 在本機執行，不經 ssh（腳本本來就在 coma 上跑）。
//   scc-server——舊的那台，經 ssh。它正在降為備份接收端，保留這條路只為了過渡期。
// 前置需求：coma sudo 免密碼；打 scc-server 則需要 ~/.ssh/config 有 Host scc-server。

import { execFileSync } from 'node:child_process';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

const argv = process.argv.slice(2);
const hostIdx = argv.indexOf('--host');
const host = hostIdx === -1 ? 'coma' : argv[hostIdx + 1];
// 把 --host 與它的值挑掉，剩下的第一個位置參數才是 dev/prod。
// （不要用 `i !== hostIdx + 1` 過濾：hostIdx 為 -1 時那會誤刪 index 0，也就是 dev/prod 本身。）
const positional = argv.filter((a, i) => hostIdx === -1 ? true : (i !== hostIdx && i !== hostIdx + 1));
const target = positional[0] || 'dev';
if (target !== 'dev' && target !== 'prod') {
  console.error('用法：node scripts/deploy-onprem.mjs [dev|prod] [--host coma|scc-server]');
  process.exit(1);
}
if (host !== 'coma' && host !== 'scc-server') {
  console.error('--host 只接受 coma 或 scc-server（實際上有這兩台，寫錯會部署到不存在的地方）');
  process.exit(1);
}
const inst = 'scc-tutor-' + target;
const port = target === 'prod' ? 8789 : 8790;
// coma 的實例在 /srv/scc-tutor 底下、由 scc-tutor 這個使用者跑；scc-server 是該帳號的家目錄。
const instDir = host === 'coma' ? '/srv/scc-tutor/' + inst : '~/' + inst;

// 前置檢查：漏 push 直接擋下（會部署到舊版還以為成功）；工作樹有未 commit 變更只警告
// （變更不會被部署，但常是「改了忘記 commit」的訊號）。
const ahead = sh('git', ['rev-list', '--count', 'origin/master..HEAD']);
if (ahead !== '0') {
  console.error('[deploy] 本機比 origin/master 多 ' + ahead + ' 個 commit——先 git push 再部署。');
  process.exit(1);
}
const dirty = sh('git', ['status', '--porcelain']);
if (dirty) {
  console.warn('[deploy] 注意：工作樹有未 commit 的變更（不會被部署）：\n' + dirty);
}
const localHead = sh('git', ['rev-parse', 'HEAD']);

// coma 上 repo 的檔案屬於 scc-tutor（那個使用者沒有 sudo，也不該有），所以更新程式碼那兩步
// 用 `sudo -u scc-tutor` 切過去跑，重啟服務那步留給 coma 自己的 sudo。scc-server 上兩者
// 都是同一個帳號，不用切。**不要反過來整段用 root 跑**：那會讓 git pull 產生 root 擁有的檔案，
// 下一次以 scc-tutor 身分 pull 就會權限不足。
const asOwner = host === 'coma' ? 'sudo -u scc-tutor bash -c ' : 'bash -c ';
const q = (s) => "'" + s.replace(/'/g, `'\\''`) + "'";

const remoteScript = [
  'set -e',
  // 刻意**不**在最外層 cd 進實例目錄：coma 上那個目錄是 0750／scc-tutor，外層身分進不去。
  // 每一步各自帶絕對路徑或自己切身分。
  asOwner + q('cd ' + instDir + ' && git pull --ff-only'),
  asOwner + q('cd ' + instDir + ' && node server/scripts/build-public.js'),
  'sudo systemctl restart ' + inst,
  'sleep 2',
  // healthz 打該實例 .env 實際設定的 BIND 位址，不再寫死 127.0.0.1：實機的 BIND 已改為區網
  // 位址（資安：服務不得出現在主機的對外介面上），寫死 loopback 會健檢不到而誤判部署失敗；
  // 反過來若哪天 BIND 被改錯，這裡也會直接健檢失敗而中止，不會帶著錯誤設定回報成功。
  // .env 是 0600 且屬於服務使用者（裡面有 SMTP 密碼），所以連讀它都要切身分。
  'BIND_ADDR="$(' + asOwner + q('grep -E "^BIND=" ' + instDir + '/server/.env') + ' | cut -d= -f2- | tr -d "[:space:]")"',
  'BIND_ADDR="${BIND_ADDR:-127.0.0.1}"',
  'curl -sf "http://$BIND_ADDR:' + port + '/healthz" > /dev/null && echo HEALTHZ_OK',
  'echo REMOTE_HEAD=$(' + asOwner + q('git -C ' + instDir + ' rev-parse HEAD') + ')',
].join('\n');

const runner = host === 'coma'
  ? ['bash', ['-c', remoteScript]]         // 就在 coma 上，不必 ssh 回自己
  : ['ssh', [host, remoteScript]];

let out;
try {
  out = execFileSync(runner[0], runner[1], { encoding: 'utf8' });
} catch (e) {
  console.error('[deploy] 部署失敗（' + host + '）：');
  if (e.stdout) console.error(String(e.stdout));
  console.error(String(e.stderr || e.message));
  process.exit(1);
}
process.stdout.write(out);

if (out.indexOf('HEALTHZ_OK') === -1) {
  console.error('[deploy] healthz 未通過——服務可能沒起來，上 scc-server 看 journalctl -u ' + inst);
  process.exit(1);
}
const m = /REMOTE_HEAD=([0-9a-f]{40})/.exec(out);
if (!m || m[1] !== localHead) {
  console.error('[deploy] 遠端 HEAD（' + (m ? m[1].slice(0, 7) : '?') + '）≠ 本機 HEAD（' + localHead.slice(0, 7) + '）——遠端可能有本地變更擋住 ff-only，上去查。');
  process.exit(1);
}
// 驗證網址依主機而異：coma 只聽 loopback（對外走 Cloudflare Tunnel），
// scc-server 聽的是區網位址。寫死一個會在另一台上誤導。
const verifyUrl = host === 'coma'
  ? 'http://127.0.0.1:' + port + '/（只聽 loopback；對外網址見 tunnel 設定）'
  : 'http://192.168.100.123:' + port + '/';
console.log('[deploy] OK：' + host + ' 的 ' + inst + ' 已更新到 ' + localHead.slice(0, 7) + '，驗證網址 ' + verifyUrl);
