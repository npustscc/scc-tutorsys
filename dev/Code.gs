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

// ── 進入點 ────────────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    const payload = JSON.parse(e.parameter.payload);
    const idToken = payload.idToken;
    const action = payload.action;
    const rootFolderId = payload.rootFolderId;
    const params = {};
    Object.keys(payload).forEach(function (k) {
      if (k !== 'idToken' && k !== 'action' && k !== 'rootFolderId') params[k] = payload[k];
    });

    // 認證（所有 action 都要過，含 ping）——這一層只確認「這是誰」，不代表這個人
    // 有權限做這件事；授權判斷在每個 action 內部依角色/紀錄狀態進行（見檔頭註解）。
    const userEmail = verifyIdToken_(idToken);
    if (!userEmail) return jsonResp_({ error: 'Unauthorized' });

    let ctx = { root: ROOT_FOLDER_ID };
    if (rootFolderId) {
      if (!ALLOWED_ROOTS[rootFolderId]) return jsonResp_({ error: 'Unauthorized rootFolderId' });
      ctx = { root: rootFolderId };
    }

    let result;
    switch (action) {
      case 'ping':                  result = { ok: true, email: userEmail }; break;
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
function resolveRoles_(email, config, departments, classes) {
  const roles = { email: email, isAdmin: false, isDirector: false, deptHeadOf: [], tutorOf: [] };
  if (!email) return roles;

  if (typeof BOOTSTRAP_ADMINS !== 'undefined' && BOOTSTRAP_ADMINS.indexOf(email) !== -1) {
    roles.isAdmin = true;
  }

  const u = config && config.users && config.users[email];
  if (u && u.disabled !== true) {
    if (u.role === 'admin') roles.isAdmin = true;
    if (u.role === 'director') roles.isDirector = true;
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
  if (roles.isAdmin || roles.isDirector) return true;
  if (record.uploader && record.uploader.email === viewerEmail) return true;
  if (classInfo && (roles.tutorOf || []).indexOf(classInfo.id) !== -1) return true;
  if (deptInfo && (roles.deptHeadOf || []).indexOf(deptInfo.id) !== -1) return true;
  return false;
}

// 找出「目前這個 pending 狀態，輪到誰核章／退件」，並判斷 actor 是否有資格動作。
// admin 視為全關卡的 override（後台管理員可代為處理任何一關，例如職員請假時代核）。
// 回傳 { ok:true, stage:'tutor'|'dept'|'director' } 或 { ok:false, reason }。
function resolveActionableStage_(record, classInfo, deptInfo, roles) {
  if (!record) return { ok: false, reason: 'record not found' };

  if (roles && roles.isAdmin) {
    if (record.status === 'pending_tutor') return { ok: true, stage: 'tutor' };
    if (record.status === 'pending_dept') return { ok: true, stage: 'dept' };
    if (record.status === 'pending_director') return { ok: true, stage: 'director' };
    return { ok: false, reason: 'record not pending (status=' + record.status + ')' };
  }

  if (record.status === 'pending_tutor') {
    const isTutor = classInfo && (roles.tutorOf || []).indexOf(classInfo.id) !== -1;
    return isTutor ? { ok: true, stage: 'tutor' } : { ok: false, reason: 'not a tutor of this class' };
  }
  if (record.status === 'pending_dept') {
    const isHead = deptInfo && (roles.deptHeadOf || []).indexOf(deptInfo.id) !== -1;
    return isHead ? { ok: true, stage: 'dept' } : { ok: false, reason: 'not the department head' };
  }
  if (record.status === 'pending_director') {
    return roles.isDirector ? { ok: true, stage: 'director' } : { ok: false, reason: 'not the director' };
  }
  return { ok: false, reason: 'record not pending (status=' + record.status + ')' };
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
    status: 'pending_tutor',
    approvals: { tutor: [], dept: null, director: null },
    rejection: null,
    history: [{ action: 'submit', by: input.uploader.email, at: now, note: null }],
    createdAt: now,
    updatedAt: now,
  };
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
    status: 'pending_director',
    history: record.history.concat([{ action: 'dept_approve', by: deptHeadEmail, at: now, note: null }]),
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

// 授權判斷 + 狀態推進的整合入口（供 recordApproveAction_ 呼叫）。
// resolveActionableStage_ 判斷「這個人現在能不能核這一關」，通過才呼叫對應的 advanceOnXApproval_。
function recordApprove_(record, classInfo, deptInfo, roles, actorEmail, actorName, now) {
  const chk = resolveActionableStage_(record, classInfo, deptInfo, roles);
  if (!chk.ok) return { ok: false, error: chk.reason };
  let updated;
  if (chk.stage === 'tutor') updated = advanceOnTutorApproval_(record, classInfo, actorEmail, actorName, now);
  else if (chk.stage === 'dept') updated = advanceOnDeptApproval_(record, actorEmail, actorName, now);
  else updated = advanceOnDirectorApproval_(record, actorEmail, actorName, now);
  return { ok: true, record: updated, stage: chk.stage };
}

// 退件：三關都可退（用同一套 resolveActionableStage_ 判斷「現在輪到誰」），必須填理由。
function applyRejection_(record, byEmail, role, reason, now) {
  return Object.assign({}, record, {
    status: 'rejected',
    rejection: { by: byEmail, role: role, reason: reason, at: now },
    history: record.history.concat([{ action: 'reject', by: byEmail, at: now, note: reason }]),
    updatedAt: now,
  });
}

function recordReject_(record, classInfo, deptInfo, roles, actorEmail, reason, now) {
  const chk = resolveActionableStage_(record, classInfo, deptInfo, roles);
  if (!chk.ok) return { ok: false, error: chk.reason };
  if (!reason || !String(reason).trim()) return { ok: false, error: 'reason required' };
  const updated = applyRejection_(record, actorEmail, chk.stage, reason, now);
  return { ok: true, record: updated, stage: chk.stage };
}

// 退件重送：只有原上傳者本人、且紀錄目前是 rejected 狀態，才能重送。
function canResubmit_(record, actorEmail) {
  if (!record) return { ok: false, error: 'record not found' };
  if (record.status !== 'rejected') return { ok: false, error: 'record not rejected' };
  if (!record.uploader || record.uploader.email !== actorEmail) return { ok: false, error: 'not the original uploader' };
  return { ok: true };
}

// 重送後狀態回 pending_tutor、approvals 清空、rejection 清空，history 保留累加（不清空）。
// 「重跑」：若重送者本人是該班導師，立刻視同已完成導師核章該關（與初次上傳同一套邏輯），
// 單導師/雙導師 any 直接進 pending_dept，雙導師 all 則停在 pending_tutor 等另一位導師。
function applyResubmit_(record, updatedForm, updatedAttachments, byEmail, now) {
  return Object.assign({}, record, {
    status: 'pending_tutor',
    approvals: { tutor: [], dept: null, director: null },
    rejection: null,
    form: updatedForm || record.form,
    attachments: updatedAttachments || record.attachments,
    history: record.history.concat([{ action: 'resubmit', by: byEmail, at: now, note: null }]),
    updatedAt: now,
  });
}

function recordResubmit_(record, classInfo, actorEmail, actorName, updatedForm, updatedAttachments, now) {
  const chk = canResubmit_(record, actorEmail);
  if (!chk.ok) return chk;
  let next = applyResubmit_(record, updatedForm, updatedAttachments, actorEmail, now);
  if (isClassTutor_(classInfo, actorEmail)) {
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

// ══════════════════════════════════════════════════════════════════════════════
// ── Action handlers（會呼叫 Drive/LockService，不是純函式，不在單元測試範圍）──
// ══════════════════════════════════════════════════════════════════════════════

// bootstrap：一次回傳 config（去敏感欄位：users 只有 admin 看得到）/departments/classes/
// semesters/當學期 records（依呼叫者角色過濾看得到的 records，用 canViewRecord_）。
// 任何已通過認證的 Google 帳號都可以呼叫（這就是「學生」角色的入口）。
function bootstrapAction_(params, ctx, userEmail) {
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const semesters = readJsonSafe_('semesters.json', ctx, []);
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
    // uploadWhitelist（學生 gmail 清單）只給該班導師/admin 看，其他人只拿到 hasWhitelist 布林。
    classes: sanitizeClassesForViewer_(classes, roles),
    semesters: semesters,
    semester: semesterId,
    records: visibleRecords,
    settings: config.settings || {},
    users: roles.isAdmin ? config.users : undefined,
  };
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

  return withLock_(function () {
    const path = 'records_' + semester + '.json';
    const data = readJsonSafe_(path, ctx, { records: [] });
    data.records = data.records || [];
    const now = new Date().toISOString();
    const id = Utilities.getUuid();
    const record = buildNewRecord_({
      id: id, type: type, semester: semester, classId: classId, deptId: classInfo.deptId,
      uploader: uploader, form: params.form || {}, attachments: params.attachments || [],
    }, classInfo, now);
    data.records.push(record);
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordSubmit', by: userEmail, recordId: id, at: now });
    return { record: record };
  });
}

// recordResubmit：只有原上傳者、且該筆目前是 rejected 狀態才可呼叫（canResubmit_ 把關）。
function recordResubmitAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);
  const classes = readJsonSafe_('classes.json', ctx, []);

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
    // 附件歸屬驗證：重送後的整組 attachments（含沿用的與新增的）全部重驗，簡單為上。
    // 用 record 上既有的 semester/classId（存檔值，非 client 傳入值）當基準。
    assertAttachmentsBelong_(res.record.attachments, record.semester, record.classId, ctx);
    list[idx] = res.record;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordResubmit', by: userEmail, recordId: recordId, at: now });
    return { record: res.record };
  });
}

