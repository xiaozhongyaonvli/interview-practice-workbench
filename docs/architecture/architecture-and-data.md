# 架构与数据

## 分层

```text
public/      浏览器端 UI
server.js    轻量 HTTP server 和路由分发
src/api/     API handler
src/domain/  领域模型与校验
src/storage/ JSON / JSONL 文件存储
src/llm/     Prompt、LLM client、抽题/评分服务
src/sources/ 外部信息源防腐层
prompts/     Prompt 模板
tests/       单测、schema、API、e2e
```

## 领域边界

- `InterviewSource`：外部面经来源，目前主要是 NowCoder。
- `QuestionTraining`：问题池、作答、重答、状态流转。
- `LlmEvaluation`：抽题、评分、标题分类和输出校验。
- `CardLibrary`：已沉淀的正式复习卡片。

## 数据文件

运行数据默认落在 `data/`：

```text
data/articles/
data/questions/
data/attempts/
data/scores/
data/cards/
data/llm/
data/crawl-cursors/
```

## 核心模型

### ArticleRecord

文章是输入材料。来源包括：

- `manual`
- `nowcoder`

### QuestionRecord

问题是 Phase A 的核心训练对象。它携带来源、分类、难度、证据、状态和标签。

### AttemptRecord

一次回答就是一次 attempt。一个问题可以有多次 attempt，用于重答和对比。

### ScoreRecord / ScoreSummary

评分以结构化 summary 为核心，必须包含：

- 五项 rubric 分数。
- 技术短板、表达短板、工程思维短板。
- 下一次重答建议。

### CardRecord

正式卡片是练习沉淀结果，只能从 scored attempt 生成。

## API 概览

- `GET /health`
- `GET /api/settings/llm`
- `POST /api/settings/llm`
- `GET /api/settings/llm/models`
- `POST /api/articles/manual`
- `GET /api/articles`
- `POST /api/questions/import`
- `POST /api/questions/extract`
- `GET /api/questions`
- `PATCH /api/questions/:id`
- `POST /api/questions/purge-ignored`
- `POST /api/attempts`
- `GET /api/attempts`
- `DELETE /api/attempts/:id`
- `POST /api/attempts/:id/score`
- `POST /api/attempts/:id/llm-score`
- `POST /api/cards/from-attempt`
- `GET /api/cards`
- `POST /api/sources/nowcoder/fetch`
- `GET /api/prompts/scoring`

## 工程约束

- [x] 不引入数据库。
- [x] 不引入登录系统。
- [x] API 和存储保持轻量。
- [x] LLM 输出必须校验，失败时保存 debug raw。
- [x] Cards 只通过 `POST /api/cards/from-attempt` 写入。
- [x] 外部来源字段不直接污染内部 Question / Attempt / Card 模型。
