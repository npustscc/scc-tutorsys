# server/ —— tutorsys 自架 Node 後端

把 GAS 版後端（`Code.gs` / `dev/Code.gs`）搬到中心 Ubuntu 伺服器上跑，不必依賴
Google Apps Script 部署。**零 npm 依賴**，只用 Node 18+ 內建模組。

## 架構

`server/gas-host.js` 用 `node:vm` 把 `Code.gs` 本體**原封不動**載入到一個提供 GAS 服務
stub（`Utilities`/`LockService`/`PropertiesService`/`CacheService`/`MailApp`/`ScriptApp`/
`ContentService`/`UrlFetchApp`）的 sandbox 裡，載入後用「儲存 seam」重新指派
`readJsonSafe_`/`writeJsonPath_`/`uploadFile_`/`downloadFileBase64_`/
`assertAttachmentsBelong_` 等頂層函式，把原本打 Google Drive REST API 的邏輯換成讀寫本機
檔案系統（`<DATA_DIR>/store/*.json` 對應 Drive 上的 JSON 檔、`<DATA_DIR>/attachments/…`
對應附件資料夾）。`Code.gs`／`dev/Code.gs` 一個字都不改，日後兩邊（GAS 部署與自架伺服器）
永遠跑同一份業務邏輯，不會分岔。

`server/index.js` 是單一 http server：`/exec` 代理 GAS 的 `doPost`/`doGet`，`/login` 是
自架環境專用的本地帳密登入（因為區網 IP 不是 Google OAuth 認可的合法 origin，走不了
Google 登入），其餘 GET 靜態服務 `PUBLIC_DIR`（`build-public.js` 的產物）。

## 部署步驟（單一實例；dev/prod 各跑一份，設定不同）

```bash
git clone <repo>
cd scc-tutorsys
cp server/.env.example server/.env    # 填入這個實例的 PORT/GS_FILE/FRONTEND_FILE/SERVER_ORIGIN
node server/scripts/build-public.js   # 產出 server/public/{index.html,login.html}
node server/scripts/import-drive.js --src <舊 Drive 匯出資料夾>   # 一次性遷移舊資料（可選）
node server/scripts/create-user.js admin@school.edu.tw somepassword 管理員姓名
node server/index.js                  # 手動起一次，確認沒有錯誤
```

確認可用後，改用 systemd 常駐（dev、prod 各自一個 unit，`WorkingDirectory`/`ExecStart`
一樣，靠各自的 `server/.env` 區分埠號與資料目錄——若同機器跑兩個實例，`server/.env`
本身沒辦法分身，實務上會是兩份 repo checkout 或用 `EnvironmentFile=` 指到不同路徑，
依實際部署方式調整）：

```ini
[Unit]
Description=SCC Tutor System (self-hosted)
After=network.target

[Service]
Type=simple
User=scc-s-admin
WorkingDirectory=/opt/scc-tutorsys
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scc-tutorsys-dev.service
```

日後更新程式碼：`git pull` → 若 `dev/index.html`/`index.html` 有變動就重跑
`build-public.js` → `systemctl restart scc-tutorsys-dev.service`。

## 腳本

- `server/scripts/build-public.js` — 把 `FRONTEND_FILE` 的 `APPS_SCRIPT_URL` 換成
  `SERVER_ORIGIN + '/exec'`，輸出 `PUBLIC_DIR/index.html`；注入 `login-template.html`
  輸出 `PUBLIC_DIR/login.html`。前端有更新（改了 `dev/index.html`）後要重跑。
- `server/scripts/create-user.js <email> <password> [name]` — 建立/更新本地登入帳號。
- `server/scripts/import-drive.js --src <exportDir> [--wipe]` — 一次性匯入舊 Drive 匯出
  資料（`manifest.jsonl` + `content/<id>` 格式，比照 scc-infosys
  `scripts/export-drive-tree.mjs` 的輸出）。
- `server/scripts/smoke.mjs` — 自足冒煙測試，`node server/scripts/smoke.mjs`，
  綠燈 exit 0。不依賴任何已部署的實例，會自己起暫存伺服器測完就關掉。

## 已知限制

- **不支援自架環境下的 Google 登入**：區網 IP（例如 `http://192.168.100.123:8790`）
  不是 Google OAuth 認可的合法 origin，`dev/index.html`/`index.html` 內建的 Google 登入
  流程在這裡打不通。因此自架部署一律走 `/login` 本地帳密（`create-user.js` 建帳號），
  跳過 Google 這一關直接換發本系統自建的 session token——後端授權邏輯（`resolveRoles_`
  等）完全不變，只是「認證」這一步換了管道。
- **通知信只落地檔案，沒有真的寄出**：`MailApp.sendEmail` 被覆寫成 append 一行 JSON 到
  `<DATA_DIR>/mails.jsonl`（不接 SMTP）。`sessionStart` 回傳的 `mailSent:true` 在這個環境
  下的實際意思是「已落一筆稽核紀錄」，不代表真的有信寄到收件匣。若要真的寄信，之後可以
  另外寫一支背景程式 tail `mails.jsonl` 接 SMTP/系上郵件系統，不影響這裡的核心邏輯。
- **LockService 是 no-op**：单一 Node 程序、`doPost` 全程同步執行，事件迴圈不會在
  一次請求處理到一半時插入另一次請求，所以不需要真的鎖。若未來改成多程序/多執行緒部署
  （例如用 `cluster` 模組水平擴充），這個假設會失效，必須換成真正的跨程序鎖
  （檔案鎖或外部鎖服務）。目前規模（一個學校的導師資訊系統）用不到這種擴充。
