# scc-tutorsys — Claude 工作規則

## 專案簡介

國立屏東科技大學學生諮商中心「導師資訊系統」。
每班每學期須繳交 5 份班會紀錄 + 1 份導生活動紀錄，經「導師 → 系主任 → 學諮中心主任」三關線上核章，
可退件重送；提供繳交進度統計與後台（系所/班級/職員帳號）管理。

單一 `index.html`，純前端 vanilla JS SPA，後端為 Google Apps Script（`doPost` dispatcher），
資料庫為 Google Drive 資料夾內的 JSON 檔（Drive REST API 讀寫 + LockService）。
架構與工作慣例完全比照同單位既有專案 `scc-infosys`（同一人維護，同一套習慣）。

**2026-07-16 起主要運行環境改為中心自架伺服器 scc-server**（`server/`：零依賴 Node，
`node:vm` 載入同一份 Code.gs，儲存 seam 換成本機檔案系統）；GAS＋GitHub Pages 軌凍結為
既有使用者的過渡服務，待移機三條件（SSO/LDAP、公網 HTTPS、資料 cutover）到齊後下架
（見「部署環境」節）。

## 資安原則（最高優先，凌駕功能）

本系統的紀錄內容含學生姓名/學號等基本個資，且 **GitHub repo 為公開**。因此：

1. **後端 GAS `doPost` 才是真正的安全邊界，前端只是 UI 閘門。** 任何人都能取得公開的
   `CLIENT_ID` / `APPS_SCRIPT_URL` / `ROOT_FOLDER_ID` 直接呼叫後端。因此每個 action 內部
   都必須依動態角色解析（`resolveRoles_`）做 default-deny 授權判斷；新增 action 時預設它
   「需要授權」，並在該 action 內明確寫出誰能呼叫、檢查什麼。
   - 認證（`verifyIdToken_`／`verifySessionToken_`，所有 action 都要過）與授權（各 action
     內依角色/紀錄狀態判斷）是分開的兩層，不要混淆。
   - **2026-08-17 起在兩層之間多了第三層：全域登入閘門 `checkSystemAccess_`**（doPost 認證後、
     switch 前）。使用者決策「關閉一般入口」：只有管理員／學諮中心助理／系辦助理進得來，
     導師、系主任、學生一律擋下。允許集合資料驅動（`config.settings.accessAllowRoles`，
     角色鍵見該函式），**預設 fail-closed**（沒設定＝關閉）；要開系主任入口只要加 `'deptHead'`，
     不必改程式碼。GAS 軌用 `maintenanceSetAccessPolicy()` 改，自架軌直接改
     `<DATA_DIR>/store/config.json`。**閘門放行 ≠ 有權做任何事**，各 action 的 default-deny 照舊。
   - 自架軌的 `/login`、`/change-password` 不經過 doPost，由 `server/index.js` 自己呼叫
     `host.checkAccess()`——新增任何「不走 doPost 的入口」時必須一併補上，否則閘門在那條路上等於沒有。
2. **機密與個資永不進 repo。** `creds.json`（OAuth client secret）、`*.csv`、`*.docx`/`*.xlsx`/`*.xlsm`、
   `.drive-token.json`、`.clasprc.json` 已列入 `.gitignore`；新增這類檔案前先確認被 ignore。
   絕不 `git add -A` 一把梭，commit 前用 `git status` 檢查 staged 內容。
3. **去識別化**：commit message、issue、公開 changelog 涉及個案/學生時，不得出現姓名/學號等，
   以案號/紀錄 ID 代稱。

## 部署環境（正式版 vs 測試版）

**主要運行環境（2026-07-16 起）＝自架 scc-server（192.168.100.123，`ssh scc-server`）：**

| | 目錄（scc-server） | URL | 載入檔案 | systemd unit |
|---|---|---|---|---|
| **正式版** | `~/scc-tutor-prod` | `http://192.168.100.123:8789/` | `Code.gs`＋`index.html` | `scc-tutor-prod` |
| **測試版** | `~/scc-tutor-dev` | `http://192.168.100.123:8790/` | `dev/Code.gs`＋`dev/index.html` | `scc-tutor-dev` |

部署一律用 `node scripts/deploy-onprem.mjs dev|prod`（先 `git push` 再跑；腳本會 ssh 到
scc-server 做 git pull → build-public → restart → healthz，並比對遠端/本機 HEAD 一致）。
維運細節（登入機制、SMTP、備份、資料匯入）見 `server/README.md` 與 memory
`tutorsys-onprem-deploy`。

