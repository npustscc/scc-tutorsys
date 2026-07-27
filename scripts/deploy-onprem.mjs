#!/usr/bin/env node
// scripts/deploy-onprem.mjs — 一鍵部署到 scc-server 自架實例。
//
//   node scripts/deploy-onprem.mjs [dev|prod]     （預設 dev）
//
// 部署的是 **GitHub 上的 master**，不是本機工作樹：腳本先確認本機沒有漏 push 的
// commit，再 ssh 到 scc-server 對該實例做 git pull → build-public → systemctl
// restart → healthz 驗證，最後比對遠端 HEAD 與本機 HEAD 一致才算成功（exit 0）。
// 前置需求：本機 ~/.ssh/config 有 Host scc-server（金鑰登入）、該機 sudo 免密碼。

import { execFileSync } from 'node:child_process';

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
}

const target = process.argv[2] || 'dev';
if (target !== 'dev' && target !== 'prod') {
  console.error('用法：node scripts/deploy-onprem.mjs [dev|prod]');
  process.exit(1);
}
const inst = 'scc-tutor-' + target;
const port = target === 'prod' ? 8789 : 8790;

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

const remoteScript = [
  'set -e',
  'cd ~/' + inst,
  'git pull --ff-only',
  'node server/scripts/build-public.js',
  'sudo systemctl restart ' + inst,
  'sleep 2',
  // healthz 打該實例 .env 實際設定的 BIND 位址，不再寫死 127.0.0.1：實機的 BIND 已改為區網
  // 位址（資安：服務不得出現在主機的對外介面上），寫死 loopback 會健檢不到而誤判部署失敗；
  // 反過來若哪天 BIND 被改錯，這裡也會直接健檢失敗而中止，不會帶著錯誤設定回報成功。
  'BIND_ADDR="$(grep -E "^BIND=" server/.env | cut -d= -f2- | tr -d "[:space:]")"',
  'BIND_ADDR="${BIND_ADDR:-127.0.0.1}"',
  'curl -sf "http://$BIND_ADDR:' + port + '/healthz" > /dev/null && echo HEALTHZ_OK',
  'echo REMOTE_HEAD=$(git rev-parse HEAD)',
].join('\n');

let out;
try {
  out = execFileSync('ssh', ['scc-server', remoteScript], { encoding: 'utf8' });
} catch (e) {
  console.error('[deploy] 遠端部署失敗：');
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
console.log('[deploy] OK：' + inst + ' 已更新到 ' + localHead.slice(0, 7) + '，驗證網址 http://192.168.100.123:' + port + '/');
