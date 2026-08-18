// Code.gs — 導師資訊系統 SCC Drive Proxy（正式版）
// 執行身份：Me（USER_DEPLOYING）；存取：任何擁有 Google 帳戶（ANYONE_ANONYMOUS）
// ⚠️ 此為正式版專用 GAS，只能存取正式版資料夾，不可存取 dev 資料。
//
// 架構比照 scc-infosys 的 Code.gs：doPost dispatcher + verifyIdToken_ + Drive REST API
// 讀寫 JSON + LockService read-modify-write。與 infosys 的關鍵差異：
//   - infosys 是「通用 Drive JSON 讀寫代理」（readJson/updateJson/query 等泛用 action，
//     授權靠單一 isAuthorizedUser_ 允許清單閘）。
//   - 本系統的「學生」角色 = 任何登入的 Google 帳號（免預建名單），沒有預建名單可比對，
//     因此改成「具名業務 action」（recordSubmit / recordApprove / ...），每個 action 內部
//     依動態角色解析（resolveRoles_）與紀錄狀態做 default-deny 授權判斷。
//     **2026-08-17 起另外多了一道全域登入閘門**（checkSystemAccess_，見 doPost）：先依角色
//     決定「這個人現在准不准進系統」，通過之後才輪到各 action 自己的授權判斷。兩層是獨立的，
//     閘門放行不代表有權做任何事；閘門的允許集合存在設定檔，不是硬編碼名單。
//   - 所有寫入 action 一律包在 withLock_（LockService.getScriptLock）內做 read-modify-write，
//     並在同一個臨界區內 append audit_log.json（比照 infosys casesUpsert_ 的 RMW 模式，
//     但這裡通用化成每個寫入 action 都套用，而不是只有單一函式）。

const CLIENT_ID      = '68582831293-fecbka17adht886tm6oh18vrdsdg1hbj.apps.googleusercontent.com';
const ROOT_FOLDER_ID = '1ZwVwWEQ6bUWgS_5WpKP3NF0DTlSca7Ik';  // 正式版 Drive 根資料夾

// 白名單：只允許正式版資料夾（前端可傳 rootFolderId 指定要打哪個環境的資料夾，
// 但後端只承認自己環境的白名單，其餘一律 Unauthorized rootFolderId）。
const ALLOWED_ROOTS = {};
ALLOWED_ROOTS[ROOT_FOLDER_ID] = { label: 'prod' };

// 緊急備援名單：即使 config.json 讀不到或帳號不在名單，這些帳號仍可視為 admin 登入以修復系統。
// 註：列出 email 不構成後門——仍須持有該帳號的 Google 憑證（有效 ID token）才通過，
// 攻擊者知道 email 也無法冒充。
// linkinlol528101@gmail.com＝系統維護者（2026-08-17 加）。放這裡而不是各環境的 config.users
// 是刻意的：①一次涵蓋四個環境（含 GAS 正式版，那邊沒有可寫 config 的憑證）
// ②全域登入閘門上線後，維護者不會因為「config 裡沒有自己的角色」被鎖在外面
// ③設定檔壞掉時仍進得去，這正是這份名單的用途。
// 代價：這是**硬編碼**的 admin，後台停用不了，要收回得改這一行並重新部署兩軌。
// 想改成可從後台停用的形式，就從這裡移除、改在各環境 config.users 設 role:'admin'。
const BOOTSTRAP_ADMINS = ['npust.scc@heartnpust.tw', 'linkinlol528101@gmail.com'];

// ── 全域登入閘門（2026-08-17 使用者決策：關閉一般入口）─────────────────────────
// 本系統原本刻意**沒有**全域允許清單（見檔頭：學生＝任何登入的 Google 帳號），授權全散在
// 各 action 內。2026-08-17 起改成「先關門，再依角色放行」：只有學諮中心人員與各系系辦助理
// 進得來，導師/系主任/學生一律擋在門外。
//
// 為什麼是 doPost 裡的單一位置，而不是逐個 action 加條件：本系統的 default-deny 是
// 「每個 action 各自判斷」，逐點補條件必定漏掉日後新增的 action——這與 resolveRoles_ 裡
// 「主責 ⇒ isAdmin 寫成單一條規則」的理由完全相同。
//
// 允許集合是**資料驅動**的（config.settings.accessAllowRoles），要開系主任入口只要在設定
// 加上 'deptHead'，不必改這份程式碼、不必重新部署（使用者 2026-08-17：「另外保留系主任的
// 登入入口，之後再做」）。可用的角色鍵見 checkSystemAccess_ 的 has 表。
const DEFAULT_ACCESS_ALLOW_ROLES_ = ['admin', 'staffAssistant', 'deptAssistant', 'safetyOfficer'];
const DEFAULT_ACCESS_DENIED_MESSAGE_ =
  '系統目前僅開放學諮中心人員與各系系辦助理使用。若您是導師或系主任，請洽學生諮商中心。';

// 導師制度預設種子（bootstrap 時若 tutorSystems.json 不存在則以此建立；admin 可事後修改/停用）。
// durationYears = 修業年限（年級升級/畢業判斷用，Ticket D）。注意：種子只在檔案不存在時
// 生效，既有部署的 tutorSystems.json 不會自動補值——解析端（resolveDuration_）必須容忍
// durationYears 缺值（fallback 鏈：班級覆寫 → 制度 → prefix 內建預設 → null）。
const DEFAULT_TUTOR_SYSTEMS_ = [
  { id: 'day_college',      name: '大學日間部', requiredMeetingCount: 4, durationYears: 4,    disabled: false },
  { id: 'evening_college',  name: '大學進修部', requiredMeetingCount: 4, durationYears: 4,    disabled: false },
  { id: 'master',           name: '碩士',       requiredMeetingCount: 4, durationYears: 2,    disabled: false },
  { id: 'master_inservice', name: '碩專',       requiredMeetingCount: 4, durationYears: 2,    disabled: false },
  { id: 'doctor',           name: '博士',       requiredMeetingCount: 4, durationYears: 4,    disabled: false },
  { id: 'family',           name: '家族',       requiredMeetingCount: 2, durationYears: null, disabled: false },
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
    // ctx（Drive 根資料夾）先解析：免認證的 localLogin 也需要它，而白名單比對本身
    // 不依賴使用者身分。帶不在白名單的 rootFolderId 一律拒絕（跨環境 fail-closed）。
    let ctx = { root: ROOT_FOLDER_ID };
    if (rootFolderId) {
      if (!ALLOWED_ROOTS[rootFolderId]) return jsonResp_({ error: 'Unauthorized rootFolderId' });
      ctx = { root: rootFolderId };
    }

    // **本 dispatcher 唯一免認證的兩個 action**：帳密登入與帳密改密碼——它們自己就是認證
    // （驗完帳密才簽發／才改），要求先有憑證等於雞生蛋。兩者都在函式內部自行節流，
    // 且回應形狀只有 {error} 或簽發結果，不洩漏帳號是否存在。
    // 新增任何 action 時預設「需要認證」，不要往這個分支加東西。
    if (action === 'localLogin') return jsonResp_(localLoginAction_(params, ctx));
    if (action === 'localChangePassword') return jsonResp_(localChangePasswordAction_(params, ctx));

    let userEmail;
    if (sessionToken) {
      if (action === 'sessionStart') return jsonResp_({ error: 'sessionStart requires idToken' });
      userEmail = verifySessionToken_(sessionToken);
      if (!userEmail) return jsonResp_({ error: 'Session expired' });
    } else {
      userEmail = idToken ? verifyIdToken_(idToken) : null;
      if (!userEmail) return jsonResp_({ error: 'Unauthorized' });
    }

    // 全域登入閘門（見 DEFAULT_ACCESS_ALLOW_ROLES_ 與 checkSystemAccess_）。
    // 位置是刻意的：認證之後（要先知道是誰）、switch 之前（這是唯一所有 action 都會經過的點）。
    // 回應碼與 'Unauthorized' 分開，因為前端對 Unauthorized 會靜默重走 Google 登入再重試一次——
    // 對「這個人本來就不准進來」重試只會多打一輪後端，且畫面停在無訊息的失敗上。
    const denied = checkSystemAccess_(userEmail, ctx);
    if (denied) return jsonResp_({ error: denied.code, message: denied.message });

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
      case 'adminUpsertDeptAssistant':  result = adminUpsertDeptAssistantAction_(params, ctx, userEmail); break;
      case 'adminRenameDeptAssistant':  result = adminRenameDeptAssistantAction_(params, ctx, userEmail); break;
      case 'adminUpsertSafetyOfficer':  result = adminUpsertSafetyOfficerAction_(params, ctx, userEmail); break;
      case 'auditAppend':               result = auditAppendAction_(params, ctx, userEmail); break;
      case 'adminAuditList':            result = adminAuditListAction_(params, ctx, userEmail); break;
      case 'adminLocalAccounts':        result = adminLocalAccountsAction_(params, ctx, userEmail); break;
      case 'deptRosterGet':             result = deptRosterGetAction_(params, ctx, userEmail); break;
      // 這三個是名冊異動：回傳後要做收尾（排入主責通知佇列＋同步 Google Sheet），
      // 收尾一律在 action 的 withLock_ 之外，見 withRosterAftercare_。
      case 'deptRosterUpsertClass':     result = withRosterAftercare_(deptRosterUpsertClassAction_(params, ctx, userEmail), ctx, userEmail); break;
      case 'deptRosterDeleteClass':     result = withRosterAftercare_(deptRosterDeleteClassAction_(params, ctx, userEmail), ctx, userEmail); break;
      case 'deptRosterUpsertHead':      result = withRosterAftercare_(deptRosterUpsertHeadAction_(params, ctx, userEmail), ctx, userEmail); break;
      case 'adminBulkUpsertDeptHeads':  result = adminBulkUpsertDeptHeadsAction_(params, ctx, userEmail); break;
      case 'adminBulkApplyDeptSheet':   result = adminBulkApplyDeptSheetAction_(params, ctx, userEmail); break;
      case 'adminChangeTutorMidterm':   result = adminChangeTutorMidtermAction_(params, ctx, userEmail); break;
      case 'tutorHistoryGet':           result = tutorHistoryGetAction_(params, ctx, userEmail); break;
      case 'adminRolloverPreview':      result = adminRolloverPreviewAction_(params, ctx, userEmail); break;
      case 'adminRolloverApply':        result = adminRolloverApplyAction_(params, ctx, userEmail); break;
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
  // via/hasPayload 為診斷欄位：前端 loadBootstrap 的形狀防衛若回報收到本回應，
  // 即證明瀏覽器的 POST 在途中被降級成 GET（doPost 從未執行），且可看出 query 是否還帶著 payload。
  return jsonResp_({
    ok: true, service: 'SCC Tutor System Drive Proxy (PROD)', via: 'doGet',
    hasPayload: !!(e && e.parameter && e.parameter.payload),
  });
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

// ══════════════════════════════════════════════════════════════════════════════
// ── 本機帳密（系辦助理用；GAS 軌也要有）────────────────────────────────────────
// 為什麼 GAS 軌需要帳密：系辦助理的校內信箱 @mail.npust.edu.tw **不是 Google 帳號**
// （MX 指向學校自架的 spamalumni.npust.edu.tw，不是 Google），所以他們沒辦法用 Google 登入。
// 導師與中心同仁走 Google 登入不變，這一套只是多一條路。
//
// 密碼保護：HMAC-SHA256 迭代（PBKDF2 精神；GAS 沒有 scrypt/bcrypt）＋ Script Property 的
// **pepper**。pepper 不在資料庫裡，所以就算 Drive 上的 localAccounts.json 整份外流，
// 沒有 pepper 也無法離線暴力破解。格式：hmac$<iterations>$<saltHex>$<keyHex>。
//
// ⚠️ 初始密碼＝校內分機，而分機在各系所官網上公開查得到。這在區網自架版還算堪用，
// 搬到公開網際網路的 GAS 軌就等於「任何人都能拿到的密碼」。因此這裡加了兩道限制：
//   1. mustChangePassword 的帳號有 **activationExpiresAt 啟用期限**（預設 14 天），
//      過期即拒絕登入，要由中心重新啟用——公開的分機只在啟用窗口內有效。
//   2. 前端在非自架軌不提供「稍後再做」，首次登入必須改密碼。
// 這兩道都不是「安全」，是把暴露窗口從無限縮到有限。真正的解是接學校 SSO。
function getPasswordPepper_() {
  return PropertiesService.getScriptProperties().getProperty('PASSWORD_PEPPER');
}

// 在 GAS 編輯器手動執行一次（每個環境各跑一次，dev/prod 的 pepper 互不相同）。
// 刻意不自動產生：pepper 一旦改變，所有既存密碼全部失效，不能讓它在請求路徑上被偷偷重建。
function setupPasswordPepper() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PASSWORD_PEPPER')) {
    Logger.log('PASSWORD_PEPPER 已存在，不覆寫。');
    return;
  }
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  const secret = Utilities.base64Encode(bytes);
  props.setProperty('PASSWORD_PEPPER', secret);
  Logger.log('PASSWORD_PEPPER 已產生並存入 Script Properties（長度 ' + secret.length + '）。');
}

function bytesToHex_(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// 迭代次數：**實測值決定的**，不是拍腦袋。2026-08-09 在 GAS dev 量到
// 2000 次要 2.9 秒（總耗時 4.2 秒 − doGet 基準 1.39 秒），登入太慢、而且會把
// withLock_ 的 15 秒鎖佔住導致 Lock timeout。降到 200 次約 0.3 秒。
//
// 安全性取捨要講清楚：迭代次數只在「資料庫**和** pepper 同時外洩」時才有意義——
// pepper 存在 Script Properties、不在 Drive 的 localAccounts.json 裡，所以單純資料外洩
// 根本無法離線嘗試。而初始密碼是 4 碼分機（10^4 空間），再多迭代也擋不住。
// 在 GAS 這個「每次 HMAC 都是一次服務呼叫」的環境裡，200 次是可用性與強度的折衷。
// 次數存在雜湊字串裡，之後調整不會讓既有密碼失效。
const PASSWORD_ITERATIONS_ = 200;

// 迭代 HMAC。第一輪把 salt 與密碼綁進去，之後對前一輪輸出反覆 HMAC。
//
// ⚠️ `Utilities.computeHmacSha256Signature` 只接受 **(String, String)** 或 **(Byte[], Byte[])**，
// 兩個參數的型別必須一致。第一輪的 value 是字串、之後幾輪的 value 是前一輪產出的 byte array，
// 所以 key 不能直接用字串 pepper——2026-08-09 實際踩到：本機模擬器兩種都收，一路綠燈，
// 推上 GAS 才炸 "The parameters (number[],String) don't match the method signature"。
// 修法是把 pepper 一次轉成 bytes，全程走 (Byte[], Byte[]) 這個 overload。
function derivePasswordKey_(password, saltHex, iterations, pepper) {
  const keyBytes = Utilities.newBlob(String(pepper)).getBytes();
  let acc = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(saltHex + ':' + String(password)).getBytes(), keyBytes);
  for (let i = 1; i < iterations; i++) {
    acc = Utilities.computeHmacSha256Signature(acc, keyBytes);
  }
  return bytesToHex_(acc);
}

function hashPasswordGas_(password) {
  const pepper = getPasswordPepper_();
  if (!pepper) throw new Error('PASSWORD_PEPPER not configured（請在 GAS 編輯器執行一次 setupPasswordPepper）');
  const saltBytes = [];
  for (let i = 0; i < 16; i++) saltBytes.push(Math.floor(Math.random() * 256));
  const saltHex = bytesToHex_(saltBytes);
  const key = derivePasswordKey_(password, saltHex, PASSWORD_ITERATIONS_, pepper);
  return 'hmac$' + PASSWORD_ITERATIONS_ + '$' + saltHex + '$' + key;
}

// 長度先比、再逐字元 XOR 累加——避免早退造成的時間差。
function constantTimeEqual_(a, b) {
  const x = String(a), y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x.charCodeAt(i) ^ y.charCodeAt(i));
  return diff === 0;
}

function verifyPasswordGas_(password, hashStr) {
  const pepper = getPasswordPepper_();
  if (!pepper) return false;
  const parts = String(hashStr || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'hmac') return false;
  const iterations = Number(parts[1]);
  if (!iterations || iterations > 20000) return false;
  const derived = derivePasswordKey_(password, parts[2], iterations, pepper);
  return constantTimeEqual_(derived, parts[3]);
}

// 新密碼規則與自架版一致（server/index.js validateNewPassword_）：至少 8 字、不得全數字。
function validateNewPasswordGas_(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < 8) return '新密碼至少 8 個字元';
  if (s.length > 200) return '新密碼過長';
  if (/^\d+$/.test(s)) return '新密碼不能只有數字（分機那種形式全校查得到）';
  return null;
}

// 初始密碼取分機的第一段數字（名冊有「7829/7803」這種一格兩支的寫法）。
// 與 server/index.js 的 initialPasswordFromExt_ 同規則，改動要兩邊同步。
function initialPasswordFromExtGas_(ext) {
  const m = String(ext == null ? '' : ext).match(/\d+/);
  return m ? m[0] : '';
}

const ACTIVATION_WINDOW_DAYS_ = 14;

// 登入失敗節流：CacheService 記 (email) 的連續失敗次數，達 5 次鎖 60 秒。
// CacheService 是 best-effort（可能被清空），所以這是「提高成本」而不是硬保證。
function loginFailKey_(email) { return 'lgf:' + String(email || '').toLowerCase(); }
function loginFailCount_(email) {
  const v = CacheService.getScriptCache().get(loginFailKey_(email));
  return v ? Number(v) : 0;
}
function bumpLoginFail_(email) {
  const n = loginFailCount_(email) + 1;
  CacheService.getScriptCache().put(loginFailKey_(email), String(n), 60);
  return n;
}
function clearLoginFail_(email) {
  CacheService.getScriptCache().remove(loginFailKey_(email));
}

// 帳號解析：允許只打 @ 之前那段（規則同 server/index.js 的 resolveLoginEmail_——
// local-part 剛好命中一個帳號才算數，多個一律當查無）。
function resolveLocalLoginEmail_(accounts, input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  if (!raw || raw.indexOf('@') !== -1) return raw;
  const hits = Object.keys(accounts || {}).filter(function (e) {
    return String(e).toLowerCase().split('@')[0] === raw;
  });
  return hits.length === 1 ? hits[0] : raw;
}

// localLogin：**這個 dispatcher 唯一免認證的 action**——它自己就是認證。
// 驗完帳密才簽發 session token，形狀與 sessionStart 一致（前端共用同一套 session 流程）。
function localLoginAction_(params, ctx) {
  const accounts = readJsonSafe_('localAccounts.json', ctx, {});
  const email = resolveLocalLoginEmail_(accounts, params.email);
  const password = String(params.password == null ? '' : params.password);

  if (loginFailCount_(email) >= 5) return { error: '嘗試次數過多，請稍後再試' };

  const entry = email ? accounts[email] : null;
  // 查無帳號也照跑一次同樣迭代次數的雜湊，拉平時間差（同 server/index.js 的 DUMMY_HASH 手法）。
  const hashToCheck = (entry && entry.hash) ? entry.hash
    : ('hmac$' + PASSWORD_ITERATIONS_ + '$' + '00'.repeat(16) + '$' + 'ff'.repeat(32));
  const passwordOk = verifyPasswordGas_(password, hashToCheck);
  const accountOk = !!entry && entry.disabled !== true && entry.deleted !== true;
  if (!accountOk || !passwordOk) {
    bumpLoginFail_(email);
    return { error: '帳號或密碼錯誤' };
  }
  // 啟用期限：仍在用初始密碼（分機，公開查得到）且已過期 → 拒絕，要中心重新啟用。
  if (entry.mustChangePassword === true && entry.activationExpiresAt &&
      new Date().toISOString() > entry.activationExpiresAt) {
    bumpLoginFail_(email);
    return { error: '初次登入啟用期限已過，請聯絡學諮中心重新啟用帳號' };
  }

  clearLoginFail_(email);
  // 全域登入閘門也要套在這條路上——localLogin 免認證（它自己就是認證），走不到 dispatcher
  // 那道檢查。放在帳密驗過之後：對帳密錯的人先回「帳號或密碼錯誤」，不會因為訊息不同而
  // 洩漏「這個帳號存在但沒有權限」。回的是人話訊息而非 code，因為前端這條路（帳密登入表單）
  // 直接把 error 字串顯示出來。
  const denied = checkSystemAccess_(email, ctx);
  if (denied) return { error: denied.message };

  const issued = issueSessionToken_(email);
  return {
    sessionToken: issued.token, exp: issued.exp, email: email,
    name: entry.name || '', mustChangePassword: entry.mustChangePassword === true,
  };
}

// localChangePassword：要帶目前密碼（不只認 session token——token 存 localStorage，
// 撿到 token 的人不該就能改密碼把本人鎖在外面）。同 server/index.js 的判斷。
function localChangePasswordAction_(params, ctx) {
  const accounts = readJsonSafe_('localAccounts.json', ctx, {});
  const email = resolveLocalLoginEmail_(accounts, params.email);
  const current = String(params.currentPassword == null ? '' : params.currentPassword);
  const next = String(params.newPassword == null ? '' : params.newPassword);

  if (loginFailCount_(email) >= 5) return { error: '嘗試次數過多，請稍後再試' };
  const policyErr = validateNewPasswordGas_(next);
  if (policyErr) return { error: policyErr };

  const entry = accounts[email];
  const hashToCheck = (entry && entry.hash) ? entry.hash
    : ('hmac$' + PASSWORD_ITERATIONS_ + '$' + '00'.repeat(16) + '$' + 'ff'.repeat(32));
  const ok = verifyPasswordGas_(current, hashToCheck) && !!entry && entry.disabled !== true;
  if (!ok) {
    // 冪等：目前密碼對不上，但「新密碼」已經是現行密碼 → 代表這次請求其實已經成功過一次
    // （GAS 偶發 404/503 讓前端重試時就會這樣，使用者 2026-08-09 實際踩到：
    //  第一次改成功但畫面報錯，第二次送出被判「目前密碼錯誤」）。
    // 回成功而不改動任何東西——呼叫端證明了自己知道新密碼，且狀態已經是它要的樣子。
    if (entry && entry.disabled !== true && verifyPasswordGas_(next, entry.hash)) {
      clearLoginFail_(email);
      return { changed: false, alreadyChanged: true };
    }
    bumpLoginFail_(email); return { error: '帳號或目前密碼錯誤' };
  }
  if (current === next) return { error: '新密碼不能與目前密碼相同' };

  // 同 localLoginAction_：這條路免認證，走不到 dispatcher 的閘門。進不了系統的人也不該
  // 還能改動自己的帳號。放在帳密驗過之後，理由與那邊相同（不因訊息差異洩漏帳號存在與否）。
  const deniedPw = checkSystemAccess_(email, ctx);
  if (deniedPw) return { error: deniedPw.message };

  clearLoginFail_(email);
  const newHash = hashPasswordGas_(next);   // 同上：慢的一步留在鎖外
  return withLock_(function () {
    const fresh = readJsonSafe_('localAccounts.json', ctx, {});
    const now = new Date().toISOString();
    fresh[email] = Object.assign({}, fresh[email] || entry, {
      hash: newHash, mustChangePassword: false,
      activationExpiresAt: null, passwordChangedAt: now,
    });
    writeJsonPath_('localAccounts.json', fresh, ctx);
    return { changed: true };
  });
}