**GAS＋GitHub Pages 軌已凍結（2026-07-16 A 方案決策）**：下表的 GAS 部署維持現版服務
既有使用者，**不再接收新功能**（致命 bug 才例外 clasp push）。cutover 完成後整軌下架
（公告 → 唯讀觀察期 → Pages 換轉址頁 → 下架）。

**「凍結」是指不往這條軌加新功能，不是「這兩個檔案永遠不動」。** GitHub Pages 的來源是
`gas-frozen` 分支而不是 master，所以平常往 master 推的 commit 不會影響 Pages 網站；
但**每次「推行到正式版」時，這條軌的兩半要一起跟上**，否則會留下版本錯配：

1. 後端：`clasp push`（根 `.clasp.json` → prod scriptId，`.claspignore` 只放行
   `Code.gs`＋`appsscript.json`）→ `clasp create-version` → `clasp redeploy <deploymentId> -V <版本>`
   （deploymentId 就是 `index.html` 裡 `APPS_SCRIPT_URL` 那一串；另一筆 @HEAD 不要動）。
   clasp 用 `npx -y @google/clasp@latest`（v3；`~/.clasprc.json` 是 v3 格式，用 2.x 會噴
   `Cannot read properties of undefined (reading 'access_token')`）。
2. 前端：`git push origin <master 的 commit>:gas-frozen`（快轉，不需 --force）。

**這個釘子的歷史值不要寫死在這裡**（2026-08-12 就是因為這裡還寫著早已過期的 `c8bbb43`，
導致誤判「Pages 永遠不會更新」、只推了後端就收工，留下舊前端配新後端）。要知道現在釘在哪，
跑 `git log --oneline -1 origin/gas-frozen`；要確認線上服務的是哪一版，直接抓
`https://npustscc.github.io/scc-tutorsys/` 下來 grep 該版本才有的字串。

**GAS 軌（凍結中）：**

| | 檔案 | URL | Drive 根資料夾 ID | Apps Script URL（`APPS_SCRIPT_URL`） |
|---|---|---|---|---|
| **正式版** | `index.html` | `https://npustscc.github.io/scc-tutorsys/` | `__PROD_ROOT_FOLDER_ID__` | `__PROD_APPS_SCRIPT_URL__` |
| **測試版** | `dev/index.html` | `https://npustscc.github.io/scc-tutorsys/dev/` | `__DEV_ROOT_FOLDER_ID__` | `__DEV_APPS_SCRIPT_URL__` |

正式版與測試版是**兩個完全獨立的 Apps Script 後端部署**（各自的 `ALLOWED_ROOTS` 白名單只認自己的
Drive 資料夾 ID）。兩個環境專屬常數（`ROOT_FOLDER_ID` 與 `APPS_SCRIPT_URL`）必須成對正確，
帶錯任一個都會導致該版本完全無法登入（`Unauthorized rootFolderId`）。

（外部資源已於 2026-07-07 設置完成；上表 placeholder 僅為欄位示意，實際 ID／URL 以
`Code.gs`／`index.html`／`.clasp.json` 檔內的值為準。）

注意：**這對環境常數對自架軌一樣攸關**——`server/scripts/build-public.js` 只替換前端的
`APPS_SCRIPT_URL`，前端的 `ROOT_FOLDER_ID` 原樣保留、後端 `ALLOWED_ROOTS` 白名單照常比對，
成對帶錯一樣 `Unauthorized rootFolderId` 整版無法登入。

`CLIENT_ID` 沿用 scc-infosys 的 OAuth Client（同源 `npustscc.github.io`，公開值，可安全沿用）：
`68582831293-fecbka17adht886tm6oh18vrdsdg1hbj.apps.googleusercontent.com`。

## 模型分工與 token 紀律（常設授權，不必每次徵詢）

> 這一節原本只存在於 `token-efficient-workflow-prompt.md`，開頭寫著「把下面複製貼上當
> 新 session 的第一則訊息」—— **而 CLAUDE.md 從來沒有引用它，所以實際上等於不存在**。
> 2026-08-11 搬進來（CLAUDE.md 每個 session 自動載入）。那份檔案保留當長版說明。

