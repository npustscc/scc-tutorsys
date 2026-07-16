// server/scripts/backup.js — 資料目錄備份（tar.gz + 保留份數輪替），供 cron 每日執行。
//
//   node server/scripts/backup.js --out <備份目錄> [--env server/.env] [--name <前綴>] [--keep 30]
//
// - 讀 .env 取 DATA_DIR（整個系統的資料庫：store/、attachments/、props.json、
//   users.json、mails.jsonl 全在裡面），整目錄打包成 <out>/<name>-YYYYMMDD-HHMMSS.tar.gz。
// - 打包用系統 tar（Ubuntu 內建；Windows 10+ 有 bsdtar，本機測試也能跑），零 npm 依賴。
// - 備份檔含 SESSION_SECRET 與個資 → chmod 0600。
// - 打包後以 `tar -tzf` 驗證可讀且非空，才算成功（exit 0）；任何一步失敗 exit 1，
//   cron 搭配 MAILTO 或 log 檢查即可發現備份中斷。
// - 輪替：只刪除「同前綴且符合本腳本命名格式」的舊檔，保留最新 --keep 份（預設 30），
//   絕不碰備份目錄裡的其他檔案。
// - 一致性：gas-host 所有 JSON 寫入都是原子 rename，tar 當下每個檔案必為完整內容；
//   跨檔案的瞬間不一致（例如打包期間剛好有人送出紀錄）理論上存在，實務上排在深夜
//   離峰（見 README 的 crontab 範例）即可忽略。
//
// 注意：備份放同一顆碟只防誤刪不防碟損，備份目錄建議掛另一顆碟或定期 rsync 到另一台機器。

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../config');

function parseArgs_(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '--env' || a === '--name' || a === '--keep') {
      out[a.slice(2)] = argv[++i];
    } else {
      console.error('未知參數：' + a);
      process.exit(1);
    }
  }
  return out;
}

function stamp_() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function main() {
  const args = parseArgs_(process.argv.slice(2));
  if (!args.out) {
    console.error('用法：node server/scripts/backup.js --out <備份目錄> [--env server/.env] [--name <前綴>] [--keep 30]');
    process.exit(1);
  }
  const config = loadConfig(args.env ? { envPath: path.resolve(args.env) } : {});
  const name = args.name || path.basename(config.repoRoot); // 兩實例=兩份 checkout，目錄名（scc-tutor-prod/dev）天然可區分
  const keep = args.keep ? Number(args.keep) : 30;
  if (!Number.isInteger(keep) || keep < 1) {
    console.error('--keep 必須是正整數，收到：' + args.keep);
    process.exit(1);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error('--name 只允許英數與 . _ -，收到：' + name);
    process.exit(1);
  }
  const dataDir = path.resolve(config.dataDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    console.error('DATA_DIR 不存在或不是目錄：' + dataDir);
    process.exit(1);
  }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const file = path.join(outDir, name + '-' + stamp_() + '.tar.gz');
  // -C 到 DATA_DIR 的上一層、只打包目錄名，解包時得到單一頂層目錄，不會炸滿還原點。
  execFileSync('tar', ['-czf', file, '-C', path.dirname(dataDir), path.basename(dataDir)], { stdio: 'inherit' });
  fs.chmodSync(file, 0o600);

  // 驗證：列得出內容且至少一個條目才算數（截斷/損毀的 gzip 在這步會炸）。
  const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' });
  const entryCount = listing.split(/\r?\n/).filter(Boolean).length;
  if (entryCount < 1) {
    console.error('備份驗證失敗：tar 內容為空（' + file + '）');
    process.exit(1);
  }
  const sizeMB = (fs.statSync(file).size / (1024 * 1024)).toFixed(1);

  // 輪替：嚴格比對「本腳本產出的命名格式」，新到舊排序後刪超出 keep 的部分。
  const pattern = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d{8}-\\d{6}\\.tar\\.gz$');
  const siblings = fs.readdirSync(outDir).filter(function (f) { return pattern.test(f); }).sort().reverse();
  const removed = siblings.slice(keep);
  removed.forEach(function (f) { fs.unlinkSync(path.join(outDir, f)); });

  console.log('[backup] OK ' + file + '（' + sizeMB + ' MB、' + entryCount + ' 個條目；保留 ' +
    Math.min(siblings.length, keep) + ' 份' + (removed.length ? '、輪替刪除 ' + removed.length + ' 份舊檔' : '') + '）');
}

main();
