# verify/ — 端到端驗證 harness

把 **dev/index.html＋dev/Code.gs 本體**（一個字不改）在本機真的跑起來、用 Playwright 操作、截圖存證。
不是單元測試——test/ 管純函式，這裡管「整個 app 接起來會不會動」。

## 組成

| 檔案 | 角色 |
|---|---|
| `gas-emulator.js` | node:vm 載入 `dev/Code.gs` 本體；stub GAS 服務（LockService/PropertiesService/CacheService/Utilities/MailApp/ContentService…）；載入後覆寫 `readJsonSafe_`/`writeJsonPath_` 等 Drive I/O 為 in-memory Map（儲存 seam）；種子資料；`mint(email)` 鑄造合法 session token |
| `server.js` | `:8788` POST `/exec`（GAS doPost，`e.parameter.payload`，600ms 人工延遲讓 pending 態可觀察）＋ GET `/mint` `/mails` `/state`；`:8787` static serve repo 根目錄 |
| `drive.mjs` | Playwright 驅動五張票的 UI 流程＋API 探針，每步截圖到 scratchpad `verify-shots/` |

## 啟動

```bash
# 一次性：在 scratchpad 裝 playwright（repo 不裝任何依賴）
cd <scratchpad> && npm i playwright && npx playwright install chromium

# 全自動驅動（自帶啟動/關閉 server）
node verify/drive.mjs
# 環境變數 VERIFY_SCRATCH 可覆寫 scratchpad 路徑（playwright 與截圖輸出所在）

# 只起 server 手動玩（瀏覽器開 http://127.0.0.1:8787/dev/index.html 需自行處理登入攔截）
node verify/server.js
```

## 關鍵機制（坑）

1. **HMAC 型別對齊**：GAS `computeHmacSha256Signature` 回 signed byte array（-128..127）、
   `base64EncodeWebSafe` 吃字串或 byte array 且**保留 '=' padding**（node `base64url` 會去掉，不可用）。
   emulator 以 Buffer↔signed array 轉換模擬，`issueSessionToken_`/`verifySessionToken_` 往返一致。
2. **儲存 seam 靠 classic script 語意**：vm 中頂層 `function` 宣告掛在 global 物件上，
   載入後重指派 `sandbox.readJsonSafe_ = ...` 即可攔截內部呼叫；頂層 `const`（如
   `DEFAULT_TUTOR_SYSTEMS_`）在 script scope、蓋不掉——所以 seam 只能選 function。
3. **`UrlFetchApp.fetch` stub 直接 throw**：正常流程（session token 認證＋in-memory 儲存）
   不應觸網，被呼叫即失敗＝防漏檢查。
4. **免登入**：`addInitScript` 預塞 localStorage `tutor_user_<ROOT_FOLDER_ID>` 與
   `tutor_session_<ROOT_FOLDER_ID>`（token 用 emulator `mint()` 鑄造、exp 為未來）→
   dev/index.html 的 load 恢復邏輯直接 `afterLogin()`，完全不碰 Google。
5. **路由攔截**：`APPS_SCRIPT_URL`（從 dev/index.html 讀出，不寫死）→ 本機 `/exec`；
   `accounts.google.com/gsi/client` → `window.google` no-op stub；SheetJS CDN → scratchpad
   `node_modules/xlsx/dist/xlsx.full.min.js`（離線穩定）；ipapi.co → `{}`。
6. **斷言不中止**：每個 flow 包在 try/catch，❌ 記錄後續跑；dialog（confirm）自動接受並記錄。

## 種子資料形狀

semesters 114-1/114-2(current)/115-1；admin=`admin@test.local`＋staffLead/staffAssistant 各一；
農學院＋獸醫學院；農園系（含 headEmail）/獸醫系/森林系；班級五筆：農園四技一A（單導師）、
農園四技四A（雙導師 all）、獸醫四技四A（graduationGrade:5）、森林家族陳美惠（override:2）、
農園碩二；tutorSystems 留給 `ensureTutorSystemsSeeded_` 播種（驗證種子路徑）。

## 已知邊界

- 附件流程不在範圍（相關 Drive 函式覆寫為無害 no-op；送出紀錄不帶附件）。
- `Utilities.formatDate` 為最小可用實作，格式不參與斷言。
- 匯入真實統計表的路徑寫死在 drive.mjs 的 `XLSX_REAL`。
