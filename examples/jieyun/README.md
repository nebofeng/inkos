# 《劫云》长书上下文默认

把 `inkos.json.example` 合并进项目 `inkos.json`（或复制为 `inkos.json`）：

- `context.profile=longform-rag`：写章分桶（大纲 + 全局记忆摘要 + RAG + 伏笔）
- `context.windowCapTokens=128000`：与 grok-4.7 硬窗对齐
- `context.autoConsolidateOnGuard=true`、`maxGuardRetries=2`：超窗自动降载重试
- `memory.graph.enabled=true`：默认打开 story-graph RAG

书级识别：标题或 id 含「劫云 / jieyun」时也会自动切到 longform-rag，即使项目级 profile 仍是 default。
