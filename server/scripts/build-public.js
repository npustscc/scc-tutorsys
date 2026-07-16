// server/scripts/build-public.js — 從 FRONTEND_FILE 產出可自架部署的靜態檔到 PUBLIC_DIR。
// 用法：node server/scripts/build-public.js
//
// 動作：
//   1. 讀 FRONTEND_FILE（如 dev/index.html），把唯一一行 APPS_SCRIPT_URL 常數宣告
//      換成 SERVER_ORIGIN + '/exec'（同源部署，前端直接打自己這台伺服器）。
//   2. 從 FRONTEND_FILE 抽 ROOT_FOLDER_ID，連同 GS_FILE 是否含 'dev/' 判斷的環境標籤，
//      注入 login-template.html 產出 PUBLIC_DIR/login.html。
// 任何一步的前提不成立（regex 沒有恰好命中 1 次、抽不到常數）一律 fail-fast，
// 不要輸出一份「看起來正常但其實打錯後端」的靜態檔。

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../config');

const APPS_SCRIPT_URL_RE = /^const APPS_SCRIPT_URL = '[^']*';$/m;
const ROOT_FOLDER_ID_RE = /^const ROOT_FOLDER_ID\s*=\s*'([^']+)'/m;

function run(opts) {
  opts = opts || {};
  const config = opts.config || loadConfig({ envPath: opts.envPath, repoRoot: opts.repoRoot });

  const src = fs.readFileSync(config.frontendFile, 'utf8');

  const hitCount = (src.match(new RegExp(APPS_SCRIPT_URL_RE.source, 'gm')) || []).length;
  if (hitCount !== 1) {
    throw new Error(
      'build-public: APPS_SCRIPT_URL 這行必須在 ' + config.frontendFileRel + ' 內恰好出現 1 次，實際偵測到 ' + hitCount + ' 次。'
    );
  }
  const newLine = "const APPS_SCRIPT_URL = '" + config.serverOrigin + "/exec';";
  const patched = src.replace(APPS_SCRIPT_URL_RE, newLine);

  const rootMatch = ROOT_FOLDER_ID_RE.exec(src);
  if (!rootMatch) throw new Error('build-public: 在 ' + config.frontendFileRel + ' 找不到 ROOT_FOLDER_ID 常數。');
  const rootFolderId = rootMatch[1];

  // 用 '/' 正規化再判斷：GS_FILE 在 .env 裡可能寫成絕對路徑（Windows 下含 '\'），
  // 不能只認字面的 'dev/'。
  const gsFileNormalized = config.gsFileRel.replace(/\\/g, '/');
  const envLabel = gsFileNormalized.indexOf('dev/') !== -1 ? '測試版' : '正式版';

  fs.mkdirSync(config.publicDir, { recursive: true });
  fs.writeFileSync(path.join(config.publicDir, 'index.html'), patched);

  const templatePath = path.join(__dirname, '..', 'login-template.html');
  const template = fs.readFileSync(templatePath, 'utf8');
  const loginHtml = template.split('__ROOT_FOLDER_ID__').join(rootFolderId).split('__ENV_LABEL__').join(envLabel);
  if (loginHtml.indexOf('__ROOT_FOLDER_ID__') !== -1 || loginHtml.indexOf('__ENV_LABEL__') !== -1) {
    throw new Error('build-public: login.html 注入後仍有殘留佔位，中止輸出。');
  }
  fs.writeFileSync(path.join(config.publicDir, 'login.html'), loginHtml);

  console.log('[build-public] APPS_SCRIPT_URL → ' + config.serverOrigin + '/exec');
  console.log('[build-public] ROOT_FOLDER_ID  = ' + rootFolderId + '（' + envLabel + '）');
  console.log('[build-public] 輸出：' + path.join(config.publicDir, 'index.html'));
  console.log('[build-public] 輸出：' + path.join(config.publicDir, 'login.html'));

  return { rootFolderId: rootFolderId, envLabel: envLabel, publicDir: config.publicDir };
}

module.exports = { run };

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('[build-public] 失敗：' + e.message);
    process.exit(1);
  }
}
