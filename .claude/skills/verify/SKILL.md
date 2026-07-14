---
name: verify
description: 端到端驗證本專案（scc-tutorsys）——把 dev/index.html＋dev/Code.gs 以本機 GAS 模擬器真的跑起來，用 Playwright 驅動 UI 流程並截圖存證。改動 dev/Code.gs 或 dev/index.html 的行為面後、commit 前使用。
---

# scc-tutorsys 端到端驗證

單元測試（`node --test test/*.test.js`）只蓋純函式；行為改動要用這套 harness
把真的 app 跑起來驅動一遍。**dev/Code.gs 與 dev/index.html 一個字都不准為了 harness 而改**——
跑不起來的原因本身就是發現。

## 執行

```bash
# 前置（一次性）：scratchpad 裝 playwright + chromium（repo 不裝依賴）
#   cd <scratchpad> && npm i playwright && npx playwright install chromium
node verify/drive.mjs        # 全自動：起 server → 驅動 UI → 截圖 → 輸出逐步 ✅/❌
```

- 截圖與 `api-evidence.json` 落在 `<scratchpad>/verify-shots/`。
- scratchpad 路徑可用環境變數 `VERIFY_SCRATCH` 覆寫（drive.mjs 內有預設值）。
- 只想手動玩：`node verify/server.js`（:8788 /exec API、:8787 static）。

## 驗證守則

1. 每步「操作→等待→斷言→截圖」；斷言失敗**記錄後繼續**，不中止。
2. 關鍵斷言要有負面探針（fetch 直打 /exec）：fail-closed 拒絕、竄改 token、
   非 admin 打 admin action——回應體原文存證。
3. console error、對話框、意外行為照實記錄，不繞過。
4. 新流程加進 `verify/drive.mjs`；需要新種子資料改 `verify/gas-emulator.js` 的 seed()。
5. 機制與坑（HMAC 型別、儲存 seam、路由攔截、免登入注入）見 `verify/README.md`。
