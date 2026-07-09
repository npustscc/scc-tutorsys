// Code.gs — 導師資訊系統 SCC Drive Proxy（測試版）
// 執行身份：Me（USER_DEPLOYING）；存取：任何擁有 Google 帳戶（ANYONE_ANONYMOUS）
// ⚠️ 此為測試版專用 GAS，只能存取 dev 資料夾，不可存取正式版資料。
//
// 架構比照 scc-infosys 的 Code.gs：doPost dispatcher + verifyIdToken_ + Drive REST API
// 讀寫 JSON + LockService read-modify-write。與 infosys 的關鍵差異：
//   - infosys 是「通用 Drive JSON 讀寫代理」（readJson/updateJson/query 等泛用 action，
//     授權靠單一 isAuthorizedUser_ 允許清單閘）。
//   - 本系統的「學生」角色 = 任何登入的 Google 帳號（免預建名單），沒有全域允許清單可比對，
//     因此改成「具名業務 action」（recordSubmit / recordApprove / ...），每個 action 內部
//     依動態角色解析（resolveRoles_）與紀錄狀態做 default-deny 授權判斷。
//   - 所有寫入 action 一律包在 withLock_（LockService.getScriptLock）內做 read-modify-write，
//     並在同一個臨界區內 append audit_log.json（比照 infosys casesUpsert_ 的 RMW 模式，
//     但這裡通用化成每個寫入 action 都套用，而不是只有單一函式）。

const CLIENT_ID      = '68582831293-fecbka17adht886tm6oh18vrdsdg1hbj.apps.googleusercontent.com';
const ROOT_FOLDER_ID = '1y4vyMvVoVp-b4-ORLEJEOERDtmNasQVT';  // dev 資料夾

// 白名單：只允許 dev 資料夾（前端可傳 rootFolderId 指定要打哪個環境的資料夾，
// 但後端只承認自己環境的白名單，其餘一律 Unauthorized rootFolderId）。
const ALLOWED_ROOTS = {};
ALLOWED_ROOTS[ROOT_FOLDER_ID] = { label: 'dev' };

// 緊急備援名單：即使 config.json 讀不到或帳號不在名單，這些帳號仍可視為 admin 登入以修復系統。
// 註：列出 email 不構成後門——仍須持有該帳號的 Google 憑證（有效 ID token）才通過，
// 攻擊者知道 email 也無法冒充。
const BOOTSTRAP_ADMINS = ['npust.scc@heartnpust.tw'];

// 導師制度預設種子（bootstrap 時若 tutorSystems.json 不存在則以此建立；admin 可事後修改/停用）。
const DEFAULT_TUTOR_SYSTEMS_ = [
  { id: 'day_college',      name: '大學日間部', requiredMeetingCount: 4, disabled: false },
  { id: 'evening_college',  name: '大學進修部', requiredMeetingCount: 4, disabled: false },
  { id: 'master',           name: '碩士',       requiredMeetingCount: 4, disabled: false },
  { id: 'master_inservice', name: '碩專',       requiredMeetingCount: 4, disabled: false },
  { id: 'doctor',           name: '博士',       requiredMeetingCount: 4, disabled: false },
  { id: 'family',           name: '家族',       requiredMeetingCount: 2, disabled: false },
];

// 四類宣導關鍵字預設種子（bootstrap 時若 config.keywordRules 不存在則以此建立；admin/staffLead 可調整）。
const DEFAULT_KEYWORD_RULES_ = {
  traffic: { label: '交通安全宣導', keywords: ['交通安全', '交通宣導', '酒駕', '車禍', '騎車', '安全帽'] },
  gender:  { label: '性平宣導',     keywords: ['性平', '性別平等', '性騷擾', '性侵'] },
  smoking: { label: '菸害防制宣導', keywords: ['菸害', '菸品', '戒菸', '電子煙'] },
  fraud:   { label: '防詐騙宣導',   keywords: ['詐騙', '防詐', '反詐', '詐欺'] },
};

// 未指定 requiredMeetingOverride、且班級的 systemId 對不到任何 tutorSystem 時的保底預設。
const DEFAULT_REQUIRED_MEETING_COUNT_ = 4;

// ── 進入點 ────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const payload = JSON.parse(e.parameter.payload);
    const idToken = payload.idToken;
    const sessionToken = payload.sessionToken;
    const action = payload.action;
    const rootFolderId = payload.rootFolderId;
    const params = {};
    Object.keys(payload).forEach(function (k) {
      if (k !== 'idToken' && k !== 'sessionToken' && k !== 'action' && k !== 'rootFolderId') params[k] = payload[k];
    });

    // 認證（所有 action 都要過，含 ping）——這一層只確認「這是誰」，不代表這個人
    // 有權限做這件事；授權判斷在每個 action 內部依角色/紀錄狀態進行（見檔頭註解）。
    // 兩種憑證：
    //   - sessionToken：自建 HMAC session（sessionStart 簽發，效期至當日台北 24:00），
    //     純本地驗證、零外部 HTTP。失效回 'Session expired'（前端據此靜默重登＋重試）。
    //   - idToken：Google ID token。sessionStart 只收 idToken——帶 sessionToken 打
    //     sessionStart 一律拒絕，不允許「以舊 session 換新 session」無限續命。
    let userEmail;
    if (sessionToken) {
      if (action === 'sessionStart') return jsonResp_({ error: 'sessionStart requires idToken' });
      userEmail = verifySessionToken_(sessionToken);
      if (!userEmail) return jsonResp_({ error: 'Session expired' });
    } else {
      userEmail = idToken ? verifyIdToken_(idToken) : null;
      if (!userEmail) return jsonResp_({ error: 'Unauthorized' });
    }

    let ctx = { root: ROOT_FOLDER_ID };
    if (rootFolderId) {
      if (!ALLOWED_ROOTS[rootFolderId]) return jsonResp_({ error: 'Unauthorized rootFolderId' });
      ctx = { root: rootFolderId };
    }

    let result;
    switch (action) {
      case 'ping':                  result = { ok: true, email: userEmail }; break;
      case 'sessionStart':           result = sessionStartAction_(params, ctx, userEmail); break;
      case 'sessionLogout':          result = sessionLogoutAction_(params, ctx, userEmail); break;
      case 'listMySessions':         result = listMySessionsAction_(params, ctx, userEmail); break;
      case 'bootstrap':              result = bootstrapAction_(params, ctx, userEmail); break;
      case 'recordSubmit':           result = recordSubmitAction_(params, ctx, userEmail); break;
      case 'recordResubmit':         result = recordResubmitAction_(params, ctx, userEmail); break;
      case 'recordGetMine':          result = recordGetMineAction_(params, ctx, userEmail); break;
      case 'uploadAttachment':       result = uploadAttachmentAction_(params, ctx, userEmail); break;
      case 'downloadAttachment':     result = downloadAttachmentAction_(params, ctx, userEmail); break;
      case 'recordApprove':          result = recordApproveAction_(params, ctx, userEmail); break;
      case 'recordReject':           result = recordRejectAction_(params, ctx, userEmail); break;
      case 'adminUpsertDepartment':  result = adminUpsertDepartmentAction_(params, ctx, userEmail); break;
      case 'adminUpsertClass':       result = adminUpsertClassAction_(params, ctx, userEmail); break;
      case 'adminUpsertUser':        result = adminUpsertUserAction_(params, ctx, userEmail); break;
      case 'adminUpsertSemester':    result = adminUpsertSemesterAction_(params, ctx, userEmail); break;
      case 'adminImportRoster':      result = adminImportRosterAction_(params, ctx, userEmail); break;
      case 'classSetWhitelist':      result = classSetWhitelistAction_(params, ctx, userEmail); break;
      case 'classResolve':           result = classResolveAction_(params, ctx, userEmail); break;
      case 'classStats':             result = classStatsAction_(params, ctx, userEmail); break;
      case 'adminUpsertCollege':     result = adminUpsertCollegeAction_(params, ctx, userEmail); break;
      case 'adminUpsertTutorSystem': result = adminUpsertTutorSystemAction_(params, ctx, userEmail); break;
      case 'adminUpsertStaffLead':      result = adminUpsertStaffLeadAction_(params, ctx, userEmail); break;
      case 'adminUpsertStaffAssistant': result = adminUpsertStaffAssistantAction_(params, ctx, userEmail); break;
      case 'recordSetTopics':        result = recordSetTopicsAction_(params, ctx, userEmail); break;
      case 'overviewStats':          result = overviewStatsAction_(params, ctx, userEmail); break;
      case 'adminSetKeywordRules':   result = adminSetKeywordRulesAction_(params, ctx, userEmail); break;
      default: return jsonResp_({ error: 'Unknown action: ' + action });
    }
    return jsonResp_(result);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return jsonResp_({ ok: true, service: 'SCC Tutor System Drive Proxy (DEV)' });
}

// ── ID Token 驗證（與 infosys 相同模式）───────────────────────────────────────

function verifyIdToken_(idToken) {
  // CacheService 快取：同一 idToken 在 5 分鐘內跳過外部 tokeninfo HTTP 呼叫。
  // idToken 末尾為 JWT 簽章（每個 token 唯一），取末 199 字元作為 key（CacheService 限制 250 字元）。
  const cache = CacheService.getScriptCache();
  const cacheKey = 't' + idToken.slice(-199);
  try {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  } catch (_) {}
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + idToken,
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return null;
    const d = JSON.parse(res.getContentText());
    if (d.aud !== CLIENT_ID) return null;
    if (Number(d.exp) < Math.floor(Date.now() / 1000)) return null;
    // email_verified：tokeninfo 端點回傳的是字串 'true'（JWT 內為布林），兩種都接受；
    // 未驗證的 email 一律拒絕（角色解析、白名單、audit 都以 email 為主鍵，不能收未驗證值）。
    if (d.email_verified !== 'true' && d.email_verified !== true) return null;
    try { cache.put(cacheKey, d.email, 300); } catch (_) {}
    return d.email;
  } catch (e) { return null; }
}

// ── 自建 Session Token（每日登入一次）────────────────────────────────────────
// 動機：Google ID token 只有 1 小時效期，靠 One Tap 靜默續命常失敗跳 modal。
// 改為：每天首次以 Google idToken 打 sessionStart 換發自建 HMAC token，效期固定至
// 當日台北時間 24:00（不滑動延長），之後所有請求帶 sessionToken——後端純本地 HMAC
// 驗證、零外部 HTTP。密鑰只存 Script Properties（SESSION_SECRET），永不進 repo。
// token 格式：base64url(payloadJSON) + '.' + base64url(HMAC-SHA256(payloadB64, secret))
// payload = { e: email, iat: 簽發秒, exp: 當日台北 24:00 的 epoch 秒 }

function getSessionSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
}

// 一次性設置：部署者在 GAS 編輯器手動執行一次即可。已存在則不覆寫
// （誤跑第二次不會讓全站 session 立即失效）。密鑰值只活在 Script Properties。
function setupSessionSecret() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SESSION_SECRET')) {
    Logger.log('SESSION_SECRET 已存在，不覆寫。');
    return;
  }
  // 兩個 UUID 去掉連字號 = 64 個隨機十六進位字元
  const secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('SESSION_SECRET', secret);
  Logger.log('SESSION_SECRET 已產生並存入 Script Properties（長度 ' + secret.length + '）。');
}

// 簽發 session token；效期固定至當日台北 24:00（nextTaipeiMidnightEpochSec_，見純函式區）。
// jti = 每個 token 的唯一識別碼（登入紀錄頁標記「目前裝置」用；每台裝置各自一組）。
function issueSessionToken_(email) {
  const secret = getSessionSecret_();
  if (!secret) throw new Error('SESSION_SECRET not configured（請在 GAS 編輯器執行一次 setupSessionSecret）');
  const now = Date.now();
  const iat = Math.floor(now / 1000);
  const exp = nextTaipeiMidnightEpochSec_(now);
  const jti = Utilities.getUuid();
  const payloadB64 = Utilities.base64EncodeWebSafe(
    JSON.stringify({ e: email, jti: jti, iat: iat, exp: exp })
  );
  const sigB64 = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadB64, secret)
  );
  return { token: payloadB64 + '.' + sigB64, exp: exp, jti: jti, iat: iat };
}

// ── 登出即註銷（全部裝置）：以「該帳號的 revokedBefore 時間戳」實作（仿 infosys v146）──
// 登出時把 revokedBefore[email] 設為當下秒數；驗證時 iat < revokedBefore 一律拒絕，
// 等於讓該帳號「登出前簽發的所有 token（不分裝置）」全部失效。存 Script Properties 單一 JSON，
// 以 CacheService 快取 60 秒（登出時主動清快取→實質即時生效），避免每個請求都讀 Property。
function sessionRevokedBeforeMap_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('sess_rb'); if (hit) return JSON.parse(hit); } catch (_) {}
  const raw = PropertiesService.getScriptProperties().getProperty('SESSION_REVOKED_BEFORE') || '{}';
  try { cache.put('sess_rb', raw, 60); } catch (_) {}
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

// 註：這裡直接拿 LockService 而不用 withLock_，語意相同；獨立小臨界區、5 秒即可。
function sessionRevokeAllDevices_(email) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (_) {}
  try {
    const props = PropertiesService.getScriptProperties();
    let map = {};
    try { map = JSON.parse(props.getProperty('SESSION_REVOKED_BEFORE') || '{}'); } catch (_) { map = {}; }
    map[email] = Math.floor(Date.now() / 1000);
    props.setProperty('SESSION_REVOKED_BEFORE', JSON.stringify(map));
    try { CacheService.getScriptCache().remove('sess_rb'); } catch (_) {}  // 清快取→下次驗證立即讀到新值
  } finally { try { lock.releaseLock(); } catch (_) {} }
}