// recordGetMine：只回傳呼叫者自己上傳的紀錄，不需額外角色判斷（本來就只查自己）。
function recordGetMineAction_(params, ctx, userEmail) {
  const semester = params.semester;
  if (!semester) throw new Error('semester required');
  requireValidSemester_(semester, ctx);
  const data = readJsonSafe_('records_' + semester + '.json', ctx, { records: [] });
  const mine = (data.records || []).filter(function (r) { return r.uploader && r.uploader.email === userEmail; });
  return { records: mine };
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
// 錯誤狀態一律拒絕；admin 可代為處理任何一關。
function recordApproveAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);
  const actorName = (config.users && config.users[userEmail] && config.users[userEmail].name) || userEmail;

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
    const res = recordApprove_(record, classInfo, deptInfo, roles, userEmail, actorName, now);
    if (!res.ok) throw new Error(res.error);
    list[idx] = res.record;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordApprove', by: userEmail, recordId: recordId, stage: res.stage, at: now });
    return { record: res.record };
  });
}

// recordReject：同一套 resolveActionableStage_ 判斷「輪到誰」，加上必填理由。
function recordRejectAction_(params, ctx, userEmail) {
  const semester = params.semester, recordId = params.recordId, reason = params.reason;
  if (!semester || !recordId) throw new Error('semester and recordId required');
  requireValidSemester_(semester, ctx);

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);

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
    const res = recordReject_(record, classInfo, deptInfo, roles, userEmail, reason, now);
    if (!res.ok) throw new Error(res.error);
    list[idx] = res.record;
    data.records = list;
    writeJsonPath_(path, data, ctx);
    appendAuditLog_(ctx, { action: 'recordReject', by: userEmail, recordId: recordId, reason: reason, stage: res.stage, at: now });
    return { record: res.record };
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

