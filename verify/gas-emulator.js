// verify/gas-emulator.js — 本機 GAS 模擬器
// 以 node:vm 載入 dev/Code.gs **本體**（fs 讀入，不複製任何程式碼），sandbox 提供
// GAS 服務 stub；載入後以「儲存 seam」直接覆寫 readJsonSafe_/writeJsonPath_ 等
// Drive I/O 函式為 in-memory Map（classic script 的頂層 function 宣告掛在 global 物件上，
// 內部呼叫走 global 綁定 → 重指派即生效）。dev/Code.gs 一個字都不改。
//
// Utilities HMAC 型別對齊（讀自 issueSessionToken_/verifySessionToken_ 的實際用法）：
//   - base64EncodeWebSafe(輸入)：字串（payload JSON）或 byte array（HMAC 簽章）都要吃；
//     GAS 的 web-safe 是 +/ → -_ 且**保留 '=' padding**（node 的 'base64url' 會去掉，不可用）。
//   - computeHmacSha256Signature(value, key)：GAS 回傳 signed byte array（-128..127），
//     這裡以 Buffer → array of signed ints 模擬，讓簽發/驗證往返一致。
//   - verifySessionToken_ 走 newBlob(base64DecodeWebSafe(b64)).getDataAsString()。

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

function createEmulator(opts) {
  opts = opts || {};
  const store = new Map();   // Drive path → JSON（存深拷貝，杜絕跨請求共享參照）
  const props = new Map([['SESSION_SECRET', 'verify-harness-secret']]);
  const cache = new Map();
  const sentMails = [];      // MailApp 證據
  const urlFetchCalls = [];  // 防漏檢查：不應有任何呼叫

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
      // 最小可用：登入通知信內文用，格式不參與任何斷言
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
      getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {}, tryLock: function () { return true; } }; },
    },
    PropertiesService: {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return props.has(k) ? props.get(k) : null; },
          setProperty: function (k, v) { props.set(k, String(v)); },
        };
      },
    },
    CacheService: {
      getScriptCache: function () {
        return {
          get: function (k) { return cache.has(k) ? cache.get(k) : null; },
          put: function (k, v) { cache.set(k, String(v)); },
          remove: function (k) { cache.delete(k); },
        };
      },
    },
    MailApp: { sendEmail: function (msg) { sentMails.push(msg); } },
    ScriptApp: { getOAuthToken: function () { return 'stub-oauth-token'; } },
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
      fetch: function (url) {
        urlFetchCalls.push(String(url));
        throw new Error('UrlFetchApp.fetch 不應被呼叫（防漏檢查）：' + url);
      },
    },
  };
  vm.createContext(sandbox);
  const gsPath = path.join(__dirname, '..', 'dev', 'Code.gs');
  vm.runInContext(fs.readFileSync(gsPath, 'utf8'), sandbox, { filename: 'dev/Code.gs' });

  // ── 儲存 seam：所有 Drive JSON 讀寫 → in-memory Map ──────────────────────────
  sandbox.readJsonSafe_ = function (p, ctx, fallback) {
    return store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : fallback;
  };
  sandbox.writeJsonPath_ = function (p, content, ctx) {
    store.set(p, JSON.parse(JSON.stringify(content)));
    return { id: 'mem:' + p };
  };
  sandbox.readJson_ = function (params, ctx) {
    if (store.has(params.path)) return JSON.parse(JSON.stringify(store.get(params.path)));
    throw new Error('readJson failed: ' + params.path);
  };
  sandbox.updateJson_ = function (params, ctx) { return sandbox.writeJsonPath_(params.path, params.content, ctx); };
  // 其餘 Drive I/O（附件/資料夾）：無害化——附件流程不在本次驗證範圍（紀錄送出不帶附件）
  sandbox.resolvePathToId_ = function () { return 'mem-id'; };
  sandbox.resolvePathToParentAndName_ = function () { return { parentId: 'mem', fileName: 'mem' }; };
  sandbox.findFolderPathId_ = function () { return 'mem-folder'; };
  sandbox.ensureFolder_ = function () { return 'mem-folder'; };
  sandbox.ensureFolderPath_ = function () { return 'mem-folder'; };
  sandbox.assertAttachmentsBelong_ = function () {};
  sandbox.uploadFile_ = function (p) { return { fileId: 'mem-file', fileName: (p && p.fileName) || 'mem' }; };
  sandbox.downloadFileBase64_ = function () { return { fileName: 'mem', mimeType: 'application/octet-stream', base64: '' }; };
  sandbox.createFolder_ = function () { return { id: 'mem-folder' }; };
  sandbox.driveGet_ = function (p) { throw new Error('driveGet_ 不應被呼叫（防漏檢查）：' + p); };
  sandbox.drivePatch_ = function () { throw new Error('drivePatch_ 不應被呼叫（防漏檢查）'); };
  sandbox.driveUpload_ = function () { throw new Error('driveUpload_ 不應被呼叫（防漏檢查）'); };
  sandbox.driveUpdateContent_ = function () { throw new Error('driveUpdateContent_ 不應被呼叫（防漏檢查）'); };

  // ── 種子資料 ────────────────────────────────────────────────────────────────
  if (opts.seed !== false) seed(sandbox);

  function seed(sb) {
    sb.writeJsonPath_('semesters.json', [
      { id: '114-1', label: '114 學年度第 1 學期', quotaMeeting: 5, quotaActivity: 1, isCurrent: false },
      { id: '114-2', label: '114 學年度第 2 學期', quotaMeeting: 5, quotaActivity: 1, isCurrent: true },
      { id: '115-1', label: '115 學年度第 1 學期', quotaMeeting: 5, quotaActivity: 1, isCurrent: false },
    ], {});
    sb.writeJsonPath_('config.json', {
      users: { 'admin@test.local': { name: '測試管理員', role: 'admin' } },
      staffLeads: [{ email: 'lead@test.local', name: '測試主責', disabled: false }],
      staffAssistants: [{ email: 'assistant@test.local', name: '測試助理', leadEmail: 'lead@test.local', disabled: false }],
      settings: {},
    }, {});
    sb.writeJsonPath_('colleges.json', [
      { id: '農學院', name: '農學院', order: 0, disabled: false },
      { id: '獸醫學院', name: '獸醫學院', order: 1, disabled: false },
    ], {});
    sb.writeJsonPath_('departments.json', [
      { id: '農園系', name: '農園系', headEmail: 'head@test.local', headName: '測試系主任', collegeId: '農學院', active: true },
      { id: '獸醫系', name: '獸醫系', headEmail: '', headName: '', collegeId: '獸醫學院', active: true },
      { id: '森林系', name: '森林系', headEmail: '', headName: '', collegeId: '農學院', active: true },
    ], {});
    // tutorSystems.json 不種——留給 ensureTutorSystemsSeeded_ 以 DEFAULT_TUTOR_SYSTEMS_ 播種
    sb.writeJsonPath_('classes.json', [
      { id: '農園系_四技一A', name: '四技一A', deptId: '農園系', systemId: 'day_college', displayName: '四農園一A',
        requiredMeetingOverride: null, graduationGrade: null, tutors: [{ name: '王小明', email: 'wang@test.local' }],
        suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true },
      { id: '農園系_四技四A', name: '四技四A', deptId: '農園系', systemId: 'day_college', displayName: '四農園四A',
        requiredMeetingOverride: null, graduationGrade: null,
        tutors: [{ name: '李雙一', email: 'dual1@test.local' }, { name: '李雙二', email: 'dual2@test.local' }],
        suggestedTutors: [], dualApprovalMode: 'all', uploadWhitelist: [], active: true },
      { id: '獸醫系_四技四A', name: '四技四A', deptId: '獸醫系', systemId: 'day_college', displayName: '四獸醫四A',
        requiredMeetingOverride: null, graduationGrade: 5, tutors: [{ name: '林獸醫', email: 'vet@test.local' }],
        suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true },
      { id: '森林系_家族陳美惠', name: '家族陳美惠', deptId: '森林系', systemId: 'family', displayName: '森林家族(陳美惠)',
        requiredMeetingOverride: 2, graduationGrade: null, tutors: [{ name: '陳美惠', email: 'chen@test.local' }],
        suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true },
      { id: '農園系_碩二', name: '碩二', deptId: '農園系', systemId: 'master', displayName: '碩農園二',
        requiredMeetingOverride: null, graduationGrade: null, tutors: [{ name: '翁珮怡', email: 'weng@test.local' }],
        suggestedTutors: [], dualApprovalMode: 'any', uploadWhitelist: [], active: true },
    ], {});
    sb.writeJsonPath_('records_114-2.json', { records: [] }, {});
  }

  return {
    sandbox: sandbox,
    store: store,
    sentMails: sentMails,
    urlFetchCalls: urlFetchCalls,
    // token 鑄造：自家 HMAC 簽的必然過自家驗證
    mint: function (email) { return sandbox.issueSessionToken_(email); },
    // 直接呼叫 doPost（server.js 用）
    exec: function (payloadString) {
      const out = sandbox.doPost({ parameter: { payload: payloadString } });
      return out.getContent();
    },
  };
}

module.exports = { createEmulator };