| 誰 | 做什麼 |
|---|---|
| **主會話（Opus）** | 規劃、架構決策、**資安判斷**、審 diff、跟使用者溝通。小到不值得派工的（單行修改、跑一個指令）直接做 |
| **Sonnet subagent** | 所有實作 —— 寫功能、修 bug、需要判斷力的調查 |
| **Haiku subagent** | 機械雜務 —— 跑測試回報數字、查部署狀態、JSON 編輯、格式化、grep 盤點 |
| **Fable subagent** | **只在下面那三個關卡**做對抗性覆核（見下節） |
| **qwen（本機、斷網、不吃額度）** | 量大又重複、有原文可核對、錯了一眼看得出來的事：摘要、分類、改格式。**而且它是唯一能碰含真實姓名的資料的執行者** |

**派工慣例**：一個 agent 一次做完一批相關修正（別一件事開一個）；後續修正用 SendMessage
追加給既有 agent，**不要開新的** —— 冷啟動重讀 repo 要 3–8 萬 token。
**大檔隔離**：`dev/index.html`（約 4,700 行、≈7 萬 token）與 `dev/Code.gs`（約 4,400 行、
≈6.3 萬 token）**只讓 subagent 讀，主會話只收結論與 diff 摘要**，或自己用
`Read` 的 offset/limit 讀指定區段 —— 絕不整檔讀入。

**審查深度分級**：低風險（UI 文字、樣式、版面）→ 針對性 grep 抽查 diff；
資安、授權、資料寫入 → 細讀完整 diff。

**對話衛生**：一張 ticket 做完就開新 session（從記憶接手比拖長對話便宜）；
變長用 `/compact`、換題目用 `/clear`。
**常駐開銷**：記憶裡的狀態檔與 CLAUDE.md 保持精瘦，歷史交給 git log。

### Fable 的位置（2026-08-11 訂正）

**可用性：2026-08-11 以最小 dispatch 實測通過**（`model: "fable"`、不用工具、只要它回
一個 `OK`）—— 6 秒、17,488 token。**那 17k 是每派一顆的冷啟動底價**，所以它適合
「一個關卡派一次」，不適合細碎來回。記憶裡「Fable 在台灣不可用」那句**已經過期**，
而那就是它一直沒被派上的原因。
它**不接主會話**（不做資安審查，而這個專案的安全邊界判斷是主會話的核心工作），
只在這三個關卡當 subagent 做「試著證明這段是錯的」：

1. **會寫入或刪除資料**的改動（含批次更新、狀態機、聚合／去重口徑）。
2. **第一次要對正式資料跑的批次操作** —— 覆核的是**計畫**不只是 diff。
   反例就在眼前：`adminRolloverApply` 的撞名設計與「失敗列不中斷、成功列照寫」
   通過了測試也通過了人工審查，實際一跑 200 列失敗、104 列已經寫進去。
3. 出過事、或錯了很難發現的地方（`classResolveCore_` 的同名防線那類）。

**不派 Fable**：日常實作（Sonnet）、機械雜務（Haiku）、範圍已知的 grep（主會話）、
qwen 做得來的（本機免費）。**資安審查一律主會話自己做**（Fable 的安全分類器會擋
cyber 類內容，官方也說它的找 bug 優勢不含資安導向分析）。
**給 Fable 的指示要寫鬆** —— 講目標與約束、不要列步驟（跟寫給 Sonnet 的逐條 spec 相反）。

#### 如果哪天 Fable 又不能用了

**關卡不會因此消失。** 2026-07 那次就是「Fable 在台灣不可用」被記成一句裸的事實，
於是那道覆核靜靜地不見了一個月 —— 沒有人決定要放棄它，它只是沒人再提。
不能用的時候照這個順序退，**不要跳過**：

1. **換一顆 Opus subagent 做同一件事**，指示照樣寫鬆（「試著證明這段是錯的，找出會讓它
   做錯事的輸入」）。關鍵是**跟寫這段程式的那顆不同的 agent** —— 對抗性覆核的價值
   一半來自乾淨的 context，不是來自模型本身。
2. 連 subagent 都不能派 → **主會話自己做，但要當成獨立的一步**：重新讀一次 diff，
   明確寫下「什麼輸入會讓它做錯」，寫不出來才算過。混在原本的審查裡等於沒做。
3. **絕對不要**只在紀錄裡寫「Fable 不可用所以略過」就結案。

而且記這件事的時候：**寫上日期與怎麼確認的**（例：「2026-08-11 以最小 dispatch 實測失敗」），
並附上當時用的替代方案。只寫「不可用」的話，半年後沒人知道那句還算不算數 ——
今天就是這樣浪費掉一個月的。

