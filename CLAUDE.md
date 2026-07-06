# scc-tutorsys — Claude 工作規則

## 專案簡介

國立屏東科技大學學生諮商中心「導師資訊系統」。
每班每學期須繳交 5 份班會紀錄 + 1 份導生活動紀錄，經「導師 → 系主任 → 學諮中心主任」三關線上核章，
可退件重送；提供繳交進度統計與後台（系所/班級/職員帳號）管理。

單一 `index.html`，純前端 vanilla JS SPA，後端為 Google Apps Script（`doPost` dispatcher），
資料庫為 Google Drive 資料夾內的 JSON 檔（Drive REST API 讀寫 + LockService）。
架構與工作慣例完全比照同單位既有專案 `scc-infosys`（同一人維護，同一套習慣）。

## 資安原則（最高優先，凌駕功能）

本系統的紀錄內容含學生姓名/學號等基本個資，且 **GitHub repo 為公開**。因此：

1. **後端 GAS `doPost` 才是真正的安全邊界，前端只是 UI 閘門。** 任何人都能取得公開的
   `CLIENT_ID` / `APPS_SCRIPT_URL` / `ROOT_FOLDER_ID` 直接呼叫後端。因此每個 action 內部
   都必須依動態角色解析（`resolveRoles_`）做 default-deny 授權判斷；新增 action 時預設它
   「需要授權」，並在該 action 內明確寫出誰能呼叫、檢查什麼。
   - 與 infosys 不同：本系統「學生」角色 = 任何已登入的 Google 帳號（免預建名單），因此
     **沒有** infosys 那種 doPost 層級的全域 `isAuthorizedUser_` 允許清單閘門——認證
     （`verifyIdToken_`，所有 action 都要過）與授權（各 action 內依角色/紀錄狀態判斷）是
     分開的兩層，不要混淆。
2. **機密與個資永不進 repo。** `creds.json`（OAuth client secret）、`*.csv`、`*.docx`/`*.xlsx`/`*.xlsm`、
   `.drive-token.json`、`.clasprc.json` 已列入 `.gitignore`；新增這類檔案前先確認被 ignore。
   絕不 `git add -A` 一把梭，commit 前用 `git status` 檢查 staged 內容。
3. **去識別化**：commit message、issue、公開 changelog 涉及個案/學生時，不得出現姓名/學號等，
   以案號/紀錄 ID 代稱。

## 正式版 vs 測試版

| | 檔案 | URL | Drive 根資料夾 ID | Apps Script URL（`APPS_SCRIPT_URL`） |
|---|---|---|---|---|
| **正式版** | `index.html` | `https://npustscc.github.io/scc-tutorsys/` | `__PROD_ROOT_FOLDER_ID__` | `__PROD_APPS_SCRIPT_URL__` |
| **測試版** | `dev/index.html` | `https://npustscc.github.io/scc-tutorsys/dev/` | `__DEV_ROOT_FOLDER_ID__` | `__DEV_APPS_SCRIPT_URL__` |

正式版與測試版是**兩個完全獨立的 Apps Script 後端部署**（各自的 `ALLOWED_ROOTS` 白名單只認自己的
Drive 資料夾 ID）。兩個環境專屬常數（`ROOT_FOLDER_ID` 與 `APPS_SCRIPT_URL`）必須成對正確，
帶錯任一個都會導致該版本完全無法登入（`Unauthorized rootFolderId`）。

上表中的 `__PROD_ROOT_FOLDER_ID__` / `__DEV_ROOT_FOLDER_ID__` / `__PROD_APPS_SCRIPT_URL__` /
`__DEV_APPS_SCRIPT_URL__` / `.clasp.json` 內的 `scriptId` 目前都是 placeholder，
需要使用者完成「外部資源設置」（建 2 個 GAS 專案、2 個 Drive 根資料夾、clasp 部署）後才能填入實際值——
詳見實作計畫步驟 4。**在 placeholder 被填入之前，前端/後端都無法真正連線**，這是預期狀態，不是 bug。

`CLIENT_ID` 沿用 scc-infosys 的 OAuth Client（同源 `npustscc.github.io`，公開值，可安全沿用）：
`68582831293-fecbka17adht886tm6oh18vrdsdg1hbj.apps.googleusercontent.com`。

## 固定工作流程

**所有新功能、修改、Bug 修復 → 預設只改 `dev/Code.gs` 與 `dev/index.html`。**

- 動到有測試覆蓋的純邏輯（核章狀態機、角色解析、白名單判斷等）→ 先跑
  `node --test test/*.test.js`，綠燈再 commit（測試就地從 `dev/Code.gs` 抽函式，
  改壞即紅燈；見 `test/README.md`）
- 完成後 `git add dev/Code.gs dev/index.html`（視改動範圍）、`git commit`、`git push origin master`
- 使用者在 `dev/` URL 或 dev 版 Apps Script 部署驗證

**推行到正式版（使用者明確說「推行到正式版」或「promote」）：**

```powershell
Copy-Item dev\Code.gs Code.gs
Copy-Item dev\index.html index.html
git add Code.gs index.html dev\Code.gs dev\index.html
git commit -m "推行到正式版：[功能說明]"
git push origin master
```

注意：`Copy-Item` 會把 dev 版的兩個環境專屬常數一起帶進來，兩個都必須改回正式版的值，缺一都會讓
正式版整個無法登入：

- `ROOT_FOLDER_ID`（`Code.gs` 內）→ 正式版 Drive 根資料夾 ID
- `APPS_SCRIPT_URL`（`index.html` 內）→ 正式版部署網址

推行後（`Copy-Item` 完、`git push` 前）**必跑環境常數守門員**：
`node scripts/check-env-constants.mjs`，綠燈（exit 0）才能 push。它機械比對 prod/dev 兩邊的
`ROOT_FOLDER_ID`（`Code.gs` 與 `index.html` 各檢查一次）、`APPS_SCRIPT_URL`、GAS `scriptId`
（`.clasp.json`）是否為對的那組——這是為了避免 scc-infosys 曾發生過的事故重演
（2026-07-03：只改了其中一個環境常數、漏改另一個，導致正式版打到測試版後端，
`Unauthorized rootFolderId` 讓正式版完全無法登入，直到下次 hotfix 才修復）。
在 placeholder 尚未填入真實值前，此腳本只會警告（不阻擋 CI）；填入後才會真正比對 dev ≠ prod。

## Git 設定

- Branch: `master`
- Remote: `origin` → `https://github.com/npustscc/scc-tutorsys.git`（步驟 4 建立後補上）
- 使用者 email: `linkinlol528101@gmail.com`

## 回應格式

使用者說「what now」或「接下來要做什麼」時，固定回覆三個項目：
1. **Progress**（已完成功能）
2. **Pending Verification**（待驗證）
3. **TODO**（待辦）

內容以最新專案狀態記憶為準（見 memory `tutorsys-plan-status`）。