// adminLocalAccounts：admin only，操作與自架版 /admin/accounts 完全對應
// （list / createOrReset / setDisabled），前端同一套 UI 依環境切換傳輸方式。
function adminLocalAccountsAction_(params, ctx, userEmail) {
  const roles = loadRolesForCtx_(ctx, userEmail);
  requireAdmin_(roles);
  const op = String(params.op || 'list');
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const accounts = readJsonSafe_('localAccounts.json', ctx, {});

  if (op === 'list') {
    const assistants = (config.deptAssistants || []).filter(function (a) { return a && a.deleted !== true; });
    return {
      accounts: assistants.map(function (a) {
        const u = accounts[String(a.email || '').toLowerCase()];
        return {
          email: a.email, name: a.name || '', ext: a.ext || '', deptIds: a.deptIds || [],
          assistantDisabled: a.disabled === true,
          hasAccount: !!u, accountDisabled: !!u && u.disabled === true,
          mustChangePassword: !!u && u.mustChangePassword === true,
          activationExpiresAt: (u && u.activationExpiresAt) || null,
          passwordChangedAt: (u && u.passwordChangedAt) || null,
        };
      }),
    };
  }

  const targetEmail = String(params.email || '').trim().toLowerCase();
  if (!targetEmail) throw new Error('email required');

  if (op === 'createOrReset') {
    // 可以發本機帳號的兩種身分：系辦助理與校安人員。**一定要在某個白名單內**——
    // 不然這支就變成「admin 可以為任意 email 憑空造一組可登入的密碼」。
    const assistant = (config.deptAssistants || []).concat(config.safetyOfficers || [])
      .filter(function (a) {
        return a && a.deleted !== true && String(a.email || '').toLowerCase() === targetEmail;
      })[0];
    if (!assistant) throw new Error('這個 email 不在系辦助理或校安人員名單內');
    const pw = String(params.password || initialPasswordFromExtGas_(assistant.ext) || '').trim();
    if (!pw) throw new Error('沒有可用的初始密碼（白名單沒填分機），請手動指定');
    // 雜湊在鎖**外面**算：它是這裡最慢的一步，放進臨界區會讓別的請求等到 waitLock 逾時
    // （2026-08-09 使用者實際踩到 Lock timeout）。鎖裡只留讀檔→改一筆→寫檔。
    const newHash = hashPasswordGas_(pw);
    return withLock_(function () {
      const fresh = readJsonSafe_('localAccounts.json', ctx, {});
      const now = new Date();
      fresh[targetEmail] = Object.assign({}, fresh[targetEmail] || {}, {
        name: assistant.name || '', hash: newHash, disabled: false,
        mustChangePassword: true,
        activationExpiresAt: new Date(now.getTime() + ACTIVATION_WINDOW_DAYS_ * 86400000).toISOString(),
      });
      writeJsonPath_('localAccounts.json', fresh, ctx);
      appendAuditLog_(ctx, { action: 'adminResetLocalAccount', by: userEmail, targetId: targetEmail, at: now.toISOString() });
      return { email: targetEmail, activationDays: ACTIVATION_WINDOW_DAYS_ };
    });
  }

  if (op === 'setDisabled') {
    return withLock_(function () {
      const fresh = readJsonSafe_('localAccounts.json', ctx, {});
      if (!fresh[targetEmail]) throw new Error('這個 email 沒有本機帳號');
      fresh[targetEmail] = Object.assign({}, fresh[targetEmail], { disabled: params.disabled === true });
      writeJsonPath_('localAccounts.json', fresh, ctx);
      appendAuditLog_(ctx, { action: 'adminSetLocalAccountDisabled', by: userEmail, targetId: targetEmail, at: new Date().toISOString() });
      return { email: targetEmail, disabled: params.disabled === true };
    });
  }

  // delete：整筆移除本機帳號（含密碼雜湊）。換 email 時用來收掉舊信箱的帳號，也用來清掉
  // 新信箱可能殘留的孤兒帳號——白名單軟刪除不會動到這份資料，留著等於「這個信箱哪天再被
  // 加回白名單，舊密碼就又能登入」。**找不到不算失敗**（呼叫端是清理，不是查詢）。
  if (op === 'delete') {
    return withLock_(function () {
      const fresh = readJsonSafe_('localAccounts.json', ctx, {});
      const existed = !!fresh[targetEmail];
      if (existed) {
        delete fresh[targetEmail];
        writeJsonPath_('localAccounts.json', fresh, ctx);
        appendAuditLog_(ctx, { action: 'adminDeleteLocalAccount', by: userEmail, targetId: targetEmail, at: new Date().toISOString() });
      }
      return { email: targetEmail, deleted: existed };
    });
  }

  throw new Error('unknown op: ' + op);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 維運函式（只能由專案擁有者經 Apps Script API／編輯器呼叫）─────────────────
// 這幾支**不在 doPost 的 switch 裡**，網頁請求打不到；它們的用途是讓維護者從 comanage
// 用 `clasp run` 做灌資料、對帳這類一次性工作，不必手動點編輯器。
//
// 安全性：呼叫者必須是 BOOTSTRAP_ADMINS 之一（Apps Script API 以呼叫者身分執行，
// manifest 的 executionApi.access 是 MYSELF）。能呼叫這些的人本來就能直接改這份程式碼，
// 所以這不是新的攻擊面；但仍然明確擋一道，避免哪天 manifest 被改寬。
function requireMaintenanceOwner_() {
  let who = '';
  try { who = Session.getEffectiveUser().getEmail() || ''; } catch (e) { who = ''; }
  if (typeof BOOTSTRAP_ADMINS === 'undefined' || BOOTSTRAP_ADMINS.indexOf(who) === -1) {
    throw new Error('maintenance: 僅限專案擁有者（目前身分：' + (who || '(未知)') + '）');
  }
  return who;
}

// 狀態總覽：確認密鑰有沒有設好、各資料表有幾筆。**不回傳任何密鑰內容**，只回布林。
// 注意：GAS 編輯器的「執行紀錄」只顯示 Logger.log 的輸出，**不顯示回傳值**，
// 所以這幾支維運函式一律「log 一份、也回傳一份」——從編輯器點執行的人看得到，
// 用 API 呼叫的人也拿得到。
function maintenanceStatus() {
  requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const accounts = readJsonSafe_('localAccounts.json', ctx, {});
  const out = JSON.stringify({
    root: ROOT_FOLDER_ID,
    hasSessionSecret: !!getSessionSecret_(),
    hasPasswordPepper: !!getPasswordPepper_(),
    passwordIterations: PASSWORD_ITERATIONS_,
    colleges: readJsonSafe_('colleges.json', ctx, []).length,
    departments: readJsonSafe_('departments.json', ctx, []).length,
    classes: readJsonSafe_('classes.json', ctx, []).length,
    deptAssistants: (config.deptAssistants || []).length,
    localAccounts: Object.keys(accounts).length,
  });
  Logger.log(out);
  return out;
}

// 開關全域登入閘門（見 DEFAULT_ACCESS_ALLOW_ROLES_）。三個參數都可傳 null＝該欄不動。
//   maintenanceSetAccessPolicy('restricted', null, null)                       關門（預設允許集合）
//   maintenanceSetAccessPolicy(null, '["admin","staffAssistant","deptAssistant","deptHead"]', null)
//                                                                              開系主任入口
//   maintenanceSetAccessPolicy('open', null, null)                             完全恢復對外開放
// **自架軌沒有 clasp、也叫不到這支**：直接改 <DATA_DIR>/store/config.json 的
// settings.accessMode / settings.accessAllowRoles / settings.accessMessage，欄位名一模一樣。
function maintenanceSetAccessPolicy(mode, allowRolesJson, message) {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  if (mode !== null && mode !== undefined && mode !== 'open' && mode !== 'restricted') {
    throw new Error("mode 只能是 'open' / 'restricted' / null");
  }
  let roles = null;
  if (allowRolesJson !== null && allowRolesJson !== undefined && allowRolesJson !== '') {
    roles = JSON.parse(allowRolesJson);
    if (!Array.isArray(roles) || !roles.length) throw new Error('allowRolesJson 必須是非空的 JSON 陣列');
    const known = ['admin', 'director', 'staffLead', 'staffAssistant', 'deptAssistant', 'safetyOfficer', 'deptHead', 'tutor', 'anyone'];
    // 打錯字的角色鍵在 checkSystemAccess_ 裡只會安靜地永遠不命中（＝把人擋在外面而設定看起來
    // 是對的），所以在寫入的這一端就擋下來，不要讓它進到設定檔裡。
    roles.forEach(function (r) { if (known.indexOf(r) === -1) throw new Error('未知的角色鍵：' + r); });
  }
  const out = withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    if (!config.settings || typeof config.settings !== 'object') config.settings = {};
    if (mode !== null && mode !== undefined) config.settings.accessMode = mode;
    if (roles) config.settings.accessAllowRoles = roles;
    if (typeof message === 'string') config.settings.accessMessage = message;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, {
      action: 'maintenanceSetAccessPolicy', by: who, at: new Date().toISOString(),
      accessMode: config.settings.accessMode || null,
      accessAllowRoles: config.settings.accessAllowRoles || null,
    });
    return JSON.stringify({
      accessMode: config.settings.accessMode || '(未設定＝restricted)',
      accessAllowRoles: config.settings.accessAllowRoles || DEFAULT_ACCESS_ALLOW_ROLES_,
      accessMessage: config.settings.accessMessage || DEFAULT_ACCESS_DENIED_MESSAGE_,
    });
  });
  Logger.log(out);
  return out;
}

// 批次寫入系辦助理白名單。輸入 JSON 陣列字串 [{email,name,ext,deptIds:[]}...]，
// 走與 adminUpsertDeptAssistant 相同的驗證（deptIds 必須是現存且啟用的系所，錯一個整筆拒絕）。
function maintenanceUpsertDeptAssistants(json) {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const rows = JSON.parse(json || '[]');
  const result = { ok: 0, failed: [] };
  rows.forEach(function (r) {
    try {
      adminUpsertDeptAssistantAction_({ deptAssistant: r }, ctx, who);
      result.ok++;
    } catch (e) {
      result.failed.push({ email: r && r.email, error: e.message });
    }
  });
  const out = JSON.stringify(result);
  Logger.log(out);
  return out;
}

// 幫管理員本人開一個**帳密**登入帳號。
// 為什麼需要：登入頁把 Google 登入收起來之後（它只剩中心人員在用，擺前面會誤導系辦助理），
// 管理員仍要有一條不依賴 Google 的路進後台——尤其 Google 那條路若哪天出狀況，
// 這就是 break-glass 入口。密碼隨機產生並 log 出來，只此一次，請立刻自行更改。
function maintenanceCreateAdminAccount() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  // 24 字元隨機密碼（含大小寫與數字，符合「至少 8 字、不得全數字」的政策）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 24; i++) pw += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  const hash = hashPasswordGas_(pw);   // 慢的一步留在鎖外
  withLock_(function () {
    const accounts = readJsonSafe_('localAccounts.json', ctx, {});
    accounts[who] = Object.assign({}, accounts[who] || {}, {
      name: '系統管理員', hash: hash, disabled: false,
      mustChangePassword: false,   // 隨機長密碼，不必強迫改；要改可用登入頁的改密碼流程
    });
    writeJsonPath_('localAccounts.json', accounts, ctx);
  });
  appendAuditLog_(ctx, { action: 'maintenanceCreateAdminAccount', by: who, targetId: who, at: new Date().toISOString() });
  const out = JSON.stringify({
    帳號: who, 密碼: pw,
    提醒: '這個密碼只顯示這一次，請立刻存到密碼管理器。它是不依賴 Google 的後台入口。',
  });
  Logger.log(out);
  return out;
}

// importer 專用的服務帳號。校內自架站的排程要來拉名冊，需要一組憑證——
// **刻意不用 admin**：importer 只需要「讀得到全部系所的名冊」，而那正好是
// 「系辦助理掛滿所有系所」的權限。用 admin 等於把後台帳號管理、config、稽核一起交出去。
//
// 與一般助理帳號的兩個差異，都是因為它是服務帳號而非真人帳號：
//   - mustChangePassword=false（沒有人會去改它）
//   - 不設 activationExpiresAt（14 天後過期會讓排程無聲無息地停掉）
// 要換密碼就再執行一次本函式，舊密碼立即失效。
const IMPORTER_ACCOUNT_EMAIL_ = 'importer@heartnpust.tw';

function maintenanceCreateImporterAccount() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const departments = readJsonSafe_('departments.json', ctx, []);
  const allDeptIds = departments.filter(function (d) {
    return d && d.active !== false && d.deleted !== true;
  }).map(function (d) { return d.id; });
  if (!allDeptIds.length) {
    const e = JSON.stringify({ error: '這個環境沒有任何啟用的系所，先把名冊灌進來再跑' });
    Logger.log(e);
    return e;
  }

  adminUpsertDeptAssistantAction_({
    deptAssistant: { email: IMPORTER_ACCOUNT_EMAIL_, name: '校內同步服務（importer）', ext: '', deptIds: allDeptIds },
  }, ctx, who);

  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 32; i++) pw += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  const hash = hashPasswordGas_(pw);
  withLock_(function () {
    const accounts = readJsonSafe_('localAccounts.json', ctx, {});
    accounts[IMPORTER_ACCOUNT_EMAIL_] = {
      name: '校內同步服務（importer）', hash: hash, disabled: false,
      mustChangePassword: false, activationExpiresAt: null,
    };
    writeJsonPath_('localAccounts.json', accounts, ctx);
  });
  appendAuditLog_(ctx, { action: 'maintenanceCreateImporterAccount', by: who, targetId: IMPORTER_ACCOUNT_EMAIL_, at: new Date().toISOString() });

  const out = JSON.stringify({
    帳號: IMPORTER_ACCOUNT_EMAIL_, 密碼: pw, 涵蓋系所數: allDeptIds.length,
    權限: '等同「掛滿所有系所的系辦助理」——讀寫名冊，但不是 admin：碰不到帳號管理、config、稽核',
    用途: '寫進 scc-server 的 server/.env（GAS_ADMIN_EMAIL/GAS_ADMIN_PASSWORD），給排程 importer 用',
    輪替: '再執行一次本函式即產生新密碼，舊的立即失效',
  });
  Logger.log(out);
  return out;
}

// ── 名冊搬運：自架版 → GAS Drive ─────────────────────────────────────────────
// 為什麼是「上傳檔案 + 零參數函式」這種形狀：
//   - GAS 編輯器只能執行**零參數**函式，所以資料不能用參數傳。
//   - 走 Drive REST 直接寫需要另一組 OAuth 憑證（comanage 上沒有 creds.json），
//     等於要使用者再做一次授權；而把資料檔丟進 Drive 資料夾是拖放就完成的事。
//   - 刻意**不做成 doPost 的 action**：整份覆寫名冊是維運動作，不該有網路端點常駐。
//
// 用法：把 migration.json 上傳到本環境的 Drive 根資料夾，再執行本函式。
// 檔案格式：{ generatedAt, source, files: { "colleges.json": [...], ... }, deptAssistants: [...] }
//
// 安全與資料保全：
//   - 只接受白名單內的檔名（名冊類），**不碰** records_*／sessions／props／audit_log。
//   - 每個被覆寫的檔案先存一份 <name>.bak-migrate-<時間戳>，出事可回。
//   - deptAssistants 併進現有 config.json（只換這個欄位），不整檔覆寫——
//     config 裡還有 users/settings/staffLeads，整檔蓋掉會把它們一起清空。
const MIGRATION_ALLOWED_FILES_ = [
  'colleges.json', 'departments.json', 'tutorSystems.json', 'semesters.json', 'classes.json',
];

function maintenanceImportFromDriveJson() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  let payload;
  let sourceNote = '根資料夾';
  try {
    payload = readJson_({ path: 'migration.json' }, ctx);
  } catch (eRoot) {
    // 不在根資料夾 → 搜尋整個雲端硬碟。實務上最常見的原因是上傳時用了另一個 Google 帳號、
    // 或拖到別的資料夾；檔案還是同一份，沒必要為了位置讓人重來一次。
    // 找到多份就取最後修改的那份，並把來源位置與時間一起 log 出來（免得默默吃到舊檔）。
    try {
      const found = driveGet_('files', {
        q: "name='migration.json' and trashed=false",
        fields: 'files(id,name,modifiedTime,parents)', orderBy: 'modifiedTime desc', pageSize: '10',
      });
      if (found.files && found.files.length) {
        const f = found.files[0];
        let parentName = '(未知)';
        try {
          const p = driveGet_('files/' + (f.parents && f.parents[0]), { fields: 'name' });
          parentName = p.name || parentName;
        } catch (e3) { /* 取不到父資料夾名稱不影響匯入 */ }
        const resDl = UrlFetchApp.fetch(
          'https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media&supportsAllDrives=true',
          { headers: { Authorization: 'Bearer ' + tok_() }, muteHttpExceptions: true }
        );
        if (resDl.getResponseCode() >= 400) throw new Error('下載 migration.json 失敗');
        payload = JSON.parse(resDl.getContentText());
        sourceNote = '雲端硬碟其他位置：資料夾「' + parentName + '」，最後修改 ' + f.modifiedTime +
          (found.files.length > 1 ? '（共找到 ' + found.files.length + ' 份，取最新）' : '');
        Logger.log('注意：migration.json 不在根資料夾，改用 ' + sourceNote);
      }
    } catch (eSearch) { /* 落到下面的錯誤回報 */ }
  }
  if (!payload) {
    // 找不到就**直接列出根資料夾實際有什麼**——「找不到」這種錯誤最沒用的形式就是
    // 只說找不到，讓人去猜是傳錯資料夾還是名字不對。一次執行就把真相印出來。
    let listing = [];
    try {
      const res = driveGet_('files', {
        q: "'" + ctx.root + "' in parents and trashed=false",
        fields: 'files(name,mimeType)', pageSize: '100', orderBy: 'name',
      });
      listing = (res.files || []).map(function (f) {
        return f.name + (f.mimeType === 'application/vnd.google-apps.folder' ? '/' : '');
      });
    } catch (e2) { listing = ['(列出根資料夾也失敗：' + e2.message + ')']; }
    const err = JSON.stringify({
      error: '找不到 migration.json',
      rootFolderId: ROOT_FOLDER_ID,
      根資料夾實際內容: listing,
      提示: '請確認檔案是上傳到上面這個 ID 的資料夾，且檔名正好是 migration.json（結尾有 / 的是子資料夾）',
    });
    Logger.log(err);
    return err;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = {
    讀取來源: sourceNote,
    source: payload.source || '(未標示)', generatedAt: payload.generatedAt || '(未標示)',
    wrote: [], skipped: [], backups: [],
  };
  const files = payload.files || {};

  MIGRATION_ALLOWED_FILES_.forEach(function (name) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) { result.skipped.push(name + '（檔案裡沒有）'); return; }
    const content = files[name];
    if (!Array.isArray(content)) { result.skipped.push(name + '（內容不是陣列，跳過）'); return; }
    const before = readJsonSafe_(name, ctx, null);
    if (before !== null) {
      writeJsonPath_(name + '.bak-migrate-' + stamp, before, ctx);
      result.backups.push(name + '.bak-migrate-' + stamp);
    }
    writeJsonPath_(name, content, ctx);
    result.wrote.push(name + '（' + content.length + ' 筆）');
  });

  if (Array.isArray(payload.deptAssistants)) {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    writeJsonPath_('config.json.bak-migrate-' + stamp, config, ctx);
    result.backups.push('config.json.bak-migrate-' + stamp);
    config.deptAssistants = payload.deptAssistants;
    writeJsonPath_('config.json', config, ctx);
    result.wrote.push('config.deptAssistants（' + payload.deptAssistants.length + ' 筆）');
  }

  appendAuditLog_(ctx, { action: 'maintenanceImportFromDriveJson', by: who, targetId: 'migration.json', at: new Date().toISOString() });
  const out = JSON.stringify(result);
  Logger.log(out);
  return out;
}

// ── 復原一次「換學期升級」的部分套用（2026-08-11 事故）───────────────────────
// adminRolloverApply 的失敗列只收進 errors、**不中斷整批**，而這份資料是席位式的
// （每個系四技一/二/三/四同時存在），所以 advance 幾乎全部撞名失敗、graduate 全部成功
// → 結果是「每個系的最高年級被停用，其他一個都沒升」。114-2→115-1 那次：99 筆停用 + 5 筆改名。
//
// 邏輯與 scripts/undo-rollover.mjs 完全相同（那支只能對本機檔案動手，而權威資料在 Drive）：
//   1. graduatedSemester === from 的班 → 還原成 **null**（不是 delete：顯式 null 才是這份資料
//      的正規形狀，欄位刪掉會讓 import-from-gas 每次同步都判定「有更新」）、active 改回 true。
//      **以 graduatedSemester 當鍵，不是以 active** —— 本來就停用的班不會被誤救活。
//   2. nameHistory 最後一筆的 upToSemester === from → 還原 name/displayName 並把那筆 pop 掉。
//   3. **tutorHistory 不動**：append-only 的稽核軌跡，那次升級確實發生過。
const UNDO_ROLLOVER_FROM_ = '114-2';   // 要復原哪一次升級的「來源學期」；換事故要改這裡

function undoRolloverInPlace_(classes, fromSemester) {
  const unGraduated = [];
  const renamed = [];
  (classes || []).forEach(function (c) {
    if (!c) return;
    if (c.graduatedSemester === fromSemester) {
      unGraduated.push({ id: c.id, dept: c.deptId, name: c.name, wasActive: c.active });
      c.graduatedSemester = null;
      c.active = true;
    }
    const nh = Array.isArray(c.nameHistory) ? c.nameHistory : null;
    const last = nh && nh.length ? nh[nh.length - 1] : null;
    if (last && last.upToSemester === fromSemester) {
      renamed.push({ id: c.id, dept: c.deptId, from: c.name, to: last.name });
      c.name = last.name;
      if (last.displayName !== undefined) c.displayName = last.displayName;
      nh.pop();
      if (!nh.length) delete c.nameHistory;
    }
  });
  return { unGraduated: unGraduated, renamed: renamed };
}

// 摘要做成純函式，預覽與套用共用同一份文字——兩邊各寫一次的話，看到的與寫下去的會分岔。
function undoRolloverSummary_(plan, total, fromSemester) {
  const byName = {};
  plan.unGraduated.forEach(function (x) { byName[x.name] = (byName[x.name] || 0) + 1; });
  return {
    學期: fromSemester,
    班級總數: total,
    復原停用: plan.unGraduated.length,
    停用班級分布: Object.keys(byName).sort(function (a, b) { return byName[b] - byName[a]; })
      .map(function (n) { return n + '×' + byName[n]; }).join('、'),
    復原改名: plan.renamed.length,
    改名清單: plan.renamed.map(function (r) { return r.dept + '：' + r.from + ' → 還原成 ' + r.to; }),
  };
}

// 預覽（零參數，不寫入）。先跑這支，數字對了再跑 Apply 那支。
function maintenanceUndoRollover() {
  requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const classes = readJsonSafe_('classes.json', ctx, null);
  if (!Array.isArray(classes)) {
    const err = JSON.stringify({ error: 'classes.json 不是陣列或讀不到，拒絕處理' });
    Logger.log(err);
    return err;
  }
  const plan = undoRolloverInPlace_(classes, UNDO_ROLLOVER_FROM_);   // 只動記憶體裡的副本，不寫回
  const out = JSON.stringify(Object.assign(
    { 模式: '預覽（未寫入）' },
    undoRolloverSummary_(plan, classes.length, UNDO_ROLLOVER_FROM_),
    (!plan.unGraduated.length && !plan.renamed.length)
      ? { 結論: '沒有找到 ' + UNDO_ROLLOVER_FROM_ + ' 的升級痕跡，這份資料不需要復原（也可能是跑錯環境）' }
      : { 下一步: '數字無誤才執行 maintenanceUndoRolloverApply（會先備份再寫入）' }
  ));
  Logger.log(out);
  return out;
}

// 實際套用（零參數）。寫入前把原檔備份成 classes.json.bak-undorollover-<時間戳>。
function maintenanceUndoRolloverApply() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  return withLock_(function () {
    const classes = readJsonSafe_('classes.json', ctx, null);
    if (!Array.isArray(classes)) {
      const err = JSON.stringify({ error: 'classes.json 不是陣列或讀不到，拒絕處理' });
      Logger.log(err);
      return err;
    }
    // 備份要的是「改之前」的樣子，所以在 undo 之前先拷一份——事後再讀一次 Drive 看似也行，
    // 但那是把備份的正確性押在「兩次讀到的是同一份」上，沒必要。
    const original = JSON.parse(JSON.stringify(classes));
    const plan = undoRolloverInPlace_(classes, UNDO_ROLLOVER_FROM_);
    if (!plan.unGraduated.length && !plan.renamed.length) {
      // 什麼都不必改就不要寫檔——白寫一次等於平白多一個「資料變動過」的事實。
      const out = JSON.stringify({ 模式: '未寫入', 結論: '沒有找到 ' + UNDO_ROLLOVER_FROM_ + ' 的升級痕跡' });
      Logger.log(out);
      return out;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = 'classes.json.bak-undorollover-' + stamp;
    writeJsonPath_(bak, original, ctx);
    writeJsonPath_('classes.json', classes, ctx);
    appendAuditLog_(ctx, {
      action: 'maintenanceUndoRollover', by: who,
      targetId: UNDO_ROLLOVER_FROM_ + '：復原停用 ' + plan.unGraduated.length + '、復原改名 ' + plan.renamed.length,
      at: new Date().toISOString(),
    });
    const out = JSON.stringify(Object.assign(
      { 模式: '已寫入', 備份: bak, by: who },
      undoRolloverSummary_(plan, classes.length, UNDO_ROLLOVER_FROM_),
      { 提醒: 'tutorHistory 沒有動（append-only 稽核軌跡），裡面仍留著那次升級的紀錄' }
    ));
    Logger.log(out);
    return out;
  });
}

// 種一筆**測試用**系辦助理白名單（給人從編輯器一鍵執行——編輯器只能跑零參數函式）。
// 刻意用 example.com 的假 email 與假分機：這支會進公開 repo，不能帶任何真實個資。
// 掛的系所取「現存且啟用」的第一個，不寫死——各環境的系所清單不一樣。
function maintenanceSeedTestAssistant() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const departments = readJsonSafe_('departments.json', ctx, []);
  const dept = departments.filter(function (d) { return d && d.active !== false && d.deleted !== true; })[0];
  if (!dept) { const e = JSON.stringify({ error: '這個環境沒有任何啟用的系所' }); Logger.log(e); return e; }
  adminUpsertDeptAssistantAction_({
    deptAssistant: { email: 'test-assistant@example.com', name: '測試系辦助理', ext: '9999', deptIds: [dept.id] },
  }, ctx, who);
  adminLocalAccountsAction_({ op: 'createOrReset', email: 'test-assistant@example.com' }, ctx, who);
  const out = JSON.stringify({
    seeded: 'test-assistant@example.com', dept: dept.id,
    帳號: 'test-assistant（或完整 email）', 初始密碼: '9999',
    note: '首次登入會強制改密碼；啟用期限 ' + ACTIVATION_WINDOW_DAYS_ + ' 天',
  });
  Logger.log(out);
  return out;
}

