// Code.gs — 導師資訊系統 SCC Drive Proxy（正式版）
//
// ⚠️ STUB：正式版尚未從 dev 晉升。這個檔案只是為了讓 clasp / Apps Script 專案骨架
// 可以先建立、可以先部署一個「活著但沒有實際功能」的 webapp。
//
// 待 dev/Code.gs（完整實作，見該檔開頭註解）在 dev 環境驗證完成後，依 CLAUDE.md
// 「推行到正式版」流程用 Copy-Item 覆蓋本檔，並務必把下面兩個環境專屬常數
// （ROOT_FOLDER_ID、以及 .clasp.json 的 scriptId）改回正式版的值——缺一都會讓
// 正式版整個無法登入（Unauthorized rootFolderId）。

const CLIENT_ID      = '68582831293-fecbka17adht886tm6oh18vrdsdg1hbj.apps.googleusercontent.com';
const ROOT_FOLDER_ID = '__PROD_ROOT_FOLDER_ID__';  // 正式版 Drive 根資料夾

const ALLOWED_ROOTS = {};
ALLOWED_ROOTS[ROOT_FOLDER_ID] = { label: 'prod' };

// 緊急備援名單：即使 config.json 讀不到或帳號不在名單，這些帳號仍可登入以修復系統。
// 註：列出 email 不構成後門——仍須持有該帳號的 Google 憑證（有效 ID token）才通過。
const BOOTSTRAP_ADMINS = ['linkinlol528101@gmail.com'];

function doGet(e) {
  return jsonResp_({ ok: true, service: 'SCC Tutor System Drive Proxy (PROD, STUB)' });
}

function doPost(e) {
  return jsonResp_({ error: 'Not implemented: 正式版為 scaffold stub，尚待從 dev/Code.gs 晉升。' });
}

function jsonResp_(data) {
  return ContentService.createTextOutput(JSON.stringify({ success: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}
