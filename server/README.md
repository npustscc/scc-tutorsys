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
- `server/scripts/backup.js` — 備份 `DATA_DIR` 整目錄成 tar.gz（打包後 `tar -tzf` 驗證、
  chmod 600、保留最新 `--keep` 份輪替），見下方「備份」節。

## 通知信（SMTP）

`server/mailer.js`：零依賴 SMTP 客戶端（SMTPS 465 隱式 TLS + AUTH LOGIN），在
`server/.env` 設定 `SMTP_USER`/`SMTP_PASS`（Gmail 應用程式密碼）後啟用；未設定時
維持原行為（只落地 `mails.jsonl` 稽核，不寄）。啟動 log 會印出目前的寄信模式。

- 寄送是 fire-and-forget：`doPost` 不等 SMTP 完成，寄失敗不影響任何業務動作
  （與 GAS 版 MailApp 失敗不擋登入的語意一致）。
- 每封信在 `mails.jsonl` 有兩行：gas-host 落的原始稽核行（誰/何時/主旨/內文）＋
  mailer 落的結果行（`kind:'smtp-result'`，`status:'sent'|'error'`）。查信有沒有
  真的寄出去看第二行。
- 多封信串行寄送（單一連線佇列），不會對 Gmail 開並發連線。
- 收件人過白名單 regex、主旨/寄件人名稱一律 RFC 2047 base64 編碼、內文 base64
  傳輸——header 注入（CRLF）在這三處都進不來。
- 單元測試：`node --test test/mailer.test.js`（假 SMTP server 驗證完整對話）。

## 備份

`DATA_DIR` 是整個系統的資料庫（含個資與 SESSION_SECRET），必須每日備份：

```bash
node server/scripts/backup.js --out ~/scc-tutor-backups/prod [--env server/.env] [--name prod] [--keep 30]
```

打包 `DATA_DIR` 整目錄 → `<out>/<name>-YYYYMMDD-HHMMSS.tar.gz`（`--name` 預設取
repo checkout 的目錄名），成功條件是 `tar -tzf` 驗證可讀且非空；輪替只刪同前綴、
同命名格式的舊檔。crontab 範例（兩實例錯開、排離峰）：

```cron
30 3 * * * cd $HOME/scc-tutor-prod && /usr/bin/node server/scripts/backup.js --out $HOME/scc-tutor-backups/prod >> $HOME/scc-tutor-backups/backup.log 2>&1
40 3 * * * cd $HOME/scc-tutor-dev  && /usr/bin/node server/scripts/backup.js --out $HOME/scc-tutor-backups/dev  >> $HOME/scc-tutor-backups/backup.log 2>&1
```

注意：備份放同一顆碟只防誤刪不防碟損——備份目錄建議掛另一顆碟，或再加一條 cron 把
`~/scc-tutor-backups/` rsync 到另一台機器。備份檔含機密與個資（已 chmod 600），
搬運時比照 `DATA_DIR` 本身的保護等級。

## 已知限制

- **不支援自架環境下的 Google 登入**：區網 IP（例如 `http://192.168.100.123:8790`）
  不是 Google OAuth 認可的合法 origin，`dev/index.html`/`index.html` 內建的 Google 登入
  流程在這裡打不通。因此自架部署一律走 `/login` 本地帳密（`create-user.js` 建帳號），
  跳過 Google 這一關直接換發本系統自建的 session token——後端授權邏輯（`resolveRoles_`
  等）完全不變，只是「認證」這一步換了管道。
- **通知信預設只落地檔案**：未設定 `SMTP_USER`/`SMTP_PASS` 時，`MailApp.sendEmail` 只
  append 一行 JSON 到 `<DATA_DIR>/mails.jsonl`，`sessionStart` 回傳的 `mailSent:true`
  意思是「已落一筆稽核紀錄」。設定後改走 `server/mailer.js` 真的寄出（見「通知信（SMTP）」
  節）；但 `mailSent:true` 仍不等於送達——SMTP 是請求後非同步進行，實際結果看
  `mails.jsonl` 的 `smtp-result` 行。
- **LockService 是 no-op**：单一 Node 程序、`doPost` 全程同步執行，事件迴圈不會在
  一次請求處理到一半時插入另一次請求，所以不需要真的鎖。若未來改成多程序/多執行緒部署
  （例如用 `cluster` 模組水平擴充），這個假設會失效，必須換成真正的跨程序鎖
  （檔案鎖或外部鎖服務）。目前規模（一個學校的導師資訊系統）用不到這種擴充。