// 依白名單的分機批次建立/重設本機登入帳號。
//
// **刻意不重用 adminLocalAccountsAction_ 逐筆呼叫**：那樣每一筆都要重讀 config／departments／
// classes.json（107 KB）、各自進一次鎖、各寫一次稽核，實測 47 筆會逼近 GAS 的 6 分鐘上限
// （使用者 2026-08-10 實際卡住）。這裡改成「讀一次 → 全部算完 → 寫一次」：
// 雜湊在鎖外算（47 × 約 0.5 秒），鎖裡只做一次讀檔、合併、寫檔。
// 驗證條件與逐筆版完全一致（必須在白名單內、必須有可用的分機），只是攤平了 I/O。
function maintenanceResetLocalAccounts(emailsCsv) {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const existing = readJsonSafe_('localAccounts.json', ctx, {});
  const only = String(emailsCsv || '').split(',').map(function (s2) { return s2.trim().toLowerCase(); }).filter(Boolean);

  const targets = (config.deptAssistants || []).filter(function (a) {
    if (!a || a.deleted === true) return false;
    const e = String(a.email || '').toLowerCase();
    if (only.length) return only.indexOf(e) !== -1;
    return !existing[e];            // 不指名時只補「還沒有帳號」的，不動已改過密碼的人
  });

  const now = new Date();
  const expires = new Date(now.getTime() + ACTIVATION_WINDOW_DAYS_ * 86400000).toISOString();
  const prepared = [];
  const skipped = [];
  targets.forEach(function (a) {
    const email = String(a.email || '').toLowerCase();
    const pw = initialPasswordFromExtGas_(a.ext);
    if (!pw) { skipped.push(email + '（白名單沒填分機）'); return; }
    prepared.push({ email: email, name: a.name || '', hash: hashPasswordGas_(pw) });   // 雜湊在鎖外
  });

  withLock_(function () {
    const fresh = readJsonSafe_('localAccounts.json', ctx, {});
    prepared.forEach(function (x) {
      fresh[x.email] = Object.assign({}, fresh[x.email] || {}, {
        name: x.name, hash: x.hash, disabled: false,
        mustChangePassword: true, activationExpiresAt: expires,
      });
    });
    writeJsonPath_('localAccounts.json', fresh, ctx);
  });
  appendAuditLog_(ctx, {
    action: 'maintenanceResetLocalAccounts', by: who,
    targetId: prepared.length + ' accounts', at: now.toISOString(),
  });

  const out = JSON.stringify({
    建立或重設: prepared.length, 略過: skipped, 啟用期限: expires,
    note: '初始密碼＝各自分機第一段數字；首次登入強制改密碼',
  });
  Logger.log(out);
  return out;
}

// 建立（或綁定）名冊同步用的 Google 試算表，並立刻同步一次。零參數，從 GAS 編輯器執行。
// 已經有 ROSTER_SHEET_ID 就沿用那一份，不會重建——重建會讓已分享出去的網址失效。
// **分享設定要人工做**：這份表不含私人手機（決策如此），但仍是全校導師名單，
// 請只分享給需要的人，不要用「知道連結的人」。
function maintenanceSetupRosterSheet() {
  const who = requireMaintenanceOwner_();
  const ctx = { root: ROOT_FOLDER_ID };
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(ROSTER_SHEET_PROP_) || '';
  let created = false;
  if (!id) {
    const ss = SpreadsheetApp.create('各系導師名冊（自動同步）');
    id = ss.getId();
    props.setProperty(ROSTER_SHEET_PROP_, id);
    created = true;
    // 放進系統的根資料夾，跟其他資料檔擺一起，之後好找
    try { DriveApp.getFileById(id).moveTo(DriveApp.getFolderById(ROOT_FOLDER_ID)); } catch (e) {}
  }
  const res = syncRosterSheet_(ctx);
  const out = JSON.stringify({
    建立: created, sheetId: id,
    網址: 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
    同步結果: res, by: who,
    提醒: '請手動設定共用對象（不含私人手機，但仍是全校導師名單）',
  });
  Logger.log(out);
  return out;
}