// 驗證 session token：重算簽章比對 → decode payload → exp 未過 → 未被登出註銷 → 回 email。
// 任何一步失敗（含 SESSION_SECRET 未設置）一律回 null——fail-closed，
// doPost 據此回 'Session expired' 讓前端靜默重走 Google 登入。
function verifySessionToken_(token) {
  try {
    const secret = getSessionSecret_();
    if (!secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 2) return null;
    const expected = Utilities.base64EncodeWebSafe(
      Utilities.computeHmacSha256Signature(parts[0], secret)
    );
    if (expected !== parts[1]) return null;
    const payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()
    );
    if (!payload || !payload.e) return null;
    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null;
    const rb = sessionRevokedBeforeMap_()[payload.e];  // 登出註銷檢查（全部裝置）
    if (rb && Number(payload.iat) < Number(rb)) return null;
    return payload.e;
  } catch (e) { return null; }
}

// ── 回應工具 ──────────────────────────────────────────────────────────────────

function jsonResp_(data) {
  return ContentService.createTextOutput(JSON.stringify({ success: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Drive API 底層（比照 infosys）─────────────────────────────────────────────

function tok_() { return ScriptApp.getOAuthToken(); }

function driveGet_(path, qParams) {
  const base = { supportsAllDrives: true, includeItemsFromAllDrives: true };
  const merged = Object.assign(base, qParams || {});
  const qs = Object.entries(merged).map(function (kv) { return kv[0] + '=' + encodeURIComponent(kv[1]); }).join('&');
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/' + path + '?' + qs,
    { headers: { Authorization: 'Bearer ' + tok_() }, muteHttpExceptions: true }
  );
  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 400) throw new Error(body.error && body.error.message || 'Drive error');
  return body;
}

function drivePatch_(fileId, metadata) {
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId + '?supportsAllDrives=true',
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + tok_(), 'Content-Type': 'application/json' },
      payload: JSON.stringify(metadata),
      muteHttpExceptions: true
    }
  );
  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 400) throw new Error(body.error && body.error.message || 'Drive error');
  return body;
}

function driveUpload_(name, jsonContent, parentId) {
  const body = JSON.stringify(jsonContent);
  const boundary = 'scc_boundary';
  const metadata = JSON.stringify({ name: name, mimeType: 'application/json', parents: [parentId] });
  const multipart =
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    metadata + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    body + '\r\n' +
    '--' + boundary + '--';
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tok_(),
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      payload: multipart,
      muteHttpExceptions: true
    }
  );
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 400) throw new Error(data.error && data.error.message || 'Upload error');
  return data;
}

function driveUpdateContent_(fileId, jsonContent) {
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media&supportsAllDrives=true',
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + tok_(), 'Content-Type': 'application/json' },
      payload: JSON.stringify(jsonContent),
      muteHttpExceptions: true
    }
  );
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 400) throw new Error(data.error && data.error.message || 'Update error');
  return data;
}

function createFolder_(params) {
  const name = params.name, parentId = params.parentId;
  const metadata = JSON.stringify({
    name: name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  });
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok_(), 'Content-Type': 'application/json' },
      payload: metadata,
      muteHttpExceptions: true
    }
  );
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 400) throw new Error(data.error && data.error.message || 'createFolder error');
  return data;
}

function uploadFile_(params) {
  const bytes = Utilities.base64Decode(params.base64Data);
  const blob  = Utilities.newBlob(bytes, params.mimeType, params.fileName);
  const folder = DriveApp.getFolderById(params.parentFolderId);
  const file  = folder.createFile(blob);
  return { fileId: file.getId(), fileName: file.getName() };
}

function downloadFileBase64_(params) {
  const file = DriveApp.getFileById(params.fileId);
  const blob = file.getBlob();
  return {
    fileName: file.getName(),
    mimeType: blob.getContentType(),
    base64:   Utilities.base64Encode(blob.getBytes()),
  };
}

// ── 路徑解析 / JSON 讀寫（比照 infosys resolvePathToId_/readJson_/updateJson_）──

function resolvePathToId_(path, ctx) {
  const parts = path.split('/');
  let curId = ctx.root;
  for (let i = 0; i < parts.length - 1; i++) {
    const q = "name='" + parts[i] + "' and mimeType='application/vnd.google-apps.folder'" +
              " and '" + curId + "' in parents and trashed=false";
    const res = driveGet_('files', { q: q, fields: 'files(id)', pageSize: '1' });
    if (!res.files || res.files.length === 0) throw new Error('Folder not found: ' + parts[i]);
    curId = res.files[0].id;
  }
  const fileName = parts[parts.length - 1];
  const q2 = "name='" + fileName + "' and '" + curId + "' in parents and trashed=false";
  const res2 = driveGet_('files', { q: q2, fields: 'files(id)', orderBy: 'modifiedTime desc', pageSize: '5' });
  if (!res2.files || res2.files.length === 0) throw new Error('File not found: ' + path);
  if (res2.files.length > 1) {
    res2.files.slice(1).forEach(function (f) { try { drivePatch_(f.id, { trashed: true }); } catch (e) {} });
  }
  return res2.files[0].id;
}

function resolvePathToParentAndName_(path, ctx) {
  const parts = path.split('/');
  const fileName = parts[parts.length - 1];
  let parentId = ctx.root;
  for (let i = 0; i < parts.length - 1; i++) {
    const q = "name='" + parts[i] + "' and mimeType='application/vnd.google-apps.folder'" +
              " and '" + parentId + "' in parents and trashed=false";
    const res = driveGet_('files', { q: q, fields: 'files(id)', pageSize: '1' });
    if (!res.files || res.files.length === 0) throw new Error('Folder not found: ' + parts[i]);
    parentId = res.files[0].id;
  }
  return { parentId: parentId, fileName: fileName };
}

function readJson_(params, ctx) {
  const fileId = resolvePathToId_(params.path, ctx);
  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true',
    { headers: { Authorization: 'Bearer ' + tok_() }, muteHttpExceptions: true }
  );
  if (res.getResponseCode() >= 400) throw new Error('readJson failed: ' + params.path);
  return JSON.parse(res.getContentText());
}

// 讀不到（檔案不存在或格式錯誤）就回傳 fallback，不拋錯——用於「檔案可能還沒建立」的情境
// （例如新學期第一次寫 records_<semester>.json、第一次寫 audit_log.json）。
function readJsonSafe_(path, ctx, fallback) {
  try {
    return readJson_({ path: path }, ctx);
  } catch (e) {
    return fallback;
  }
}

function updateJson_(params, ctx) {
  const path = params.path, content = params.content;
  let fileId;
  try {
    fileId = resolvePathToId_(path, ctx);
  } catch (notFound) {
    const pn = resolvePathToParentAndName_(path, ctx);
    const verify = driveGet_('files', {
      q: "name='" + pn.fileName + "' and '" + pn.parentId + "' in parents and trashed=false",
      fields: 'files(id)', orderBy: 'modifiedTime desc', pageSize: '5'
    });
    if (verify.files && verify.files.length > 0) {
      fileId = verify.files[0].id;
      verify.files.slice(1).forEach(function (f) { try { drivePatch_(f.id, { trashed: true }); } catch (e) {} });
    } else {
      return driveUpload_(pn.fileName, content, pn.parentId);
    }
  }
  return driveUpdateContent_(fileId, content);
}

// create-or-update 的簡短別名，語意上「寫入這個路徑」比 updateJson_ 這種泛用代理命名更貼近本系統的用法。
function writeJsonPath_(path, content, ctx) {
  return updateJson_({ path: path, content: content }, ctx);
}

// ── 巢狀資料夾建立（用於 attachments/<semester>/<classId>/）───────────────────

function ensureFolder_(name, parentId) {
  const q = "name='" + name + "' and mimeType='application/vnd.google-apps.folder' and '" + parentId + "' in parents and trashed=false";
  const res = driveGet_('files', { q: q, fields: 'files(id)', pageSize: '1' });
  if (res.files && res.files.length > 0) return res.files[0].id;
  const created = createFolder_({ name: name, parentId: parentId });
  return created.id;
}

function ensureFolderPath_(parts, ctx) {
  let curId = ctx.root;
  parts.forEach(function (name) { curId = ensureFolder_(name, curId); });
  return curId;
}

// 只查找、不建立的資料夾路徑解析：任何一層不存在就回傳 null。
// 用於附件歸屬驗證——驗證情境下資料夾不存在代表「不可能有合法附件」，
// 絕不能順手建立資料夾（那會把驗證變成永遠通過）。
function findFolderPathId_(parts, ctx) {
  let curId = ctx.root;
  for (let i = 0; i < parts.length; i++) {
    const q = "name='" + parts[i] + "' and mimeType='application/vnd.google-apps.folder'" +
              " and '" + curId + "' in parents and trashed=false";
    const res = driveGet_('files', { q: q, fields: 'files(id)', pageSize: '1' });
    if (!res.files || res.files.length === 0) return null;
    curId = res.files[0].id;
  }
  return curId;
}

// 附件歸屬驗證（提交側，防禦縱深第一層）：attachments 裡的每個 fileId 都必須實際位於
// ctx.root 底下 attachments/<semester>/<classId>/ 對應資料夾內（用 Drive API 查 parents，
// 純函式判斷交給 isAttachmentInFolder_），任何一個不合法就整筆拒絕。
// 前置條件：semester 已通過 requireValidSemester_、classId 已比對過 classes.json，
// 因此拼進 findFolderPathId_ 的 q 字串的都是受控值，無注入疑慮。
function assertAttachmentsBelong_(attachments, semester, classId, ctx) {
  const list = attachments || [];
  if (!list.length) return;
  const folderId = findFolderPathId_(['attachments', semester, classId], ctx);
  if (!folderId) throw new Error('attachments folder not found for this class/semester');
  list.forEach(function (a) {
    if (!a || !a.fileId) throw new Error('attachment.fileId required');
    let meta = null;
    try {
      meta = driveGet_('files/' + encodeURIComponent(a.fileId), { fields: 'id,parents,trashed' });
    } catch (e) { /* 查不到 metadata → meta 保持 null → fail-closed */ }
    if (!isAttachmentInFolder_(meta, folderId)) {
      throw new Error('attachment does not belong to this class/semester: ' + a.fileId);
    }
  });
}

// semester 參數的入口守門：所有接受 client 傳入 semester 的 action 都必須先過這關。
function requireValidSemester_(semesterId, ctx) {
  const semesters = readJsonSafe_('semesters.json', ctx, []);
  if (!isValidSemesterId_(semesterId, semesters)) throw new Error('invalid semester: ' + semesterId);
  return semesterId;
}

