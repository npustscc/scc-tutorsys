// server/gas-host.js — 自架伺服器的 GAS 執行期主機（持久化版）
//
// 手法與 verify/gas-emulator.js 完全同源：以 node:vm 載入 Code.gs **本體**（fs 讀入，
// 不複製任何程式碼），sandbox 提供 GAS 服務 stub；載入後以「儲存 seam」直接覆寫
// readJsonSafe_/writeJsonPath_ 等 Drive I/O 函式（classic script 的頂層 function 宣告
// 掛在 sandbox 這個 global 物件上，內部呼叫走 global 綁定 → 重指派即生效）。Code.gs
// 一個字都不改。
//
// 與 verify/gas-emulator.js 的差異：那邊是 in-memory 測試 harness（每次啟動歸零、
// 服務 CI 冒煙與 e2e）；這裡是**持久化到本機檔案系統**的版本，供正式上線使用，
// 兩者互相獨立維護，不共用程式碼（各自的 sandbox stub 有各自的取捨，例如這裡
// PropertiesService/MailApp 要落地檔案，emulator 版不需要）。
//
// Utilities HMAC 型別對齊（抄自 verify/gas-emulator.js，勿改動這幾個函式的行為——
// 任何偏差都會讓 issueSessionToken_/verifySessionToken_ 簽發/驗證不一致）：
//   - base64EncodeWebSafe：GAS 的 web-safe 是 +/ → -_ 且**保留 '=' padding**
//     （node 的 'base64url' 編碼會去掉 padding，不可用於這裡）。
//   - computeHmacSha256Signature：GAS 回傳 signed byte array（-128..127），
//     這裡以 Buffer → array of signed ints 模擬，讓簽發/驗證往返一致。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function toSignedBytes(buf) {
  return Array.from(buf, function (b) { return b > 127 ? b - 256 : b; });
}
function toBuffer(v) {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (Buffer.isBuffer(v)) return v;
  // signed byte array（GAS 慣例）→ unsigned
  return Buffer.from(v.map(function (b) { return (b + 256) % 256; }));
}

// 原子寫：同目錄 tmp 檔 + renameSync（同一個檔案系統內 rename 是原子操作，避免
// 進程中途被殺掉時讀到寫一半的半成品 JSON）。
function atomicWriteFileSync(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmp, content, mode ? { mode: mode } : undefined); // rename 保留 tmp 的權限位
  fs.renameSync(tmp, filePath);
}

// ── 儲存路徑淨化（每次讀寫都過；fail-closed）──────────────────────────────────
// 拆 '/' 段，任一段為 ''、'.'、'..' 或含反斜線 → 拒絕；整體只允許英數、常見標點
// （'.'、'_'、'-'）、'/'，以及中日韓統一表意文字（CJK Unified Ideographs U+4E00–U+9FFF，
// 本系統的系所/班級 ID 常以中文命名，例如「農園系_四技一A」）。
const STORE_PATH_RE = /^[A-Za-z0-9一-鿿._\-\/]+$/;
function sanitizeStorePath_(p) {
  if (typeof p !== 'string' || !p || !STORE_PATH_RE.test(p)) {
    throw new Error('invalid store path: ' + p);
  }
  const parts = p.split('/');
  parts.forEach(function (seg) {
    if (seg === '' || seg === '.' || seg === '..' || seg.indexOf('\\') !== -1) {
      throw new Error('invalid store path: ' + p);
    }
  });
  return parts;
}

