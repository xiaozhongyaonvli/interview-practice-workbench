# 面经训练工作台 (Interview Training Workbench)

本地优先的面试训练工作台。Phase A 把以下闭环

```text
方向 -> 文章 -> 问题 -> 回答 -> 评分 -> 重答 -> 保存卡片
```

变成一个浏览器可用的应用,所有数据用 JSON / JSONL 文件存储——不依赖
数据库、不需要登录、不上云。

## 启动

```powershell
node server.js
```

然后打开 <http://127.0.0.1:8000/>。

默认端口和地址可以覆盖:

```powershell
$env:PORT=18000; $env:HOST="127.0.0.1"; node server.js
```

## LLM (可选)

只有配置了 DeepSeek API key,真实 LLM 调用才会启用。手动粘贴通路在
没有 key 的情况下仍然可用。

```powershell
copy .env.example .env
# 编辑 .env,填入 DEEPSEEK_API_KEY=sk-...
```

服务启动时读取 `process.env.DEEPSEEK_API_KEY`。可以直接在终端 export,
也可以使用任意 `.env` 加载工具(`.env` 本身已在 `.gitignore` 里)。

## 测试

```powershell
npm test            # 单元 + 集成测试
npm run test:e2e    # jsdom 驱动的前端端到端测试
npm run test:schema # 数据 schema 校验
```

每完成一个 Phase A step,这三套必须全部通过才能进入下一个。详见
父项目的 `docs/phase-a-implementation-plan.md`。

## 目录结构

```text
public/         前端 (vanilla HTML/CSS/JS, 不带打包)
src/domain/    数据 schema 与领域规则
src/storage/   按 record 类型分文件的 JSON/JSONL 存储
src/sources/   外部数据来源适配器 (NowCoder)
src/llm/       prompt provider + DeepSeek client + 评估服务
src/api/       HTTP 路由处理
prompts/       LLM 提示词模板 (extraction、interview-coach-v2)
data/          运行时状态 (已 gitignore)
tests/         单元 / e2e / schema 测试套件
```

## Phase A 进度

`docs/phase-a-implementation-plan.md` 中的 9 个 step 已全部完成:

| Step | 主题 | API |
|------|------|-----|
| 0 | 骨架 + 视图切换 | `/health`,静态文件 |
| 1 | 领域模型 + 存储 | — |
| 2 | 手动文章导入 | `POST /api/articles/manual`,`GET /api/articles` |
| 3 | 抽题 JSON 粘贴 | `POST /api/questions/import`,`GET /api/questions`,`PATCH /api/questions/:id` |
| 4 | 作答与 Attempt | `POST /api/attempts`,`GET /api/attempts?questionId=` |
| 5 | 评分 JSON 粘贴 | `POST /api/attempts/:id/score` |
| 6 | 重答对比与最佳 Attempt | (前端计算) |
| 7 | 保存为卡片 | `POST /api/cards/from-attempt`,`GET /api/cards` |
| 8 | NowCoder 抓取 | `POST /api/sources/nowcoder/fetch` |
| 9 | 真实 LLM | `POST /api/questions/extract`,`POST /api/attempts/:id/llm-score` |

## 工程约束

- 不引入数据库 / ORM / 登录系统
- attempts 是 append-only,重答 / 重评只追加,不覆盖
- 卡片库 `cards/` 只能通过 `POST /api/cards/from-attempt` 写入,且要求
  attempt 已评分
- LLM 输出非法时,raw 响应保留到 `data/llm/<phase>_results.jsonl`,
  绝不静默丢弃
- 评分必须包含 `primaryTechnicalGap`、`primaryExpressionGap`、
  `engineeringMindsetGap`、`retryInstruction` 四个 gap 字段
- 抓取 / LLM 失败都不会阻塞手动粘贴通路