// ── LockService 寫入保護 + 稽核紀錄 ────────────────────────────────────────────
// 與 infosys 的差異：infosys 只有 casesUpsert_ 單一函式用 LockService 保護；
// 本系統把它抽成通用 withLock_ wrapper，套用到「每一個」寫入 action（recordSubmit、
// recordApprove、adminUpsert* 等），確保所有 read-modify-write 都在同一個臨界區內完成，
// 且 audit_log.json 的 append 與主要資料寫入落在同一個 lock 內（LockService.getScriptLock()
// 是整個腳本共用的全域鎖，同一個臨界區內可以連續寫兩個檔案而不必再拿一次鎖）。
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function appendAuditLog_(ctx, entry) {
  let log = readJsonSafe_('audit_log.json', ctx, { entries: [] });
  if (!log || !Array.isArray(log.entries)) log = { entries: [] };
  log.entries.push(entry);
  writeJsonPath_('audit_log.json', log, ctx);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 純函式：角色解析、白名單判斷、核章狀態機 ──────────────────────────────────
// 這一整段刻意寫成不碰任何 GAS 全域物件（DriveApp/UrlFetchApp/LockService/...）的
// 純函式，方便用 test/harness.js 從本檔就地抽出，在 Node vm context 內單元測試。
// ══════════════════════════════════════════════════════════════════════════════

// 判斷 email 是否為某班的導師（tutors 陣列含 1~2 位）。
function isClassTutor_(classInfo, email) {
  if (!classInfo) return false;
  return (classInfo.tutors || []).some(function (t) { return t && t.email === email; });
}

// 角色動態解析：一個 email 可以同時兼任多角色（例如同時是某班導師、也是系主任）。
// - admin：BOOTSTRAP_ADMINS 硬編碼名單，或 config.users[email].role === 'admin' 且未停用。
// - director：config.users[email].role === 'director' 且未停用。
// - deptHeadOf：departments.json 中 headEmail 命中且該系所 active 的 department id 陣列。
// - tutorOf：classes.json 中 tutors 含此 email 且該班 active 的 class id 陣列。
// 注意：config.users 的 disabled 只影響「後台指派的角色」（admin/director）的取得，
// 不影響「學生」身分（任何 Google 帳號都能以學生身分上傳，本系統不預建學生名單）。
// isStaffLead / isStaffAssistant：config.staffLeads / config.staffAssistants 陣列命中且未停用
// （disabled!==true）。assistantLead：助理綁定的主責 {email,name}——只有當該主責也存在且未停用
// 才算綁定成功，否則 null（fail-closed：綁定失效的助理不能代為核章，見 resolveActionableStage_）。
function resolveRoles_(email, config, departments, classes) {
  const roles = {
    email: email, isAdmin: false, isDirector: false,
    isStaffLead: false, isStaffAssistant: false, assistantLead: null,
    deptHeadOf: [], tutorOf: [],
  };
  if (!email) return roles;

  if (typeof BOOTSTRAP_ADMINS !== 'undefined' && BOOTSTRAP_ADMINS.indexOf(email) !== -1) {
    roles.isAdmin = true;
  }

  const u = config && config.users && config.users[email];
  if (u && u.disabled !== true) {
    if (u.role === 'admin') roles.isAdmin = true;
    if (u.role === 'director') roles.isDirector = true;
  }

  const staffLeads = (config && config.staffLeads) || [];
  const staffAssistants = (config && config.staffAssistants) || [];
  const lead = staffLeads.filter(function (s) { return s && s.email === email && s.disabled !== true; })[0];
  if (lead) roles.isStaffLead = true;
  const assistant = staffAssistants.filter(function (s) { return s && s.email === email && s.disabled !== true; })[0];
  if (assistant) {
    roles.isStaffAssistant = true;
    const boundLead = staffLeads.filter(function (s) { return s && s.email === assistant.leadEmail && s.disabled !== true; })[0];
    roles.assistantLead = boundLead ? { email: boundLead.email, name: boundLead.name } : null;
  }

  (departments || []).forEach(function (d) {
    if (d && d.headEmail === email && d.active !== false) roles.deptHeadOf.push(d.id);
  });
  (classes || []).forEach(function (c) {
    if (!c || c.active === false) return;
    if (isClassTutor_(c, email)) roles.tutorOf.push(c.id);
  });

  return roles;
}

// 上傳白名單判斷：導師本人一定可以上傳；白名單為空 = 不限（任何登入帳號皆可上傳該班）；
// 白名單非空時，非導師帳號必須在名單內才允許上傳。
function isUploadAllowed_(classInfo, email) {
  if (!classInfo) return false;
  if (isClassTutor_(classInfo, email)) return true;
  const wl = classInfo.uploadWhitelist || [];
  if (!wl.length) return true;
  return wl.indexOf(email) !== -1;
}

// 紀錄可視範圍判斷：本人上傳的、本班導師、本系系主任、學諮主任、管理員都能看到。
// 用於 bootstrap 的 records 過濾，以及 downloadAttachment 的授權檢查。
function canViewRecord_(record, classInfo, deptInfo, roles, viewerEmail) {
  if (!record || !roles) return false;
  if (roles.isAdmin || roles.isDirector || roles.isStaffLead || roles.isStaffAssistant) return true;
  if (record.uploader && record.uploader.email === viewerEmail) return true;
  if (classInfo && (roles.tutorOf || []).indexOf(classInfo.id) !== -1) return true;
  if (deptInfo && (roles.deptHeadOf || []).indexOf(deptInfo.id) !== -1) return true;
  return false;
}

// 核章鏈定義：班會紀錄 4 關（導師→系主任→學諮中心主責→學諮中心主任）、
// 導生活動紀錄 2 關（學諮中心主責→學諮中心主任，跳過導師與系主任）。
function chainForType_(type) {
  return type === 'activity' ? ['staffLead', 'director'] : ['tutor', 'dept', 'staffLead', 'director'];
}

// 新紀錄的起始狀態：依類型套用對應核章鏈的第一關。
function initialStatusForType_(type) {
  return 'pending_' + chainForType_(type)[0];
}

// 從 'pending_xxx' 狀態字串取出關卡代號；非 pending_ 狀態（approved/rejected）回傳 null。
function stageFromStatus_(status) {
  if (typeof status !== 'string' || status.indexOf('pending_') !== 0) return null;
  return status.slice('pending_'.length);
}

// 找出「目前這個 pending 狀態，輪到誰核章／退件」，並判斷 actor 是否有資格動作。
// admin 視為全關卡的 override（後台管理員可代為處理任何一關，例如職員請假時代核）。
// 學諮中心主責關（staffLead）：主責本人可動；助理僅在「已綁定且該主責未停用」時可代為動作
// （resolveRoles_ 的 assistantLead 已 fail-closed，綁定失效的助理 assistantLead 為 null）。
// 回傳 { ok:true, stage:'tutor'|'dept'|'staffLead'|'director' } 或 { ok:false, reason }。
function resolveActionableStage_(record, classInfo, deptInfo, roles) {
  if (!record) return { ok: false, reason: 'record not found' };
  const stage = stageFromStatus_(record.status);
  if (!stage) return { ok: false, reason: 'record not pending (status=' + record.status + ')' };

  if (roles && roles.isAdmin) return { ok: true, stage: stage };

  if (stage === 'tutor') {
    const isTutor = classInfo && (roles.tutorOf || []).indexOf(classInfo.id) !== -1;
    return isTutor ? { ok: true, stage: 'tutor' } : { ok: false, reason: 'not a tutor of this class' };
  }
  if (stage === 'dept') {
    const isHead = deptInfo && (roles.deptHeadOf || []).indexOf(deptInfo.id) !== -1;
    return isHead ? { ok: true, stage: 'dept' } : { ok: false, reason: 'not the department head' };
  }
  if (stage === 'staffLead') {
    if (roles.isStaffLead) return { ok: true, stage: 'staffLead' };
    if (roles.isStaffAssistant && roles.assistantLead) return { ok: true, stage: 'staffLead' };
    return { ok: false, reason: 'not staff lead or bound assistant' };
  }
  if (stage === 'director') {
    return roles.isDirector ? { ok: true, stage: 'director' } : { ok: false, reason: 'not the director' };
  }
  return { ok: false, reason: 'unknown stage: ' + stage };
}

// 助理代主責時，核章顯示身分要「掛主責的名字」，真實動作者另存 actualBy（見 sanitizeRecordForViewer_，
// 只有 admin/staffLead/staffAssistant/director 看得到 actualBy）。
// - 主責本人動作、或 tutor/dept/director 關：approver = 動作者本人，actualBy = null。
// - staffLead 關且動作者是「已綁定的助理」（非主責本人）：approver = 綁定主責的身分，actualBy = 助理 email。
function resolveApproverIdentity_(stage, roles, userEmail, userName) {
  if (stage === 'staffLead' && !roles.isStaffLead && roles.isStaffAssistant && roles.assistantLead) {
    return { email: roles.assistantLead.email, name: roles.assistantLead.name, actualBy: userEmail };
  }
  return { email: userEmail, name: userName, actualBy: null };
}

// 組出一筆全新的紀錄。若上傳者本人就是該班導師，視同「已完成導師核章該關」立刻套用
// advanceOnTutorApproval_：單導師班或雙導師 any 模式會直接跳到 pending_dept；
// 雙導師 all 模式則停在 pending_tutor，等另一位導師核章。
function buildNewRecord_(input, classInfo, now) {
  let record = {
    id: input.id,
    type: input.type,
    semester: input.semester,
    classId: input.classId,
    deptId: input.deptId,
    uploader: input.uploader,
    form: input.form || {},
    attachments: input.attachments || [],
    status: initialStatusForType_(input.type),
    approvals: { tutor: [], dept: null, staffLead: null, director: null },
    rejection: null,
    topics: input.topics || null,
    editLog: [],
    history: [{ action: 'submit', by: input.uploader.email, at: now, note: null }],
    createdAt: now,
    updatedAt: now,
  };
  // 只有班會紀錄（meeting）才有導師關；導生活動紀錄（activity）起始就是 pending_staffLead，
  // 這裡的 advanceOnTutorApproval_ 對 activity 是 no-op（guard: status!=='pending_tutor'）。
  if (input.uploader && input.uploader.isTutor) {
    record = advanceOnTutorApproval_(record, classInfo, input.uploader.email, input.uploader.name, now);
  }
  return record;
}

// 導師核章推進：
// - 冪等：同一位導師重複核章不會重複計入 approvals.tutor。
// - 雙導師 all 模式（tutors.length>=2 且 dualApprovalMode==='all'）：需要全部導師都核章
//   （requiredCount = tutors.length）才進 pending_dept；其餘情況（單導師、或 any 模式）
//   任一位核章即進 pending_dept（requiredCount = 1）。
function advanceOnTutorApproval_(record, classInfo, tutorEmail, tutorName, now) {
  if (record.status !== 'pending_tutor') return record;

  const tutorList = record.approvals.tutor.slice();
  const already = tutorList.some(function (t) { return t.email === tutorEmail; });
  if (!already) tutorList.push({ email: tutorEmail, name: tutorName, at: now });

  const totalTutors = (classInfo && classInfo.tutors || []).length;
  const requiredCount = (totalTutors >= 2 && classInfo.dualApprovalMode === 'all') ? totalTutors : 1;
  const nextStatus = tutorList.length >= requiredCount ? 'pending_dept' : 'pending_tutor';

  return Object.assign({}, record, {
    approvals: Object.assign({}, record.approvals, { tutor: tutorList }),
    status: nextStatus,
    history: record.history.concat([{
      action: already ? 'tutor_approve_noop' : 'tutor_approve',
      by: tutorEmail, at: now, note: null,
    }]),
    updatedAt: now,
  });
}

function advanceOnDeptApproval_(record, deptHeadEmail, deptHeadName, now) {
  if (record.status !== 'pending_dept') return record;
  return Object.assign({}, record, {
    approvals: Object.assign({}, record.approvals, { dept: { email: deptHeadEmail, name: deptHeadName, at: now } }),
    status: 'pending_staffLead',
    history: record.history.concat([{ action: 'dept_approve', by: deptHeadEmail, at: now, note: null }]),
    updatedAt: now,
  });
}

// 學諮中心主責關。actualBy 非空 = 由已綁定助理代為動作（approvals.staffLead 顯示主責的姓名，
// actualBy 記錄真正動作的助理 email——sanitizeRecordForViewer_ 會把 actualBy 對非授權角色隱藏）。
function advanceOnStaffLeadApproval_(record, actorEmail, actorName, actualBy, now) {
  if (record.status !== 'pending_staffLead') return record;
  const approval = { email: actorEmail, name: actorName, at: now };
  if (actualBy) approval.actualBy = actualBy;
  return Object.assign({}, record, {
    approvals: Object.assign({}, record.approvals, { staffLead: approval }),
    status: 'pending_director',
    history: record.history.concat([{ action: 'staffLead_approve', by: actorEmail, at: now, note: null, actualBy: actualBy || null }]),
    updatedAt: now,
  });
}

function advanceOnDirectorApproval_(record, directorEmail, directorName, now) {
  if (record.status !== 'pending_director') return record;
  return Object.assign({}, record, {
    approvals: Object.assign({}, record.approvals, { director: { email: directorEmail, name: directorName, at: now } }),
    status: 'approved',
    history: record.history.concat([{ action: 'director_approve', by: directorEmail, at: now, note: null }]),
    updatedAt: now,
  });
}

// meeting 表單欄位（必填 + 六段選填）／activity 表單欄位（必填）白名單：核章關「編輯內容」時
// 用來過濾 updatedForm，只允許改動這些欄位（同 recordSubmit 表單欄位範圍，不接受任意鍵值）。
const MEETING_FORM_FIELDS_ = [
  'date', 'topic', 'chair', 'recorder', 'attendance',
  'chairReport', 'discussion', 'resolutions', 'tutorRemarks', 'extempore', 'others',
];
const ACTIVITY_FORM_FIELDS_ = ['date', 'topic', 'summary', 'attendance'];

function formFieldsForType_(type) {
  return type === 'activity' ? ACTIVITY_FORM_FIELDS_ : MEETING_FORM_FIELDS_;
}

// 白名單過濾：只留下該類型允許的欄位，且值必須是字串（非字串一律丟棄，不拋錯——由呼叫端決定
// 是否要求全部欄位存在；這裡只做「不可夾帶未知鍵/非法型別」的防線）。
function sanitizeFormFields_(type, form) {
  const allowed = formFieldsForType_(type);
  const out = {};
  allowed.forEach(function (k) {
    if (form && typeof form[k] === 'string') out[k] = form[k];
  });
  return out;
}

// 核章關「編輯內容」：套用白名單過濾後的欄位、記錄 editLog（changedFields 只列真的變動的鍵）。
// 沒有任何欄位變動則原樣回傳（不 append 空的 editLog 項目）。byEmail 一律記真實動作者
// （即使是助理代主責核章，也記助理本人 email，不是「掛名」的主責——見 recordApprove_ 呼叫處註解）。
function applyFormEdit_(record, updatedForm, byEmail, roleStage, now) {
  if (!updatedForm || typeof updatedForm !== 'object') return record;
  const clean = sanitizeFormFields_(record.type, updatedForm);
  const changed = [];
  Object.keys(clean).forEach(function (k) {
    if ((record.form || {})[k] !== clean[k]) changed.push(k);
  });
  if (!changed.length) return record;
  const newForm = Object.assign({}, record.form, clean);
  const editLog = (record.editLog || []).concat([{ by: byEmail, roleStage: roleStage, at: now, changedFields: changed }]);
  return Object.assign({}, record, { form: newForm, editLog: editLog, updatedAt: now });
}

// 授權判斷 + （選填）內容編輯 + 狀態推進的整合入口（供 recordApproveAction_ 呼叫）。
// resolveActionableStage_ 判斷「這個人現在能不能核這一關」，通過才套用 updatedForm（若有）
// 並呼叫對應的 advanceOnXApproval_；核准照常推進，不重跑已過關卡。
// userName：動作者本人姓名（config.users 查得）；助理代主責時 approver 身分由
// resolveApproverIdentity_ 換成「綁定主責」的 email/name，actualBy 存助理本人 email。
function recordApprove_(record, classInfo, deptInfo, roles, userEmail, userName, updatedForm, now) {
  const chk = resolveActionableStage_(record, classInfo, deptInfo, roles);
  if (!chk.ok) return { ok: false, error: chk.reason };
  const approver = resolveApproverIdentity_(chk.stage, roles, userEmail, userName);
  let rec = applyFormEdit_(record, updatedForm, userEmail, chk.stage, now);
  let updated;
  if (chk.stage === 'tutor') updated = advanceOnTutorApproval_(rec, classInfo, approver.email, approver.name, now);
  else if (chk.stage === 'dept') updated = advanceOnDeptApproval_(rec, approver.email, approver.name, now);
  else if (chk.stage === 'staffLead') updated = advanceOnStaffLeadApproval_(rec, approver.email, approver.name, approver.actualBy, now);
  else updated = advanceOnDirectorApproval_(rec, approver.email, approver.name, now);
  return { ok: true, record: updated, stage: chk.stage };
}

// 退件：任何一關都可退（用同一套 resolveActionableStage_ 判斷「現在輪到誰」），必須填理由，
// 一律退回「導師」（狀態統一設為 rejected；由 canResubmit_ 規定只有該班導師能修正重送，
// 不論是哪一關退的、也不論原上傳者是誰——見 canResubmit_ 註解）。
function applyRejection_(record, byEmail, byName, actualBy, role, reason, now) {
  const rejection = { by: byEmail, name: byName, role: role, reason: reason, at: now };
  if (actualBy) rejection.actualBy = actualBy;
  return Object.assign({}, record, {
    status: 'rejected',
    rejection: rejection,
    history: record.history.concat([{ action: 'reject', by: byEmail, at: now, note: reason, actualBy: actualBy || null }]),
    updatedAt: now,
  });
}

function recordReject_(record, classInfo, deptInfo, roles, userEmail, userName, reason, updatedForm, now) {
  const chk = resolveActionableStage_(record, classInfo, deptInfo, roles);
  if (!chk.ok) return { ok: false, error: chk.reason };
  if (!reason || !String(reason).trim()) return { ok: false, error: 'reason required' };
  const approver = resolveApproverIdentity_(chk.stage, roles, userEmail, userName);
  const rec = applyFormEdit_(record, updatedForm, userEmail, chk.stage, now);
  const updated = applyRejection_(rec, approver.email, approver.name, approver.actualBy, chk.stage, reason, now);
  return { ok: true, record: updated, stage: chk.stage };
}

// 退件重送權限：一律「退回導師」——不論是哪一關退的、原上傳者是誰，只有該班導師
// （isClassTutor_）能修正重送；且紀錄必須目前是 rejected 狀態。
// （與舊版差異：舊版限「原上傳者本人」，新版限「該班導師」——因為新規則不論哪一關退件，
// 責任都收斂回導師身上，導師不必是原上傳者也能代表全班修正重送。）
function canResubmit_(record, classInfo, actorEmail) {
  if (!record) return { ok: false, error: 'record not found' };
  if (record.status !== 'rejected') return { ok: false, error: 'record not rejected' };
  if (!isClassTutor_(classInfo, actorEmail)) return { ok: false, error: 'only a tutor of this class may resubmit' };
  return { ok: true };
}

// 重送後「從該紀錄類型的第一關重跑」：meeting 回 pending_tutor（重送者必為導師，立即視同已完成
// 導師核章該關，套用同一套 advanceOnTutorApproval_ 邏輯——單導師/雙導師 any 直接進 pending_dept，
// 雙導師 all 則停在 pending_tutor 等另一位導師）；activity 沒有導師關，直接回 pending_staffLead。
// approvals/topics 的 auto 欄位由呼叫端（recordResubmitAction_）視需要重新掃描關鍵字覆蓋；
// 這裡只重置核章鏈本身。history 保留累加（不清空）。
function applyResubmit_(record, updatedForm, updatedAttachments, byEmail, now) {
  return Object.assign({}, record, {
    status: initialStatusForType_(record.type),
    approvals: { tutor: [], dept: null, staffLead: null, director: null },
    rejection: null,
    form: updatedForm || record.form,
    attachments: updatedAttachments || record.attachments,
    history: record.history.concat([{ action: 'resubmit', by: byEmail, at: now, note: null }]),
    updatedAt: now,
  });
}

function recordResubmit_(record, classInfo, actorEmail, actorName, updatedForm, updatedAttachments, now) {
  const chk = canResubmit_(record, classInfo, actorEmail);
  if (!chk.ok) return chk;
  let next = applyResubmit_(record, updatedForm, updatedAttachments, actorEmail, now);
  if (next.type !== 'activity' && isClassTutor_(classInfo, actorEmail)) {
    next = advanceOnTutorApproval_(next, classInfo, actorEmail, actorName, now);
  }
  return { ok: true, record: next };
}

// semester 參數白名單驗證：格式必須為 NNN-N（如 114-2）**且**存在於 semesters.json。
// 防禦：semester 由 client 傳入、會被串進 records_<semester>.json 檔名與 Drive 搜尋的 q 字串
// （resolvePathToId_ 直接把檔名拼進 q），未驗證會有兩個風險：
// (1) 含單引號的字串可逃逸 q 的引號、注入查詢條件（跳出「in parents」範圍）；
// (2) recordSubmit / uploadAttachment 會用它建檔案/資料夾，任意字串 = 垃圾檔。
function isValidSemesterId_(semesterId, semesters) {
  if (typeof semesterId !== 'string') return false;
  if (!/^[0-9]{3}-[0-9]$/.test(semesterId)) return false;
  return (semesters || []).some(function (s) { return s && s.id === semesterId; });
}

// 依呼叫者角色過濾 classes 的敏感欄位再回傳給前端。
// - uploadWhitelist 是學生 gmail 清單（個資），只有「該班導師或 admin」看得到；
//   其他人拿到的物件移除該欄位，改附 hasWhitelist 布林（前端仍可顯示「此班有限制名單」提示）。
// - suggestedTutors 的 by（建議者 email，即上傳學生）與自填 email 屬個資，只有 admin
//   看得到完整內容；其他人（含該班導師）只拿到 name（前端顯示「待確認」chip 用）。
// - tutors 的 email/姓名保留——上傳表單選班級與核章顯示都需要。
function sanitizeClassesForViewer_(classes, roles) {
  return (classes || []).map(function (c) {
    if (!c) return c;
    if (roles && roles.isAdmin === true) return c;
    const isTutor = !!roles && (roles.tutorOf || []).indexOf(c.id) !== -1;
    const hasSuggestions = !!(c.suggestedTutors && c.suggestedTutors.length);
    if (isTutor && !hasSuggestions) return c;
    const copy = Object.assign({}, c);
    if (hasSuggestions) {
      copy.suggestedTutors = c.suggestedTutors.map(function (s) { return { name: (s && s.name) || '' }; });
    }
    if (!isTutor) {
      copy.hasWhitelist = !!(c.uploadWhitelist && c.uploadWhitelist.length);
      delete copy.uploadWhitelist;
    }
    return copy;
  });
}

// 依呼叫者角色過濾單筆 record 的敏感欄位（actualBy：助理代主責核章時的真實身分）。
// 只有 admin / director / staffLead / staffAssistant 看得到 actualBy；其他人（含導師、系主任、
// 提交者本人）拿到的 approvals.*.actualBy 與 history[].actualBy / rejection.actualBy 一律移除，
// 只留「掛名」的主責姓名——助理不能替真人身分曝光給非學諮端角色。用深拷貝避免就地修改輸入。
function sanitizeRecordForViewer_(record, roles) {
  if (!record) return record;
  const privileged = !!(roles && (roles.isAdmin || roles.isDirector || roles.isStaffLead || roles.isStaffAssistant));
  if (privileged) return record;
  const copy = JSON.parse(JSON.stringify(record));
  if (copy.approvals) {
    ['dept', 'staffLead', 'director'].forEach(function (k) {
      if (copy.approvals[k] && copy.approvals[k].actualBy) delete copy.approvals[k].actualBy;
    });
    if (Array.isArray(copy.approvals.tutor)) {
      copy.approvals.tutor.forEach(function (a) { if (a && a.actualBy) delete a.actualBy; });
    }
  }
  if (copy.rejection && copy.rejection.actualBy) delete copy.rejection.actualBy;
  if (Array.isArray(copy.history)) {
    copy.history.forEach(function (h) { if (h && h.actualBy) delete h.actualBy; });
  }
  // editLog.by 記真實動作者；staffLead 關的編輯（主責或助理）對非學諮端角色一律隱藏 by，
  // 否則助理在核章時順手改內容會經 editLog 洩漏真實身分（與 actualBy 同一套遮罩原則）。
  if (Array.isArray(copy.editLog)) {
    copy.editLog.forEach(function (e) { if (e && e.roleStage === 'staffLead' && e.by) delete e.by; });
  }
  return copy;
}

function sanitizeRecordsForViewer_(records, roles) {
  return (records || []).map(function (r) { return sanitizeRecordForViewer_(r, roles); });
}

// ── 四類宣導關鍵字自動偵測（class.form 所有文字欄位 vs config.keywordRules）───────
// auto:true 代表由關鍵字掃描自動勾選；auto:false 代表已被人工手動調整過（見 applySetTopics_）。
// 重新掃描（提交/重送/編輯內容時）只覆蓋 auto:true 的項目，人工調整過的（auto:false）維持原狀，
// 不被自動掃描蓋回去。
function detectTopics_(form, keywordRules) {
  const text = Object.keys(form || {}).map(function (k) { return String(form[k] || ''); }).join('\n');
  const result = {};
  Object.keys(keywordRules || {}).forEach(function (key) {
    const kws = (keywordRules[key] && keywordRules[key].keywords) || [];
    const hit = kws.some(function (kw) { return kw && text.indexOf(kw) !== -1; });
    result[key] = { checked: hit, auto: true };
  });
  return result;
}

function mergeTopicsOnEdit_(existingTopics, form, keywordRules) {
  const detected = detectTopics_(form, keywordRules);
  const out = {};
  Object.keys(detected).forEach(function (key) {
    const prev = (existingTopics || {})[key];
    out[key] = (prev && prev.auto === false) ? prev : detected[key];
  });
  return out;
}

// 手動勾選調整權限：只有 staffLead 關的驗證者（主責/已綁定助理）與 director/admin 能動。
// 助理必須「已綁定且主責未停用」（assistantLead 非 null）才算數——與 resolveActionableStage_
// 的 fail-closed 綁定規則一致，綁定失效的助理不能動 topics。
function canSetTopics_(roles) {
  if (!roles) return false;
  if (roles.isAdmin || roles.isDirector || roles.isStaffLead) return true;
  return !!(roles.isStaffAssistant && roles.assistantLead);
}

// 手動調整後該項目 auto 一律變 false（人工鎖定，之後自動掃描不會再覆蓋，見 mergeTopicsOnEdit_）。
// topicsPatch 只認已存在於 record.topics 的鍵（四類固定 key），未知鍵忽略；checked 必須是布林。
// byEmail = 對外顯示身分（助理代主責時為綁定主責的 email）；actualBy = 助理真實 email
// （sanitizeRecordForViewer_ 會對非學諮端角色隱藏 history 的 actualBy，同核章的遮罩原則）。
function applySetTopics_(record, topicsPatch, byEmail, actualBy, now) {
  const cur = record.topics || {};
  const next = Object.assign({}, cur);
  Object.keys(topicsPatch || {}).forEach(function (key) {
    if (!next[key]) return;
    const patch = topicsPatch[key];
    if (patch && typeof patch.checked === 'boolean') {
      next[key] = { checked: patch.checked, auto: false };
    }
  });
  return Object.assign({}, record, {
    topics: next, updatedAt: now,
    history: record.history.concat([{ action: 'setTopics', by: byEmail, at: now, note: null, actualBy: actualBy || null }]),
  });
}

// ── displayName 自動融合（建議值，admin 可事後改）───────────────────────────────
// 系簡稱 = 系所名去尾字「系」。四技一A→「四+系簡+一A」、四技進一A→「進四+系簡+一A」、
// 碩一→「碩+系簡+一」、碩專一B→「碩專+系簡+一B」、博一→「博+系簡+一」、
// 家族→「系簡+家族(導師名)」（家族由呼叫端帶 tutorName，未帶則不含括號）；
// 技優/產訓/產專/海青等已知但無法歸入上述規則的前綴→前綴保留、系簡插入其後；
// 完全無法判別 → 直接「系簡+原名」。純字串規則，不查資料庫，僅供 UI 預填建議值。
function deptShortName_(deptName) {
  const n = String(deptName || '').trim();
  return (n.length > 1 && n.slice(-1) === '系') ? n.slice(0, -1) : n;
}

function fuseClassDisplayName_(className, deptName, systemId, tutorName) {
  const name = String(className || '').trim();
  const short = deptShortName_(deptName);
  if (!name) return short;
  if (name.indexOf('家族') !== -1) {
    return tutorName ? (short + '家族(' + tutorName + ')') : (short + '家族');
  }
  if (name.indexOf('四技進') === 0) return '進四' + short + name.slice(3);
  if (name.indexOf('四技') === 0) return '四' + short + name.slice(2);
  if (name.indexOf('碩專') === 0) return '碩專' + short + name.slice(2);
  if (name.indexOf('碩') === 0) return '碩' + short + name.slice(1);
  if (name.indexOf('博') === 0) return '博' + short + name.slice(1);
  const otherPrefixes = ['技優', '產訓', '產專', '海青'];
  for (let i = 0; i < otherPrefixes.length; i++) {
    const p = otherPrefixes[i];
    if (name.indexOf(p) === 0) return p + short + name.slice(p.length);
  }
  return short + name;
}

// 應繳班會份數解析：requiredMeetingOverride 為數字（含 0＝本學期免繳）時優先套用；
// 否則查 class.systemId 對應的 tutorSystem.requiredMeetingCount（停用的制度不採用其值，
// 視同查無制度）；都查不到則用保底預設 DEFAULT_REQUIRED_MEETING_COUNT_。
function resolveRequiredMeetingCount_(classInfo, tutorSystems) {
  if (classInfo && classInfo.requiredMeetingOverride !== undefined && classInfo.requiredMeetingOverride !== null) {
    const ov = Number(classInfo.requiredMeetingOverride);
    if (!isNaN(ov)) return ov;
  }
  const sys = (tutorSystems || []).filter(function (s) {
    return s && s.id === (classInfo && classInfo.systemId) && s.disabled !== true;
  })[0];
  if (sys && typeof sys.requiredMeetingCount === 'number') return sys.requiredMeetingCount;
  return DEFAULT_REQUIRED_MEETING_COUNT_;
}

// ── 統計總表彙總（純函式）：依 學院→系所→班級 分組，只回彙總與日期，不回紀錄內文 ──────
function overviewStats_(colleges, departments, classes, tutorSystems, records, keywordTopicKeys) {
  const collegeById = {};
  (colleges || []).forEach(function (c) { if (c) collegeById[c.id] = c; });
  const deptById = {};
  (departments || []).forEach(function (d) { if (d) deptById[d.id] = d; });
  const recordsByClass = {};
  (records || []).forEach(function (r) {
    if (!r || !r.classId) return;
    (recordsByClass[r.classId] = recordsByClass[r.classId] || []).push(r);
  });
  const topicKeys = keywordTopicKeys || ['traffic', 'gender', 'smoking', 'fraud'];

  return (classes || []).filter(function (c) { return c && c.active !== false; }).map(function (c) {
    const dept = deptById[c.deptId];
    const college = (dept && dept.collegeId) ? collegeById[dept.collegeId] : null;
    const classRecords = recordsByClass[c.id] || [];
    const meetingRecords = classRecords.filter(function (r) { return r.type === 'meeting'; });
    const activityRecords = classRecords.filter(function (r) { return r.type === 'activity'; });
    const submittedCount = meetingRecords.length;
    const approvedCount = meetingRecords.filter(function (r) { return r.status === 'approved'; }).length;
    const pendingCount = meetingRecords.filter(function (r) { return String(r.status || '').indexOf('pending') === 0; }).length;

    const topics = {};
    topicKeys.forEach(function (key) {
      const dates = meetingRecords
        .filter(function (r) { return r.topics && r.topics[key] && r.topics[key].checked; })
        .map(function (r) { return r.form && r.form.date; })
        .filter(Boolean);
      topics[key] = { checked: dates.length > 0, dates: dates };
    });

    const act = activityRecords[0] || null;
    const activity = act
      ? { submitted: true, date: (act.form && act.form.date) || null, approved: act.status === 'approved' }
      : { submitted: false, date: null, approved: false };

    return {
      college: college ? college.name : null,
      dept: dept ? dept.name : c.deptId,
      classId: c.id,
      displayName: c.displayName || c.name,
      tutors: (c.tutors || []).map(function (t) { return t.name; }),
      required: resolveRequiredMeetingCount_(c, tutorSystems),
      submittedCount: submittedCount,
      approvedCount: approvedCount,
      pendingCount: pendingCount,
      topics: topics,
      activity: activity,
    };
  });
}

// 附件歸屬驗證的純函式骨架：檔案 metadata（{ id, parents, trashed }）是否真的掛在預期的
// attachments/<semester>/<classId> 資料夾底下。expectedFolderId 為 null（資料夾不存在）、
// metadata 缺失、檔案已進垃圾桶、或 parents 未命中，一律 false（fail-closed）。
// 不變式：record.attachments 裡的每個 fileId 都必須通過本檢查——否則任何帳號可以在 submit
// 時塞任意 Drive fileId（例如部署者個人 Drive 的檔案），再對自己的 record 呼叫
// downloadAttachment，讓後端用部署者權限把該檔 base64 回傳 = 任意檔案外洩。
function isAttachmentInFolder_(fileMeta, expectedFolderId) {
  if (!expectedFolderId) return false;
  if (!fileMeta || fileMeta.trashed === true) return false;
  return (fileMeta.parents || []).indexOf(expectedFolderId) !== -1;
}

// 學期輔助：找出 isCurrent 的學期；找不到就退而求其次用陣列最後一筆（假設按時間排序）。
function currentSemesterId_(semesters) {
  const found = (semesters || []).filter(function (s) { return s && s.isCurrent; })[0];
  if (found) return found.id;
  if (semesters && semesters.length) return semesters[semesters.length - 1].id;
  return null;
}

// ── classResolve 純邏輯：系所/班級 find-or-create + 導師建議 ──────────────────
// 班級的身分是 (系所, 班級名稱) 組合，名稱為自由文字（如「資管三A」「碩一」），
// 由上傳者第一次使用時自動建立（免管理員預建）。
// 資安重點：className/deptName/suggestedTutors 都是 client 傳入值，className 會進
// classes.json 的 id 與 Drive 資料夾路徑/查詢字串（attachments/<semester>/<classId>/），
// 比照 semester 白名單的教訓（commit d28fedb），一律先過嚴格白名單驗證——
// 禁止引號/斜線/空白/控制字元，避免 Drive q 字串注入與垃圾 id。

// className（班級名稱）：trim 後 1–20 字，只允許英數與中日韓統一表意文字（一-鿿），
// 禁止空白/引號/斜線/符號（會進 classId 與 Drive 查詢字串）。
function isValidClassName_(name) {
  if (typeof name !== 'string') return false;
  return /^[A-Za-z0-9一-鿿]{1,20}$/.test(name.trim());
}

// deptName（自填系所名稱）：trim 後 1–30 字，只允許英數/中文/括號/空白。
function isValidDeptName_(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= 1 && t.length <= 30 && /^[A-Za-z0-9一-鿿()（）\s]{1,30}$/.test(t);
}

// 系所 id slugify：只保留英數/中文/底線（去掉括號與空白），不信任前端傳 id 建新系所。
// className 建 id 時也套同一套（防禦縱深；className regex 本來就更嚴）。
function slugifyDeptId_(name) {
  return String(name || '').replace(/[^A-Za-z0-9一-鿿_]/g, '');
}

// slug 撞既有系所 id 時加序號後綴（_2、_3…）；slug 為空（名稱全是括號/空白）用 'dept' 打底。
function uniqueDeptId_(slug, departments) {
  const ids = {};
  (departments || []).forEach(function (d) { if (d && d.id) ids[d.id] = true; });
  const base = slug || 'dept';
  if (!ids[base]) return base;
  let i = 2;
  while (ids[base + '_' + i]) i++;
  return base + '_' + i;
}

// class id 撞名後綴（比照 uniqueDeptId_ 模式）：同 slug 不同名稱的班級可各自取得唯一 id。
function uniqueClassId_(slug, classes) {
  const ids = {};
  (classes || []).forEach(function (c) { if (c && c.id) ids[c.id] = true; });
  const base = slug || 'class';
  if (!ids[base]) return base;
  let i = 2;
  while (ids[base + '_' + i]) i++;
  return base + '_' + i;
}

// 學生自填導師建議的驗證與正規化：
// - 每筆 { name, email? }：name trim 後 1–20 字（英數/中文/間隔號/空白）；
//   email 選填，若有必須過基本格式檢查並轉小寫。
// - 整個陣列上限 2 筆（單次呼叫）。任一筆不合法 → 整包拒絕（fail-closed）。
function normalizeSuggestedTutors_(list) {
  if (list === undefined || list === null) return { ok: true, tutors: [] };
  if (!Array.isArray(list)) return { ok: false, error: 'invalid suggestedTutors' };
  if (list.length > 2) return { ok: false, error: 'too many suggested tutors (max 2)' };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || typeof t.name !== 'string') return { ok: false, error: 'invalid suggested tutor name' };
    const name = t.name.trim();
    if (!/^[A-Za-z0-9一-鿿·\s]{1,20}$/.test(name)) return { ok: false, error: 'invalid suggested tutor name' };
    let email = '';
    if (t.email !== undefined && t.email !== null && String(t.email).trim() !== '') {
      email = String(t.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid suggested tutor email' };
    }
    out.push({ name: name, email: email });
  }
  return { ok: true, tutors: out };
}

