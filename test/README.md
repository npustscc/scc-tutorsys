# 純函式單元測試

零依賴（用 Node 內建 `node:test` / `node:assert` / `node:vm`），**不修改 `dev/Code.gs`**。
`harness.js` 會就地從 `dev/Code.gs` 抽出指定函式，在隔離的 vm context 執行——測試讀的是同一份
正式碼，改壞邏輯即紅燈。

（與 scc-infosys 的 `test/harness.js` 差異：這裡讀的是 `dev/Code.gs` 而非 `dev/index.html`——
本專案這一輪只實作後端，核章狀態機/角色解析/白名單判斷等純函式都寫在 Code.gs 裡。）

## 執行

```bash
node --test test/*.test.js
```

（注意：Windows 上 `node --test test/` 目錄形式可能失敗，用上面的 glob 形式最穩。）

## 加新測試

1. 在對應的 `*.test.js` 裡 `load([...函式名], {...被依賴的全域})`。
2. `load` 的第二個參數注入函式依賴的全域：常數（如 `BOOTSTRAP_ADMINS: [...]`）、資料、
   或被 stub 的 helper。
3. 若函式依賴其他函式，把它們一起列進 `load([...])`（例：`buildNewRecord_` 需連
   `advanceOnTutorApproval_`；`recordApprove_`/`recordReject_` 需連
   `resolveActionableStage_` 與各 `advanceOnXApproval_`/`applyRejection_`）。

## 只適用純函式

harness 適合無 DOM／無 GAS 全域（`DriveApp`/`UrlFetchApp`/`LockService`/...）依賴的純邏輯。
碰 Drive API、LockService 的 action handler（`*Action_` 結尾的函式）不在此範圍——那類請在
dev 環境的實際 GAS 部署上端到端驗證。

## 目前涵蓋

- **角色解析**（`role-resolution.test.js`）：`resolveRoles_`/`isClassTutor_`——BOOTSTRAP_ADMINS
  硬編碼防鎖死、config.users 的 admin/director（含 disabled 排除）、系主任（含 inactive 系所排除）、
  導師（含 inactive 班級排除、雙導師班兩位皆可解析）、一人兼任多角色、未登入回傳全 false。
- **上傳白名單**（`whitelist.test.js`）：`isUploadAllowed_`——導師本人永遠可上傳、空白名單
  不限、非空白名單擋非名單非導師帳號。
- **核章狀態機**（`approval-state-machine.test.js`）：`buildNewRecord_`/`advanceOnTutorApproval_`/
  `advanceOnDeptApproval_`/`advanceOnDirectorApproval_`/`applyRejection_`/`canResubmit_`/
  `applyResubmit_`/`recordResubmit_`——單導師班全流程推進、導師本人上傳視同已核章、雙導師
  any/all 兩種模式（含導師自傳、重複核章冪等）、三關退件、退件重送重跑（含雙導師 all 班
  仍需重新湊滿兩位核章）。
- **授權判斷**（`authorization.test.js`）：`resolveActionableStage_`/`recordApprove_`/
  `recordReject_`/`canViewRecord_`——錯誤角色/錯誤狀態一律拒絕、admin 可代為處理任一關但
  不能動終態、director 只能動 pending_director、退件必填理由、紀錄可視範圍規則。