// adminImportRoster：前端把 Excel 解析成 JSON diff（departmentUpserts / classUpserts）後
// 呼叫本 action 套用，admin only。
function adminImportRosterAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const classUpserts = params.classUpserts || [];
  const departmentUpserts = params.departmentUpserts || [];

  return withLock_(function () {
    const now = new Date().toISOString();
    let depts = readJsonSafe_('departments.json', ctx, []);
    if (departmentUpserts.length) {
      departmentUpserts.forEach(function (entry) {
        if (!entry || !entry.id) return;
        const idx = depts.findIndex(function (d) { return d.id === entry.id; });
        if (idx === -1) depts.push(entry); else depts[idx] = Object.assign({}, depts[idx], entry);
      });
      writeJsonPath_('departments.json', depts, ctx);
    }
    const classesData = readJsonSafe_('classes.json', ctx, []);
    if (classUpserts.length) {
      classUpserts.forEach(function (entry) {
        if (!entry || !entry.id) return;
        const idx = classesData.findIndex(function (c) { return c.id === entry.id; });
        if (idx === -1) classesData.push(entry); else classesData[idx] = Object.assign({}, classesData[idx], entry);
      });
      writeJsonPath_('classes.json', classesData, ctx);
    }
    appendAuditLog_(ctx, {
      action: 'adminImportRoster', by: userEmail,
      count: classUpserts.length + departmentUpserts.length, at: now,
    });
    return { departments: depts, classes: classesData };
  });
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