// 把驗證過的建議 append 進 class.suggestedTutors（純函式，不改動輸入物件）。
// 資安不變式：**絕對不寫入 class.tutors**——tutors 是核章授權來源，只有 admin action
// （adminUpsertClass / adminImportRoster）能動；學生自填一律只進 suggestedTutors，
// 待管理員在後台確認後才轉正。
// - 依 name（trim 比對）對既有 tutors 與既有 suggestions 去重（重複者靜默略過）。
// - 每班 suggestions 總量上限 10：超過的丟棄並以 dropped 計數回報。
function applyTutorSuggestions_(cls, tutors, byEmail, now) {
  const seen = {};
  (cls.tutors || []).forEach(function (t) { if (t && t.name) seen[String(t.name).trim()] = true; });
  const sugList = (cls.suggestedTutors || []).slice();
  sugList.forEach(function (s) { if (s && s.name) seen[String(s.name).trim()] = true; });
  let added = 0, dropped = 0;
  (tutors || []).forEach(function (t) {
    if (seen[t.name]) return;                      // 與正式導師或既有建議同名 → 略過
    if (sugList.length >= 10) { dropped++; return; } // 每班建議總量上限
    sugList.push({ name: t.name, email: t.email, by: byEmail, at: now });
    seen[t.name] = true;
    added++;
  });
  if (!added) return { cls: cls, added: 0, dropped: dropped };
  return { cls: Object.assign({}, cls, { suggestedTutors: sugList }), added: added, dropped: dropped };
}