## 固定工作流程

**所有新功能、修改、Bug 修復 → 預設只改 `dev/Code.gs` 與 `dev/index.html`。**

- 動到有測試覆蓋的純邏輯（核章狀態機、角色解析、白名單判斷等）→ 先跑
  `node --test test/*.test.js`，綠燈再 commit（測試就地從 `dev/Code.gs` 抽函式，
  改壞即紅燈；見 `test/README.md`）
- 完成後 `git add dev/Code.gs dev/index.html`（視改動範圍）、`git commit`、`git push origin master`
- 部署：`node scripts/deploy-onprem.mjs dev` → 使用者在 `http://192.168.100.123:8790/` 驗證
  （GAS 軌已凍結，不再 clasp push）

**推行到正式版（使用者明確說「推行到正式版」或「promote」）：**

```bash
node scripts/promote.mjs            # 預演：印出會改哪 13 處，不寫檔
node scripts/promote.mjs --apply    # 實際推行；內含環境常數守門員，紅燈就不要 push
git diff                            # 複核：應只有環境差異，不該有非預期的功能變動
node --test test/*.test.js
git add Code.gs index.html dev/Code.gs dev/index.html
git commit -m "推行到正式版：[功能說明]"
git push origin master
node scripts/deploy-onprem.mjs prod  # 部署到自架正式實例（GAS 軌凍結，不 clasp push）
```

**不要再用手動 `Copy-Item`／`cp` 複製 dev→prod**（原本的 PowerShell 流程在 Linux 端也照抄不動）。
推行的本質是「複製 dev 到 prod，再把所有環境專屬差異換回 prod 的樣子」，而這份差異一共 **13 處**，
人工比對做不對：

- 2 處是**環境常數**（`ROOT_FOLDER_ID`、`APPS_SCRIPT_URL`），帶錯任一個都會讓正式版整個無法登入
  （**自架軌同樣中招**——前端 `ROOT_FOLDER_ID` 與後端 `ALLOWED_ROOTS` 白名單在自架環境照常成對比對）。
  這是 scc-infosys 2026-07-03 事故的形狀：只改了其中一個、漏改另一個，正式版打到測試版後端，
  `Unauthorized rootFolderId` 讓正式版完全無法登入，直到下次 hotfix 才修復。
- 另外 11 處是**環境字樣與標記**：`Code.gs` 檔首註記與警語、`ALLOWED_ROOTS` 的 label 與註解、
  `doGet` 的 `(PROD)`/`(DEV)` 診斷標記、登入通知信的 subject 與內文「環境」欄、頁面 `<title>`、
  兩處「測試版」badge、前端檔首註記。2026-07-18 的 `a14d5b7` 就是常數改對、這 11 處被 dev 版
  整批蓋掉，而守門員只驗常數所以全綠放行——正式版對外自稱「測試版」、登入通知信也寫測試版，
  在線上掛了三週才發現（2026-08-07 以 `promote.mjs` 修復）。更早的 `a91cb04` 也犯過同一類錯
  （當時只漏 `doGet` 標記一項）。

`scripts/promote.mjs` 把這 13 處寫成規則表一次套用，**任一條沒命中預期次數就中止、一個字都不寫**——
dev 端改了措辭導致規則失配時，寧可擋下推行，也不要推出一個「看起來成功、其實漏改」的正式版；
遇到時同步更新該檔的 `FILES` 規則表再重跑。`--apply` 內含 `check-env-constants.mjs`（常數比對，
placeholder 未填時只警告不阻擋）。CI 另跑 `node scripts/promote.mjs --check`，正式版檔案殘留
任何 dev 標記即紅燈，防止同類漏改再次進 master。

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

Pending Verification 的處理規則（2026-07-15 使用者指示）：
- **Claude 能自行驗證的項目**（單元測試、`verify/` e2e harness、腳本可達的檢查）→ 直接驗，
  不要只列出來等使用者。全部綠燈且無其他阻擋事項時，直接執行推行到正式版流程（見上節）。
- **必須由使用者驗證的項目**（真實 Google 登入、真實 Drive 寫入、通知信收取等基礎設施接點）→
  在 what now 三項目之後，**詳細列出逐步驗證步驟**（開哪個網址、按什麼、預期看到什麼、
  異常時回報什麼），讓使用者照著做即可。