// 安裝兩個時間觸發器：每小時全量校正 Sheet、每 10 分鐘出清通知佇列。
// 重複執行不會裝出兩份（先刪同名的舊觸發器）。零參數，從 GAS 編輯器執行。
function maintenanceInstallRosterTriggers() {
  const who = requireMaintenanceOwner_();
  const wanted = ['hourlyRosterSheetSync', 'flushRosterNotifications'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (wanted.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyRosterSheetSync').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('flushRosterNotifications').timeBased().everyMinutes(10).create();
  const out = JSON.stringify({ installed: wanted, by: who });
  Logger.log(out);
  return out;
}

// 每小時的全量校正（時間觸發器用，零參數）。存檔即同步已經涵蓋 99% 的情況，
// 這一趟是為了修掉漏寫、手動亂改、或某次同步剛好失敗的殘留。
function hourlyRosterSheetSync() {
  const res = syncRosterSheetSafe_({ root: ROOT_FOLDER_ID });
  Logger.log(JSON.stringify(res));
  return JSON.stringify(res);
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

// 稽核上限：2026-08-18 起前端也會寫這個檔（瀏覽軌跡），不設上限的話它會單向長大，
// 而每次 append 都是「整檔讀→push→整檔寫」，檔案變大＝每一個寫入動作都跟著變慢。
// 超過就丟掉最舊的。**只在這裡截斷**，呼叫端不必知道。
const AUDIT_LOG_MAX_ENTRIES_ = 20000;

function appendAuditLog_(ctx, entry) {
  let log = readJsonSafe_('audit_log.json', ctx, { entries: [] });
  if (!log || !Array.isArray(log.entries)) log = { entries: [] };
  log.entries.push(entry);
  if (log.entries.length > AUDIT_LOG_MAX_ENTRIES_) {
    log.entries = log.entries.slice(log.entries.length - AUDIT_LOG_MAX_ENTRIES_);
  }
  writeJsonPath_('audit_log.json', log, ctx);
}

// 導師異動歷史（tutorHistory.json，扁平陣列；Ticket C）。比照 appendAuditLog_ 的寫法：
// 讀→push→寫回。**必須在與班級寫入同一個 withLock_ 臨界區內呼叫**（LockService 全域鎖，
// 同臨界區可連續寫多個檔案；本函式自己不拿鎖——withLock_ 不可重入，內部再取鎖會卡死）。
// entries 為陣列（匯入一批可能多筆，單筆呼叫端包成 [entry]），空陣列直接 no-op 不碰檔案。
function appendTutorHistory_(ctx, entries) {
  if (!entries || !entries.length) return;
  let hist = readJsonSafe_('tutorHistory.json', ctx, []);
  if (!Array.isArray(hist)) hist = [];
  entries.forEach(function (e) { hist.push(e); });
  writeJsonPath_('tutorHistory.json', hist, ctx);
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
// - deptAssistantOf：config.deptAssistants（**系辦助理**，與學諮中心的 staffAssistant 是兩回事）
//   陣列命中且未停用/未刪除時，回該筆的 deptIds **交集現存且啟用的系所**——名單裡掛著的系所
//   若被停用或軟刪除，就地從授權集合消失（fail-closed，比照 deptHeadOf 的既有判斷）。
//   一人可掛多系（技職所/師培中心有跨單位的情況）。這個集合是「系辦助理看得到哪些系」的
//   **唯一事實來源**：所有 deptRoster* action 一律拿它重新驗證前端送來的 deptId，不信任前端。
// - isSafetyOfficer：config.safetyOfficers（**校安人員**，2026-08-18 新增）。這是一個
//   **全校唯讀**的角色：危機或緊急事件時要立刻聯絡得到導師，所以看得到全部系所的名冊
//   **含私人手機**；相對的，任何寫入一律不給（見 resolveDeptRosterScope_ 與
//   resolveDeptRosterReadScope_ 的分工——寫入路徑那支不認這個角色）。
//   刻意**不**把它併進 deptAssistantOf：那個集合是「可以維護哪些系」的意思，混進來就會
//   讓校安人員沿著助理的寫入路徑一路通行。
function resolveRoles_(email, config, departments, classes) {
  const roles = {
    email: email, isAdmin: false, isDirector: false,
    isStaffLead: false, isStaffAssistant: false, assistantLead: null,
    isSafetyOfficer: false,
    deptHeadOf: [], tutorOf: [], deptAssistantOf: [],
  };
  if (!email) return roles;

  if (typeof BOOTSTRAP_ADMINS !== 'undefined' && BOOTSTRAP_ADMINS.indexOf(email) !== -1) {
    roles.isAdmin = true;
  }

  // 軟刪除（deleted:true）帳號/系所視同不存在，一律不賦予角色——比照 disabled 的既有
  // fail-closed 判斷點，就地加上 deleted 檢查（見 Ticket B：六類實體軟刪除）。
  const u = config && config.users && config.users[email];
  if (u && u.disabled !== true && u.deleted !== true) {
    if (u.role === 'admin') roles.isAdmin = true;
    if (u.role === 'director') roles.isDirector = true;
  }

  const staffLeads = (config && config.staffLeads) || [];
  const staffAssistants = (config && config.staffAssistants) || [];
  const lead = staffLeads.filter(function (s) { return s && s.email === email && s.disabled !== true && s.deleted !== true; })[0];
  if (lead) {
    roles.isStaffLead = true;
    // 學諮中心主責＝系統最大權限（2026-08-11 使用者決策）：主責看得到、也做得到 admin 的一切。
    // 刻意寫成「主責 ⇒ isAdmin」單一條規則，而不是在每個閘門各補一個 `|| roles.isStaffLead`：
    // 本系統是 default-deny，逐點補會漏掉日後新增的 action（漏了＝主責少看到一頁），
    // 也讓「誰有權限」散在幾十處無法一眼確認。代價要講清楚——主責因此同時獲得
    //   ①resolveActionableStage_ 的 admin override（可代核/代退**任何一關**，含導師關與系主任關）
    //   ②職員帳號與系辦助理帳號的管理權（可新增管理員、可把助理密碼重設為分機）
    //   ③全部系所的名冊讀取權（deptRosterGet 走 isAdmin 分支，含私人手機）
    // 要收回其中任何一項，就不能靠這一行，得改成該閘門自己判斷 isStaffLead。
    roles.isAdmin = true;
  }
  const assistant = staffAssistants.filter(function (s) { return s && s.email === email && s.disabled !== true && s.deleted !== true; })[0];
  if (assistant) {
    roles.isStaffAssistant = true;
    const boundLead = staffLeads.filter(function (s) { return s && s.email === assistant.leadEmail && s.disabled !== true && s.deleted !== true; })[0];
    roles.assistantLead = boundLead ? { email: boundLead.email, name: boundLead.name } : null;
  }

  // 系辦助理白名單：帳號那筆要未停用/未刪除，掛的系所也要現存且啟用，兩層都通過才進集合。
  const deptAssistants = (config && config.deptAssistants) || [];
  const da = deptAssistants.filter(function (s) { return s && s.email === email && s.disabled !== true && s.deleted !== true; })[0];
  if (da) {
    const ids = Array.isArray(da.deptIds) ? da.deptIds : [];
    ids.forEach(function (id) {
      const d = (departments || []).filter(function (x) { return x && x.id === id; })[0];
      if (d && d.active !== false && d.deleted !== true && roles.deptAssistantOf.indexOf(id) === -1) {
        roles.deptAssistantOf.push(id);
      }
    });
  }

  // 校安人員：單一布林，沒有系所範圍（緊急聯繫本來就不分系）。停用/軟刪除即失效。
  const so = ((config && config.safetyOfficers) || [])
    .filter(function (s) { return s && s.email === email && s.disabled !== true && s.deleted !== true; })[0];
  if (so) roles.isSafetyOfficer = true;

  (departments || []).forEach(function (d) {
    if (d && d.headEmail === email && d.active !== false && d.deleted !== true) roles.deptHeadOf.push(d.id);
  });
  (classes || []).forEach(function (c) {
    if (!c || c.active === false) return;
    if (isClassTutor_(c, email)) roles.tutorOf.push(c.id);
  });

  return roles;
}

// 全域登入閘門的判斷本體：回 null＝放行，回 {code,message}＝擋下。
// 政策說明與「為什麼放在 doPost 單一位置」見 DEFAULT_ACCESS_ALLOW_ROLES_ 上方那段。
//
// fail-closed 的三個面向：
//   ① `accessMode` 只有**明確等於 'open'** 才開放——缺值、拼錯、被誤刪一律視為關閉。
//      反過來（缺值＝開放）會讓「設定檔壞掉」變成「大門敞開」，那是最糟的失效方向。
//   ② config.json 讀不到時 readJsonSafe_ 回空設定 → 同樣是關閉，但 BOOTSTRAP_ADMINS 的判斷
//      不依賴 config，所以維護者永遠進得來把系統修回來。這正是那份硬編碼名單存在的理由。
//   ③ 被擋的請求**不寫 audit_log**：那等於讓任何未授權的人都能觸發一次帶 LockService 的寫入。
function checkSystemAccess_(email, ctx) {
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const settings = (config && config.settings) || {};
  if (settings.accessMode === 'open') return null;

  const configured = settings.accessAllowRoles;
  const allow = (Array.isArray(configured) && configured.length) ? configured : DEFAULT_ACCESS_ALLOW_ROLES_;
  // 'anyone' ＝ 關閉之前的原始行為（任何通過認證的帳號）。保留這個鍵是為了緊急恢復：
  // 不必改程式碼、不必重新部署，改一個設定就能把系統開回原樣。
  if (allow.indexOf('anyone') !== -1) return null;

  const departments = readJsonSafe_('departments.json', ctx, []);
  // classes.json 是這裡面最大的一個檔（300+ 班），只為了算 tutorOf 就讓**每個請求**多讀一次
  // 並不划算，所以預設傳 []。寫成條件讀取而不是固定傳 [] 是重點：固定傳 [] 的話，日後有人
  // 在設定裡加了 'tutor'，tutorOf 會永遠是空的，導師被安靜地擋在外面而設定看起來是對的。
  const classes = (allow.indexOf('tutor') !== -1) ? readJsonSafe_('classes.json', ctx, []) : [];
  const roles = resolveRoles_(email, config, departments, classes);

  const has = {
    admin:          !!roles.isAdmin,            // 含 BOOTSTRAP_ADMINS 與「主責 ⇒ isAdmin」
    director:       !!roles.isDirector,
    staffLead:      !!roles.isStaffLead,
    staffAssistant: !!roles.isStaffAssistant,
    deptAssistant:  (roles.deptAssistantOf || []).length > 0,
    safetyOfficer:  !!roles.isSafetyOfficer,
    deptHead:       (roles.deptHeadOf || []).length > 0,
    tutor:          (roles.tutorOf || []).length > 0,
  };
  for (let i = 0; i < allow.length; i++) {
    if (has[allow[i]] === true) return null;
  }
  return {
    code: 'AccessRestricted',
    message: (typeof settings.accessMessage === 'string' && settings.accessMessage.trim())
      ? settings.accessMessage.trim() : DEFAULT_ACCESS_DENIED_MESSAGE_,
  };
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
// 導師聯絡方式（tutors[].ext 校內分機／tutors[].mobile 私人手機，以及 2026-08-11 之前的
// 單一欄位 phone）**一律不進 bootstrap**——
// bootstrap 的 classes 是每一個登入者（含任何 Google 帳號的學生）都拿得到的，
// 手機留在裡面就等於全校可讀。要看它們只有一條路：deptRosterGet（後端按系所驗權限）。
// 分機雖然是校內公開資訊，也一起拔掉：同一組欄位走同一條通道，不留「這欄可以、那欄不行」
// 的判斷空間。
// 這裡對**所有角色含 admin** 都拔掉，讓「bootstrap 的 classes 沒有 phone」成為一條無例外的
// 不變量——有例外就會有人依賴例外，然後某天例外變成漏洞。
// 實作刻意**內聯**在 sanitizeClassesForViewer_ 裡而不是抽成 helper：抽出去的話，
// test/harness.js 每個載入 sanitizeClassesForViewer_ 的測試都得記得一起載那個 helper，
// 忘了就 ReferenceError——把不變量放在同一個函式裡，就不會有人漏掉它。
function sanitizeClassesForViewer_(classes, roles) {
  return (classes || []).map(function (c0) {
    let c = c0;
    if (c && c.tutors && c.tutors.length) {
      c = Object.assign({}, c0);
      c.tutors = c0.tutors.map(function (t) {
        if (!t || (t.phone === undefined && t.ext === undefined && t.mobile === undefined)) return t;
        const t2 = Object.assign({}, t);
        delete t2.phone;
        delete t2.ext;
        delete t2.mobile;
        return t2;
      });
    }
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

// 系所的「主任導師」（＝系主任）聯絡方式，比照導師的 ext/mobile：**一律不進 bootstrap**。
// departments 是每個登入者都拿得到的（前端要用它顯示系所名稱），主任的私人手機留在裡面
// 等於全校可讀。要看它只有 deptRosterGet 一條路。headName/headEmail 照舊保留——
// 那是核章身分（resolveRoles_ 的 deptHeadOf 靠 headEmail 命中），且是校內公開資訊。
function sanitizeDepartmentsForViewer_(departments) {
  return (departments || []).map(function (d) {
    if (!d || !d.head) return d;
    const copy = Object.assign({}, d);
    copy.head = { name: d.head.name || '', email: d.head.email || '' };
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
// 家族→「系簡+導師名+家族」（導師名優先取呼叫端的 tutorName，未帶則從班名「家族+姓名」取）；
// 技優/產訓/產專/海青等已知但無法歸入上述規則的前綴→前綴保留、系簡插入其後；
// 完全無法判別 → 直接「系簡+原名」。純字串規則，不查資料庫，僅供 UI 預填建議值。
// 注意：dev/index.html 匯入解析器區有一份同邏輯前端複本 fuseClassDisplayNameFront（匯入預覽
// 預填「簡稱」欄用），改動本規則時兩處同步（比照 CLASS_NAME_RE ↔ IMPORT_CLASS_NAME_RE_ 的先例；
// test/import-parser.test.js 有 parity 測試抽出兩版比對輸出，漂移即紅燈）。
function deptShortName_(deptName) {
  const n = String(deptName || '').trim();
  return (n.length > 1 && n.slice(-1) === '系') ? n.slice(0, -1) : n;
}

function fuseClassDisplayName_(className, deptName, systemId, tutorName) {
  const name = String(className || '').trim();
  const short = deptShortName_(deptName);
  if (!name) return short;
  if (name.indexOf('家族') !== -1) {
    // 家族班顯示名＝「系簡稱＋導師姓名＋家族」（2026-08-07 使用者指定，取代原本的
    // 「系簡稱＋家族(導師姓名)」）。導師姓名優先用呼叫端帶的 tutorName；未帶則從班名取——
    // 統計表解析器產出的家族班名本身就是「家族＋姓名」（如 家族陳美惠 → 陳美惠），
    // 這也是家族班在 (deptId, 班名) 身分下能每位導師各自一班的原因。兩者皆無姓名可用時
    // 才退回不含姓名的「系簡稱＋家族」。
    const who = String(tutorName || '').trim() || name.split('家族').join('').trim();
    return who ? (short + who + '家族') : (short + '家族');
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

// ── displayName 全校 canonical 簡稱正規化（2026-07 教務處簡稱對齊，使用者逐條裁決）────────
// 與上面的 fuseClassDisplayName_（新班融合建議值）是兩件事：fuseClassDisplayName_ 只負責
// 「從原始班名生出一個建議顯示名」；這裡是「把已存在（剛融合出的、或使用者填的、或既有資料庫
// 裡本來就有）的 displayName 收斂到全校統一的系所簡稱／碩士班班別字母規則」，在
// importRosterRow_ 匯入一列時對新班融合值與既有班沿用值/使用者填的 classDisplayName 一律
// 過一次自動套用；scripts/migrate-display-name-canonical.mjs 對既有資料做一次性遷移時
// 透過 test/harness.js 直接抽出這幾個函式共用同一份規則，不會與程式邏輯分岔。
// 只動顯示字串——不動 deptId/name/systemId，班級身分（(deptId, name)）與 records 的 classId
// 關聯完全不受影響。
//
// 系所簡稱覆寫表：只有以下 7 個系所的簡稱會變動，其餘系所簡稱維持現行不動；覆寫只替換
// displayName 裡「該系所現行簡稱子字串」（= deptShortName_(dept.name) 的產出）本身，
// 不影響其前後的學制前綴／年級／班別字母：
//   動疫所→動疫科技、EMBA (進)→EMBA、智慧機電學程→智慧機電、財金學程→財金、
//   科技農業→科農、材料工程系→材料、客研所→客家。
function classDisplayNameDeptOverride_(deptName) {
  const OVERRIDES = {
    '動疫所': '動疫科技',
    'EMBA (進)': 'EMBA',
    '智慧機電學程': '智慧機電',
    '財金學程': '財金',
    '科技農業': '科農',
    '材料工程系': '材料',
    '客研所': '客家',
  };
  return OVERRIDES[String(deptName || '').trim()] || null;
}

// 技優/產訓/產專/海青 前綴班（與 fuseClassDisplayName_ 的 otherPrefixes 同一份清單）完全跳過
// 本正規化——使用者明定維持 tutorsys 現行的 infix 顯示樣式，不套用系所簡稱覆寫、也不補碩士班
// 班別字母。
//
// **家族班自 2026-08-07 起不再受保護**（使用者裁決改案）。原本 7/18 的裁決把家族班一起列入
// 保護，但那次的上下文是「家族班沒有年級班別可言，前綴/班別字母不要亂動」，系所簡稱覆寫是被
// 連帶包進來的，不是刻意。簡稱覆寫的用意是對齊教務處的全校統一簡稱，那是**系所層級的事實**，
// 與班級是不是家族班無關；留著保護會產生同一系所內不一致的怪現象（`四材料一A` 用新簡稱、
// `材料工程X家族` 用舊簡稱）。家族班本來就不是 systemId==='master'，所以放行後也不會被補上
// 班別字母，只會套用簡稱覆寫。影響 61 個家族班裡的 9 個（動疫所 7、材料工程系 2），
// 其餘系所無覆寫規則、結果不變。
function isProtectedClassForDisplayNameNormalization_(rawClassName, systemId) {
  const name = String(rawClassName || '').trim();
  const protectedPrefixes = ['技優', '產訓', '產專', '海青'];
  for (let i = 0; i < protectedPrefixes.length; i++) {
    if (name.indexOf(protectedPrefixes[i]) === 0) return true;
  }
  return false;
}

// 回傳 { value, changed, matched }：
// - matched:false → 該系所理論上有簡稱覆寫規則，但在現有 displayName 裡既找不到預期的現行
//   簡稱子字串、也不是已經套用過覆寫值的 canonical 狀態（多半是已被人工改成自訂顯示名的
//   班級），本函式不猜測替換方式，原樣保留（value===displayName、changed:false），由呼叫端
//   記錄下來供人工複核，不自行發明規則。
// - 已經是 canonical 狀態（displayName 已含覆寫值）→ matched:true、changed:false，
//   確保本函式對已收斂過的資料重複執行是 idempotent（不會誤判成「找不到、需人工複核」）。
// - systemId==='master'（碩士班，不含碩專 master_inservice）：displayName 結尾若不是英文
//   字母才補一個 'A'（碩農園一→碩農園一A）；結尾已經是字母（A-Z）者維持現狀不動。
// - systemId==='master_inservice'（碩專）：只套用系所簡稱覆寫（若適用），前綴/班別字母不動
//   （現行資料前綴皆已是「碩專」開頭、字母已依單班/多班現狀標示，使用者裁決維持現狀）。
function normalizeClassDisplayName_(displayName, deptName, systemId, rawClassName) {
  const current = String(displayName || '').trim();
  if (!current) return { value: current, changed: false, matched: true };
  if (isProtectedClassForDisplayNameNormalization_(rawClassName, systemId)) {
    return { value: current, changed: false, matched: true };
  }
  let next = current;
  let matched = true;
  const override = classDisplayNameDeptOverride_(deptName);
  if (override) {
    const fromShort = deptShortName_(deptName);
    if (fromShort && next.indexOf(fromShort) !== -1) {
      next = next.split(fromShort).join(override);
    } else if (next.indexOf(override) !== -1) {
      // 已經是套用過覆寫值的 canonical 狀態（例如遷移腳本重複執行、或本來就已手動改好）——
      // 沒有現行簡稱子字串可替換是正常狀況，不算「找不到」。
      matched = true;
    } else {
      matched = false;
    }
  }
  if (matched && systemId === 'master' && !/[A-Za-z]$/.test(next)) {
    next = next + 'A';
  }
  return { value: next, changed: next !== current, matched: matched };
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
// semesterId（選填）：查歷史學期時，班名以 classNameForSemester_ 解析（升級改名後看舊學期
// 統計仍顯示當時的班名）；未帶則用現行 displayName||name。
function overviewStats_(colleges, departments, classes, tutorSystems, records, keywordTopicKeys, semesterId) {
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

  // 統計納入規則（Ticket D 調整）：現役未刪一律納入；畢業班（升級時 active:false＋
  // graduatedSemester）在其在學學期（查詢學期 ≤ graduatedSemester，NNN-N 定寬字串比較）
  // 仍納入——升級後查歷史學期看得到當時的畢業班（含未繳交者）。手動停用班維持既有
  // 排除行為；已刪除班一律排除。
  return (classes || []).filter(function (c) {
    if (!c || c.deleted === true) return false;
    if (c.active !== false) return true;
    return !!(c.graduatedSemester && semesterId && String(semesterId) <= String(c.graduatedSemester));
  }).map(function (c) {
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
      displayName: classNameForSemester_(c, semesterId),
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
    if (!dept || dept.active === false || dept.deleted === true) return { ok: false, error: 'department not found: ' + params.deptId };
  } else {
    if (!isValidDeptName_(params.deptName)) return { ok: false, error: 'invalid deptName' };
    const name = String(params.deptName).trim();
    // 以名稱完全比對既有系所（含 inactive/deleted 也算命中，避免重複建同名系所）。
    dept = (departments || []).filter(function (d) { return d && d.name === name; })[0];
    // 命中已停用/已刪除系所一律拒絕（fail-closed）：停用/刪除是管理員下架垃圾/濫用 chip 的
    // 唯一手段，若在此放行，重打同名即可繞過；命中後拒絕也同時避免落到「建同名新系所」分支。
    if (dept && (dept.active === false || dept.deleted === true)) return { ok: false, error: 'department disabled: ' + dept.id };
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
  // 命中已停用/已刪除班級一律拒絕（fail-closed，理由同上：防重打同名繞過停用/刪除）。
  if (cls && (cls.active === false || cls.deleted === true)) return { ok: false, error: 'class disabled: ' + cls.id };
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

// ── 導師歷史＋期中更換導師（Ticket C，純函式區）──────────────────────────────
// tutorHistory.json = 扁平陣列，每筆 { classId, semester, changeType, effectiveDate,
// previousTutors, tutors, classNameAtTime, note, at, by }。changeType：
// 'manual'（後台編輯班級改名單）/ 'midterm'（期中更換，effectiveDate 必填）/
// 'import'（Excel 匯入覆蓋名單）/ 'rollover'（升級帶入，保留給未來學期滾動功能）。

// 導師名單是否有異動：長度或任一位置的 name/email 不同即 true（順序視為有意義——
// 導師 1/導師 2 槽位對調也算異動，照實記錄）。
function tutorsDiffer_(a, b) {
  const x = a || [], y = b || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) {
    const p = x[i] || {}, q = y[i] || {};
    if (p.name !== q.name || p.email !== q.email) return true;
  }
  return false;
}

// 組一筆 tutorHistory entry（cls 為「異動後」的班級物件；快照只留 name/email，
// 不帶其他欄位進歷史檔）。
function buildTutorHistoryEntry_(cls, previousTutors, changeType, effectiveDate, note, semesterId, byEmail, now) {
  return {
    classId: cls.id,
    semester: semesterId || null,
    changeType: changeType,
    effectiveDate: effectiveDate || null,
    previousTutors: (previousTutors || []).map(function (t) { return { name: (t && t.name) || '', email: (t && t.email) || '' }; }),
    tutors: (cls.tutors || []).map(function (t) { return { name: (t && t.name) || '', email: (t && t.email) || '' }; }),
    classNameAtTime: cls.displayName || cls.name,
    note: note || null,
    at: now,
    by: byEmail,
  };
}

// 期中更換導師的輸入驗證（純函式，供 adminChangeTutorMidtermAction_ 與單元測試共用）：
// - classId 必須存在且未被軟刪除（deleted!==true，fail-closed）；inactive（停用）允許——
//   停用班也可能需要正名單。
// - effectiveDate 必填、格式 YYYY-MM-DD 且為真實存在的日期（2 月 30 日之類拒絕）。
// - newTutors 1~2 位；name 走與匯入/自填建議相同的白名單 regex；email 必填（期中更換是
//   正式名單、核章授權以 email 比對，不可空）且過標準格式檢查、轉小寫。
// - note 選填、必須是字串、長度 ≤200。
// 回傳 { ok:true, cls, tutors, note } 或 { ok:false, error }。
function validateMidtermChange_(params, classes) {
  const classId = params && params.classId;
  if (!classId) return { ok: false, error: 'classId required' };
  const cls = (classes || []).filter(function (c) { return c && c.id === classId; })[0];
  if (!cls || cls.deleted === true) return { ok: false, error: 'class not found: ' + classId };

  const ed = params.effectiveDate;
  if (typeof ed !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ed)) return { ok: false, error: 'invalid effectiveDate' };
  const y = Number(ed.slice(0, 4)), m = Number(ed.slice(5, 7)), d = Number(ed.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: 'invalid effectiveDate' };
  }

  const list = params.newTutors;
  if (!Array.isArray(list) || list.length < 1 || list.length > 2) return { ok: false, error: 'newTutors must contain 1-2 tutors' };
  const tutors = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t || typeof t.name !== 'string') return { ok: false, error: 'invalid tutor name' };
    const name = t.name.trim();
    if (!/^[A-Za-z0-9一-鿿·\s]{1,20}$/.test(name)) return { ok: false, error: 'invalid tutor name' };
    const email = String(t.email === undefined || t.email === null ? '' : t.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid tutor email' };
    tutors.push({ name: name, email: email });
  }

  let note = null;
  if (params.note !== undefined && params.note !== null && params.note !== '') {
    if (typeof params.note !== 'string') return { ok: false, error: 'invalid note' };
    if (params.note.length > 200) return { ok: false, error: 'note too long (max 200)' };
    note = params.note;
  }

  return { ok: true, cls: cls, tutors: tutors, note: note };
}

// 導師歷史可視權限（default-deny）：admin / director / staffLead / staffAssistant 任何班；
// 系主任限本系（deptHeadOf 含該班 deptId）；導師限自班（tutorOf 含該 classId）；
// 其他（含一般學生）一律拒絕。墓碑班級（deleted）也走同一套判斷——歷史正是刪除後
// 還要查的東西（注意 resolveRoles_ 對 inactive 班不給 tutorOf，該情境導師需請 admin 代查）。
function canViewTutorHistory_(roles, classInfo) {
  if (!roles || !classInfo) return false;
  if (roles.isAdmin || roles.isDirector || roles.isStaffLead || roles.isStaffAssistant) return true;
  if ((roles.deptHeadOf || []).indexOf(classInfo.deptId) !== -1) return true;
  if ((roles.tutorOf || []).indexOf(classInfo.id) !== -1) return true;
  return false;
}

// ── 換學期帶入＋年級升級（Ticket D，純函式區；2026-08-11 事故後改為席位式）───────
// 班級實體 = 席位（同一系每個年級的班名同時並存，如 四技一A~四技四A 全年都在），
// 不是「一屆學生」（cohort）。升級的本質是「導師跟著這屆學生換到下一個年級的班」——
// **不改班名、不畢業任何班**：originally（2026-08-11 前）的 cohort 式邏輯把「改名往上推＋
// 最高年級 graduate 停用」當升級，套到席位式資料上必然撞名（目標班名本來就已經有人在用），
// 撞名列進 errors 但不中斷整批，結果是 200 列失敗、104 列已經寫進正式資料（99 班被停用+
// 畢業註記、5 班被改名）。改版後：畢業＝admin 另外手動停用該屆最高年級班，不由 rollover
// 自動判斷；action 只有 inherit（導師從低一個年級的席位接手）／vacate（新生席位，原導師
// 隨學生升上去、本班待指派新導師）／keep（原樣不動）。管理員按鈕觸發、預覽逐列顯示、
// 確認才套用；套用（applyRolloverPlan_）是**全有全無**，任何一列有問題就整批不寫
// （見該函式註解）。

const GRADE_CHARS_ = ['一', '二', '三', '四', '五', '六', '七'];

// 依 prefix 的內建修業年限預設表（resolveDuration_ 第三順位；prefix 精確比對）。
const DURATION_BY_PREFIX_ = { '四技': 4, '四技進': 4, '技優': 4, '產專': 4, '產訓': 4, '碩': 2, '碩專': 2, '博': 4 };

// 解析班名中的年級：結尾為「年級字（一~七）＋選填班別字母」才算，回
// { prefix, grade(1-7), section }；「家族」「海青班」「三A、四A共同指導」等
// 非年級班名回 null（升級規劃時 keep 不動）。
function parseClassGrade_(name) {
  const m = /^(.*?)([一二三四五六七])([A-Za-z]?)$/.exec(String(name || ''));
  if (!m) return null;
  return { prefix: m[1], grade: GRADE_CHARS_.indexOf(m[2]) + 1, section: m[3] || '' };
}

// 修業年限解析鏈（fail-open 為 null，讓規劃端標 uncertain 交 admin 人工確認）：
// 班級層級覆寫 graduationGrade（獸醫系四技五年制填 5）→ 制度 durationYears →
// 依 parse 出的 prefix 查內建預設表 → null。
function resolveDuration_(cls, system, parsed) {
  if (cls && typeof cls.graduationGrade === 'number' && cls.graduationGrade >= 1 && cls.graduationGrade <= 7) {
    return cls.graduationGrade;
  }
  if (system && typeof system.durationYears === 'number' && system.durationYears >= 1 && system.durationYears <= 7) {
    return system.durationYears;
  }
  if (parsed && Object.prototype.hasOwnProperty.call(DURATION_BY_PREFIX_, parsed.prefix)) {
    return DURATION_BY_PREFIX_[parsed.prefix];
  }
  return null;
}

// 產生升級規劃（預覽用，不寫入）：逐班判斷 inherit（導師從低一個年級的席位接手）/
// vacate（新生席位：原導師隨學生升上去，本班待指派）/ keep（原樣保留）。年差
// dy = 學年(to) - 學年(from)：dy ≤ 0（同學年換學期、或選反）全部 keep——名單本來就掛在
// 班上自動沿用，無事可做。只納入 active 且未刪除的班。決策順序見函式內註解（先命中先回，
// 這個順序本身就是規格，別為了「看起來更省」重排）。
// 注意：displayName 刻意不重算（沿用 c.displayName）——fuseClassDisplayName_ 只有「家族」
// 那條分支會用到導師姓名，而家族班在第 2 條就一律 keep，班名也從不改變，沒有需要重算的情況。
//
// ── cascade（2026-08-13 修：gate 4 問錯問題）───────────────────────────────
// 第一輪的 gate 4（規則 4）只檢查「目標席位存在嗎」，但存在不代表它這次真的會接手——
// 目標席位自己也可能因為它的目標/來源不齊而被判 keep。用正式資料骨架實跑過：某系有
// 一B/二B/三B 但沒有四B（duration 4）→ 三B 被 gate 4 正確擋成 keep+uncertain，但二B
// 看到「三B 存在」就放行 inherit——二B 原本的導師被「其實不會接手」的三B 拒收，憑空消失；
// 一B 同理被 vacate 掉。降級會像骨牌一樣往下傳染（三B keep → 二B keep → 一B keep），
// 所以第一輪算完之後要反覆掃描到不動點（fixed point），不能只掃一輪——這正是下面
// cascadeDowngrade_ 在做的事：任一列 R 若會動（inherit/vacate）、現在有導師、不是畢業，
// 而它指望接手的目標列 T 這次並不會真的接手（T 不存在、T 不是 inherit、或 T 的來源
// 不是 R），就把 R 也降回 keep+uncertain。跑完之後，預設 plan 本身就是自洽的：沒有任何
// 一列會讓導師無人接手。
function computeRolloverPlan_(classes, departments, tutorSystems, fromId, toId) {
  const deptById = {};
  (departments || []).forEach(function (d) { if (d) deptById[d.id] = d; });
  const sysById = {};
  (tutorSystems || []).forEach(function (s) { if (s) sysById[s.id] = s; });
  // 年差 = 學年(to) - 學年(from)；semester id 為 NNN-N（呼叫端已過 requireValidSemester_），
  // 任一邊解析失敗保守視為 0（全部 keep，fail-closed 不動任何班）。
  const fromYear = Number(String(fromId || '').slice(0, 3));
  const toYear = Number(String(toId || '').slice(0, 3));
  const dy = (isNaN(fromYear) || isNaN(toYear)) ? 0 : toYear - fromYear;

  const active = (classes || []).filter(function (c) { return c && c.active !== false && c.deleted !== true; });

  // 依 (deptId, name) 查現存席位——只查 active（停用/刪除的班一律視同不存在，見規格
  // 案例 7：這正是「來源班存在但被停用」要落到 keep+uncertain 而非誤接手的原因）。
  function findByName(deptId, name) {
    if (!name) return null;
    return active.filter(function (c) { return c.deptId === deptId && c.name === name; })[0] || null;
  }
  // 依 prefix/section 组回某個年級的班名；grade 落在 1..7（GRADE_CHARS_ 範圍）外一律
  // 算不出（回 null），呼叫端自行決定 null 時的措辭與後續判斷。
  function gradeName(prefix, section, grade) {
    if (grade < 1 || grade > GRADE_CHARS_.length) return null;
    return prefix + GRADE_CHARS_[grade - 1] + section;
  }

  const rows = active.map(function (c) {
    const dept = deptById[c.deptId];
    const deptNameStr = dept ? dept.name : c.deptId;
    const system = sysById[c.systemId];
    const parsed = parseClassGrade_(c.name);
    const duration = resolveDuration_(c, system, parsed);
    const tutorNames = (c.tutors || []).map(function (t) { return (t && t.name) || ''; });

    const row = {
      classId: c.id, deptId: c.deptId, deptName: deptNameStr,
      name: c.name, displayName: c.displayName || c.name,
      tutors: tutorNames,
      grade: parsed ? parsed.grade : null, sourceGrade: null,
      sourceClassId: null, sourceName: null, sourceTutors: [],
      targetName: null, targetClassId: null, graduating: false,
      duration: duration,
      action: 'keep', alreadyDone: false,
      uncertain: false, reason: null,
    };

    // 0. dy ≤ 0：同學年換學期、或選反，名單本來就掛在班上自動沿用，全部 keep。
    if (dy <= 0) {
      row.reason = '同學年換學期，導師沿用';
      return row;
    }
    // 1. 冪等守門：這班「這個學年」已經做過一次升級就不重複執行——比對學年（前三碼）
    //    而非完整學期 id：「同一學年內又被推一次」（例：114-2→115-1 做完後又跑
    //    114-2→115-2）是很自然的誤操作，且預覽會看起來完全正常（一堆 inherit）。
    //    解析失敗（rolloverSemester 格式不明）保守退回完整字串比對。
    if (c.rolloverSemester) {
      const doneYear = Number(String(c.rolloverSemester).slice(0, 3));
      const isDone = isNaN(doneYear) ? (c.rolloverSemester === toId) : (doneYear >= toYear);
      if (isDone) {
        row.alreadyDone = true;
        row.reason = '已於 ' + c.rolloverSemester + ' 完成升級，同一學年不重複執行';
        return row;
      }
    }
    // 2. 非年級班（家族／專班等）：parseClassGrade_ 回 null，或班名含「家族」。
    //    「家族」要另外擋是因為導師姓名結尾若剛好是年級字（一~七），例如導師姓「大三」
    //    的家族班「家族林大三」，parseClassGrade_ 光看結尾字元會誤判成年級 3、不會回 null。
    if (String(c.name || '').indexOf('家族') !== -1 || !parsed) {
      row.reason = '非年級班（家族／專班等），導師不隨學年異動';
      return row;
    }

    row.sourceGrade = parsed.grade - dy;
    const targetGrade = parsed.grade + dy;
    row.targetName = gradeName(parsed.prefix, parsed.section, targetGrade);
    const sourceName = gradeName(parsed.prefix, parsed.section, row.sourceGrade);
    row.sourceName = row.sourceGrade >= 1 ? sourceName : null;
    const target = findByName(c.deptId, row.targetName);
    row.targetClassId = target ? target.id : null;
    // 本班學生讀完了、本來就沒有去處（例如四技四A升五年級但制度只有四年）——
    // duration 未知時一律視為「不確定畢業與否」，不能當成畢業例外放行。
    row.graduating = (duration !== null && targetGrade > duration);

    // 4. 導師去處守門：本班現在有導師、不是畢業，卻連目標席位這個班都不存在
    //    → 不能悄悄 vacate/inherit 到一個不存在的班。這只是「存在性」的第一關；
    //    「存在但這次不會真的接手」由函式最後的 cascadeDowngrade_ 補上（見上方函式頂端註解）。
    if (tutorNames.length && !row.graduating && !target) {
      row.action = 'keep';
      row.uncertain = true;
      row.reason = (row.targetName ? '找不到學生要升上去的班「' + row.targetName + '」' : '算不出升上去的班') +
        '，現任導師會變成沒班可帶，請先建立該班或設定修業年限後再執行。';
      return row;
    }

    // 5. 新生席位（sourceGrade < 1）：本班學生不是從系上既有班升上來的（剛入學）。
    if (row.sourceGrade < 1) {
      if (!tutorNames.length) {
        row.reason = '新生班，目前無導師，待指派';
        return row;
      }
      row.action = 'vacate';
      row.reason = '新生班：原導師隨學生升上「' + (row.targetName || '（無法判定）') + '」，本班導師待指派';
      return row;
    }

    // 6. 找不到來源班：無法決定由誰接手（沒有第 4 條那種「導師消失」風險——本班現在的
    //    導師還在原位，只是不知道要接手的名單掛在哪，交 admin 人工判斷）。
    const source = findByName(c.deptId, sourceName);
    if (!source) {
      row.action = 'keep';
      row.uncertain = true;
      row.reason = '找不到來源班「' + sourceName + '」，無法決定由誰接手——請確認名冊或手動指派';
      return row;
    }

    // 7. 由來源班（低一個年級的席位）的導師接手。
    row.action = 'inherit';
    row.sourceClassId = source.id;
    row.sourceTutors = (source.tutors || []).map(function (t) { return (t && t.name) || ''; });
    if (!row.sourceTutors.length) {
      row.uncertain = true;
      row.reason = '來源班「' + sourceName + '」目前沒有導師，接手後本班將無導師';
    } else {
      row.reason = '由「' + sourceName + '」的導師接手（學生升上來）';
    }
    return row;
  });

  return cascadeDowngrade_(rows);
}

// 把第一輪算完的 rows 收斂到不動點：任一列 R 會動（inherit/vacate）、現在有導師、
// 不是畢業，但它指望接手的目標列 T 這次並不會真的接手（不存在／T 不是 inherit／
// T 的來源不是 R）→ 把 R 也降回 keep+uncertain。降級會像骨牌一樣往下傳染（見函式
// computeRolloverPlan_ 頂端註解的三B/二B/一B 例子），所以要反覆掃描直到某一輪完全
// 沒有變動才停止；GRADE_CHARS_.length + 1 輪是保險上限（鏈最長不會超過年級字表長度），
// 正常情況下遠遠掃不到那麼多輪就會收斂。就地修改傳入的 rows（呼叫端每次都是全新陣列，
// 沒有外部別名疑慮）。
// 兩個方向都會把某一列降回 keep，且都要在同一個不動點迴圈裡跑——單掃一個方向不會收斂
// （下游降級可能讓某列失去接收者、觸發上游降級；上游降級也可能讓某列的目標不再合格、
// 觸發下游降級，反之亦然）：
// - 下游方向：R 要動（inherit/vacate）、現在有導師、不是畢業，但它指望接手的目標列 T
//   這次並不會真的接手（見 computeRolloverPlan_ 頂端註解的三B/二B/一B 例子）。
// - 上游方向（2026-08-13 用去識別化正式資料骨架實跑抓到的第二個洞）：R 是 inherit，
//   但它的來源列 S 這次不會交出導師（S 停在 keep，通常是規則 6「S 自己找不到來源」）、
//   而 S 現在確實有導師 → 讓 R 照 plan 接手就會讓同一位導師同時掛在 S 與 R 兩班。
//   S 目前沒有導師則不必降級——接手一份空名單不會造成重複，維持原行為。
// 上限用 rows.length + 1（原本 GRADE_CHARS_.length + 1 在兩個方向交錯降級時可能不夠）：
// 降級是單向的（action 只會往 keep 走、不會回頭），所以最多 rows.length 輪、每輪至少
// 降一列就一定會收斂；真的撞到上限代表邏輯有環或其他 bug，直接 throw，不要靜靜地回一個
// 沒收斂、可能還在自相矛盾的 plan。
function cascadeDowngrade_(rows) {
  const byId = {};
  rows.forEach(function (r) { byId[r.classId] = r; });
  const maxRounds = rows.length + 1;
  let round = 0;
  for (; round < maxRounds; round++) {
    let changed = false;
    rows.forEach(function (r) {
      // 下游方向
      if ((r.action === 'inherit' || r.action === 'vacate') && r.tutors.length && !r.graduating) {
        const t = r.targetClassId ? byId[r.targetClassId] : null;
        const willReceive = t && t.action === 'inherit' && t.sourceClassId === r.classId;
        if (!willReceive) {
          r.action = 'keep';
          r.uncertain = true;
          r.sourceClassId = null;
          r.sourceTutors = [];
          r.reason = '學生要升上去的席位「' + (r.targetName || '（無法判定）') + '」這次不會接手（該班需人工確認），' +
            '現任導師會沒有去處，因此本班保持不動';
          changed = true;
          return; // 這一列這輪已經降級（action 不再是 inherit），不用再檢查上游方向
        }
      }
      // 上游方向
      if (r.action === 'inherit') {
        const srcRow = r.sourceClassId ? byId[r.sourceClassId] : null;
        const srcHandsOver = !!srcRow && (srcRow.action === 'inherit' || srcRow.action === 'vacate');
        if (!srcHandsOver && srcRow && srcRow.tutors.length) {
          const srcName = r.sourceName;
          r.action = 'keep';
          r.uncertain = true;
          r.sourceClassId = null;
          r.sourceTutors = [];
          r.reason = '來源席位「' + (srcName || '（無法判定）') + '」這次不會交出導師（該班需人工確認），' +
            '暫不接手以免同一位導師同時掛兩班';
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  if (round >= maxRounds) {
    throw new Error('cascadeDowngrade_ 未在 ' + maxRounds + ' 輪內收斂（可能有邏輯錯誤，如環狀依賴）——拒絕回傳未收斂的 plan');
  }
  return rows;
}

// 純函式（不碰 I/O，供單元測試就地抽取）：把後端重算的 planRows 與前端確認的 clientRows
// 合成一次「全有全無」的寫入——2026-08-11 事故的教訓正是「失敗列不中斷、成功列照寫」，
// 200 列失敗但 104 列已經寫進正式資料。這裡反過來：**只要 errors 非空就整批放棄**，
// 驗證階段一個字都不准動到 classes，回傳的 classes 與輸入逐位元相同。
// clientRows 只信 classId 與 action，其餘（尤其導師名單）一律從 classes 的原始快照取——
// 每一列的 previousTutors／inherit 來源導師都是從輸入的 classes 陣列直接查（不是從逐步
// 套用中的陣列鏈式往上推），所以套用順序完全不影響結果（見 test 13：clientRows 反序送入
// 結果逐位元相同）。
//
// 每一列允許的動作只有兩個：plan.action 本身，或降級成 keep（見下方逐列驗證）。
// 不准把 plan 判的 keep「升級」成 inherit/vacate——那等於繞過 computeRolloverPlan_ 的所有
// 守門（gate 4／cascadeDowngrade_／來源存在性…），admin 真正該做的是先把資料修好（建缺的
// 席位、設修業年限）再重新產生預覽，不是在 UI 上硬點一個 plan 沒打算給的動作。這條同時
// 關掉一個併發破口：預覽之後別人改動資料、鎖內重算後這列翻成 keep，stale 的 vacate 就會
// 被這條擋下（不然「鎖內重算」形同白做）。
//
// 光是逐列合法還不夠：vacate 與 inherit 是成對的（見 F1 的 cascade），UI／API 都可能只送
// plan 的子集，把本來成對的兩列拆開——例如「二A 接手」被人工改回 keep，但「一A 釋出」
// 照送，逐列驗證兩列都合法，套用後一A 的導師就悄悄不見了。所以逐列驗證全過之後，套用前
// 還有一段全批一致性檢查（R1／R2，見下方），任一條不成立一樣整批 abort。
function applyRolloverPlan_(classes, planRows, clientRows, opts) {
  const errors = [];
  const planById = {};
  (planRows || []).forEach(function (p) { if (p) planById[p.classId] = p; });
  const classById = {};
  (classes || []).forEach(function (c) { if (c) classById[c.id] = c; });
  const seen = {};
  const validRows = [];

  (clientRows || []).forEach(function (row, i) {
    const classId = row && row.classId;
    if (!classId) { errors.push({ row: i, classId: null, error: 'classId required' }); return; }
    if (seen[classId]) { errors.push({ row: i, classId: classId, error: 'duplicate classId: ' + classId }); return; }
    seen[classId] = true;
    const plan = planById[classId];
    if (!plan) { errors.push({ row: i, classId: classId, error: 'class not in plan: ' + classId }); return; }
    const action = row.action;
    if (['inherit', 'vacate', 'keep'].indexOf(action) === -1) {
      errors.push({ row: i, classId: classId, error: 'invalid action: ' + action }); return;
    }
    if (action !== 'keep' && plan.alreadyDone) {
      errors.push({ row: i, classId: classId, error: 'already rolled over to ' + opts.toSemester + ': ' + classId }); return;
    }
    // 只准原樣採用 plan 的動作，或降級成 keep；不准把 plan 的 keep 升級成別的動作。
    if (action !== 'keep' && action !== plan.action) {
      errors.push({ row: i, classId: classId, error: 'action does not match plan (' + plan.action + '): ' + classId }); return;
    }
    if (action === 'inherit') {
      if (!plan.sourceClassId) { errors.push({ row: i, classId: classId, error: 'no source class to inherit from: ' + classId }); return; }
      const srcCls = classById[plan.sourceClassId];
      if (!srcCls || srcCls.deleted === true || srcCls.active === false) {
        errors.push({ row: i, classId: classId, error: 'source class unavailable: ' + plan.sourceClassId }); return;
      }
    }
    validRows.push({ row: i, classId: classId, action: action, plan: plan });
  });

  // 全批一致性檢查（R1/R2）：只在逐列都合法時才跑，跑出的錯誤一樣進 errors 陣列，維持
  // 「全有全無」單一回應形狀。這兩條是 backstop——F1 修好後，預設 plan 全套用不該觸發
  // 它們，只有人工把某幾列降級成 keep、或 API 只送 plan 子集時才會踩到。
  if (!errors.length) {
    const appliedActionByClassId = {};
    validRows.forEach(function (vr) { appliedActionByClassId[vr.classId] = vr.action; });
    const inheritedFromClassId = {};
    validRows.forEach(function (vr) { if (vr.action === 'inherit') inheritedFromClassId[vr.plan.sourceClassId] = true; });

    validRows.forEach(function (vr) {
      // R1（不准掉導師）：本班現在有導師、不是畢業，卻沒有任何一列真的接手它。
      if ((vr.action === 'inherit' || vr.action === 'vacate') && vr.plan.tutors.length && !vr.plan.graduating) {
        if (!inheritedFromClassId[vr.classId]) {
          errors.push({ row: vr.row, classId: vr.classId, error: 'tutors would be dropped: ' + vr.classId + '（沒有任何一列接手它的導師）' });
        }
      }
      // R2（不准同一位導師同時掛兩班）：inherit 的來源班現在有導師，來源班那一列
      // 也必須在本批被套用（inherit 或 vacate），否則來源班會保留原導師、目標班
      // 又拿到同一批導師，變成同一位導師同時掛兩個班。
      if (vr.action === 'inherit') {
        const srcId = vr.plan.sourceClassId;
        const srcCls = classById[srcId];
        if (srcCls && srcCls.tutors && srcCls.tutors.length) {
          const srcAction = appliedActionByClassId[srcId];
          if (srcAction === undefined || srcAction === 'keep') {
            errors.push({ row: vr.row, classId: vr.classId, error: 'source class kept while inheriting from it: ' + srcId });
          }
        }
      }
    });
  }

  if (errors.length) {
    return { ok: false, errors: errors, classes: classes, applied: null, historyEntries: [] };
  }

  const out = classes.slice();
  const idxById = {};
  out.forEach(function (c, i) { if (c) idxById[c.id] = i; });
  const historyEntries = [];
  // unchanged 是 inherited+vacated 的子集（導師 JSON 剛好沒變的列），不要跟 inherited/
  // vacated 分開加總——inherited+vacated 已經含 unchanged，加總時只需取前兩者。
  const applied = { inherited: 0, vacated: 0, kept: 0, unchanged: 0 };
  const fromSemester = opts.fromSemester, toSemester = opts.toSemester, by = opts.by, now = opts.now;

  validRows.forEach(function (vr) {
    if (vr.action === 'keep') { applied.kept++; return; }
    const idx = idxById[vr.classId];
    const cls = classes[idx]; // 原始快照，不是 out[idx]——見函式頂端註解的順序無關性
    const previousTutors = cls.tutors || [];
    let newTutors, note;
    if (vr.action === 'inherit') {
      const srcCls = classById[vr.plan.sourceClassId]; // 同樣取原始快照，不受同批次其他列影響
      // 整個導師物件淺拷貝搬過去——tutors 自 2026-08-11 起還帶 ext（校內分機）／mobile
      // （私人手機，含舊鍵 phone），那是系辦助理逐筆填的名冊資料。這裡只負責搬移不負責
      // 清洗，只挑 name/email 會讓接手的班拿到「半殘」的導師、原班又被 vacate 清空，
      // 分機/手機就從系統裡憑空消失，助理得重填。
      newTutors = (srcCls.tutors || []).map(function (t) { return (t && typeof t === 'object') ? Object.assign({}, t) : { name: '', email: '' }; });
      note = '升級接手：導師由「' + (vr.plan.sourceName || srcCls.name) + '」帶上來（' + fromSemester + '→' + toSemester + '）';
      applied.inherited++;
    } else { // vacate
      newTutors = [];
      note = '新生班釋出：原導師隨學生升上「' + (vr.plan.targetName || '（無法判定）') + '」，導師待指派（' + fromSemester + '→' + toSemester + '）';
      applied.vacated++;
    }
    const changed = tutorsDiffer_(previousTutors, newTutors);
    if (!changed) applied.unchanged++;
    // 即使導師剛好沒變也要蓋 rolloverSemester，否則下次執行時冪等守門（規則 1）會漏掉這班。
    const updated = Object.assign({}, cls, { tutors: newTutors, rolloverSemester: toSemester });
    out[idx] = updated;
    if (changed) {
      historyEntries.push(buildTutorHistoryEntry_(updated, previousTutors, 'rollover', null, note, toSemester, by, now));
    }
  });

  return { ok: true, errors: [], classes: out, applied: applied, historyEntries: historyEntries };
}

// 歷史學期班名解析：nameHistory 依 upToSemester 升冪，找第一筆 semesterId <= upToSemester
// （NNN-N 固定寬度，字串比較即可）回其 displayName||name；找不到（或無歷史/未帶學期）
// 回現行 displayName||name。供統計等有學期上下文的顯示使用，確保升級改名後看舊學期
// 統計仍顯示當時的班名。
function classNameForSemester_(cls, semesterId) {
  if (!cls) return '';
  const current = cls.displayName || cls.name;
  if (!semesterId || !Array.isArray(cls.nameHistory) || !cls.nameHistory.length) return current;
  const hist = cls.nameHistory.slice().sort(function (a, b) {
    return String((a && a.upToSemester) || '').localeCompare(String((b && b.upToSemester) || ''));
  });
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (h && h.upToSemester && String(semesterId) <= String(h.upToSemester)) {
      return h.displayName || h.name || current;
    }
  }
  return current;
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
  if (found && (found.disabled === true || found.deleted === true)) return { ok: false, error: 'college disabled: ' + found.name };
  if (found) return { ok: true, colleges: colleges, college: found };
  const created = { id: uniqueDeptId_(slugifyDeptId_(t), colleges), name: t, order: (colleges || []).length, disabled: false };
  return { ok: true, colleges: (colleges || []).concat([created]), college: created };
}

function resolveOrCreateDept_(name, collegeId, departments) {
  const t = String(name || '').trim();
  if (!t) return { ok: false, error: 'deptName required' };
  const found = findByNameExact_(departments, t);
  if (found && (found.active === false || found.deleted === true)) return { ok: false, error: 'department disabled: ' + found.name };
  if (found) return { ok: true, departments: departments, dept: found };
  const created = { id: uniqueDeptId_(slugifyDeptId_(t), departments), name: t, headEmail: '', headName: '', collegeId: collegeId || null, active: true };
  return { ok: true, departments: (departments || []).concat([created]), dept: created };
}

function resolveOrCreateSystem_(name, tutorSystems) {
  const t = String(name || '').trim();
  if (!t) return { ok: true, tutorSystems: tutorSystems, system: null };
  const found = findByNameExact_(tutorSystems, t);
  if (found && (found.disabled === true || found.deleted === true)) return { ok: false, error: 'tutorSystem disabled: ' + found.name };
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

// 家族班班名唯一化。家族班的班級身分是「每位家族導師各自一班」，但名冊常見寫法是整欄都填
// 「家族」（`114-2導師名單上傳範例.xlsx` 即如此，61 列全叫「家族」）。若照原樣以
// (deptId, '家族') 認班，同系所有家族導師會落進同一班，而且匯入是「Excel 視為權威、直接覆寫
// tutors」，所以後一列會把前一列的導師蓋掉——2026-08-07 在 scc-tutor-dev 實查證實：61 列家族班
// 塌成 8 班，每班只剩名冊最後一列那位導師，其餘 53 位從未進入系統。
//
// 統計表解析器（parseStatsWorkbook）產出的家族班名本來就帶姓名（家族陳美惠），所以只有標準
// 範本那條路徑會中；這裡在後端統一補齊，兩條匯入路徑都經過 importRosterRow_。
//
// 只在「班名剛好就是『家族』兩字」且拿得到導師姓名時才動它，其餘一律原樣（含已經帶姓名的
// 家族陳美惠、以及共同指導/海青這類非家族班）。拿不到姓名時保持「家族」不動——名冊確實有
// 沒填導師姓名的家族列（材料工程系 114-2 就有一列），那種列本來就要人工補，
// 不該在這裡發明一個班名。
//
// 判斷依據刻意只看**班名**，不看導師制度的 systemId：一個班名就叫「家族」的班，本質上就是
// 家族班，制度欄填什麼都不改變這件事；反過來拿 systemId==='family' 當條件是脆的——
// `family` 這個 id 只有 DEFAULT_TUTOR_SYSTEMS_ 種子才有，若制度是匯入時由
// resolveOrCreateSystem_ 依名稱「家族」現場建立的，它的 id 就不是 'family'，
// 用 systemId 當否決條件會把正確情況擋掉。
function familyClassNameForImport_(className, firstTutorName) {
  const name = String(className || '').trim();
  if (name !== '家族') return name;
  const who = String(firstTutorName || '').trim();
  return who ? (name + who) : name;
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

  const tutorsForName_ = buildImportTutors_(row);
  const className = familyClassNameForImport_(
    String(row.classNameRaw).trim(),
    tutorsForName_.length ? tutorsForName_[0].name : ''
  );
  if (!isValidClassName_(className)) return { ok: false, error: 'invalid classNameRaw: ' + className };
  let cls = (classes || []).filter(function (c) { return c && c.deptId === deptRes.dept.id && c.name === className; })[0];
  if (cls && (cls.active === false || cls.deleted === true)) return { ok: false, error: 'class disabled: ' + cls.id };

  const tutors = tutorsForName_;
  const explicitDisplayName = row.classDisplayName && String(row.classDisplayName).trim();
  let nextClasses = classes || [];
  let classCreated = false;
  // 導師歷史（Ticket C）：回傳本列是否造成導師名單異動＋異動前快照，供呼叫端
  // （adminImportRosterAction_）在同一個 withLock_ 內 append tutorHistory（changeType:'import'）。
  // 不改動既有回傳欄位語意，只新增 tutorsChanged / previousTutors。
  let tutorsChanged = false;
  let previousTutors = [];

  // 家族班顯示名是系統規則（系簡稱＋導師姓名＋家族），**不讓 Excel 的「班級顯示名稱」欄覆寫**，
  // 也不沿用既有值：名冊檔那一欄留的是舊格式（森林家族(陳美惠)），若照一般班別的
  // 「填了就以填的為準」語意，重匯一次就會把舊格式帶回來。其餘班別語意完全不變。
  const isFamilyRow_ = (systemRes.system ? systemRes.system.id : null) === 'family'
    || className.indexOf('家族') === 0;
  const familyFused_ = isFamilyRow_
    ? fuseClassDisplayName_(className, deptRes.dept.name, 'family',
        tutors.length ? tutors[0].name : undefined)
    : '';

  if (!cls) {
    const newSystemId = systemRes.system ? systemRes.system.id : null;
    const fused = familyFused_ || explicitDisplayName || fuseClassDisplayName_(
      className, deptRes.dept.name, newSystemId,
      tutors.length ? tutors[0].name : undefined
    );
    // 融合建議值（或使用者填的 classDisplayName）再過一次全校 canonical 簡稱正規化
    // （見 normalizeClassDisplayName_ 上方註解）——匯入時自動套用，admin 事後仍可在後台改。
    const normalized = normalizeClassDisplayName_(fused, deptRes.dept.name, newSystemId, className);
    cls = {
      id: uniqueClassId_(deptRes.dept.id + '_' + slugifyDeptId_(className), classes),
      name: className, deptId: deptRes.dept.id,
      systemId: newSystemId,
      displayName: normalized.value,
      requiredMeetingOverride: reqRes.value,
      tutors: tutors, suggestedTutors: [],
      dualApprovalMode: 'any', uploadWhitelist: [], active: true,
    };
    nextClasses = nextClasses.concat([cls]);
    classCreated = true;
    tutorsChanged = tutors.length > 0;  // 新班且本列有導師 = 從無到有的異動
  } else {
    previousTutors = cls.tutors || [];
    const updatedSystemId = systemRes.system ? systemRes.system.id : cls.systemId;
    const normalized = normalizeClassDisplayName_(
      familyFused_ || explicitDisplayName || cls.displayName, deptRes.dept.name, updatedSystemId, className
    );
    const updated = Object.assign({}, cls, {
      deptId: deptRes.dept.id,
      systemId: updatedSystemId,
      displayName: normalized.value,
      // 應繳份數（Ticket E bug fix）：本列未帶（Excel 空白/undefined/null → parse 出 null）
      // → 保留既有覆寫值不動；帶數字（含 0＝免繳）→ 設定。舊版空白會把既有覆寫洗回 null。
      requiredMeetingOverride: reqRes.value === null ? cls.requiredMeetingOverride : reqRes.value,
      tutors: tutors.length ? tutors : cls.tutors,
    });
    nextClasses = nextClasses.map(function (c) { return c.id === cls.id ? updated : c; });
    cls = updated;
    // 本列未填導師時沿用既有名單（updated.tutors === previousTutors）→ 無異動。
    tutorsChanged = tutors.length > 0 && tutorsDiffer_(previousTutors, tutors);
  }

  return {
    ok: true,
    colleges: collegeRes.colleges, departments: deptRes.departments,
    tutorSystems: systemRes.tutorSystems, classes: nextClasses,
    college: collegeRes.college, dept: deptRes.dept, system: systemRes.system,
    cls: cls, classCreated: classCreated,
    tutorsChanged: tutorsChanged, previousTutors: previousTutors,
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
    // 主任導師的分機/手機不在這裡出現（見 sanitizeDepartmentsForViewer_）。
    departments: sanitizeDepartmentsForViewer_(departments),
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
    // 系辦助理白名單同理：整份名單（含各系助理 email）只給 admin；助理自己只需要知道
    // 「我管哪幾系」，roles.deptAssistantOf 已經算好了。
    deptAssistants: roles.isAdmin ? (config.deptAssistants || []) : undefined,
    // 校安人員名單同理：只給 admin。這個角色自己只需要知道「我是」，roles.isSafetyOfficer 有了。
    safetyOfficers: roles.isAdmin ? (config.safetyOfficers || []) : undefined,
  };
}

// sessionStart：以 Google idToken 換發自建 session token（效期至當日台北 24:00）。
// 走到這裡的人已經通過 doPost 的全域登入閘門（checkSystemAccess_，2026-08-17 加），
// 所以這支不必再判斷一次；簽發 session ≠ 授權任何操作——授權仍由各 action 內部
// resolveRoles_ default-deny 判斷。閘門開放（accessMode:'open'）時行為回到原始設計：
// 任何通過 verifyIdToken_ 的帳號都直接簽發。
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
      roles.isStaffAssistant || roles.deptHeadOf.length > 0 || roles.tutorOf.length > 0 ||
      roles.deptAssistantOf.length > 0 || roles.isSafetyOfficer;
    if (hasRole) {
      const timeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
      const lines = [
        '您的帳號剛剛登入導師資訊系統。', '',
        '環境：正式版',
        '時間：' + timeStr + '（台北時間）',
        '瀏覽器：' + (ua || '（未知）'),
      ];
      if (ip) lines.push('IP 位址：' + ip);
      if (geo) lines.push('大致位置：' + geo);
      lines.push('', '本次登入憑證有效至今日 24:00（台北時間），到期後需重新登入。',
        '若非本人操作，請立即聯繫系統管理者停用帳號，並可於系統「登入紀錄」按「登出所有裝置」使所有憑證即時失效。');
      // 主責/助理可能填了「其他收信信箱」——登入通知也照那個設定寄，否則設定了卻只有名冊
      // 通知會用到，人會以為沒生效。找不到那個人的設定時就退回登入信箱本身。
      const meEntry = ((config.staffLeads || []).concat(config.staffAssistants || []))
        .filter(function (x) { return x && x.email === userEmail && x.deleted !== true; })[0];
      const to = (meEntry ? mailTargetsForEntry_(meEntry) : [userEmail]).join(',') || userEmail;
      MailApp.sendEmail({
        to: to,
        subject: '【屏科大導師資訊系統】登入通知（正式版）',
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
  // 已刪除班級一律拒絕新增紀錄（fail-closed，同 active===false 的既有規則；見 Ticket B）。
  if (!classInfo || classInfo.active === false || classInfo.deleted === true) throw new Error('class not found: ' + classId);
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
  // 已刪除班級一律拒絕上傳（fail-closed，同 active===false 的既有規則；見 Ticket B）。
  if (!classInfo || classInfo.active === false || classInfo.deleted === true) throw new Error('class not found: ' + classId);
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

// 六類實體「軟刪除」共用邏輯（Ticket B）：entry.deleted===true → 蓋上刪除墓碑
// （deleted/deletedAt/deletedBy 一律由後端算，deletedAt/deletedBy 不信任 client 帶的值，
// 避免偽造刪除時間/刪除者）；否則（未設或 false）→ 明確清空墓碑欄位，等同「upsert 收到
// 同 id 且 deleted 未設/false 時允許覆寫回未刪除」的復原後門（不擴 UI，只保留 API 可用，
// 見 Ticket B 設計說明）。純函式，不做 I/O，供各 adminUpsert*Action_ 共用。
function applyUpsertDeleteFields_(existing, entry, userEmail, now) {
  const merged = Object.assign({}, existing, entry);
  if (entry && entry.deleted === true) {
    merged.deleted = true;
    merged.deletedAt = now;
    merged.deletedBy = userEmail;
  } else {
    merged.deleted = false;
    delete merged.deletedAt;
    delete merged.deletedBy;
  }
  return merged;
}

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
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const data = readJsonSafe_('departments.json', ctx, []);
    const idx = data.findIndex(function (d) { return d.id === entry.id; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : data[idx], entry, userEmail, now);
    if (idx === -1) data.push(merged); else data[idx] = merged;
    writeJsonPath_('departments.json', data, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteDepartment' : 'adminUpsertDepartment', by: userEmail, targetId: entry.id, at: now });
    return { departments: sanitizeDepartmentsForViewer_(data) };
  });
}

function adminUpsertClassAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.class;
  if (!entry || !entry.id) throw new Error('class.id required');
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const data = readJsonSafe_('classes.json', ctx, []);
    const idx = data.findIndex(function (c) { return c.id === entry.id; });
    const prevTutors = (idx === -1 ? [] : (data[idx].tutors || []));
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : data[idx], entry, userEmail, now);
    if (idx === -1) data.push(merged); else data[idx] = merged;
    writeJsonPath_('classes.json', data, ctx);
    // 導師歷史（Ticket C）：名單有異動才記（changeType:'manual'）。刪除墓碑那次 upsert
    // （entry 只帶 id+deleted，merged.tutors 沿用既有值）名單沒變，tutorsDiffer_ 為 false
    // 自然不記；isDelete 再擋一層保險。同一個 withLock_ 臨界區內寫入。
    if (!isDelete && tutorsDiffer_(prevTutors, merged.tutors)) {
      const semesters = readJsonSafe_('semesters.json', ctx, []);
      appendTutorHistory_(ctx, [buildTutorHistoryEntry_(
        merged, prevTutors, 'manual', null, null, currentSemesterId_(semesters), userEmail, now
      )]);
    }
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteClass' : 'adminUpsertClass', by: userEmail, targetId: entry.id, at: now });
    return { classes: data };
  });
}

function adminUpsertUserAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const targetEmail = params.email;
  const entry = params.user;
  if (!targetEmail || !entry) throw new Error('email and user required');
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.users = config.users || {};
    config.users[targetEmail] = applyUpsertDeleteFields_(config.users[targetEmail] || {}, entry, userEmail, now);
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteUser' : 'adminUpsertUser', by: userEmail, targetId: targetEmail, at: now });
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
    const semesters = readJsonSafe_('semesters.json', ctx, []);
    const semesterId = currentSemesterId_(semesters);
    let successCount = 0;
    const errors = [];
    const historyEntries = [];  // 導師歷史（Ticket C）：名單有異動的列，批次收集、同鎖一次寫入

    rows.forEach(function (row, i) {
      const res = importRosterRow_(row, colleges, departments, tutorSystems, classes, now);
      if (!res.ok) { errors.push({ row: i, error: res.error }); return; }
      colleges = res.colleges; departments = res.departments; tutorSystems = res.tutorSystems; classes = res.classes;
      if (res.tutorsChanged) {
        historyEntries.push(buildTutorHistoryEntry_(
          res.cls, res.previousTutors, 'import', null, null, semesterId, userEmail, now
        ));
      }
      successCount++;
    });

    writeJsonPath_('colleges.json', colleges, ctx);
    writeJsonPath_('departments.json', departments, ctx);
    writeJsonPath_('tutorSystems.json', tutorSystems, ctx);
    writeJsonPath_('classes.json', classes, ctx);
    appendTutorHistory_(ctx, historyEntries);
    appendAuditLog_(ctx, {
      action: 'adminImportRoster', by: userEmail,
      count: successCount, errorCount: errors.length, at: now,
    });
    return {
      colleges: colleges, departments: sanitizeDepartmentsForViewer_(departments),
      tutorSystems: tutorSystems, classes: classes,
      successCount: successCount, errors: errors,
    };
  });
}

// adminUpsertCollege：admin only，upsert-by-id（比照 adminUpsertDepartment 寫法）。
function adminUpsertCollegeAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.college;
  if (!entry || !entry.id) throw new Error('college.id required');
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const data = readJsonSafe_('colleges.json', ctx, []);
    const idx = data.findIndex(function (c) { return c.id === entry.id; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : data[idx], entry, userEmail, now);
    if (idx === -1) data.push(merged); else data[idx] = merged;
    writeJsonPath_('colleges.json', data, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteCollege' : 'adminUpsertCollege', by: userEmail, targetId: entry.id, at: now });
    return { colleges: data };
  });
}

// adminUpsertTutorSystem：admin only，upsert-by-id。
function adminUpsertTutorSystemAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.tutorSystem;
  if (!entry || !entry.id) throw new Error('tutorSystem.id required');
  const isDelete = entry.deleted === true;
  // 鎖外先播種，理由同 adminImportRosterAction_（withLock_ 不可重入）。
  ensureTutorSystemsSeeded_(ctx);

  return withLock_(function () {
    const now = new Date().toISOString();
    const data = readJsonSafe_('tutorSystems.json', ctx, []);
    const idx = data.findIndex(function (s) { return s.id === entry.id; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : data[idx], entry, userEmail, now);
    const next = idx === -1 ? data.concat([merged]) : data.map(function (s, i) { return i === idx ? merged : s; });
    writeJsonPath_('tutorSystems.json', next, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteTutorSystem' : 'adminUpsertTutorSystem', by: userEmail, targetId: entry.id, at: now });
    return { tutorSystems: next };
  });
}

// adminUpsertStaffLead / adminUpsertStaffAssistant：admin only，upsert-by-email，存進
// config.staffLeads / config.staffAssistants（比照現有職員帳號管理模式，見 adminUpsertUserAction_）。
// staffAssistant.leadEmail 綁定的主責若不存在或已停用，resolveRoles_ 會 fail-closed 判該助理
// 的 assistantLead 為 null（無法代為核章），故此處不額外擋——沿用既有 admin 信任邊界。
// ── 收信信箱解析（純函式）──────────────────────────────────────────────────────
// 學諮主責/助理有些人的登入帳號（Google/gmail）與實際收信的信箱不是同一個，所以名單那筆
// 可以填 altEmail（其他收信信箱）與 noPrimaryMail（不要寄給登入用的那個信箱）。
// 規則：預設寄登入信箱；填了 altEmail 就**兩個都寄**；勾了 noPrimaryMail 則只寄 altEmail。
// 兩者都沒有等於「不寄給任何人」，那是設定錯誤而不是意圖——所以寫入時就擋掉
// （見 normalizeMailPrefs_），這裡只負責把有效設定攤成收件者清單。
function mailTargetsForEntry_(entry) {
  if (!entry) return [];
  const primary = String(entry.email || '').trim();
  const alt = String(entry.altEmail || '').trim();
  const out = [];
  if (primary && entry.noPrimaryMail !== true) out.push(primary);
  if (alt && out.indexOf(alt) === -1) out.push(alt);
  return out;
}

// 寫入前的驗證：altEmail 格式、以及「不寄給登入信箱」時必須有替代信箱
// （否則這個人就此收不到任何通知，而且從畫面上看不出來）。
function normalizeMailPrefs_(entry) {
  const alt = String((entry && entry.altEmail) || '').trim().toLowerCase();
  if (alt && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alt)) return { ok: false, error: '其他收信信箱格式不正確：' + alt };
  if (alt.length > 100) return { ok: false, error: '其他收信信箱過長' };
  const noPrimary = (entry && entry.noPrimaryMail) === true;
  if (noPrimary && !alt) return { ok: false, error: '勾選「不寄給登入信箱」時，必須填其他收信信箱，否則這個人收不到任何通知' };
  return { ok: true, altEmail: alt, noPrimaryMail: noPrimary };
}

function adminUpsertStaffLeadAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.staffLead;
  if (!entry || !entry.email) throw new Error('staffLead.email required');
  const prefs = normalizeMailPrefs_(entry);
  if (!prefs.ok) throw new Error(prefs.error);
  entry.altEmail = prefs.altEmail;
  entry.noPrimaryMail = prefs.noPrimaryMail;
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.staffLeads = config.staffLeads || [];
    const idx = config.staffLeads.findIndex(function (s) { return s && s.email === entry.email; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : config.staffLeads[idx], entry, userEmail, now);
    if (idx === -1) config.staffLeads.push(merged); else config.staffLeads[idx] = merged;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteStaffLead' : 'adminUpsertStaffLead', by: userEmail, targetId: entry.email, at: now });
    return { staffLeads: config.staffLeads };
  });
}

function adminUpsertStaffAssistantAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.staffAssistant;
  if (!entry || !entry.email) throw new Error('staffAssistant.email required');
  const prefs = normalizeMailPrefs_(entry);
  if (!prefs.ok) throw new Error(prefs.error);
  entry.altEmail = prefs.altEmail;
  entry.noPrimaryMail = prefs.noPrimaryMail;
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    config.staffAssistants = config.staffAssistants || [];
    const idx = config.staffAssistants.findIndex(function (s) { return s && s.email === entry.email; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : config.staffAssistants[idx], entry, userEmail, now);
    if (idx === -1) config.staffAssistants.push(merged); else config.staffAssistants[idx] = merged;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteStaffAssistant' : 'adminUpsertStaffAssistant', by: userEmail, targetId: entry.email, at: now });
    return { staffAssistants: config.staffAssistants };
  });
}

// ── 系辦助理（Phase 1：角色＋白名單＋唯讀自己系）─────────────────────────────────
// 這一組是「導師資料填報平台」的安全邊界。與學諮中心的 staffLead/staffAssistant 完全無關，
// 不共用名單也不共用權限——同名容易混淆，命名一律用 deptAssistant / deptAssistantOf。
//
// 白名單形狀（config.deptAssistants，比照 staffLeads 的既有模式）：
//   { email, name, deptIds: ['農園系','森林系'], ext?, disabled?, deleted?, ... }
// deptIds 允許多系（技職所/師培中心那種跨單位的助理）。
// ext＝校內分機，純聯絡備註（中心要打電話找人用），不參與任何授權判斷；
// 自由文字但長度上限 20（名冊上有「7829/7803」「7759或7752」這種一人多分機的寫法）。

// deptIds 白名單：陣列、最多 37*2 筆保險上限、每個 id 都要是現存且啟用的系所。
// 不存在/已停用的 id 直接**拒絕整筆**而不是靜默丟掉——admin 打錯字時要看得到錯誤，
// 不能存進一份看起來成功、實際少掛一個系的名單。
function normalizeDeptAssistantDeptIds_(deptIds, departments) {
  if (!Array.isArray(deptIds)) return { ok: false, error: 'deptIds must be an array' };
  if (deptIds.length > 80) return { ok: false, error: 'too many deptIds' };
  const out = [];
  for (let i = 0; i < deptIds.length; i++) {
    const id = String(deptIds[i] == null ? '' : deptIds[i]).trim();
    if (!id) return { ok: false, error: 'empty deptId' };
    const d = (departments || []).filter(function (x) { return x && x.id === id; })[0];
    if (!d || d.active === false || d.deleted === true) return { ok: false, error: 'department not found: ' + id };
    if (out.indexOf(id) === -1) out.push(id);
  }
  return { ok: true, deptIds: out };
}

// adminUpsertDeptAssistant：admin only，upsert-by-email。deptIds 於鎖內拿最新 departments 驗，
// 避免「驗的時候系所還在、寫進去時已被刪」的競態。
function adminUpsertDeptAssistantAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.deptAssistant;
  if (!entry || !entry.email) throw new Error('deptAssistant.email required');
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = readJsonSafe_('departments.json', ctx, []);
    let next = entry;
    if (!isDelete) {
      const chk = normalizeDeptAssistantDeptIds_(entry.deptIds, departments);
      if (!chk.ok) throw new Error(chk.error);
      next = Object.assign({}, entry, { deptIds: chk.deptIds, ext: String(entry.ext || '').trim().slice(0, 20) });
    }
    config.deptAssistants = config.deptAssistants || [];
    const idx = config.deptAssistants.findIndex(function (s) { return s && s.email === entry.email; });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : config.deptAssistants[idx], next, userEmail, now);
    if (idx === -1) config.deptAssistants.push(merged); else config.deptAssistants[idx] = merged;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: isDelete ? 'adminDeleteDeptAssistant' : 'adminUpsertDeptAssistant', by: userEmail, targetId: entry.email, at: now });
    return { deptAssistants: config.deptAssistants };
  });
}

// ── 換 email（系辦助理換人／換信箱）───────────────────────────────────────────
// upsert 是 by-email 的，所以「改 email」不是編輯一個欄位，而是把整筆搬到新的鍵上。
// 做成獨立 action 而不是讓 upsert 多吃一個 previousEmail，理由是它的授權後果不一樣：
// 這一步等於**把一個系的名冊權限從甲交給乙**，稽核記錄要看得出 from → to，不能混在一般編輯裡。
//
// 舊那筆是**軟刪除留墓碑**（帶 renamedTo），不是原地改鍵：
//   - resolveRoles_ 對 deleted 的視同不存在 → 舊 email 立刻失去所有系所（fail-closed）。
//   - 舊 email 的 session token 是無狀態的、撤不掉，但沒有角色就會被 checkSystemAccess_ 擋下。
//   - 留墓碑才查得到「這個信箱以前是誰」。
//
// 撞名一律拒絕、不合併：新 email 已經有一筆在名單上時，合併會安靜地把兩個人的系所併成一份
// 權限。只有**已軟刪除的墓碑**會被覆蓋（同一個信箱先刪後回來，是正常情況）。
//
// 純函式版本（planner）：不讀檔、不取現在時間，時間與操作者由呼叫端帶進來，才測得動。
function planDeptAssistantRename_(deptAssistants, fromEmail, toEmail, actor, now) {
  const list = Array.isArray(deptAssistants) ? deptAssistants : [];
  const from = String(fromEmail == null ? '' : fromEmail).trim().toLowerCase();
  const to = String(toEmail == null ? '' : toEmail).trim().toLowerCase();
  if (!from) return { ok: false, error: '需要原本的 email' };
  if (!to) return { ok: false, error: '需要新的 email' };
  if (from === to) return { ok: false, error: '新舊 email 相同' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { ok: false, error: 'email 格式不正確：' + to };
  if (to.length > 100) return { ok: false, error: 'email 過長' };
  // importer 是每小時同步用的服務帳號（掛滿所有系所），改掉它的 email 會安靜地停掉同步。
  if (from === IMPORTER_ACCOUNT_EMAIL_ || to === IMPORTER_ACCOUNT_EMAIL_) {
    return { ok: false, error: '這是校內同步服務帳號，不能改 email' };
  }

  // 比對一律小寫化：白名單是 upsert-by-email（**大小寫敏感**）而登入比對是小寫，
  // 所以歷史資料可能同時存在 'A@x.com' 與 'a@x.com' 兩列指向同一個人。
  // 只處理找到的第一列，會留下一列還活著的舊 email——那正是這個功能最該避免的 fail-open。
  const lower = function (e) { return String((e && e.email) || '').trim().toLowerCase(); };
  const fromRows = list.filter(function (e) { return e && lower(e) === from && e.deleted !== true; });
  if (!fromRows.length) return { ok: false, error: '找不到這位系辦助理：' + from };
  if (list.some(function (e) { return e && lower(e) === to && e.deleted !== true; })) {
    return { ok: false, error: '名單上已經有 ' + to + ' 了，請先處理那一筆' };
  }

  const moved = Object.assign({}, fromRows[0], {
    email: to, deleted: false, renamedFrom: from, renamedAt: now, renamedBy: actor,
  });
  delete moved.deletedAt;
  delete moved.deletedBy;
  delete moved.renamedTo;

  const out = [];
  list.forEach(function (e) {
    const em = lower(e);
    if (e && em === from) {
      // 指向舊 email 的每一列都要變墓碑，一列都不能漏（漏掉的那列就是還能登入的權限）。
      out.push(e.deleted === true ? e
        : Object.assign({}, e, { deleted: true, deletedAt: now, deletedBy: actor, renamedTo: to }));
      return;
    }
    // 新 email 這時只可能剩墓碑（上面已擋掉活的）。**整列丟掉而不是留著**：
    // adminUpsertDeptAssistant 的 findIndex 不看 deleted，留一個同 email 的墓碑在前面，
    // 緊接著那趟存檔就會改到墓碑而不是剛搬過來的這筆。歷史查得到（稽核記錄有 from → to）。
    if (e && em === to) return;
    out.push(e);
  });
  out.push(moved);
  return { ok: true, deptAssistants: out, from: from, to: to };
}

// adminRenameDeptAssistant：admin only。**只動白名單（授權）**，本機登入帳號（認證）由前端
// 另外一趟 adminLocalAccounts/'/admin/accounts' 的 delete 收拾——那份資料在自架軌活在 server 的
// users.json、在 GAS 軌活在 Drive 的 localAccounts.json，doPost 這一側碰不到自架那份。
function adminRenameDeptAssistantAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const plan = planDeptAssistantRename_(config.deptAssistants || [], params.fromEmail, params.toEmail, userEmail, now);
    if (!plan.ok) throw new Error(plan.error);
    config.deptAssistants = plan.deptAssistants;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, { action: 'adminRenameDeptAssistant', by: userEmail, targetId: plan.from + ' → ' + plan.to, at: now });
    return { deptAssistants: config.deptAssistants, from: plan.from, to: plan.to };
  });
}