function createHost(opts) {
  opts = opts || {};
  const gsFile = opts.gsFile;
  const dataDir = opts.dataDir;
  if (!gsFile) throw new Error('createHost: gsFile required');
  if (!dataDir) throw new Error('createHost: dataDir required');

  const storeDir = path.join(dataDir, 'store');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const attachmentsIndexPath = path.join(dataDir, 'attachments-index.json');
  const propsPath = path.join(dataDir, 'props.json');
  const mailsPath = path.join(dataDir, 'mails.jsonl');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  // ── PropertiesService：持久化到 props.json（SESSION_SECRET 等機密只活在這裡）──
  let props = {};
  try { props = JSON.parse(fs.readFileSync(propsPath, 'utf8')) || {}; } catch (e) { props = {}; }
  // props.json 含 SESSION_SECRET，一律 0600（僅擁有者可讀寫；Windows 上無作用、Linux 生效）。
  function savePropsSync() { atomicWriteFileSync(propsPath, JSON.stringify(props, null, 2), 0o600); }
  if (!props.SESSION_SECRET) {
    props.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    savePropsSync();
    console.log('[gas-host] 首次啟動：已產生新的 SESSION_SECRET 並持久化到 ' + propsPath + '（值不印出）。');
  }

  // ── CacheService：in-memory Map，支援 put(k,v,ttlSec) 的過期 ─────────────────
  const cacheStore = new Map(); // key -> { value, expireAt(ms)|null }
  const CacheServiceImpl = {
    getScriptCache: function () {
      return {
        get: function (k) {
          const hit = cacheStore.get(k);
          if (!hit) return null;
          if (hit.expireAt !== null && hit.expireAt < Date.now()) { cacheStore.delete(k); return null; }
          return hit.value;
        },
        put: function (k, v, ttlSec) {
          cacheStore.set(k, { value: String(v), expireAt: ttlSec ? Date.now() + Number(ttlSec) * 1000 : null });
        },
        remove: function (k) { cacheStore.delete(k); },
      };
    },
  };

  const Utilities = {
    getUuid: function () { return crypto.randomUUID(); },
    computeHmacSha256Signature: function (value, key) {
      return toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest());
    },
    base64Encode: function (v) { return toBuffer(v).toString('base64'); },
    base64Decode: function (s) { return toSignedBytes(Buffer.from(String(s), 'base64')); },
    base64EncodeWebSafe: function (v) {
      return toBuffer(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'); // 保留 '=' padding
    },
    base64DecodeWebSafe: function (s) {
      return toSignedBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    },
    newBlob: function (bytes, mime, name) {
      return {
        getDataAsString: function () { return toBuffer(bytes).toString('utf8'); },
        getBytes: function () { return bytes; },
        getContentType: function () { return mime || 'application/octet-stream'; },
        getName: function () { return name || ''; },
      };
    },
    formatDate: function (date, tz, fmt) {
      // 最小可用：登入通知信內文用，格式不參與任何授權判斷。
      const d = new Date(date);
      const pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    },
  };

  const sandbox = {
    console: console, Date: Date, Math: Math, JSON: JSON, String: String, Number: Number,
    Boolean: Boolean, Array: Array, Object: Object, RegExp: RegExp, Error: Error,
    parseInt: parseInt, parseFloat: parseFloat, isNaN: isNaN, Set: Set, Map: Map,
    encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
    Utilities: Utilities,
    LockService: {
      // 單一 Node 程序、exec 全同步執行（doPost 執行期間事件迴圈不會插入另一個 doPost，
      // 因為中間沒有任何 await 讓出控制權）——鎖永遠是 no-op 也不會有競態。
      getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {}, tryLock: function () { return true; } }; },
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); savePropsSync(); },
        };
      },
    },
    CacheService: CacheServiceImpl,
    MailApp: {
      sendEmail: function (msg) {
        const entry = { at: new Date().toISOString(), to: (msg && msg.to) || '', subject: (msg && msg.subject) || '', body: (msg && msg.body) || '' };
        try { fs.appendFileSync(mailsPath, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (e) { console.error('[gas-host] mails.jsonl 寫入失敗：' + e.message); }
        console.log('[gas-host] MailApp.sendEmail to=' + entry.to + ' subject=' + entry.subject);
      },
    },
    ScriptApp: { getOAuthToken: function () { return 'server-side-stub-oauth-token'; } },
    Logger: { log: function () { console.log.apply(console, ['[GAS Logger]'].concat([].slice.call(arguments))); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return ''; } }; } },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (text) {
        const o = { _text: text, _mime: null };
        o.setMimeType = function (m) { o._mime = m; return o; };
        o.getContent = function () { return o._text; };
        return o;
      },
    },
    UrlFetchApp: {
      // 防漏檢查：自架環境不該有任何 Drive REST API / tokeninfo 外部 HTTP 呼叫
      // （所有 Drive I/O 都由下方的儲存 seam 接管）。verifyIdToken_ 內部有 try/catch，
      // 收到 throw 會回 null → doPost 回 Unauthorized，這是預期的 fail-closed 行為，
      // 不是 bug——本系統不支援自架環境下的 Google 登入，一律走 /login 本地帳密。
      fetch: function (url) {
        throw new Error('UrlFetchApp.fetch 不應被呼叫（自架伺服器防漏檢查）：' + String(url));
      },
    },
  };

  vm.createContext(sandbox);
  const gsPath = path.isAbsolute(gsFile) ? gsFile : path.join(process.cwd(), gsFile);
  const gsSource = fs.readFileSync(gsPath, 'utf8');
  vm.runInContext(gsSource, sandbox, { filename: gsFile });

  // rootFolderId：const 宣告不會掛在 sandbox 這個 global 物件上（const/let 進的是
  // 獨立的 lexical environment），拿不到，只能從原始碼 regex 抽。
  const rootMatch = /^const ROOT_FOLDER_ID\s*=\s*'([^']+)'/m.exec(gsSource);
  if (!rootMatch) throw new Error('createHost: 在 ' + gsFile + ' 找不到 ROOT_FOLDER_ID 常數');
  const rootFolderId = rootMatch[1];

  // ══════════════════════════════════════════════════════════════════════════
  // ── 儲存 seam：JSON 文件庫 → <dataDir>/store/<path> ─────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  function storeFilePath_(p) {
    const parts = sanitizeStorePath_(p);
    return path.join.apply(path, [storeDir].concat(parts));
  }

  sandbox.readJsonSafe_ = function (p, ctx, fallback) {
    try {
      const file = storeFilePath_(p);
      if (!fs.existsSync(file)) return fallback;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return fallback;
    }
  };
  sandbox.readJson_ = function (params, ctx) {
    let file;
    try {
      file = storeFilePath_(params.path);
    } catch (e) {
      throw new Error('readJson failed: ' + params.path);
    }
    if (!fs.existsSync(file)) throw new Error('readJson failed: ' + params.path);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error('readJson failed: ' + params.path);
    }
  };
  sandbox.writeJsonPath_ = function (p, content, ctx) {
    const file = storeFilePath_(p);
    atomicWriteFileSync(file, JSON.stringify(content));
    return { id: 'store:' + p };
  };
  sandbox.updateJson_ = function (params, ctx) {
    return sandbox.writeJsonPath_(params.path, params.content, ctx);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ── 儲存 seam：附件 → <dataDir>/attachments/…，索引 attachments-index.json ──
  // ══════════════════════════════════════════════════════════════════════════
  let attIndex = {};
  try { attIndex = JSON.parse(fs.readFileSync(attachmentsIndexPath, 'utf8')) || {}; } catch (e) { attIndex = {}; }
  function saveAttIndexSync() { atomicWriteFileSync(attachmentsIndexPath, JSON.stringify(attIndex)); }

  // ensureFolderPath_：淨化每段 → mkdir -p <dataDir>/<parts.join('/')> → 回傳相對路徑
  // 字串當 folderId（parts[0] 實際上必為 'attachments'，由呼叫端 uploadAttachmentAction_
  // 固定傳入 ['attachments', semester, classId]）。
  sandbox.ensureFolderPath_ = function (parts, ctx) {
    const clean = sanitizeStorePath_((parts || []).join('/'));
    const rel = clean.join('/');
    fs.mkdirSync(path.join(dataDir, rel), { recursive: true });
    return rel;
  };
  // findFolderPathId_：只查找、不建立——目錄不存在時代表「不可能有合法附件」，
  // 絕不能順手建立資料夾（那會把附件歸屬驗證變成永遠通過）。
  sandbox.findFolderPathId_ = function (parts, ctx) {
    let rel;
    try {
      rel = sanitizeStorePath_((parts || []).join('/')).join('/');
    } catch (e) {
      return null;
    }
    const dir = path.join(dataDir, rel);
    return (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) ? rel : null;
  };
  sandbox.uploadFile_ = function (params) {
    const parentFolderId = params && params.parentFolderId;
    sanitizeStorePath_(parentFolderId); // 不信任呼叫端傳入值，即使理論上只會是 ensureFolderPath_ 的回傳值
    const fileId = crypto.randomUUID();
    const dir = path.join(dataDir, parentFolderId);
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(String((params && params.base64Data) || ''), 'base64');
    fs.writeFileSync(path.join(dir, fileId + '.bin'), bytes);
    attIndex[fileId] = {
      dir: parentFolderId,
      fileName: (params && params.fileName) || fileId,
      mimeType: (params && params.mimeType) || 'application/octet-stream',
    };
    saveAttIndexSync();
    return { fileId: fileId, fileName: (params && params.fileName) || fileId };
  };
  sandbox.downloadFileBase64_ = function (params) {
    const fileId = params && params.fileId;
    const entry = attIndex[fileId];
    if (!entry) throw new Error('downloadFileBase64_: file not found: ' + fileId);
    const filePath = path.join(dataDir, entry.dir, fileId + '.bin');
    const bytes = fs.readFileSync(filePath); // 讀不到就讓例外自然拋出，交由 doPost 外層 catch 統一處理
    return { fileName: entry.fileName, mimeType: entry.mimeType, base64: bytes.toString('base64') };
  };
  // assertAttachmentsBelong_：完整重寫（語意同 dev/Code.gs 503-518 的 Drive 版本）。
  // 空清單直接過；否則 expectedDir = 'attachments/<semester>/<classId>'（semester、
  // classId 先過路徑淨化）；目錄不存在 → throw；逐筆核對索引（fileId 存在、dir 相符、
  // .bin 檔案存在）三者缺一即整筆拒絕——防禦縱深第二層，見 downloadAttachmentAction_
  // 呼叫處的原始註解（即使 record.attachments 混入未經第一層驗證的 fileId，下載前仍會
  // 再擋一次）。
  sandbox.assertAttachmentsBelong_ = function (attachments, semester, classId, ctx) {
    const list = attachments || [];
    if (!list.length) return;
    const semParts = sanitizeStorePath_(semester);
    const classParts = sanitizeStorePath_(classId);
    const expectedDir = ['attachments'].concat(semParts).concat(classParts).join('/');
    const folderDir = path.join(dataDir, expectedDir);
    if (!fs.existsSync(folderDir) || !fs.statSync(folderDir).isDirectory()) {
      throw new Error('attachments folder not found for this class/semester');
    }
    list.forEach(function (a) {
      if (!a || !a.fileId) throw new Error('attachment.fileId required');
      const entry = attIndex[a.fileId];
      const binPath = entry ? path.join(dataDir, entry.dir, a.fileId + '.bin') : null;
      if (!entry || entry.dir !== expectedDir || !binPath || !fs.existsSync(binPath)) {
        throw new Error('attachment does not belong to this class/semester: ' + a.fileId);
      }
    });
  };

  // ── 防漏保留：這些 Drive 底層函式在上面的 seam 覆寫後，理論上永遠不會被呼叫
  // （已逐一比對 dev/Code.gs 的呼叫點，見 server/README.md 的盤點結論）；保留成 throw
  // 是防止 Code.gs 未來新增呼叫點卻漏改本檔的安全網（fail-closed，寧可整支功能報錯，
  // 也不要悄悄退回真的去打 Google Drive API 或悄悄放行）。
  ['resolvePathToId_', 'resolvePathToParentAndName_', 'driveGet_', 'drivePatch_',
    'driveUpload_', 'driveUpdateContent_', 'createFolder_', 'ensureFolder_'].forEach(function (name) {
    sandbox[name] = function () {
      throw new Error(name + ' 不應被呼叫（自架伺服器防漏檢查：儲存 seam 應已完全接管 Drive I/O）');
    };
  });

  function exec(payloadString) {
    const out = sandbox.doPost({ parameter: { payload: payloadString } });
    return out.getContent();
  }
  function doGetCall(queryParams) {
    const out = sandbox.doGet({ parameter: queryParams || {} });
    return out.getContent();
  }
  // 不做 verify 版 emulator 的種子資料——正式資料由 import-drive.js 一次性匯入，
  // 空庫則由 Code.gs 本身的 BOOTSTRAP_ADMINS 機制自舉（第一位 bootstrap 的緊急管理員帳號）。
  function sessionStart(email, ua, ip) {
    return sandbox.sessionStartAction_({ ua: ua, ip: ip }, { root: rootFolderId }, email);
  }

  return {
    sandbox: sandbox,
    exec: exec,
    doGet: doGetCall,
    sessionStart: sessionStart,
    rootFolderId: rootFolderId,
  };
}

module.exports = { createHost, sanitizeStorePath_ };