// classResolve 核心（純函式，不做 I/O）：驗證輸入、解析（或準備建立）系所與班級、
// 套用導師建議。回傳 { ok:false, error } 或
// { ok:true, dept, cls, newDept|null, classCreated, suggestionsAdded, suggestionsDropped }——
// newDept 非 null / classCreated / suggestionsAdded>0 表示需由呼叫端（withLock_ 內）寫入。
function classResolveCore_(params, departments, classes, userEmail, now) {
  if (!isValidClassName_(params.className)) return { ok: false, error: 'invalid className' };
  const className = String(params.className).trim();
  const sug = normalizeSuggestedTutors_(params.suggestedTutors);
  if (!sug.ok) return { ok: false, error: sug.error };

  // 系所解析：deptId（選既有，必須存在且 active）與 deptName（自填）二擇一。
  let dept = null;
  let newDept = null;
  if (params.deptId) {
    dept = (departments || []).filter(function (d) { return d && d.id === params.deptId; })[0];
    if (!dept || dept.active === false) return { ok: false, error: 'department not found: ' + params.deptId };
  } else {
    if (!isValidDeptName_(params.deptName)) return { ok: false, error: 'invalid deptName' };
    const name = String(params.deptName).trim();
    // 以名稱完全比對既有系所（含 inactive 也算命中，避免重複建同名系所）。
    dept = (departments || []).filter(function (d) { return d && d.name === name; })[0];
    // 命中已停用系所一律拒絕（fail-closed）：停用是管理員下架垃圾/濫用 chip 的唯一手段，
    // 若在此放行，重打同名即可繞過停用；命中後拒絕也同時避免落到「建同名新系所」分支。
    if (dept && dept.active === false) return { ok: false, error: 'department disabled: ' + dept.id };
    if (!dept) {
      const id = uniqueDeptId_(slugifyDeptId_(name), departments);
      newDept = { id: id, name: name, headEmail: '', headName: '', active: true };
      dept = newDept;
    }
  }

  // 班級解析：以 (deptId, name===trim 後原文) 完全比對找既有；找不到就準備建立。
  // 舊資料若殘留 grade/section 欄位無妨，一律只認 name。
  let cls = (classes || []).filter(function (c) {
    return c && c.deptId === dept.id && c.name === className;
  })[0];
  // 命中已停用班級一律拒絕（fail-closed，理由同上：防重打同名繞過停用）。
  if (cls && cls.active === false) return { ok: false, error: 'class disabled: ' + cls.id };
  let classCreated = false;
  if (!cls) {
    cls = {
      id: uniqueClassId_(dept.id + '_' + slugifyDeptId_(className), classes),
      name: className, deptId: dept.id,
      systemId: null, displayName: fuseClassDisplayName_(className, dept.name, null),
      requiredMeetingOverride: null,
      tutors: [], suggestedTutors: [],
      dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    };
    classCreated = true;
  }

  // 導師建議：只進 suggestedTutors，絕不進 tutors（見 applyTutorSuggestions_ 註解）。
  const applied = applyTutorSuggestions_(cls, sug.tutors, userEmail, now);

  return {
    ok: true, dept: dept, cls: applied.cls, newDept: newDept, classCreated: classCreated,
    suggestionsAdded: applied.added, suggestionsDropped: applied.dropped,
  };
}

// classStats 彙總（純函式）：只回彙總數字，絕不回紀錄內容。
// pending = status 以 'pending' 開頭（pending_tutor / pending_dept / pending_director）。
function computeClassStats_(records, classId) {
  const stats = {
    meeting:  { approved: 0, pending: 0, rejected: 0, total: 0 },
    activity: { approved: 0, pending: 0, rejected: 0, total: 0 },
  };
  (records || []).forEach(function (r) {
    if (!r || r.classId !== classId) return;
    const bucket = stats[r.type];
    if (!bucket) return;
    bucket.total++;
    if (r.status === 'approved') bucket.approved++;
    else if (r.status === 'rejected') bucket.rejected++;
    else if (String(r.status || '').indexOf('pending') === 0) bucket.pending++;
  });
  return stats;
}

// ── Excel 匯入 v2：學院/系所/導師制度以名稱比對，不存在就建立；停用的一律 fail-closed 拒絕 ──
// （防重打同名繞過停用，同 classResolveCore_ 的既有安全規則，不可退化）。
// 純函式：不做 I/O，输入/輸出都是完整陣列，供呼叫端（adminImportRosterAction_）逐列 fold，
// 讓同一批匯入內、後面列可以命中前面列剛建立的學院/系所/制度，不會重複建立。
function findByNameExact_(list, name) {
  return (list || []).filter(function (x) { return x && x.name === name; })[0];
}

function resolveOrCreateCollege_(name, colleges) {
  const t = String(name || '').trim();
  if (!t) return { ok: true, colleges: colleges, college: null };
  const found = findByNameExact_(colleges, t);
  if (found && found.disabled === true) return { ok: false, error: 'college disabled: ' + found.name };
  if (found) return { ok: true, colleges: colleges, college: found };
  const created = { id: uniqueDeptId_(slugifyDeptId_(t), colleges), name: t, order: (colleges || []).length, disabled: false };
  return { ok: true, colleges: (colleges || []).concat([created]), college: created };
}

function resolveOrCreateDept_(name, collegeId, departments) {
  const t = String(name || '').trim();
  if (!t) return { ok: false, error: 'deptName required' };
  const found = findByNameExact_(departments, t);
  if (found && found.active === false) return { ok: false, error: 'department disabled: ' + found.name };
  if (found) return { ok: true, departments: departments, dept: found };
  const created = { id: uniqueDeptId_(slugifyDeptId_(t), departments), name: t, headEmail: '', headName: '', collegeId: collegeId || null, active: true };
  return { ok: true, departments: (departments || []).concat([created]), dept: created };
}

function resolveOrCreateSystem_(name, tutorSystems) {
  const t = String(name || '').trim();
  if (!t) return { ok: true, tutorSystems: tutorSystems, system: null };
  const found = findByNameExact_(tutorSystems, t);
  if (found && found.disabled === true) return { ok: false, error: 'tutorSystem disabled: ' + found.name };
  if (found) return { ok: true, tutorSystems: tutorSystems, system: found };
  const created = { id: uniqueDeptId_(slugifyDeptId_(t), tutorSystems), name: t, requiredMeetingCount: null, disabled: false };
  return { ok: true, tutorSystems: (tutorSystems || []).concat([created]), system: created };
}