// ── 稽核：瀏覽軌跡（2026-08-18）─────────────────────────────────────────────────
// 既有的 audit_log.json 記的是**後端自己寫的**動作（新增/修改/刪除/核章/權限異動）。
// 使用者要的「誰在看哪些畫面」只有前端知道，所以多一個由前端回報的通道。
//
// **刻意寫在不同的檔案（audit_views.json）**，不要併進 audit_log.json：
// 那個檔有筆數上限、超過就丟最舊的，而這條通道是任何登入者都能觸發的。混在一起的話，
// 有人狂切分頁就能把「誰改了什麼」的紀錄擠出去——等於提供一個清除證據的方法。
// 分開之後，前端灌爆的只會是自己那一份。
const AUDIT_VIEW_MAX_ENTRIES_ = 20000;
// 只收白名單內的事件名。開放任意字串會讓稽核表變成使用者可控的內容（看的人會信它）。
const AUDIT_VIEW_ACTIONS_ = ['viewPage', 'viewDeptRoster', 'viewMobile', 'exportRoster', 'viewAdminTab'];

function appendAuditView_(ctx, entry) {
  let log = readJsonSafe_('audit_views.json', ctx, { entries: [] });
  if (!log || !Array.isArray(log.entries)) log = { entries: [] };
  log.entries.push(entry);
  if (log.entries.length > AUDIT_VIEW_MAX_ENTRIES_) {
    log.entries = log.entries.slice(log.entries.length - AUDIT_VIEW_MAX_ENTRIES_);
  }
  writeJsonPath_('audit_views.json', log, ctx);
}

