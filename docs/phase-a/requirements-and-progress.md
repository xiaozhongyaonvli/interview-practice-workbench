# Phase A 需求与进度

更新时间：2026-05-11

## 红线路径

```text
方向 / feed -> 文章 -> 抽题 -> 问题池 -> 作答 -> 评分 -> 重答 -> 卡片
```

## 总体进度

- [x] 项目骨架：`public/`、`src/api/`、`src/domain/`、`src/storage/`、`src/llm/`、`src/sources/`、`tests/`。
- [x] 本地数据：articles、questions、attempts、scores、cards、llm debug、crawl cursors。
- [x] 手动导入文章和手动录题。
- [x] NowCoder 抓取和 feed 兜底。
- [x] LLM 抽题和手动粘贴抽题 JSON。
- [x] 作答 attempt 记录。
- [x] 手动评分 JSON 和真实 LLM 评分。
- [x] 重答历史、最佳 attempt 和分数 delta。
- [x] 保存为正式卡片，并从活跃问题池移除源问题。
- [x] 前端已覆盖导入、抓题、录题、练习、反馈、卡片库、设置。
- [x] 单测、schema 测试、API 测试和 e2e 测试已覆盖主要流程。

## Step 0-9 状态

- [x] Step 0：项目骨架和测试基线。
- [x] Step 1：领域模型和文件存储。
- [x] Step 2：手动文章输入和 ArticleRecord 防腐层。
- [x] Step 3：问题池和抽题结果导入。
- [x] Step 4：作答和 Attempt 记录。
- [x] Step 5：评分结果导入和结构校验。
- [x] Step 6：重答对比和最佳 Attempt。
- [x] Step 7：保存为正式卡片。
- [x] Step 8：NowCoder 抓取接入。
- [x] Step 9：真实 LLM 接入。

## 已实现需求

### 输入

- [x] 手动粘贴面经文章。
- [x] 手动录入单题。
- [x] 粘贴 LLM 抽题 JSON。
- [x] 真实 LLM 从文章抽题。
- [x] NowCoder 搜索抓取。
- [x] NowCoder 空 query 使用 feed。

### 问题池

- [x] 问题按 query、category、status 管理。
- [x] ignored 默认隐藏。
- [x] 支持批量 purge ignored。
- [x] 导入/抓取前自动清理 ignored。
- [x] 保存卡片后移除源问题。

### 练习

- [x] 一个问题允许多次 attempt。
- [x] 练习页显示历史 attempt。
- [x] 支持从卡片回看后继续 retry。
- [x] 前端能恢复最近 query、view、question。

### 评分

- [x] 五项 rubric：技术正确性、覆盖完整度、逻辑结构、表达清晰度、面试表现。
- [x] 必填 gap 字段：`primaryTechnicalGap`、`primaryExpressionGap`、`engineeringMindsetGap`。
- [x] 必填重答建议：`retryInstruction`。
- [x] LLM 输出非 JSON 或 schema 不合格时写入 debug log。
- [x] 重答对比可计算总分和单项 delta。

### 卡片

- [x] 只有 scored attempt 可保存为卡片。
- [x] 保存时确认 category 和 difficulty。
- [x] 卡片写入 `data/cards/` 并维护 index。
- [x] 重复 card id 默认拒绝，确认后可覆盖。
- [x] 卡片保留回答、评分、gap 和长反馈区块。

## 暂不做

- [ ] 用户画像。
- [ ] 弱项追踪和趋势图。
- [ ] Review Mode。
- [ ] Learn Mode。
- [ ] 多信息源扩展。
- [ ] 数据库化、账号、多用户、云同步。

## 主要代码入口

- 前端：`public/index.html`、`public/app.js`、`public/styles.css`
- API：`server.js`、`src/api/*.js`
- 领域模型：`src/domain/*.js`
- 存储：`src/storage/*.js`
- LLM：`src/llm/*.js`、`prompts/*.md`
- NowCoder：`src/sources/nowcoderAdapter.js`
- 测试：`tests/*.test.js`、`tests/schema/*.test.js`、`tests/e2e/*.test.js`