// 應繳班會份數欄位解析：空白 → null（用制度預設）；'0' → 0（本學期免繳）；其餘轉數字，非數字拒絕。
function parseRequiredMeetingCountField_(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: true, value: null };
  const n = Number(v);
  if (isNaN(n)) return { ok: false, error: 'invalid requiredMeetingCount: ' + v };
  return { ok: true, value: n };
}

function buildImportTutors_(row) {
  const tutors = [];
  if (row.tutor1Name && String(row.tutor1Name).trim()) {
    tutors.push({ name: String(row.tutor1Name).trim(), email: String(row.tutor1Email || '').trim().toLowerCase() });
  }
  if (row.tutor2Name && String(row.tutor2Name).trim()) {
    tutors.push({ name: String(row.tutor2Name).trim(), email: String(row.tutor2Email || '').trim().toLowerCase() });
  }
  return tutors;
}

// 匯入一列（學院/系所/導師制度/班級名稱(原始)/班級顯示名稱/應繳班會份數/導師1/導師2）。
// 班級以 (deptId, classNameRaw) 比對既有（同 classResolveCore_ 語意）；找不到就建立，
// 找到則更新 deptId/systemId/displayName（若本列有給）/requiredMeetingOverride/tutors
// （Excel 視為權威來源，這裡走 admin 匯入，直接寫入 tutors，不經 suggestedTutors 待確認流程）。
function importRosterRow_(row, colleges, departments, tutorSystems, classes, now) {
  if (!isValidClassName_(row && row.classNameRaw)) return { ok: false, error: 'invalid classNameRaw: ' + (row && row.classNameRaw) };
  if (!isValidDeptName_(row && row.deptName)) return { ok: false, error: 'invalid deptName: ' + (row && row.deptName) };

  const collegeRes = resolveOrCreateCollege_(row.collegeName, colleges);
  if (!collegeRes.ok) return collegeRes;
  const deptRes = resolveOrCreateDept_(row.deptName, collegeRes.college ? collegeRes.college.id : null, departments);
  if (!deptRes.ok) return deptRes;
  const systemRes = resolveOrCreateSystem_(row.systemName, tutorSystems);
  if (!systemRes.ok) return systemRes;
  const reqRes = parseRequiredMeetingCountField_(row.requiredMeetingCount);
  if (!reqRes.ok) return reqRes;

  const className = String(row.classNameRaw).trim();
  let cls = (classes || []).filter(function (c) { return c && c.deptId === deptRes.dept.id && c.name === className; })[0];
  if (cls && cls.active === false) return { ok: false, error: 'class disabled: ' + cls.id };

  const tutors = buildImportTutors_(row);
  const explicitDisplayName = row.classDisplayName && String(row.classDisplayName).trim();
  let nextClasses = classes || [];
  let classCreated = false;

  if (!cls) {
    const fused = explicitDisplayName || fuseClassDisplayName_(
      className, deptRes.dept.name, systemRes.system ? systemRes.system.id : null,
      tutors.length ? tutors[0].name : undefined
    );
    cls = {
      id: uniqueClassId_(deptRes.dept.id + '_' + slugifyDeptId_(className), classes),
      name: className, deptId: deptRes.dept.id,
      systemId: systemRes.system ? systemRes.system.id : null,
      displayName: fused,
      requiredMeetingOverride: reqRes.value,
      tutors: tutors, suggestedTutors: [],
      dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    };
    nextClasses = nextClasses.concat([cls]);
    classCreated = true;
  } else {
    const updated = Object.assign({}, cls, {
      deptId: deptRes.dept.id,
      systemId: systemRes.system ? systemRes.system.id : cls.systemId,
      displayName: explicitDisplayName || cls.displayName,
      requiredMeetingOverride: reqRes.value,
      tutors: tutors.length ? tutors : cls.tutors,
    });
    nextClasses = nextClasses.map(function (c) { return c.id === cls.id ? updated : c; });
    cls = updated;
  }

  return {
    ok: true,
    colleges: collegeRes.colleges, departments: deptRes.departments,
    tutorSystems: systemRes.tutorSystems, classes: nextClasses,
    college: collegeRes.college, dept: deptRes.dept, system: systemRes.system,
    cls: cls, classCreated: classCreated,
  };
}

// ── Session 效期計算（供 issueSessionToken_ 使用）────────────────────────────
// 下一個台北（UTC+8，1980 年起無日光節約）午夜 00:00 的 epoch 秒。刻意寫成純算術、
// 不用 Utilities.formatDate，才能被 test/harness.js 抽進 Node vm 單元測試
// （見 test/session-exp.test.js）。
function nextTaipeiMidnightEpochSec_(nowMs) {
  const OFF = 8 * 3600;
  return (Math.floor((Math.floor(nowMs / 1000) + OFF) / 86400) + 1) * 86400 - OFF;
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Action handlers（會呼叫 Drive/LockService，不是純函式，不在單元測試範圍）──
// ══════════════════════════════════════════════════════════════════════════════

// bootstrap：一次回傳 config（去敏感欄位：users 只有 admin 看得到）/departments/classes/
// semesters/當學期 records（依呼叫者角色過濾看得到的 records，用 canViewRecord_）。
// 任何已通過認證的 Google 帳號都可以呼叫（這就是「學生」角色的入口）。
// tutorSystems.json 首次不存在時以 DEFAULT_TUTOR_SYSTEMS_ 建立（雙重檢查鎖，避免併發首跑時
// 兩個請求都判定「不存在」而各寫一次）。readJsonSafe_ 的 fallback 傳 null 以便和「存在但空陣列」區分。
function ensureTutorSystemsSeeded_(ctx) {
  const existing = readJsonSafe_('tutorSystems.json', ctx, null);
  if (existing !== null) return existing;
  return withLock_(function () {
    const again = readJsonSafe_('tutorSystems.json', ctx, null);
    if (again !== null) return again;
    writeJsonPath_('tutorSystems.json', DEFAULT_TUTOR_SYSTEMS_, ctx);
    return DEFAULT_TUTOR_SYSTEMS_;
  });
}

// config.keywordRules 首次不存在時以 DEFAULT_KEYWORD_RULES_ 建立（同樣的雙重檢查鎖模式）。
function ensureKeywordRulesSeeded_(ctx, config) {
  if (config.keywordRules) return config.keywordRules;
  return withLock_(function () {
    const fresh = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    if (fresh.keywordRules) return fresh.keywordRules;
    fresh.keywordRules = DEFAULT_KEYWORD_RULES_;
    writeJsonPath_('config.json', fresh, ctx);
    return fresh.keywordRules;
  });
}

function bootstrapAction_(params, ctx, userEmail) {
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const semesters = readJsonSafe_('semesters.json', ctx, []);
  const colleges = readJsonSafe_('colleges.json', ctx, []);
  const tutorSystems = ensureTutorSystemsSeeded_(ctx);
  const keywordRules = ensureKeywordRulesSeeded_(ctx, config);
  const roles = resolveRoles_(userEmail, config, departments, classes);

  // params.semester 為 client 傳入，必須通過白名單驗證（見 isValidSemesterId_ 註解）；
  // 未指定時用 isCurrent 學期（來自 semesters.json，本來就是受控值）。
  if (params.semester !== undefined && params.semester !== null && !isValidSemesterId_(params.semester, semesters)) {
    throw new Error('invalid semester: ' + params.semester);
  }
  const semesterId = params.semester || currentSemesterId_(semesters);
  const records = semesterId ? readJsonSafe_('records_' + semesterId + '.json', ctx, { records: [] }) : { records: [] };

  const deptById = {};
  departments.forEach(function (d) { deptById[d.id] = d; });
  const classById = {};
  classes.forEach(function (c) { classById[c.id] = c; });

  const visibleRecords = (records.records || []).filter(function (r) {
    return canViewRecord_(r, classById[r.classId], deptById[r.deptId], roles, userEmail);
  });

  return {
    email: userEmail,
    roles: roles,
    departments: departments,
    colleges: colleges,
    tutorSystems: tutorSystems,
    // uploadWhitelist（學生 gmail 清單）只給該班導師/admin 看，其他人只拿到 hasWhitelist 布林。
    classes: sanitizeClassesForViewer_(classes, roles),
    semesters: semesters,
    semester: semesterId,
    // actualBy（助理代主責核章的真實身分）對非學諮端/admin 角色隱藏，見 sanitizeRecordForViewer_。
    records: sanitizeRecordsForViewer_(visibleRecords, roles),
    settings: config.settings || {},
    keywordRules: keywordRules,
    users: roles.isAdmin ? config.users : undefined,
    // staffLeads/staffAssistants 名單含 email 個資，只有 admin 看得到完整清單；其他角色只需要
    // 「自己是不是」，roles 已算好（isStaffLead/isStaffAssistant/assistantLead），不需整份名單。
    staffLeads: roles.isAdmin ? (config.staffLeads || []) : undefined,
    staffAssistants: roles.isAdmin ? (config.staffAssistants || []) : undefined,
  };
}

// sessionStart：以 Google idToken 換發自建 session token（效期至當日台北 24:00）。
// 與 infosys 的關鍵差異：本系統「學生」= 任何已登入 Google 帳號、沒有全域允許清單閘門，
// 因此任何通過 verifyIdToken_ 的帳號都直接簽發；簽發 session ≠ 授權任何操作——授權仍由
// 各 action 內部 resolveRoles_ default-deny 判斷。
// 登入通知信只寄給「有角色」的帳號（admin/director/staffLead/staffAssistant/系主任/導師），
// 一般學生登入不寄（兼顧 MailApp 每日配額與擾民）；寄信失敗不阻斷登入（mailSent:false）。
function sessionStartAction_(params, ctx, userEmail) {
  const issued = issueSessionToken_(userEmail);
  const ua = String(params.ua || '').slice(0, 200);
  const ip = String(params.ip || '').slice(0, 64);
  const geo = String(params.geo || '').slice(0, 120);

  let mailSent = false;
  try {
    // 只做純讀（不觸發 tutorSystems/keywordRules seed 寫入），讀法同 bootstrapAction_。
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = readJsonSafe_('departments.json', ctx, []);
    const classes = readJsonSafe_('classes.json', ctx, []);
    const roles = resolveRoles_(userEmail, config, departments, classes);
    const hasRole = roles.isAdmin || roles.isDirector || roles.isStaffLead ||
      roles.isStaffAssistant || roles.deptHeadOf.length > 0 || roles.tutorOf.length > 0;
    if (hasRole) {
      const timeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
      const lines = [
        '您的帳號剛剛登入導師資訊系統。', '',
        '環境：測試版',
        '時間：' + timeStr + '（台北時間）',
        '瀏覽器：' + (ua || '（未知）'),
      ];
      if (ip) lines.push('IP 位址：' + ip);
      if (geo) lines.push('大致位置：' + geo);
      lines.push('', '本次登入憑證有效至今日 24:00（台北時間），到期後需重新登入。',
        '若非本人操作，請立即聯繫系統管理者停用帳號，並可於系統「登入紀錄」按「登出所有裝置」使所有憑證即時失效。');
      MailApp.sendEmail({
        to: userEmail,
        subject: '【屏科大導師資訊系統】登入通知（測試版）',
        body: lines.join('\n'),
      });
      mailSent = true;
    }
  } catch (e) { /* 寄信失敗不阻斷登入 */ }

  try {
    sessionsAppendRecord_({
      jti: issued.jti, email: userEmail, ua: ua, ip: ip, geo: geo,
      iat: issued.iat, exp: issued.exp, issuedAtMs: Date.now(), issuedAt: new Date().toISOString(),
    }, ctx);
  } catch (e) { /* 登入紀錄寫入失敗不阻斷登入 */ }

  return { sessionToken: issued.token, exp: issued.exp, email: userEmail, mailSent: mailSent };
}

// ── 登入紀錄（sessions.json）：供「登入紀錄」顯示與登入通知（仿 infosys v146）──
// 每筆 { jti, email, ua, ip, geo, iat, exp, issuedAtMs, issuedAt }；
// 寫入時 prune（>45 天丟棄、每人最多留 15 筆），檔案大小有自然上限。
function sessionsAppendRecord_(rec, ctx) {
  if (!ctx) return;
  withLock_(function () {
    const data = readJsonSafe_('sessions.json', ctx, { sessions: [] });
    if (!Array.isArray(data.sessions)) data.sessions = [];
    data.sessions.push(rec);
    const cutoff = Date.now() - 45 * 24 * 3600 * 1000;
    data.sessions = data.sessions.filter(function (s) { return s && s.issuedAtMs && s.issuedAtMs >= cutoff; });
    data.sessions.sort(function (a, b) { return (b.issuedAtMs || 0) - (a.issuedAtMs || 0); });
    const perUser = {};
    data.sessions = data.sessions.filter(function (s) {
      const e = s.email || '';
      perUser[e] = (perUser[e] || 0) + 1;
      return perUser[e] <= 15;
    });
    writeJsonPath_('sessions.json', data, ctx);
  });
}

// sessionLogout：註銷「呼叫者自己」全部裝置的 token。任何已認證帳號都可呼叫，
// 只影響自己的帳號（email 取自已驗證的憑證，不收 params）。
function sessionLogoutAction_(params, ctx, userEmail) {
  sessionRevokeAllDevices_(userEmail);
  appendAuditLog_(ctx, { action: 'sessionLogout', by: userEmail, at: new Date().toISOString() });
  return { ok: true };
}

// listMySessions：只回「呼叫者自己」的登入紀錄（新到舊），每筆標記 expired/revoked/active/current。
// 不提供查他人紀錄的參數——email 一律取自已驗證的憑證。
function listMySessionsAction_(params, ctx, userEmail) {
  const data = readJsonSafe_('sessions.json', ctx, { sessions: [] });
  const rb = sessionRevokedBeforeMap_()[userEmail];
  const nowSec = Math.floor(Date.now() / 1000);
  const curJti = String(params.currentJti || '');
  const mine = (Array.isArray(data.sessions) ? data.sessions : [])
    .filter(function (s) { return s && s.email === userEmail; })
    .sort(function (a, b) { return (b.issuedAtMs || 0) - (a.issuedAtMs || 0); })
    .map(function (s) {
      const expired = Number(s.exp) <= nowSec;
      const revoked = !!(rb && Number(s.iat) < Number(rb));
      return Object.assign({}, s, {
        expired: expired, revoked: revoked,
        active: !expired && !revoked,
        current: !!(curJti && s.jti === curJti),
      });
    });
  return { sessions: mine };
}

// recordSubmit：任何已認證帳號都可呼叫，但該班若設了非空白名單、且此人不是該班導師，
// 必須在白名單內（isUploadAllowed_）才放行。
function recordSubmitAction_(params, ctx, userEmail) {
  const semester = params.semester, classId = params.classId, type = params.type;
  if (!semester || !classId || !type) throw new Error('semester, classId, type required');
  if (type !== 'meeting' && type !== 'activity') throw new Error('invalid type: ' + type);
  requireValidSemester_(semester, ctx);

  const classes = readJsonSafe_('classes.json', ctx, []);
  const classInfo = classes.filter(function (c) { return c.id === classId; })[0];
  if (!classInfo || classInfo.active === false) throw new Error('class not found: ' + classId);
  if (!isUploadAllowed_(classInfo, userEmail)) throw new Error('not authorized to upload for this class (not in whitelist)');

  // 附件歸屬驗證（防禦縱深第一層；第二層在 downloadAttachmentAction_）：
  // client 傳來的每個 attachment.fileId 都必須真的位於本班本學期的 attachments 資料夾內，
  // 否則拒絕整筆——不驗證的話，任意 fileId 之後可經 downloadAttachment 以部署者權限讀出。
  assertAttachmentsBelong_(params.attachments, semester, classId, ctx);

  const isTutor = isClassTutor_(classInfo, userEmail);
  const uploaderInfo = params.uploader || {};
  const uploader = {
    email: userEmail,
    name: uploaderInfo.name || '',
    studentId: uploaderInfo.studentId || '',
    isTutor: isTutor,
  };

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const keywordRules = config.keywordRules || DEFAULT_KEYWORD_RULES_;
  const form = params.form || {};
  // 四類宣導關鍵字自動偵測：只有班會紀錄（meeting）需要 topics；導生活動紀錄不適用。
  const topics = type === 'meeting' ? detectTopics_(form, keywordRules) : null;

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    data.records = data.records || [];
    const now = new Date().toISOString();
    const id = Utilities.getUuid();
    const record = buildNewRecord_({
      id: id, type: type, semester: semester, classId: classId, deptId: classInfo.deptId,
      uploader: uploader, form: form, attachments: params.attachments || [], topics: topics,
    }, classInfo, now);
    data.records.push(record);
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordSubmit', by: userEmail, recordId: id, at: now });
    return { record: record };
  });
}