// 正規化（純函式，可測）：白名單事件名、長度上限、**by 永遠由呼叫端用已驗證的 email 覆蓋**。
// 回 null＝不收（不是錯誤，前端不該因為稽核失敗而中斷操作）。
function normalizeAuditView_(params, userEmail, now) {
  const action = String((params && params.auditAction) || '').trim();
  if (AUDIT_VIEW_ACTIONS_.indexOf(action) === -1) return null;
  const clip = function (v, n) { return String(v == null ? '' : v).trim().slice(0, n); };
  return {
    at: now,
    by: userEmail,                        // ← 不看 params，永遠是已驗證的身分
    action: action,
    page: clip(params && params.page, 40),
    deptId: clip(params && params.deptId, 40),
    detail: clip(params && params.detail, 120),
  };
}

// auditAppend：任何通過閘門的登入者都可以回報**自己**的瀏覽事件。
// 不做授權判斷是刻意的——它記的就是「這個已驗證的人做了什麼」，而 by 取自憑證不是參數。
function auditAppendAction_(params, ctx, userEmail) {
  const rec = normalizeAuditView_(params, userEmail, new Date().toISOString());
  if (!rec) return { ok: false, ignored: true };
  withLock_(function () { appendAuditView_(ctx, rec); });
  return { ok: true };
}

// adminAuditList：admin only。把三個來源合成一張時間軸——
//   audit_log.json（後端寫的異動）／audit_views.json（前端回報的瀏覽）／sessions.json（登入）。
// 只回最近 limit 筆（預設 300、上限 2000）：這是給人看的畫面，不是資料匯出。
function adminAuditListAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const limit = Math.min(Math.max(Number(params.limit) || 300, 1), 2000);
  const wantEmail = String(params.email || '').trim().toLowerCase();
  const wantKind = String(params.kind || '').trim();     // '' | 'change' | 'view' | 'login'

  // 姓名對照表：稽核表要給人看，一整欄 email 沒有人讀得出「這是誰」。
  // 從所有名單湊出 email → {name, role}；同一個人有多重身分時，以權限大的那個為準。
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const who = {};
  const note = function (email, name, role, extra) {
    const k = String(email || '').trim().toLowerCase();
    if (!k) return;
    if (!who[k]) who[k] = { name: '', role: '', extra: '' };
    if (name && !who[k].name) who[k].name = name;
    if (role && !who[k].role) who[k].role = role;
    if (extra && !who[k].extra) who[k].extra = extra;
  };
  Object.keys(config.users || {}).forEach(function (e) {
    const u = config.users[e] || {};
    note(e, u.name || '', u.role === 'admin' ? '管理員' : (u.role === 'director' ? '中心主任' : '職員'));
  });
  (config.staffLeads || []).forEach(function (x) { if (x) note(x.email, x.name, '學諮中心主責'); });
  (config.staffAssistants || []).forEach(function (x) { if (x) note(x.email, x.name, '學諮中心助理'); });
  (config.safetyOfficers || []).forEach(function (x) { if (x) note(x.email, x.name, '校安人員', x.unit || ''); });
  (config.deptAssistants || []).forEach(function (x) {
    if (!x) return;
    // 系所顯示用全名（教務處對齊過的那個），沒有才退回內部簡稱——使用者要看的是
    //「農園生產系系辦助理」而不是「農園系」。
    const names = (x.deptIds || []).map(function (id) {
      const d = (departments || []).filter(function (dd) { return dd && dd.id === id; })[0];
      return (d && (d.fullName || d.name)) || id;
    });
    note(x.email, x.name, '系辦助理', names.join('、'));
  });
  (departments || []).forEach(function (d) {
    if (d && d.headEmail) note(d.headEmail, d.headName || (d.head && d.head.name) || '', '系主任', d.fullName || d.name);
  });

  // 顯示用的稱呼：優先姓名，附上身分與系所，查不到就退回 email（絕不留空）。
  const label = function (email) {
    const k = String(email || '').trim().toLowerCase();
    const w = who[k];
    if (!w || !w.name) return email || '';
    return w.name + (w.role ? '（' + w.role + (w.extra ? '・' + w.extra : '') + '）' : '');
  };

  const rows = [];
  const push = function (kind, at, by, action, detail, target, page) {
    if (!at) return;
    rows.push({
      kind: kind, at: at, by: by || '', byName: label(by), action: action || '',
      detail: detail || '',
      // page／分頁代號原樣送出去，由前端翻成畫面上的名稱——只有前端有那張標籤表
      // （NAV_PAGES / ADMIN_TABS），後端硬抄一份就會兩邊漂移。
      page: page || '',
      // targetLabel：被動到的那個對象也翻成人話（「農園生產系的系辦助理 王小美」），
      // 不然稽核表上只有一串 email，看的人得自己去別的分頁查那是誰。
      target: target || '', targetLabel: target ? label(target) : '',
    });
  };

  const changes = readJsonSafe_('audit_log.json', ctx, { entries: [] });
  (Array.isArray(changes.entries) ? changes.entries : []).forEach(function (e) {
    if (!e) return;
    // 「a@x → b@x」這種改 email 的 targetId 兩邊都翻成人話（改完之後才查得到新的那個，
    // 舊的通常已經是墓碑而查不到，所以查不到就原樣顯示 email）。
    const t = String(e.targetId || '');
    const arrow = t.indexOf(' → ');
    const detail = arrow === -1 ? '' :
      (label(t.slice(0, arrow)) || t.slice(0, arrow)) + ' → ' + (label(t.slice(arrow + 3)) || t.slice(arrow + 3));
    push('change', e.at, e.by, e.action, detail, arrow === -1 ? t : '');
  });

  const views = readJsonSafe_('audit_views.json', ctx, { entries: [] });
  (Array.isArray(views.entries) ? views.entries : []).forEach(function (e) {
    if (!e) return;
    // 系所一律顯示全名（使用者看的是「農園生產系」不是「農園系」）。
    const d = (departments || []).filter(function (x) { return x && x.id === e.deptId; })[0];
    const deptName = d ? (d.fullName || d.name) : (e.deptId || '');
    push('view', e.at, e.by, e.action, deptName, '', e.page || e.detail || '');
  });

  const sess = readJsonSafe_('sessions.json', ctx, { sessions: [] });
  (Array.isArray(sess.sessions) ? sess.sessions : []).forEach(function (s) {
    if (!s) return;
    push('login', s.at || (s.issuedAtMs ? new Date(s.issuedAtMs).toISOString() : ''), s.email, 'login',
      [s.ip || '', s.geo || ''].filter(Boolean).join(' / ').slice(0, 160), '');
  });

  const filtered = rows.filter(function (r) {
    if (wantKind && r.kind !== wantKind) return false;
    // 搜尋同時比對 email 與姓名——畫面上顯示的是姓名，只能用 email 搜等於搜不到。
    if (wantEmail && (String(r.by) + ' ' + String(r.byName)).toLowerCase().indexOf(wantEmail) === -1) return false;
    return true;
  }).sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });

  return { total: filtered.length, entries: filtered.slice(0, limit) };
}

// ── 校安人員（全校唯讀，2026-08-18）─────────────────────────────────────────────
// 用途：危機或緊急事件時要立刻聯絡得到導師本人，所以這個角色看得到**全校**名冊含私人手機。
// 相對的它一個字都不能改——邊界不是靠 UI，是靠「寫入路徑不認這個角色」（見下方兩支 scope）。
//
// 形狀（config.safetyOfficers，比照 deptAssistants 的既有模式）：
//   { email, name, unit?, ext?, disabled?, deleted?, ... }
// unit＝單位（例：軍訓室／生輔組），純備註；ext＝分機，同時是本機帳號的初始密碼（沿用既有機制）。
// 沒有 deptIds：緊急聯繫本來就不分系，給範圍反而會在最需要的時候擋住人。
function adminUpsertSafetyOfficerAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const entry = params.safetyOfficer;
  if (!entry || !entry.email) throw new Error('safetyOfficer.email required');
  const email = String(entry.email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('email 格式不正確：' + email);
  const isDelete = entry.deleted === true;

  return withLock_(function () {
    const now = new Date().toISOString();
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const next = isDelete ? { email: email, deleted: true } : {
      email: email,
      name: String(entry.name == null ? '' : entry.name).trim().slice(0, 40),
      unit: String(entry.unit == null ? '' : entry.unit).trim().slice(0, 40),
      ext: String(entry.ext == null ? '' : entry.ext).trim().slice(0, 20),
      disabled: entry.disabled === true,
    };
    config.safetyOfficers = config.safetyOfficers || [];
    const idx = config.safetyOfficers.findIndex(function (s) {
      return s && String(s.email || '').trim().toLowerCase() === email;
    });
    const merged = applyUpsertDeleteFields_(idx === -1 ? {} : config.safetyOfficers[idx], next, userEmail, now);
    if (idx === -1) config.safetyOfficers.push(merged); else config.safetyOfficers[idx] = merged;
    writeJsonPath_('config.json', config, ctx);
    appendAuditLog_(ctx, {
      action: isDelete ? 'adminDeleteSafetyOfficer' : 'adminUpsertSafetyOfficer',
      by: userEmail, targetId: email, at: now,
    });
    return { safetyOfficers: config.safetyOfficers };
  });
}

// ── 名冊的授權範圍：**寫入**與**讀取**是兩支函式，這個分工本身就是安全邊界 ─────────
//
// resolveDeptRosterScope_   ＝ 可以「改」哪些系（admin／系辦助理）
// resolveDeptRosterReadScope_ ＝ 可以「看」哪些系（再加上全校唯讀的校安人員）
//
// 為什麼不做成一支帶 readOnly 旗標的函式：那樣**忘記傳旗標的新 action 會自動變成可寫**，
// 失效方向是錯的。拆成兩支之後，日後新增的寫入 action 照著既有寫法呼叫
// resolveDeptRosterScope_，校安人員就自動被擋在外面——不必記得做任何事。
// （反過來，新的讀取 action 若誤用了寫入那支，後果只是校安人員少看到東西，安全。）
function resolveDeptRosterScope_(roles, deptId, departments) {
  if (!roles) return { ok: false, error: 'forbidden' };
  const allowed = roles.isAdmin
    ? (departments || []).filter(function (d) { return d && d.active !== false && d.deleted !== true; })
        .map(function (d) { return d.id; })
    : (roles.deptAssistantOf || []).slice();
  if (!allowed.length) return { ok: false, error: 'forbidden' };
  if (deptId === undefined || deptId === null || deptId === '') return { ok: true, deptIds: allowed };
  const want = String(deptId).trim();
  if (allowed.indexOf(want) === -1) return { ok: false, error: 'forbidden' };
  return { ok: true, deptIds: [want] };
}

// 讀取範圍：先問寫入那支（admin／系辦助理都有讀的權利），沒過再看是不是校安人員。
// 校安人員 → 全部啟用中的系所，**唯讀**。這條路回的資料含私人手機，那正是這個角色存在的
// 理由（危機事件要立刻聯絡得到導師），也是為什麼它只加在這一支。
function resolveDeptRosterReadScope_(roles, deptId, departments) {
  const asEditor = resolveDeptRosterScope_(roles, deptId, departments);
  if (asEditor.ok) return asEditor;
  if (!roles || !roles.isSafetyOfficer) return { ok: false, error: 'forbidden' };
  const all = (departments || [])
    .filter(function (d) { return d && d.active !== false && d.deleted !== true; })
    .map(function (d) { return d.id; });
  if (!all.length) return { ok: false, error: 'forbidden' };
  if (deptId === undefined || deptId === null || deptId === '') return { ok: true, deptIds: all, readOnly: true };
  const want = String(deptId).trim();
  if (all.indexOf(want) === -1) return { ok: false, error: 'forbidden' };
  return { ok: true, deptIds: [want], readOnly: true };
}

