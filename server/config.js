// server/config.js — 極小 .env 解析（零依賴）。
// 讀 server/.env（或呼叫端指定的 envPath），KEY=VALUE 每行一組，'#' 開頭整行視為註解，
// 不做任何變數展開（不支援 shell 的 export / ${VAR} 語法，保持極簡）。
// 缺少必填鍵一律 fail-fast——避免以不完整設定悄悄啟動、跑到一半才炸。

const fs = require('node:fs');
const path = require('node:path');

function parseEnvFile_(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error('config: 找不到 .env 檔（' + filePath + '）。請複製 server/.env.example 為 server/.env 並填值。');
  }
  const out = {};
  raw.split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 允許用一層引號包住值（去頭尾一層，不展開跳脫字元）。
    if (value.length >= 2) {
      const first = value.charAt(0), last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (key) out[key] = value;
  });
  return out;
}

function resolveMaybeRelative_(repoRoot, v) {
  if (!v) return v;
  return path.isAbsolute(v) ? v : path.join(repoRoot, v);
}

// opts.envPath：覆寫要讀的 .env 路徑（預設 server/.env，供 smoke.mjs 等測試指向暫存檔）。
// opts.repoRoot：覆寫「相對路徑鍵」的解析基準（預設本檔所在目錄的上一層，即 repo 根）。
function loadConfig(opts) {
  opts = opts || {};
  const repoRoot = opts.repoRoot || path.join(__dirname, '..');
  const envPath = opts.envPath || path.join(__dirname, '.env');
  const env = parseEnvFile_(envPath);

  if (env.PORT === undefined || env.PORT === '') throw new Error('config: 缺少必填鍵 PORT（' + envPath + '）');
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 0) throw new Error('config: PORT 必須是 0 或正整數（0 = 由作業系統挑一個空閒埠），收到：' + env.PORT);

  if (!env.GS_FILE) throw new Error('config: 缺少必填鍵 GS_FILE（' + envPath + '）');
  if (!env.FRONTEND_FILE) throw new Error('config: 缺少必填鍵 FRONTEND_FILE（' + envPath + '）');
  if (!env.SERVER_ORIGIN) throw new Error('config: 缺少必填鍵 SERVER_ORIGIN（' + envPath + '）');

  return {
    port: port,
    bind: env.BIND || '127.0.0.1',
    gsFile: resolveMaybeRelative_(repoRoot, env.GS_FILE),
    gsFileRel: env.GS_FILE,
    frontendFile: resolveMaybeRelative_(repoRoot, env.FRONTEND_FILE),
    frontendFileRel: env.FRONTEND_FILE,
    serverOrigin: env.SERVER_ORIGIN,
    dataDir: resolveMaybeRelative_(repoRoot, env.DATA_DIR || 'server/data'),
    publicDir: resolveMaybeRelative_(repoRoot, env.PUBLIC_DIR || 'server/public'),
    loginThrottleMs: env.LOGIN_THROTTLE_MS ? Number(env.LOGIN_THROTTLE_MS) : 60000,
    repoRoot: repoRoot,
  };
}

module.exports = { loadConfig, parseEnvFile_ };