// recordResubmit：一律「退回導師」——只有該班導師（isClassTutor_）能重送，不限原上傳者
// （canResubmit_ 把關，見其註解）。重送後的表單重新掃描關鍵字，人工鎖定過的 topics（auto:false）
// 不會被自動掃描覆蓋（mergeTopicsOnEdit_）。
function recordResubmitAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const keywordRules = config.keywordRules || DEFAULT_KEYWORD_RULES_;
  const roles = loadRolesForCtx_(ctx, userEmail);

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    const list = data.records || [];
    const idx = list.findIndex(function (r) { return r.id === recordId; });
    if (idx === -1) throw new Error('record not found: ' + recordId);
    const record = list[idx];
    const classInfo = classes.filter(function (c) { return c.id === record.classId; })[0];
    const now = new Date().toISOString();
    const actorName = params.uploaderName || (record.uploader && record.uploader.name) || '';
    const res = recordResubmit_(record, classInfo, userEmail, actorName, params.form, params.attachments, now);
    if (!res.ok) throw new Error(res.error);
    let updated = res.record;
    if (updated.type === 'meeting' && params.form) {
      updated = Object.assign({}, updated, { topics: mergeTopicsOnEdit_(record.topics, updated.form, keywordRules) });
    }
    // 附件歸屬驗證：重送後的整組 attachments（含沿用的與新增的）全部重驗，簡單為上。
    // 用 record 上既有的 semester/classId（存檔值，非 client 傳入值）當基準。
    assertAttachmentsBelong_(updated.attachments, record.semester, record.classId, ctx);
    list[idx] = updated;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordResubmit', by: userEmail, recordId: recordId, at: now });
    return { record: sanitizeRecordForViewer_(updated, roles) };
  });
}

// recordGetMine：回傳呼叫者自己上傳的紀錄；若呼叫者本身是某班導師，另外回傳該班本學期的
// 全部紀錄（含他人上傳）供「導師個人後台」顯示繳交進度/繳交人/目前關卡/退件狀態——
// 只回自己帶的班，不含未授權的其他班（roles.tutorOf 已由 resolveRoles_ 算好）。
function recordGetMineAction_(params, ctx, userEmail) {
  const semester = params.semester;
  if (!semester) throw new Error('semester required');
  requireValidSemester_(semester, ctx);
  const roles = loadRolesForCtx_(ctx, userEmail);
  const data = readJsonSafe_('records_' + semester + '.json', ctx, { records: [] });
  const all = data.records || [];
  const mine = all.filter(function (r) { return r.uploader && r.uploader.email === userEmail; });
  const tutorClassRecords = roles.tutorOf.length
    ? all.filter(function (r) { return roles.tutorOf.indexOf(r.classId) !== -1; })
    : [];
  return {
    records: sanitizeRecordsForViewer_(mine, roles),
    tutorClassRecords: sanitizeRecordsForViewer_(tutorClassRecords, roles),
  };
}

// uploadAttachment：與 recordSubmit 同一套白名單判斷（避免非授權帳號塞檔案進 Drive）。
// 附件實體檔存 attachments/<semester>/<classId>/，資料夾巢狀建立包在 lock 內避免併發重複建立。
function uploadAttachmentAction_(params, ctx, userEmail) {
  const semester = params.semester, classId = params.classId;
  if (!semester || !classId) throw new Error('semester and classId required');
  if (!params.fileName || !params.base64Data) throw new Error('fileName and base64Data required');
  requireValidSemester_(semester, ctx);

  const classes = readJsonSafe_('classes.json', ctx, []);
  const classInfo = classes.filter(function (c) { return c.id === classId; })[0];
  if (!classInfo || classInfo.active === false) throw new Error('class not found: ' + classId);
  if (!isUploadAllowed_(classInfo, userEmail)) throw new Error('not authorized to upload for this class (not in whitelist)');

  return withLock_(function () {
    const folderId = ensureFolderPath_(['attachments', semester, classId], ctx);
    const uploaded = uploadFile_({
      parentFolderId: folderId, fileName: params.fileName,
      mimeType: params.mimeType || 'application/octet-stream', base64Data: params.base64Data,
    });
    appendAuditLog_(ctx, {
      action: 'uploadAttachment', by: userEmail, fileId: uploaded.fileId,
      fileName: uploaded.fileName, semester: semester, classId: classId,
      at: new Date().toISOString(),
    });
    return { fileId: uploaded.fileId, fileName: uploaded.fileName };
  });
}

// downloadAttachment：必須是該筆紀錄實際掛的附件，且呼叫者對該紀錄有可視權（canViewRecord_）。
function downloadAttachmentAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId, fileId = params.fileId;
  if (!semester || !recordId || !fileId) throw new Error('semester, recordId, fileId required');
  requireValidSemester_(semester, ctx);

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);

  const data = readJsonSafe_('records_' + semester + '.json', ctx, { records: [] });
  const record = (data.records || []).filter(function (r) { return r.id === recordId; })[0];
  if (!record) throw new Error('record not found: ' + recordId);
  const hasFile = (record.attachments || []).some(function (a) { return a.fileId === fileId; });
  if (!hasFile) throw new Error('file not part of this record');

  const classInfo = classes.filter(function (c) { return c.id === record.classId; })[0];
  const deptInfo = departments.filter(function (d) { return d.id === record.deptId; })[0];
  if (!canViewRecord_(record, classInfo, deptInfo, roles, userEmail)) throw new Error('not authorized to view this record');

  // 附件歸屬驗證（防禦縱深第二層；第一層在 recordSubmit/recordResubmit 的提交側驗證）：
  // 即使 record.attachments 裡混入了未經驗證的 fileId（歷史資料、或第一層被繞過），
  // 下載前仍再確認該檔案實際位於本班本學期的 attachments 資料夾內，才用部署者權限讀出。
  // 基準用 record 上存檔的 semester/classId，不用 client 傳入值。
  assertAttachmentsBelong_([{ fileId: fileId }], record.semester, record.classId, ctx);

  return downloadFileBase64_({ fileId: fileId });
}

// recordApprove：依 record.status 判斷輪到誰核章（resolveActionableStage_），錯誤角色/
// 錯誤狀態一律拒絕；admin 可代為處理任何一關。選填 params.updatedForm：僅該關的 actionable
// 驗證者可帶，套用白名單過濾後 append editLog，核准照常推進，不重跑已過關卡（recordApprove_）。
// 學諮中心主責關若由已綁定助理動作，approvals 顯示主責姓名、actualBy 記助理真實 email
// （resolveApproverIdentity_）；回傳前依呼叫者角色 sanitize 掉非授權者看不到的 actualBy。
function recordApproveAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);
  const actorName = (config.users && config.users[userEmail] && config.users[userEmail].name) || userEmail;
  const keywordRules = config.keywordRules || DEFAULT_KEYWORD_RULES_;

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    const list = data.records || [];
    const idx = list.findIndex(function (r) { return r.id === recordId; });
    if (idx === -1) throw new Error('record not found: ' + recordId);
    const record = list[idx];
    const classInfo = classes.filter(function (c) { return c.id === record.classId; })[0];
    const deptInfo = departments.filter(function (d) { return d.id === record.deptId; })[0];
    const now = new Date().toISOString();
    const res = recordApprove_(record, classInfo, deptInfo, roles, userEmail, actorName, params.updatedForm, now);
    if (!res.ok) throw new Error(res.error);
    let updated = res.record;
    if (updated.type === 'meeting' && params.updatedForm) {
      updated = Object.assign({}, updated, { topics: mergeTopicsOnEdit_(record.topics, updated.form, keywordRules) });
    }
    list[idx] = updated;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordApprove', by: userEmail, recordId: recordId, stage: res.stage, at: now });
    return { record: sanitizeRecordForViewer_(updated, roles) };
  });
}

// recordReject：同一套 resolveActionableStage_ 判斷「輪到誰」，加上必填理由。一律退回導師
// （applyRejection_ 內狀態統一設 rejected，重送資格由 canResubmit_ 限定該班導師，見其註解）。
// 選填 params.updatedForm 語意同 recordApprove（白名單過濾 + editLog）。
function recordRejectAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId, reason = params.reason;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);
  const actorName = (config.users && config.users[userEmail] && config.users[userEmail].name) || userEmail;
  const keywordRules = config.keywordRules || DEFAULT_KEYWORD_RULES_;

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    const list = data.records || [];
    const idx = list.findIndex(function (r) { return r.id === recordId; });
    if (idx === -1) throw new Error('record not found: ' + recordId);
    const record = list[idx];
    const classInfo = classes.filter(function (c) { return c.id === record.classId; })[0];
    const deptInfo = departments.filter(function (d) { return d.id === record.deptId; })[0];
    const now = new Date().toISOString();
    const res = recordReject_(record, classInfo, deptInfo, roles, userEmail, actorName, reason, params.updatedForm, now);
    if (!res.ok) throw new Error(res.error);
    let updated = res.record;
    if (updated.type === 'meeting' && params.updatedForm) {
      updated = Object.assign({}, updated, { topics: mergeTopicsOnEdit_(record.topics, updated.form, keywordRules) });
    }
    list[idx] = updated;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordReject', by: userEmail, recordId: recordId, reason: reason, stage: res.stage, at: now });
    return { record: sanitizeRecordForViewer_(updated, roles) };
  });
}

// ── 後台管理 action：全部限 admin（BOOTSTRAP_ADMINS 或 config.users role==='admin'）──

function requireAdmin_(roles) {
  if (!roles || !roles.isAdmin) throw new Error('admin only');
}

function loadRolesForCtx_(ctx, userEmail) {
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  return resolveRoles_(userEmail, config, departments, classes);
}

function adminUpsertDepartmentAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.department;
  if (!entry || !entry.id) throw new Error('department.id required');

  return withLock_(function () {
    const data = readJsonSafe_('departments.json', ctx, []);
    const idx = data.findIndex(function (d) { return d.id === entry.id; });
    if (idx === -1) data.push(entry); else data[idx] = Object.assign({}, data[idx], entry);
    writeJsonPath_('departments.json', data, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertDepartment', by: userEmail, targetId: entry.id, at: new Date().toISOString() });
    return { departments: data };
  });
}

function adminUpsertClassAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.class;
  if (!entry || !entry.id) throw new Error('class.id required');

  return withLock_(function () {
    const data = readJsonSafe_('classes.json', ctx, []);
    const idx = data.findIndex(function (c) { return c.id === entry.id; });
    if (idx === -1) data.push(entry); else data[idx] = Object.assign({}, data[idx], entry);
    writeJsonPath_('classes.json', data, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertClass', by: userEmail, targetId: entry.id, at: new Date().toISOString() });
    return { classes: data };
  });
}

function adminUpsertUserAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const targetEmail = params.email;
  const entry = params.user;
  if (!targetEmail || !entry) throw new Error('email and user required');

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.users = config.users || {};
    config.users[targetEmail] = Object.assign({}, config.users[targetEmail], entry);
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertUser', by: userEmail, targetId: targetEmail, at: new Date().toISOString() });
    return { users: config.users };
  });
}

function adminUpsertSemesterAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.semester;
  if (!entry || !entry.id) throw new Error('semester.id required');

  return withLock_(function () {
    const data = readJsonSafe_('semesters.json', ctx, []);
    // isCurrent 唯一性：若這筆設為 isCurrent，其餘全部設回 false。
    if (entry.isCurrent) {
      data.forEach(function (s) { s.isCurrent = false; });
    }
    const idx = data.findIndex(function (s) { return s.id === entry.id; });
    if (idx === -1) data.push(entry); else data[idx] = Object.assign({}, data[idx], entry);
    writeJsonPath_('semesters.json', data, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertSemester', by: userEmail, targetId: entry.id, at: new Date().toISOString() });
    return { semesters: data };
  });
}

// adminImportRoster v2：前端把 Excel 每列解析成 params.rows（學院/系所/導師制度/班級名稱(原始)/
// 班級顯示名稱/應繳班會份數/導師1姓名/導師1email/導師2姓名/導師2email），admin only。
// 學院/系所/導師制度以名稱比對，不存在就建立；停用的一律 fail-closed 拒絕（importRosterRow_）。
// 逐列處理、單列失敗不中斷整批（errors 陣列回報是哪一列/為什麼），成功的列一次寫檔。
function adminImportRosterAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const rows = params.rows || [];
  if (!rows.length) throw new Error('rows required');
  // 先在鎖外確保 tutorSystems.json 已播種（ensureTutorSystemsSeeded_ 首跑時自己會拿鎖；
  // withLock_ 的 LockService 鎖不可重入，放進臨界區內會巢狀取鎖卡死）。
  ensureTutorSystemsSeeded_(ctx);

  return withLock_(function () {
    const now = new Date().toISOString();
    let colleges = readJsonSafe_('colleges.json', ctx, []);
    let departments = readJsonSafe_('departments.json', ctx, []);
    let tutorSystems = readJsonSafe_('tutorSystems.json', ctx, []);
    let classes = readJsonSafe_('classes.json', ctx, []);
    let successCount = 0;
    const errors = [];

    rows.forEach(function (row, i) {
      const res = importRosterRow_(row, colleges, departments, tutorSystems, classes, now);
      if (!res.ok) { errors.push({ row: i, error: res.error }); return; }
      colleges = res.colleges; departments = res.departments; tutorSystems = res.tutorSystems; classes = res.classes;
      successCount++;
    });

    writeJsonPath_('colleges.json', colleges, ctx);
    writeJsonPath_('departments.json', departments, ctx);
    writeJsonPath_('tutorSystems.json', tutorSystems, ctx);
    writeJsonPath_('classes.json', classes, ctx);
    appendAuditLog_(ctx, {
      action: 'adminImportRoster', by: userEmail,
      count: successCount, errorCount: errors.length, at: now,
    });
    return {
      colleges: colleges, departments: departments, tutorSystems: tutorSystems, classes: classes,
      successCount: successCount, errors: errors,
    };
  });
}

// adminUpsertCollege：admin only，upsert-by-id（比照 adminUpsertDepartment 寫法）。
function adminUpsertCollegeAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.college;
  if (!entry || !entry.id) throw new Error('college.id required');

  return withLock_(function () {
    const data = readJsonSafe_('colleges.json', ctx, []);
    const idx = data.findIndex(function (c) { return c.id === entry.id; });
    if (idx === -1) data.push(entry); else data[idx] = Object.assign({}, data[idx], entry);
    writeJsonPath_('colleges.json', data, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertCollege', by: userEmail, targetId: entry.id, at: new Date().toISOString() });
    return { colleges: data };
  });
}

// adminUpsertTutorSystem：admin only，upsert-by-id。
function adminUpsertTutorSystemAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.tutorSystem;
  if (!entry || !entry.id) throw new Error('tutorSystem.id required');
  // 鎖外先播種，理由同 adminImportRosterAction_（withLock_ 不可重入）。
  ensureTutorSystemsSeeded_(ctx);

  return withLock_(function () {
    const data = readJsonSafe_('tutorSystems.json', ctx, []);
    const idx = data.findIndex(function (s) { return s.id === entry.id; });
    const next = idx === -1 ? data.concat([entry]) : data.map(function (s, i) { return i === idx ? Object.assign({}, s, entry) : s; });
    writeJsonPath_('tutorSystems.json', next, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertTutorSystem', by: userEmail, targetId: entry.id, at: new Date().toISOString() });
    return { tutorSystems: next };
  });
}

// adminUpsertStaffLead / adminUpsertStaffAssistant：admin only，upsert-by-email，存進
// config.staffLeads / config.staffAssistants（比照現有職員帳號管理模式，見 adminUpsertUserAction_）。
// staffAssistant.leadEmail 綁定的主責若不存在或已停用，resolveRoles_ 會 fail-closed 判該助理
// 的 assistantLead 為 null（無法代為核章），故此處不額外擋——沿用既有 admin 信任邊界。
function adminUpsertStaffLeadAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.staffLead;
  if (!entry || !entry.email) throw new Error('staffLead.email required');

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.staffLeads = config.staffLeads || [];
    const idx = config.staffLeads.findIndex(function (s) { return s && s.email === entry.email; });
    if (idx === -1) config.staffLeads.push(entry); else config.staffLeads[idx] = Object.assign({}, config.staffLeads[idx], entry);
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertStaffLead', by: userEmail, targetId: entry.email, at: new Date().toISOString() });
    return { staffLeads: config.staffLeads };
  });
}

function adminUpsertStaffAssistantAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.staffAssistant;
  if (!entry || !entry.email) throw new Error('staffAssistant.email required');

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.staffAssistants = config.staffAssistants || [];
    const idx = config.staffAssistants.findIndex(function (s) { return s && s.email === entry.email; });
    if (idx === -1) config.staffAssistants.push(entry); else config.staffAssistants[idx] = Object.assign({}, config.staffAssistants[idx], entry);
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: 'adminUpsertStaffAssistant', by: userEmail, targetId: entry.email, at: new Date().toISOString() });
    return { staffAssistants: config.staffAssistants };
  });
}

// recordSetTopics：四類宣導勾選的手動調整，只有 staffLead 關的驗證者（主責/已綁定助理）與
// director/admin 能動（canSetTopics_）；只適用班會紀錄（meeting）。調整後該項目 auto 變 false，
// 之後的關鍵字自動掃描（提交/重送/編輯）不會再覆蓋（mergeTopicsOnEdit_）。
function recordSetTopicsAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId, topics = params.topics;
  if (!semester || !recordId || !topics) throw new Error('semester, recordId, topics required');
  requireValidSemester_(semester, ctx);
  const roles = loadRolesForCtx_(ctx, userEmail);
  if (!canSetTopics_(roles)) throw new Error('only staffLead/staffAssistant/director/admin may adjust topics');

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    const list = data.records || [];
    const idx = list.findIndex(function (r) { return r.id === recordId; });
    if (idx === -1) throw new Error('record not found: ' + recordId);
    const record = list[idx];
    if (record.type !== 'meeting') throw new Error('topics only apply to meeting records');
    if (!record.topics) throw new Error('record has no topics to adjust');
    const now = new Date().toISOString();
    // 助理（非主責本人）調整 topics 時，對外顯示身分掛綁定主責，真實身分進 actualBy——
    // 與核章的 resolveApproverIdentity_ 同一套遮罩原則。
    const identity = resolveApproverIdentity_('staffLead', roles, userEmail, userEmail);
    const updated = applySetTopics_(record, topics, identity.email, identity.actualBy, now);
    list[idx] = updated;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordSetTopics', by: userEmail, recordId: recordId, at: now });
    return { record: sanitizeRecordForViewer_(updated, roles) };
  });
}

// adminSetKeywordRules：四類宣導關鍵字庫調整，權限為 admin 與 staffLead（本身，不含助理——
// 助理只在核章當下代主責動作，不代表可以改動全校共用的關鍵字庫設定）。四類 key 固定
// （traffic/gender/smoking/fraud），只允許更新既有 key 的 label/keywords，不接受新增/刪除 key。
function adminSetKeywordRulesAction_(params, ctx, userEmail) {
  const roles = loadRolesForCtx_(ctx, userEmail);
  if (!roles.isAdmin && !roles.isStaffLead) throw new Error('only admin or staffLead may adjust keyword rules');
  const patch = params.keywordRules;
  if (!patch || typeof patch !== 'object') throw new Error('keywordRules required');

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const current = config.keywordRules || DEFAULT_KEYWORD_RULES_;
    const next = {};
    Object.keys(current).forEach(function (key) {
      const p = patch[key];
      const keywords = (p && Array.isArray(p.keywords)) ? p.keywords.filter(function (k) { return typeof k === 'string' && k.trim(); }).map(function (k) { return k.trim(); }) : current[key].keywords;
      const label = (p && typeof p.label === 'string' && p.label.trim()) ? p.label.trim() : current[key].label;
      next[key] = { label: label, keywords: keywords };
    });
    config.keywordRules = next;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: 'adminSetKeywordRules', by: userEmail, at: new Date().toISOString() });
    return { keywordRules: next };
  });
}

// overviewStats：全校彙總總表。staffLead/staffAssistant/director/admin 看全校；deptHead 限本系
// （用 classId 先過濾，避免同名系所字串比對的脆弱性）；其餘一律拒絕。只回彙總與日期，不含紀錄內文
// （見 overviewStats_ 純函式）。
function overviewStatsAction_(params, ctx, userEmail) {
  const semester = params.semester;
  if (!semester) throw new Error('semester required');
  requireValidSemester_(semester, ctx);
  const roles = loadRolesForCtx_(ctx, userEmail);
  const fullAccess = roles.isAdmin || roles.isDirector || roles.isStaffLead || roles.isStaffAssistant;
  if (!fullAccess && !(roles.deptHeadOf && roles.deptHeadOf.length)) {
    throw new Error('not authorized to view overview stats');
  }

  const colleges = readJsonSafe_('colleges.json', ctx, []);
  const departments = readJsonSafe_('departments.json', ctx, []);
  let classes = readJsonSafe_('classes.json', ctx, []);
  if (!fullAccess) {
    classes = classes.filter(function (c) { return c && roles.deptHeadOf.indexOf(c.deptId) !== -1; });
  }
  const tutorSystems = ensureTutorSystemsSeeded_(ctx);
  const data = readJsonSafe_('records_' + semester + '.json', ctx, { records: [] });
  return { rows: overviewStats_(colleges, departments, classes, tutorSystems, data.records, null) };
}

// classSetWhitelist：本班導師或 admin 才能設定。
function classSetWhitelistAction_(params, ctx, userEmail) {
  const classId = params.classId;
  const uploadWhitelist = params.uploadWhitelist || [];
  if (!classId) throw new Error('classId required');

  const roles = loadRolesForCtx_(ctx, userEmail);
  const isTutor = roles.tutorOf.indexOf(classId) !== -1;
  if (!isTutor && !roles.isAdmin) throw new Error('only tutors of this class (or admin) may set the whitelist');

  return withLock_(function () {
    const data = readJsonSafe_('classes.json', ctx, []);
    const idx = data.findIndex(function (c) { return c.id === classId; });
    if (idx === -1) throw new Error('class not found: ' + classId);
    data[idx] = Object.assign({}, data[idx], { uploadWhitelist: uploadWhitelist });
    writeJsonPath_('classes.json', data, ctx);
    appendAuditLog_(ctx, { action: 'classSetWhitelist', by: userEmail, targetId: classId, at: new Date().toISOString() });
    // 與 bootstrap 同一套過濾：導師只看得到自己班的 uploadWhitelist，不外洩其他班的名單。
    return { classes: sanitizeClassesForViewer_(data, roles) };
  });
}

// classResolve：任何已認證帳號可呼叫（自填系所/班級/建議導師正是為了免預建名單），
// 但輸入驗證在 classResolveCore_ 內卡死（className/deptName/suggestedTutors 白名單）。
// find-or-create 的 read-modify-write 全程包在 withLock_ 內，避免併發重複建立。
// 學生自填導師只進 suggestedTutors（待管理員轉正），絕不寫入 tutors（核章授權來源）。
function classResolveAction_(params, ctx, userEmail) {
  const roles = loadRolesForCtx_(ctx, userEmail);

  return withLock_(function () {
    const departments = readJsonSafe_('departments.json', ctx, []);
    const classes = readJsonSafe_('classes.json', ctx, []);
    const now = new Date().toISOString();
    const res = classResolveCore_(params, departments, classes, userEmail, now);
    if (!res.ok) throw new Error(res.error);

    if (res.newDept) {
      departments.push(res.newDept);
      writeJsonPath_('departments.json', departments, ctx);
      appendAuditLog_(ctx, { action: 'deptAutoCreate', by: userEmail, targetId: res.newDept.id, name: res.newDept.name, at: now });
    }
    let classesChanged = false;
    if (res.classCreated) {
      classes.push(res.cls);
      classesChanged = true;
      appendAuditLog_(ctx, { action: 'classAutoCreate', by: userEmail, targetId: res.cls.id, at: now });
    } else if (res.suggestionsAdded > 0) {
      const idx = classes.findIndex(function (c) { return c && c.id === res.cls.id; });
      if (idx !== -1) classes[idx] = res.cls;
      classesChanged = true;
    }
    if (res.suggestionsAdded > 0) {
      appendAuditLog_(ctx, { action: 'tutorSuggest', by: userEmail, targetId: res.cls.id, count: res.suggestionsAdded, at: now });
    }
    if (classesChanged) writeJsonPath_('classes.json', classes, ctx);

    return {
      deptId: res.dept.id,
      classId: res.cls.id,
      departments: departments,
      classes: sanitizeClassesForViewer_(classes, roles),
      suggestionsDropped: res.suggestionsDropped || 0,
    };
  });
}

// classStats：任何已認證帳號可呼叫（上傳頁選定班級後顯示繳交統計提示用）。
// 只回彙總數字（computeClassStats_），絕不回紀錄內容；純讀取，不需 lock。
function classStatsAction_(params, ctx, userEmail) {
  const semester = params.semester, classId = params.classId;
  if (!semester || !classId) throw new Error('semester and classId required');
  requireValidSemester_(semester, ctx);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const exists = classes.some(function (c) { return c && c.id === classId; });
  if (!exists) throw new Error('class not found: ' + classId);
  const data = readJsonSafe_('records_' + semester + '.json', ctx, { records: [] });
  return computeClassStats_(data.records, classId);
}