// 系辦助理看到的班級投影（純函式）。Phase 1 是唯讀，欄位刻意只給名冊需要的那幾個：
// 不帶 uploadWhitelist（學生 gmail）、不帶 suggestedTutors（學生自填的建議，含 by/email）、
// 不帶紀錄與核章狀態——那些不是名冊維護要用的資料，少給一個欄位就少一條外洩路徑。
// Phase 2 要加的手機欄位也只會出現在這條通道，**永遠不進 bootstrap 的 classes**。
function projectClassForDeptRoster_(cls) {
  return {
    id: cls.id, name: cls.name, displayName: cls.displayName || cls.name,
    deptId: cls.deptId, systemId: cls.systemId || null,
    requiredMeetingOverride: cls.requiredMeetingOverride === undefined ? null : cls.requiredMeetingOverride,
    graduatedSemester: cls.graduatedSemester || null,
    active: cls.active !== false,
    // ext（校內分機）／mobile（私人手機）**只在這條通道出現**：bootstrap 的 classes 是每個
    // 登入者都拿得到的，放進去等於全校可讀，所以 sanitizeClassesForViewer_ 會整組拔掉（見該函式）。
    // 2026-08-11 之前只有單一「電話」欄 phone，沒填過 mobile 的舊資料就把 phone 當私人手機顯示
    // （當時的欄位標籤就是「電話」，實際填的是手機）。
    tutors: (cls.tutors || []).map(function (t) {
      // 存檔時整個 tutors 陣列會被換掉（不留 phone 鍵），所以這個 fallback 只會命中沒編輯過的舊列。
      return {
        name: (t && t.name) || '', email: (t && t.email) || '',
        ext: (t && t.ext) || '', mobile: (t && (t.mobile || t.phone)) || '',
      };
    }),
  };
}

// 系辦助理送上來的導師名單（Phase 2：可增刪導師、填聯絡方式）。
// 姓名必填，其餘選填。聯絡方式是高度個資，但這裡只做**格式與長度**限制，不做真實性判斷——
// 名冊上會有「0912-345-678」「(08)7703202#1234」這類寫法，硬要正規化只會逼人填假的。
//
// 2026-08-11 起分成兩欄：ext（校內分機）與 mobile（私人手機）；在那之前是單一欄位 phone。
// 舊鍵 phone 仍當作 mobile 收下（GAS 軌與自架軌各有一份資料，不可能同時換版），
// 但寫出去的物件只有 ext/mobile，存過一次就沒有 phone 了。
// email 這裡仍然驗、仍然存：表單雖然不再讓助理填，**它是導師核章權限的身分依據**
// （resolveRoles_ 的 tutorOf 靠 email 命中），由 deptRosterUpsertClassAction_ 依姓名補回舊值。
function normalizeDeptRosterTutors_(tutors) {
  if (!Array.isArray(tutors)) return { ok: false, error: 'tutors must be an array' };
  if (tutors.length > 10) return { ok: false, error: 'too many tutors (max 10)' };
  const CONTACT_RE = /^[0-9+\-()#\s]{1,20}$/;
  const out = [];
  for (let i = 0; i < tutors.length; i++) {
    const t = tutors[i] || {};
    const name = String(t.name == null ? '' : t.name).trim();
    if (!name) return { ok: false, error: '第 ' + (i + 1) + ' 位導師沒有姓名' };
    if (name.length > 20) return { ok: false, error: '導師姓名過長：' + name };
    if (!/^[A-Za-z0-9一-鿿·．\s]{1,20}$/.test(name)) return { ok: false, error: '導師姓名含不允許的字元：' + name };
    const email = String(t.email == null ? '' : t.email).trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email 格式不正確：' + email };
    if (email.length > 100) return { ok: false, error: 'email 過長' };
    const ext = String(t.ext == null ? '' : t.ext).trim();
    if (ext && !CONTACT_RE.test(ext)) return { ok: false, error: '校內分機格式不正確（只接受數字與 + - ( ) # 空白）：' + ext };
    const mobileRaw = (t.mobile === undefined || t.mobile === null) ? t.phone : t.mobile;
    const mobile = String(mobileRaw == null ? '' : mobileRaw).trim();
    if (mobile && !CONTACT_RE.test(mobile)) return { ok: false, error: '私人手機格式不正確（只接受數字與 + - ( ) # 空白）：' + mobile };
    out.push({ name: name, email: email, ext: ext, mobile: mobile });
  }
  return { ok: true, tutors: out };
}

// ── 主任導師（＝系主任）─────────────────────────────────────────────────────
// 系所層級只有一位，資料放在 department.head = {name,email,ext,mobile}。
// headName/headEmail 是**核章身分**（resolveRoles_ 的 deptHeadOf 靠 headEmail 命中），
// 與 head.name/head.email 同步由 admin 維護；系辦助理只能改姓名與聯絡方式，**改不到 email**
// ——能改 email 就等於能把自己設成系主任、進而核章，那是提權（見 deptRosterUpsertHeadAction_）。
function projectDeptHeadForRoster_(dept) {
  const h = (dept && dept.head) || {};
  return {
    name: h.name || (dept && dept.headName) || '',
    email: h.email || (dept && dept.headEmail) || '',
    ext: h.ext || '',
    mobile: (h.mobile || h.phone) || '',
  };
}

// 主任導師欄位正規化（純函式）。規則刻意與導師名單同一套（同樣的字元白名單與長度）。
function normalizeDeptHead_(head) {
  const h = head || {};
  const CONTACT_RE = /^[0-9+\-()#\s]{1,20}$/;
  const name = String(h.name == null ? '' : h.name).trim();
  if (name && !/^[A-Za-z0-9一-鿿·．\s]{1,20}$/.test(name)) return { ok: false, error: '主任導師姓名含不允許的字元：' + name };
  const email = String(h.email == null ? '' : h.email).trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email 格式不正確：' + email };
  if (email.length > 100) return { ok: false, error: 'email 過長' };
  const ext = String(h.ext == null ? '' : h.ext).trim();
  if (ext && !CONTACT_RE.test(ext)) return { ok: false, error: '校內分機格式不正確：' + ext };
  const mobileRaw = (h.mobile === undefined || h.mobile === null) ? h.phone : h.mobile;
  const mobile = String(mobileRaw == null ? '' : mobileRaw).trim();
  if (mobile && !CONTACT_RE.test(mobile)) return { ok: false, error: '私人手機格式不正確：' + mobile };
  return { ok: true, head: { name: name, email: email, ext: ext, mobile: mobile } };
}

// deptRosterUpsertHead：系辦助理（或 admin）維護自己系的主任導師姓名與聯絡方式。
// **email 一律沿用既有值**：那是核章身分，助理改得動就等於能指派系主任。要換人請由中心（admin）改。
function deptRosterUpsertHeadAction_(params, ctx, userEmail) {
  const wantDeptId = String(params.deptId || '').trim();
  const headRes = normalizeDeptHead_(params.head);
  if (!headRes.ok) throw new Error(headRes.error);

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = readJsonSafe_('departments.json', ctx, []);
    const classes = readJsonSafe_('classes.json', ctx, []);
    const roles = resolveRoles_(userEmail, config, departments, classes);
    const scope = resolveDeptRosterScope_(roles, wantDeptId, departments);
    if (!scope.ok) throw new Error(scope.error);
    const deptId = scope.deptIds.length === 1 ? scope.deptIds[0] : wantDeptId;
    if (!deptId || scope.deptIds.indexOf(deptId) === -1) throw new Error('forbidden');

    const idx = departments.findIndex(function (d) { return d && d.id === deptId; });
    if (idx === -1) throw new Error('department not found: ' + deptId);
    const cur = departments[idx];
    const now = new Date().toISOString();
    const head = Object.assign({}, headRes.head, {
      email: (cur.head && cur.head.email) || cur.headEmail || '',   // ← 助理改不到
    });
    departments[idx] = Object.assign({}, cur, {
      head: head, headName: head.name, updatedAt: now, updatedBy: userEmail,
    });
    writeJsonPath_('departments.json', departments, ctx);
    appendAuditLog_(ctx, { action: 'deptRosterUpsertHead', by: userEmail, targetId: deptId, at: now });
    return {
      department: { id: deptId, name: cur.name, collegeId: cur.collegeId || null, head: projectDeptHeadForRoster_(departments[idx]) },
      _notify: { deptId: deptId, summary: '更新主任導師（' + (head.name || '未填姓名') + '）的聯絡方式' },
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 導師名冊 → Google Sheet 同步 ─────────────────────────────────────────────
// 使用者決策（2026-08-11）：**存檔即同步＋每小時全量校正**、**Sheet 不含私人手機**。
// - 不含手機是刻意的：Sheet 一旦分享出去，權限就由 Google 的共用設定決定，系統管不到；
//   外洩時外流的頂多是校內分機。要看手機一律回系統（deptRosterGet）。
// - 兩條路徑都是「整張重寫」而不是只補該系那幾列：名冊只有幾百列，一次 setValues 就寫完，
//   而部分更新要處理列位移／刪除，錯了會留下幽靈列——重寫沒有這個問題。
// - 只有 GAS 軌有 SpreadsheetApp；自架軌（server/gas-host.js）沒有這個全域，
//   所以一律先 typeof 檢查，缺了就當作「沒設定同步」安靜跳過，不能讓存檔失敗。
// ══════════════════════════════════════════════════════════════════════════════
const ROSTER_SHEET_PROP_ = 'ROSTER_SHEET_ID';
const ROSTER_SHEET_TAB_ = '導師名冊';

// 純函式：攤成試算表的二維陣列（第一列是表頭）。一位導師一列、沒有導師的班級也出一列，
// 與 Excel 匯出同一套形狀，差別只在**不含私人手機**。
// 純函式：產生每個分頁的內容。版面刻意仿既有統計表：
//   row0 學院名／row1 說明／row2–4 三列表頭（欄標題垂直合併）／row5 起資料，
//   系別與主任導師只在該系第一列出現（其餘留白，效果同合併儲存格的視覺）。
// 欄位是名冊的欄位，不是統計表的「應開/已開/宣導」——那些屬於班會紀錄流程，目前停用；
// 之後重啟再把欄位補回來即可（表頭是這裡產生的，加欄不影響資料寫入邏輯）。
function buildRosterSheetTabs_(departments, classes, colleges, stamp) {
  // 分頁分組：比照既有的「班級、家族會議記錄暨班級業務統計」活頁簿——一個學院一個分頁，
  // 獸醫／國際／達人三個小學院併成一頁。沒對到的學院各自成頁（不會靜默消失）。
  // 刻意放在函式**裡面**：測試沙箱只載入具名函式，頂層 const 不會跟著進去
  // （放外面第一次跑測試就 ReferenceError）。
  const TAB_MAP = {
    '農學院': '農學院', '工學院': '工學院', '管理學院': '管理學院',
    '人文暨社會科學院': '人文學院', '人文社科院': '人文學院',
    '獸醫學院': '獸醫國際達人', '國際學院': '獸醫國際達人', '達人學院': '獸醫國際達人',
  };
  const TAB_ORDER = ['農學院', '工學院', '管理學院', '人文學院', '獸醫國際達人'];
  const HEADER_ROWS = 5;   // 學院名／說明／表頭三列
  const W = 8;              // 系別｜主任導師姓名｜主任導師分機｜班級｜班名(原始)｜導師｜分機｜狀態

  const collegeName = {};
  (colleges || []).forEach(function (c) { if (c) collegeName[c.id] = c.name || c.id; });
  // 對外一律顯示正式全名（fullName，中心的系所清冊）；沒填過就退回內部的簡稱名。
  const deptLabel = function (d) { return (d && (d.fullName || d.name || d.id)) || ''; };
  const byDept = {};
  (classes || []).forEach(function (c) {
    if (!c || c.deleted === true) return;
    (byDept[c.deptId] = byDept[c.deptId] || []).push(c);
  });

  const tabs = {};      // tab → { rows:[], merges:[] }
  const tabOrder = [];
  const ensure = function (tab) {
    if (!tabs[tab]) { tabs[tab] = { rows: [], merges: [] }; tabOrder.push(tab); }
    return tabs[tab];
  };

  (departments || []).forEach(function (d) {
    if (!d || d.deleted === true || d.active === false) return;
    const cname = collegeName[d.collegeId] || d.collegeId || '未分學院';
    const t = ensure(TAB_MAP[cname] || cname);
    const head = d.head || {};
    const deptStart = t.rows.length;                    // 這個系在資料區的起始 index
    const list = (byDept[d.id] || []).slice().sort(function (a, b) {
      return String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), 'zh-Hant');
    });

    if (!list.length) {
      t.rows.push([deptLabel(d), head.name || '', head.ext || '', '（此系目前沒有班級）', '', '', '', '']);
    } else {
      list.forEach(function (c) {
        const state = [];
        if (c.active === false) state.push('停用');
        if (c.graduatedSemester) state.push('已畢業(' + c.graduatedSemester + ')');
        const tutors = (c.tutors || []).filter(Boolean);
        const clsStart = t.rows.length;
        const rowsFor = tutors.length ? tutors : [null];
        rowsFor.forEach(function (tu, i) {
          t.rows.push([
            i === 0 && clsStart === deptStart ? deptLabel(d) : '',       // 系別只寫在該系第一列
            i === 0 && clsStart === deptStart ? (head.name || '') : '',
            i === 0 && clsStart === deptStart ? (head.ext || '') : '',
            i === 0 ? (c.displayName || c.name) : '',                    // 班級只寫在該班第一列
            i === 0 ? c.name : '',
            (tu && tu.name) || '', (tu && tu.ext) || '',
            state.join('／') || '啟用',
          ]);
        });
        // 同一班多位導師 → 班級那兩欄縱向合併
        if (rowsFor.length > 1) {
          [4, 5].forEach(function (col) {
            t.merges.push({ row: HEADER_ROWS + clsStart + 1, col: col, numRows: rowsFor.length, numCols: 1 });
          });
        }
      });
    }
    // 系別與主任導師兩欄，縱向合併整個系的區塊（原檔就是合併儲存格的樣子）
    const span = t.rows.length - deptStart;
    if (span > 1) {
      [1, 2, 3].forEach(function (col) {
        t.merges.push({ row: HEADER_ROWS + deptStart + 1, col: col, numRows: span, numCols: 1 });
      });
    }
  });

  const ordered = TAB_ORDER.filter(function (t) { return tabs[t]; })
    .concat(tabOrder.filter(function (t) { return TAB_ORDER.indexOf(t) === -1; }));

  return ordered.map(function (tab) {
    const t = tabs[tab];
    const values = [];
    values.push([tab, '', '', '', '', '', '', '']);
    values.push(['資料來源：各系導師名冊（系辦助理維護）。最後同步：' + (stamp || '') +
      '　※本表不含導師私人手機，需要時請至系統查詢。', '', '', '', '', '', '', '']);
    values.push(['系別', '主任導師(系主任)', '', '班級', '班級名稱(原始)', '導師姓名', '校內分機', '狀態']);
    values.push(['', '姓名', '校內分機', '', '', '', '', '']);
    values.push(['', '', '', '', '', '', '', '']);
    t.rows.forEach(function (r) { values.push(r); });
    // 表頭的合併：學院名列與說明列各自跨滿整列；「主任導師」跨兩欄、「聯絡方式」跨兩欄；
    // 其餘欄標題垂直跨三列（第 3–5 列）——與原檔同一種讀法。
    const merges = [
      { row: 1, col: 1, numRows: 1, numCols: values[0].length },
      { row: 2, col: 1, numRows: 1, numCols: values[0].length },
      { row: 3, col: 2, numRows: 1, numCols: 2 },
    ];
    [1, 4, 5, 6, 7, 8].forEach(function (col) { merges.push({ row: 3, col: col, numRows: 3, numCols: 1 }); });
    return { tab: tab, values: values, merges: merges.concat(t.merges), rows: t.rows.length, headerRows: HEADER_ROWS, width: W };
  });
}

function rosterSheetId_() {
  try { return PropertiesService.getScriptProperties().getProperty(ROSTER_SHEET_PROP_) || ''; } catch (e) { return ''; }
}

// 整張重寫。回 {ok:true,rows} 或 {ok:false,reason}——reason 是「沒設定/沒有這個環境」這類
// 預期內的跳過，例外才 throw（由 syncRosterSheetSafe_ 吞掉）。
function syncRosterSheet_(ctx) {
  if (typeof SpreadsheetApp === 'undefined') return { ok: false, reason: '這個環境沒有 SpreadsheetApp（自架軌）' };
  const id = rosterSheetId_();
  if (!id) return { ok: false, reason: 'ROSTER_SHEET_ID 未設定（請先跑 maintenanceSetupRosterSheet）' };
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const colleges = readJsonSafe_('colleges.json', ctx, []);
  const tabs = buildRosterSheetTabs_(departments, classes, colleges, nowStampTaipei_());
  const ss = SpreadsheetApp.openById(id);
  let total = 0;
  const report = [];
  tabs.forEach(function (t, i) {
    let sh = ss.getSheetByName(t.tab);
    if (!sh) sh = ss.insertSheet(t.tab);
    sh.clear();
    // 舊的合併要先解掉，否則 setValues 會在合併範圍上炸（重寫時尺寸可能變）
    try { sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart(); } catch (e) {}
    sh.getRange(1, 1, t.values.length, t.values[0].length).setValues(t.values);
    const W = t.values[0].length;
    // 合併：表頭與「系別／主任導師」的縱向區塊，都由 buildRosterSheetTabs_ 算好座標送過來。
    // **不要整段 try 包住**——上一版那樣寫，其中一個 merge 撞到就把後面的版面全吃掉，
    // 使用者看到的是「沒有跨欄置中」而 log 一片安靜。改成逐一 try 並回報失敗數。
    let mergeFailed = 0;
    t.merges.forEach(function (m) {
      try { sh.getRange(m.row, m.col, m.numRows, m.numCols).merge(); } catch (e) { mergeFailed++; }
    });
    try {
      sh.getRange(1, 1, 1, W).setFontWeight('bold').setFontSize(14).setHorizontalAlignment('center');
      sh.getRange(2, 1, 1, W).setWrap(true).setFontSize(9).setFontColor('#666666');
      sh.getRange(3, 1, 3, W).setFontWeight('bold').setBackground('#f2f4f7');
      // 合併的儲存格要水平＋垂直置中才有原檔那個樣子
      sh.getRange(3, 1, 3 + t.rows, W).setHorizontalAlignment('center').setVerticalAlignment('middle');
      sh.setFrozenRows(t.headerRows);
      sh.setColumnWidths(1, W, 110);
      sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 80);
      if (sh.getMaxColumns() > W) sh.deleteColumns(W + 1, sh.getMaxColumns() - W);
      if (sh.getMaxRows() > t.values.length) sh.deleteRows(t.values.length + 1, sh.getMaxRows() - t.values.length);
    } catch (e) { report.push(t.tab + ' 版面：' + e.message); }
    if (mergeFailed) report.push(t.tab + ' 有 ' + mergeFailed + ' 個合併失敗');
    total += t.rows;
    if (i === 0) sh.activate();
  });
  // 上一版只有一張「導師名冊」總表，改成分學院分頁後把它清掉，免得留著過期資料誤導
  const legacy = ss.getSheetByName(ROSTER_SHEET_TAB_);
  if (legacy && tabs.length) { try { ss.deleteSheet(legacy); } catch (e) {} }
  return {
    ok: true, rows: total,
    tabs: tabs.map(function (t) { return t.tab + '(' + t.rows + ')'; }),
    版面問題: report.length ? report : '無',
  };
}

function syncRosterSheetSafe_(ctx) {
  try { return syncRosterSheet_(ctx); } catch (e) {
    // 同步失敗**不能**讓名冊存檔失敗——助理填的資料已經寫進 Drive 了，
    // 這裡只是把它抄一份到 Sheet，抄失敗下一次存檔或每小時校正就會補上。
    try { Logger.log('syncRosterSheet failed: ' + e.message); } catch (_) {}
    return { ok: false, reason: e.message };
  }
}

function nowStampTaipei_() {
  const d = new Date(Date.now() + 8 * 3600000);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 名冊異動通知學諮主責 ──────────────────────────────────────────────────────
// 使用者決策（2026-08-11）：**即時，但同一系 30 分鐘內合併成一封**。
// GAS 沒有「延後執行一次」的機制，所以做法是：異動先進佇列（Drive JSON），
// 由每 10 分鐘的時間觸發器決定哪些系所該寄了——
//   ①該系已經停手（最後一筆距今 ≥ 靜默期 10 分鐘）→ 寄
//   ②該系一直在改（最早一筆距今 ≥ 30 分鐘）→ 也寄，不能無限延後
// 這樣連續編輯十幾筆只會收到一封，而停手後最多 10 分鐘內就會收到。
// ══════════════════════════════════════════════════════════════════════════════
const ROSTER_NOTIFY_QUEUE_ = 'rosterNotifyQueue.json';
const ROSTER_NOTIFY_QUIET_MS_ = 10 * 60 * 1000;
const ROSTER_NOTIFY_MAX_WAIT_MS_ = 30 * 60 * 1000;

// 純函式：決定哪些系所的事件現在該寄出、哪些繼續等。
function selectNotifyBatches_(events, nowMs, quietMs, maxWaitMs) {
  const byDept = {};
  (events || []).forEach(function (e) {
    if (!e || !e.deptId) return;
    (byDept[e.deptId] = byDept[e.deptId] || []).push(e);
  });
  const ready = [];
  const keep = [];
  Object.keys(byDept).forEach(function (deptId) {
    const list = byDept[deptId].slice().sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    const first = new Date(list[0].at).getTime();
    const last = new Date(list[list.length - 1].at).getTime();
    if ((nowMs - last) >= quietMs || (nowMs - first) >= maxWaitMs) ready.push({ deptId: deptId, events: list });
    else list.forEach(function (e) { keep.push(e); });
  });
  ready.sort(function (a, b) { return a.deptId.localeCompare(b.deptId); });
  return { ready: ready, keep: keep };
}

function enqueueRosterChange_(ctx, deptId, userEmail, summary) {
  try {
    withLock_(function () {
      const q = readJsonSafe_(ROSTER_NOTIFY_QUEUE_, ctx, { events: [] });
      const events = (q && q.events) || [];
      // 佇列只是通知用的暫存，不是稽核（稽核在 audit_log）。爆量時丟掉最舊的，
      // 寧可少寄一封也不要讓這個檔無限長大。
      if (events.length >= 500) events.splice(0, events.length - 499);
      events.push({ deptId: deptId, by: userEmail, at: new Date().toISOString(), summary: summary });
      writeJsonPath_(ROSTER_NOTIFY_QUEUE_, { events: events }, ctx);
    });
  } catch (e) {
    try { Logger.log('enqueueRosterChange failed: ' + e.message); } catch (_) {}
  }
}

// 零參數，供每 10 分鐘的時間觸發器呼叫。
function flushRosterNotifications() {
  const ctx = { root: ROOT_FOLDER_ID };
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  // 收件者：每位未停用的主責攤成「登入信箱＋其他收信信箱」（見 mailTargetsForEntry_）
  const leads = [];
  (config.staffLeads || []).forEach(function (s) {
    if (!s || !s.email || s.disabled === true || s.deleted === true) return;
    mailTargetsForEntry_(s).forEach(function (m) { if (leads.indexOf(m) === -1) leads.push(m); });
  });

  const picked = withLock_(function () {
    const q = readJsonSafe_(ROSTER_NOTIFY_QUEUE_, ctx, { events: [] });
    const res = selectNotifyBatches_((q && q.events) || [], Date.now(), ROSTER_NOTIFY_QUIET_MS_, ROSTER_NOTIFY_MAX_WAIT_MS_);
    if (res.ready.length) writeJsonPath_(ROSTER_NOTIFY_QUEUE_, { events: res.keep }, ctx);
    return res.ready;
  });

  if (!picked.length) return 'nothing to send';
  // 沒有主責就別把佇列吃掉——上面已經寫回去了，所以這裡直接回報，事件已消失是可接受的
  // （通知是輔助，不是稽核；稽核在 audit_log）。
  if (!leads.length) return 'no staffLead to notify';

  let sent = 0;
  picked.forEach(function (batch) {
    const dept = departments.filter(function (d) { return d && d.id === batch.deptId; })[0];
    const deptName = (dept && dept.name) || batch.deptId;
    const lines = batch.events.map(function (e) {
      return '・' + stampToTaipei_(e.at) + '　' + (e.summary || '（未記錄內容）') + '　— ' + (e.by || '');
    });
    const body = deptName + ' 的導師名冊有 ' + batch.events.length + ' 筆更新：\n\n' + lines.join('\n') +
      '\n\n（同一系所 ' + (ROSTER_NOTIFY_QUIET_MS_ / 60000) + ' 分鐘內的連續編輯會合併成一封）\n' +
      '系統：各系導師名冊';
    try {
      MailApp.sendEmail({
        to: leads.join(','),
        subject: '【各系導師名冊】' + deptName + ' 有 ' + batch.events.length + ' 筆更新',
        body: body,
      });
      sent++;
    } catch (e) {
      try { Logger.log('notify failed for ' + batch.deptId + ': ' + e.message); } catch (_) {}
    }
  });
  return 'sent ' + sent + ' mail(s)';
}

function stampToTaipei_(iso) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso || '');
  const d = new Date(t + 8 * 3600000);
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// action 回傳裡的 _notify 是給 dispatcher 看的內部欄位：取出來做收尾，再從回應拿掉。
// 收尾失敗（寄信佇列寫不進去、Sheet 同步掛掉）不影響這次存檔的成功回應——資料已經落地了。
function withRosterAftercare_(result, ctx, userEmail) {
  if (!result || !result._notify) return result;
  const n = result._notify;
  delete result._notify;
  afterRosterChange_(ctx, n.deptId, userEmail, n.summary);
  return result;
}

// 名冊異動的共同收尾：同步 Sheet ＋ 排入通知佇列。**一定在 withLock_ 外面呼叫**——
// 這兩件事都是對外 I/O（Sheets API／Drive 寫檔），放在鎖裡會讓別人的存檔等到 waitLock 逾時。
function afterRosterChange_(ctx, deptId, userEmail, summary) {
  enqueueRosterChange_(ctx, deptId, userEmail, summary);
  syncRosterSheetSafe_(ctx);
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 批次套用「系所全名 ＋ 系辦助理登入密碼」（來源：中心提供的系所清冊）─────────
// 兩個發現決定了這裡的做法，都寫下來免得日後有人「簡化」掉：
//
// ① **全名存成新欄位 fullName，不改 department.name。**
//    name 不只是顯示用：deptShortName_ 會把它去掉結尾的「系」當成班級顯示名的系簡稱
//    （農園系→農園 → 四農園一A），classDisplayNameDeptOverride_ 也是用 name 當鍵
//    （'材料工程系'→'材料'…）。把 name 換成「農園生產系」會讓之後每次匯入/改名產出
//    「四農園生產一A」，並讓 7 個 canonical 覆寫全部失配。所以：
//      name     = 內部命名規則的輸入（簡稱來源），維持現狀
//      fullName = 對外顯示的正式全名（Sheet 的系別欄、選單、匯出、公文都用它）
//
// ② **密碼＝系主任分機，寫進白名單的 ext。**
//    ext 這個欄位在本系統的定義就是「初始密碼的來源」（見 initialPasswordFromExtGas_），
//    所以把它設成系主任分機，UI 顯示、匯出的「初始密碼」欄與實際登入密碼才會一致——
//    只改雜湊不改 ext 會讓後台顯示一個打不開的號碼，是接電話的人最容易被害到的那種不一致。
//
// 預設是**預演**（apply!==true 只回計畫不寫入）。已自行改過密碼的帳號預設**跳過**
// （2026-08-11 使用者剛被「重設為分機」清掉自訂密碼，那個坑不要再踩），
// 真要一起重設得明確帶 force:true。
function adminBulkApplyDeptSheetAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const rows = params.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows 必須是非空陣列');
  if (rows.length > 200) throw new Error('一次最多 200 列');
  const apply = params.apply === true;
  const force = params.force === true;

  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const accounts = readJsonSafe_('localAccounts.json', ctx, {});
  const assistants = (config.deptAssistants || []).filter(function (a) { return a && a.deleted !== true; });

  // 先全部驗完再動手：任何一列對不到系所就整批拒絕（半套的名冊比沒有更難查）
  const plan = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const deptId = String(r.deptId || '').trim();
    const fullName = String(r.fullName == null ? r.name : r.fullName).trim();
    const ext = String(r.ext == null ? '' : r.ext).trim();
    const dept = departments.filter(function (d) { return d && d.id === deptId && d.deleted !== true; })[0];
    if (!dept) throw new Error('第 ' + (i + 1) + ' 列：找不到系所「' + deptId + '」');
    if (!fullName) throw new Error('第 ' + (i + 1) + ' 列：缺全名');
    if (fullName.length > 40) throw new Error('第 ' + (i + 1) + ' 列：全名過長');
    if (ext && !/^[0-9+\-()#\s]{1,20}$/.test(ext)) throw new Error('第 ' + (i + 1) + ' 列：分機格式不正確：' + ext);
    const mine = assistants.filter(function (a) { return (a.deptIds || []).indexOf(deptId) !== -1; });
    plan.push({
      deptId: deptId, fullName: fullName, ext: ext,
      nameNow: dept.name || deptId, fullNameNow: dept.fullName || '',
      assistants: mine.map(function (a) {
        const email = String(a.email || '').toLowerCase();
        const u = accounts[email];
        const selfChanged = !!u && u.mustChangePassword !== true;
        return {
          email: email, extNow: a.ext || '',
          hasAccount: !!u, selfChanged: selfChanged,
          action: !ext ? 'skip-no-ext' : (selfChanged && !force ? 'skip-self-changed' : (u ? 'reset' : 'create')),
        };
      }),
    });
  }

  const summary = {
    模式: apply ? '已套用' : '預演（未寫入）',
    系所數: plan.length,
    全名有變動: plan.filter(function (p) { return (p.fullNameNow || '') !== p.fullName; }).length,
    助理筆數: plan.reduce(function (n, p) { return n + p.assistants.length; }, 0),
    將建立帳號: plan.reduce(function (n, p) { return n + p.assistants.filter(function (a) { return a.action === 'create'; }).length; }, 0),
    將重設密碼: plan.reduce(function (n, p) { return n + p.assistants.filter(function (a) { return a.action === 'reset'; }).length; }, 0),
    跳過已自訂密碼: plan.reduce(function (n, p) { return n + p.assistants.filter(function (a) { return a.action === 'skip-self-changed'; }).length; }, 0),
    沒有助理的系所: plan.filter(function (p) { return !p.assistants.length; }).map(function (p) { return p.deptId; }),
  };
  if (!apply) return { plan: plan, summary: summary };

  // 雜湊在鎖外算（每筆約 0.5 秒；47 筆放進鎖裡會讓別人的請求 waitLock 逾時）
  const hashes = {};
  plan.forEach(function (p) {
    p.assistants.forEach(function (a) {
      if (a.action === 'create' || a.action === 'reset') hashes[a.email] = hashPasswordGas_(initialPasswordFromExtGas_(p.ext));
    });
  });

  const now = new Date();
  const expires = new Date(now.getTime() + ACTIVATION_WINDOW_DAYS_ * 86400000).toISOString();
  withLock_(function () {
    const freshDepts = readJsonSafe_('departments.json', ctx, []);
    const freshConfig = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const freshAccounts = readJsonSafe_('localAccounts.json', ctx, {});
    plan.forEach(function (p) {
      const di = freshDepts.findIndex(function (d) { return d && d.id === p.deptId; });
      if (di !== -1) freshDepts[di] = Object.assign({}, freshDepts[di], { fullName: p.fullName, updatedAt: now.toISOString(), updatedBy: userEmail });
      (freshConfig.deptAssistants || []).forEach(function (a, ai) {
        if (!a || a.deleted === true) return;
        if ((a.deptIds || []).indexOf(p.deptId) === -1) return;
        if (p.ext) freshConfig.deptAssistants[ai] = Object.assign({}, a, { ext: p.ext });
      });
      p.assistants.forEach(function (a) {
        if (!hashes[a.email]) return;
        freshAccounts[a.email] = Object.assign({}, freshAccounts[a.email] || {}, {
          hash: hashes[a.email], disabled: false,
          mustChangePassword: true, activationExpiresAt: expires,
        });
      });
    });
    writeJsonPath_('departments.json', freshDepts, ctx);
    writeJsonPath_('config.json', freshConfig, ctx);
    writeJsonPath_('localAccounts.json', freshAccounts, ctx);
  });
  appendAuditLog_(ctx, {
    action: 'adminBulkApplyDeptSheet', by: userEmail,
    targetId: plan.length + ' depts / ' + summary.將建立帳號 + '+' + summary.將重設密碼 + ' accounts',
    at: now.toISOString(),
  });
  syncRosterSheetSafe_(ctx);
  return { plan: plan, summary: summary };
}

// adminBulkUpsertDeptHeads：admin only，一次寫入多系的主任導師（含 email）。
// 37 個系所逐筆呼叫 adminUpsertDepartment 會各進一次鎖、各寫一次檔，在 GAS 上會逼近 6 分鐘上限
// （2026-08-10 建 47 個帳號時實際卡住過），所以這裡「讀一次 → 全部算完 → 寫一次」。
// 任一列的系所不存在就整批拒絕，不做部分寫入——半套的名單比沒有更難查。
function adminBulkUpsertDeptHeadsAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const rows = params.heads;
  if (!Array.isArray(rows) || !rows.length) throw new Error('heads 必須是非空陣列');
  if (rows.length > 200) throw new Error('一次最多 200 列');

  return withLock_(function () {
    const departments = readJsonSafe_('departments.json', ctx, []);
    const now = new Date().toISOString();
    const prepared = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const deptId = String(r.deptId || '').trim();
      const idx = departments.findIndex(function (d) { return d && d.id === deptId && d.deleted !== true; });
      if (idx === -1) throw new Error('第 ' + (i + 1) + ' 列：找不到系所「' + deptId + '」');
      const res = normalizeDeptHead_(r);
      if (!res.ok) throw new Error('第 ' + (i + 1) + ' 列：' + res.error);
      if (!res.head.name) throw new Error('第 ' + (i + 1) + ' 列：主任導師姓名必填');
      prepared.push({ idx: idx, head: res.head });
    }
    prepared.forEach(function (p) {
      const cur = departments[p.idx];
      departments[p.idx] = Object.assign({}, cur, {
        head: p.head,
        // headName/headEmail 是核章身分的事實來源，與 head 同步更新。
        headName: p.head.name, headEmail: p.head.email,
        updatedAt: now, updatedBy: userEmail,
      });
    });
    writeJsonPath_('departments.json', departments, ctx);
    appendAuditLog_(ctx, { action: 'adminBulkUpsertDeptHeads', by: userEmail, targetId: prepared.length + ' depts', at: now });
    return { count: prepared.length, departments: sanitizeDepartmentsForViewer_(departments) };
  });
}

