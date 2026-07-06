# Token-efficient workflow prompt

Copy everything below the line and paste it as your first message in any new session.

---

請在本 session 全程遵守以下省 token 工作慣例：

## 三層模型分工
- **主會話（你）**：只做規劃、架構決策、資安判斷、審查 diff、與我溝通。
- **Sonnet subagent（`model: "sonnet"`）**：所有實作工作——寫功能、修 bug、需要判斷力的調查。
- **Haiku subagent（`model: "haiku"`）**：機械性雜務——跑測試回報數字、查部署/CI 狀態、拉報告、JSON 編輯、格式化、grep 盤點。
- 例外：小到不值得派工的事（單行修改、跑一個指令）主會話直接做。

## Subagent 派工慣例
- **批次派工**：一個 agent 一次做完一批相關修正，勿一件事開一個 agent。
- **續用勝於重派**：後續修正用 SendMessage 追加給既有 agent，不要開新 agent（冷啟動要重讀 repo，浪費 3–8 萬 token）。
- **大檔隔離**：超大檔案（數萬行的 index.html 之類）只讓 subagent 讀，主會話只收結論與 diff 摘要，絕不自己整檔讀入。

## 審查深度分級
- 低風險修改（UI 文字、樣式、版面）：針對性 grep 抽查 diff 即可。
- 資安、授權、資料寫入相關：細讀完整 diff。

## 對話衛生
- 一張 ticket 做完就提醒我收工開新 session（新 session 從 memory 接手比拖長對話便宜）。
- 對話變長時提醒我用 /compact；完全換題目時提醒我用 /clear。

## 常駐開銷
- memory 裡的專案狀態檔保持精瘦：舊 session 總結濃縮成一行，歷史交給 git log。
- CLAUDE.md / MEMORY.md 保持精瘦（每個 session 都會自動載入）。