// 送上來沒有 email 的導師，依**姓名**把既有的 email 補回來（純函式）。
// 2026-08-11 起導師資料表單不再有 email 欄（系辦助理只填分機與手機），送上來一律是空字串；
// 直接寫回去等於把 class.tutors[].email 清空，而那是導師核章權限的身分依據
// （resolveRoles_ 的 tutorOf 用 email 命中 isClassTutor_）——導師會就此失去自己班的核章權。
// 姓名相同視為同一人（同班同名極罕見；真的撞名就取第一個，寧可補錯也不要清空）。
// 明確送了 email 的呼叫端（admin 匯入路徑不走這裡，但未來可能有）照送的值為準。
function carryOverTutorEmails_(incoming, existing) {
  const byName = {};
  (existing || []).forEach(function (t) {
    const k = String((t && t.name) || '').trim();
    if (k && !byName[k] && t.email) byName[k] = t.email;
  });
  return (incoming || []).map(function (t) {
    if (t.email) return t;
    const old = byName[String(t.name || '').trim()];
    return old ? Object.assign({}, t, { email: old }) : t;
  });
}

// deptRosterUpsertClass：系辦助理在**自己系**新增或修改班級（班名、簡稱、導師名單含聯絡方式）。
// 刻意不開放的欄位：deptId（不能把班搬去別系）、requiredMeetingOverride／graduatedSemester
// （應繳份數與畢業狀態是中心的事）、uploadWhitelist、suggestedTutors。
// 既有班級一律先確認「它現在就屬於允許的系所」才准動——不然帶著別系的 classId 就能改到別系。
function deptRosterUpsertClassAction_(params, ctx, userEmail) {
  const entry = params.class || {};
  const tutorsRes = normalizeDeptRosterTutors_(entry.tutors);
  if (!tutorsRes.ok) throw new Error(tutorsRes.error);
  const className = String(entry.name == null ? '' : entry.name).trim();
  if (!isValidClassName_(className)) throw new Error('invalid class name: ' + className);
  const displayName = String(entry.displayName == null ? '' : entry.displayName).trim().slice(0, 40);

  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = readJsonSafe_('departments.json', ctx, []);
    const classes = readJsonSafe_('classes.json', ctx, []);
    const roles = resolveRoles_(userEmail, config, departments, classes);
    const scope = resolveDeptRosterScope_(roles, entry.deptId, departments);
    if (!scope.ok) throw new Error(scope.error);
    const deptId = scope.deptIds.length === 1 ? scope.deptIds[0] : String(entry.deptId || '').trim();
    if (!deptId || scope.deptIds.indexOf(deptId) === -1) throw new Error('forbidden');
    const dept = departments.filter(function (d) { return d && d.id === deptId; })[0];

    const now = new Date().toISOString();
    let next = classes.slice();
    let target = null;

    if (entry.id) {
      const idx = next.findIndex(function (c) { return c && c.id === entry.id; });
      if (idx === -1) throw new Error('class not found: ' + entry.id);
      const cur = next[idx];
      // 現況必須落在授權範圍內；已軟刪除的不給改（要先由 admin 復原）。
      if (scope.deptIds.indexOf(cur.deptId) === -1) throw new Error('forbidden');
      if (cur.deleted === true) throw new Error('class deleted: ' + cur.id);
      // 撞名檢查：同系不得有兩個同班名（班級身分＝(deptId, name)）。
      const clash = next.filter(function (c) {
        return c && c.id !== cur.id && c.deptId === deptId && c.name === className && c.deleted !== true;
      })[0];
      if (clash) throw new Error('class name already exists: ' + className);
      target = Object.assign({}, cur, {
        name: className, displayName: displayName || cur.displayName || className,
        tutors: carryOverTutorEmails_(tutorsRes.tutors, cur.tutors),
        updatedAt: now, updatedBy: userEmail,
      });
      next[idx] = target;
    } else {
      const clash = next.filter(function (c) {
        return c && c.deptId === deptId && c.name === className && c.deleted !== true;
      })[0];
      if (clash) throw new Error('class name already exists: ' + className);
      const fused = displayName || fuseClassDisplayName_(className, dept ? dept.name : deptId, null,
        tutorsRes.tutors.length ? tutorsRes.tutors[0].name : undefined);
      target = {
        id: uniqueClassId_(deptId + '_' + slugifyDeptId_(className), next), name: className, deptId: deptId,
        systemId: null, displayName: fused,
        requiredMeetingOverride: null, tutors: tutorsRes.tutors, suggestedTutors: [],
        dualApprovalMode: 'any', uploadWhitelist: [], active: true,
        createdAt: now, createdBy: userEmail,
      };
      next.push(target);
    }

    writeJsonPath_('classes.json', next, ctx);
    appendAuditLog_(ctx, {
      action: entry.id ? 'deptRosterUpdateClass' : 'deptRosterCreateClass',
      by: userEmail, targetId: target.id, at: now,
    });
    return { class: projectClassForDeptRoster_(target), _notify: { deptId: deptId, summary: (entry.id ? '修改班級「' : '新增班級「') + className + '」（導師 ' + tutorsRes.tutors.length + ' 位）' } };
  });
}

// deptRosterDeleteClass：系辦助理刪除自己系的班級。走**軟刪除**（deleted:true 墓碑），
// 與系統其他六類實體一致——紀錄與統計靠 classId 關聯，硬刪會讓歷史斷鏈。
function deptRosterDeleteClassAction_(params, ctx, userEmail) {
  const classId = String(params.classId || '').trim();
  if (!classId) throw new Error('classId required');
  return withLock_(function () {
    const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
    const departments = readJsonSafe_('departments.json', ctx, []);
    const classes = readJsonSafe_('classes.json', ctx, []);
    const roles = resolveRoles_(userEmail, config, departments, classes);
    const scope = resolveDeptRosterScope_(roles, null, departments);
    if (!scope.ok) throw new Error(scope.error);

    const idx = classes.findIndex(function (c) { return c && c.id === classId; });
    if (idx === -1) throw new Error('class not found: ' + classId);
    if (scope.deptIds.indexOf(classes[idx].deptId) === -1) throw new Error('forbidden');

    const now = new Date().toISOString();
    const next = classes.slice();
    next[idx] = Object.assign({}, next[idx], { deleted: true, deletedAt: now, deletedBy: userEmail });
    writeJsonPath_('classes.json', next, ctx);
    appendAuditLog_(ctx, { action: 'deptRosterDeleteClass', by: userEmail, targetId: classId, at: now });
    return { classId: classId, deleted: true, _notify: { deptId: classes[idx].deptId, summary: '刪除班級「' + (classes[idx].displayName || classes[idx].name) + '」' } };
  });
}

// deptRosterGet：系辦助理（或 admin）讀自己系的名冊。唯讀，Phase 1 的全部功能。
// 軟刪除的班級不回（比照系統其他地方對 deleted 的處理），停用的班級照回但帶 active:false——
// 助理要看得到「這班被停用了」才知道為什麼統計沒算它。
function deptRosterGetAction_(params, ctx, userEmail) {
  const config = readJsonSafe_('config.json', ctx, { users: {}, settings: {} });
  const departments = readJsonSafe_('departments.json', ctx, []);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const roles = resolveRoles_(userEmail, config, departments, classes);
  // 讀取用 ReadScope（多認一個全校唯讀的校安人員）；寫入路徑一律走 resolveDeptRosterScope_。
  const scope = resolveDeptRosterReadScope_(roles, params.deptId, departments);
  if (!scope.ok) throw new Error(scope.error);

  const rows = classes.filter(function (c) {
    return c && c.deleted !== true && scope.deptIds.indexOf(c.deptId) !== -1;
  }).map(projectClassForDeptRoster_);

  const depts = departments.filter(function (d) {
    return d && scope.deptIds.indexOf(d.id) !== -1;
  }).map(function (d) {
    // head（主任導師＝系主任）帶完整聯絡方式，因為這裡就是那條唯一通道。
    return {
      id: d.id, name: d.name, fullName: d.fullName || '',
      collegeId: d.collegeId || null, head: projectDeptHeadForRoster_(d),
    };
  });

  // readOnly：前端據此把新增/編輯/刪除的按鈕整組收起來（校安人員）。這只是 UI 提示，
  // **真正的邊界在後端**——寫入 action 走的是 resolveDeptRosterScope_，那支不認校安人員。
  return { deptIds: scope.deptIds, departments: depts, classes: rows, readOnly: scope.readOnly === true };
}

// adminChangeTutorMidterm：期中更換導師（admin only；Ticket C）。與 adminUpsertClass 改名單
// 的差異：這是「正式異動」入口——強制 effectiveDate、email 必填，寫入 tutorHistory
// changeType:'midterm'。驗證抽純函式 validateMidtermChange_（含 classId 存在且未刪除、
// 日期/名單/備註白名單），讀檔與驗證都在 withLock_ 內（拿最新 classes 驗、避免併發競態）。
function adminChangeTutorMidtermAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));

  return withLock_(function () {
    const now = new Date().toISOString();
    const classes = readJsonSafe_('classes.json', ctx, []);
    const chk = validateMidtermChange_(params, classes);
    if (!chk.ok) throw new Error(chk.error);
    const idx = classes.findIndex(function (c) { return c && c.id === chk.cls.id; });
    const prevTutors = classes[idx].tutors || [];
    const updated = Object.assign({}, classes[idx], { tutors: chk.tutors });
    classes[idx] = updated;
    writeJsonPath_('classes.json', classes, ctx);
    const semesters = readJsonSafe_('semesters.json', ctx, []);
    const historyEntry = buildTutorHistoryEntry_(
      updated, prevTutors, 'midterm', params.effectiveDate, chk.note, currentSemesterId_(semesters), userEmail, now
    );
    appendTutorHistory_(ctx, [historyEntry]);
    appendAuditLog_(ctx, { action: 'adminChangeTutorMidterm', by: userEmail, targetId: chk.cls.id, at: now });
    return { classes: classes, historyEntry: historyEntry };
  });
}

// tutorHistoryGet：查單一班級的導師異動歷史（依 at 升冪）。授權 default-deny
// （canViewTutorHistory_）：admin/director/staffLead/staffAssistant 任何班、系主任限本系、導師限自班，
// 其他一律拒。墓碑班級（deleted）也允許上述角色查——歷史正是刪除後還要看的東西。
// bootstrap 刻意不帶 tutorHistory（控制 payload），前端按需呼叫本 action。純讀取，不需 lock。
function tutorHistoryGetAction_(params, ctx, userEmail) {
  const classId = params.classId;
  if (!classId) throw new Error('classId required');
  const roles = loadRolesForCtx_(ctx, userEmail);
  const classes = readJsonSafe_('classes.json', ctx, []);
  const classInfo = classes.filter(function (c) { return c && c.id === classId; })[0];
  if (!classInfo) throw new Error('class not found: ' + classId);
  if (!canViewTutorHistory_(roles, classInfo)) throw new Error('not authorized to view tutor history');

  let hist = readJsonSafe_('tutorHistory.json', ctx, []);
  if (!Array.isArray(hist)) hist = [];
  const entries = hist
    .filter(function (e) { return e && e.classId === classId; })
    .sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  return { entries: entries };
}

// adminRolloverPreview：換學期升級規劃預覽（admin only；Ticket D）。純讀不拿鎖，
// 只產生規劃 rows 回前端逐列確認，不寫任何東西。
function adminRolloverPreviewAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const fromSemester = params.fromSemester, toSemester = params.toSemester;
  if (!fromSemester || !toSemester) throw new Error('fromSemester and toSemester required');
  requireValidSemester_(fromSemester, ctx);
  requireValidSemester_(toSemester, ctx);

  const classes = readJsonSafe_('classes.json', ctx, []);
  const departments = readJsonSafe_('departments.json', ctx, []);
  const tutorSystems = ensureTutorSystemsSeeded_(ctx);
  return { rows: computeRolloverPlan_(classes, departments, tutorSystems, fromSemester, toSemester) };
}

// adminRolloverApply：套用升級規劃（admin only；Ticket D；2026-08-11 事故後改為薄殼）。
// ensureTutorSystemsSeeded_ 在鎖外先跑一次（它首跑時自己會拿 LockService 鎖，withLock_
// 不可重入，全新部署第一次執行升級若沒有這一步會巢狀取鎖卡死 15 秒後逾時）；withLock_
// 內用剛讀到的最新 classes/departments/tutorSystems **重跑 computeRolloverPlan_**
// （不信前端 preview 快照，防併發也防灌水——client 傳來的 rows 只信 classId/action），
// 交給 applyRolloverPlan_ 做逐列驗證與「全有全無」套用：
// - ok:false（任一列有問題）→ 不寫 classes.json、不寫 tutorHistory，只留一筆 aborted
//   audit（誰在什麼時候試著套用、幾列失敗），回錯誤清單給前端逐列顯示。
// - ok:true → 只在真的有列被套用（inherited+vacated > 0）時才寫 classes.json（即使導師
//   剛好沒變，rolloverSemester 標記本身就是一次真實的寫入，見 applyRolloverPlan_ 註解）。
function adminRolloverApplyAction_(params, ctx, userEmail) {
  requireAdmin_(loadRolesForCtx_(ctx, userEmail));
  const fromSemester = params.fromSemester, toSemester = params.toSemester;
  if (!fromSemester || !toSemester) throw new Error('fromSemester and toSemester required');
  requireValidSemester_(fromSemester, ctx);
  requireValidSemester_(toSemester, ctx);
  const rows = params.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows required');
  // 先在鎖外確保 tutorSystems.json 已播種（ensureTutorSystemsSeeded_ 首跑時自己會拿鎖；
  // withLock_ 的 LockService 鎖不可重入，放進臨界區內會巢狀取鎖卡死——見 adminImportRosterAction_
  // 同一句註解）。全新部署第一次執行升級時 tutorSystems.json 還不存在，最容易踩到這個坑。
  ensureTutorSystemsSeeded_(ctx);

  return withLock_(function () {
    const now = new Date().toISOString();
    const classes = readJsonSafe_('classes.json', ctx, []);
    const departments = readJsonSafe_('departments.json', ctx, []);
    const tutorSystems = readJsonSafe_('tutorSystems.json', ctx, []);
    const plan = computeRolloverPlan_(classes, departments, tutorSystems, fromSemester, toSemester);
    const result = applyRolloverPlan_(classes, plan, rows, {
      fromSemester: fromSemester, toSemester: toSemester, by: userEmail, now: now,
    });

    if (!result.ok) {
      appendAuditLog_(ctx, {
        action: 'adminRolloverApply', by: userEmail,
        targetId: fromSemester + '→' + toSemester,
        aborted: true, errorCount: result.errors.length, at: now,
      });
      return { ok: false, aborted: true, errors: result.errors, applied: null };
    }

    const applied = result.applied;
    // 先寫 tutorHistory 再寫 classes.json（順序刻意反過來）：history 是「原本的導師是誰」
    // 唯一的一份紀錄，如果先寫 classes.json、history 寫入才拋例外，會變成「班級已經被改掉，
    // 但沒有任何紀錄說原本的導師是誰」——前端顯示套用失敗，admin 以為沒套用其實套了，
    // 重試又會撞 alreadyDone 整批 abort，變成解不開的死結。反過來的話，history 寫入失敗
    // 只會留下一筆孤兒 entry（沒有對應的 classes.json 變動），無害。
    appendTutorHistory_(ctx, result.historyEntries);
    if (applied.inherited + applied.vacated > 0) writeJsonPath_('classes.json', result.classes, ctx);
    appendAuditLog_(ctx, {
      action: 'adminRolloverApply', by: userEmail,
      targetId: fromSemester + '→' + toSemester,
      inherited: applied.inherited, vacated: applied.vacated, kept: applied.kept, unchanged: applied.unchanged,
      at: now,
    });
    return { ok: true, classes: result.classes, applied: applied, errors: [] };
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
  // semester 傳入 overviewStats_：查歷史學期時班名用當時的名字（nameHistory，Ticket D）。
  return { rows: overviewStats_(colleges, departments, classes, tutorSystems, data.records, null, semester) };
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
      departments: sanitizeDepartmentsForViewer_(departments),
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
