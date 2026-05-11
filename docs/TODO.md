# TODO

更新时间：2026-05-11

## 当前判断

Phase A 的主闭环已经完成。下一步不要继续扩大抓取、评分或卡片功能，而是把“题池治理”做扎实：用户抓到一批题之后，要能快速整理成可练题，而不是被候选题淹没。

Phase B 可以启动，但只做 Phase B-lite：只读画像聚合器。它可以并行推进，但不能压过 Phase A 收口。

## 执行顺序

1. Phase A P0：题池治理工作流。
2. Phase A P1：候选题浏览形态。
3. Phase A P1：置信度校准。
4. Phase B-lite：只读画像聚合器。

## Phase A P0：题池治理工作流

### 产品目标

新抓取一批题后，用户能在 2 分钟内完成：

```text
保留可练题 -> 忽略低质量题 -> 标记疑似重复题
```

这是 Phase A 从“能跑”进入“好用”的核心门槛。

### 状态语义

- [ ] 明确并统一 question status 的使用语义。
  - `candidate`：刚抽出来，还没确认是否值得练。
  - `accepted`：用户认为值得练，进入主要练习池。
  - `ignored`：低质量、不相关、暂不想练。
  - `duplicate`：疑似重复，默认不进入活跃练习池。
  - `mastered`：已掌握，后续 Phase B / Review Mode 再使用。

- [ ] 默认练习入口优先展示 `accepted`。
  - `candidate` 应该是待整理状态，不应长期占据主要练习区。
  - 用户仍可以手动从 candidate 进入练习，但视觉优先级低于 accepted。

### 低质量题处理

- [ ] 支持批量选择题目。
- [ ] 支持批量忽略。
- [ ] 支持按来源文章批量忽略。
- [ ] 忽略后即时从当前活跃列表消失。
- [ ] 保留现有 `purge ignored` 能力，但不要把 purge 作为日常主操作。

### 重复题识别

- [ ] 增加“疑似重复”提示。
  - 第一版只提示，不自动合并。
  - 自动合并风险高，先不做。

- [ ] 第一版重复识别规则保持简单。
  - 标准化 question 文本后完全相同。
  - 标准化后高度相似。
  - 同 category 下 slug/hash 接近。
  - 同 sourceUrl 内出现多个高度相似问题。

- [ ] 增加重复题处理动作。
  - 标记为 duplicate。
  - 忽略重复项。
  - 保留一个主问题，其余从活跃池隐藏。

- [ ] 保存卡片时提示已有相近卡片。
  - 如果同类题已有卡片，提示用户选择：覆盖、另存、忽略当前题。
  - 第一版只做提示和手动选择，不自动决策。

### 题池摘要

- [ ] 增加题池摘要，帮助用户知道当前池子是否失控。
  - 总题数。
  - candidate / accepted / ignored / duplicate / mastered 数量。
  - 按 category 分布。
  - 最近新增数量。

## Phase A P1：候选题浏览形态

### 判断

不要让问题池变成一个无限下滑页面。分页不是单纯 UI 问题，而是题池工作流问题。

推荐第一版：

```text
Tabs + 每页 N 题 + 当前筛选状态
```

不建议第一版做复杂虚拟滚动，除非已经出现明显性能卡顿。

### 视图结构

- [ ] `待确认`：新抽取的 `candidate`。
- [ ] `练习中`：`accepted` 或已有 attempt 的题。
- [ ] `已沉淀`：已保存卡片或 `mastered` 的题。
- [ ] `已隐藏`：`ignored` / `duplicate`，默认折叠或通过筛选查看。

### 分页规则

- [ ] 每页固定 N 题。
  - 建议第一版 N = 20 或 30。
  - 保留搜索和 category 筛选。

- [ ] 切换页码不丢失筛选状态。
- [ ] 批量操作只作用于当前筛选/当前页的选中题。
- [ ] 新抓取完成后优先跳到 `待确认`。

## Phase A P1：置信度校准

### 判断

当前 `confidence` 不应该被当作科学质量分。尤其如果它来自 LLM 自报，它只能作为弱信号。

Phase A 的目标不是建立“科学置信度模型”，而是避免 confidence 误导排序、筛选和用户判断。

### 语义拆分

- [ ] 复查当前 `confidence` 的来源。
  - 它表示“这是面试题”的信心？
  - 还是“抽取质量高”的信心？
  - 还是“这题值得练”的信心？

- [ ] 将概念拆清楚。
  - `extractionConfidence`：模型抽题自报或校验后的信心，弱信号。
  - `qualitySignal`：系统按规则估算的题目质量，弱信号。
  - `userDecision`：用户接受、忽略、标重复、作答、保存卡片，强信号。

### 排序原则

- [ ] 排序优先相信用户行为，而不是模型 confidence。

建议权重方向：

```text
saved as card > answered > accepted > high confidence
duplicate / ignored < low confidence
```

- [ ] 不要让 confidence 成为强过滤条件。
- [ ] 不在 UI 上突出展示小数 confidence。
- [ ] 如需展示，使用“高 / 中 / 低”这种粗粒度标签。

### 第一版质量信号

- [ ] 先做规则型 `qualitySignal`，不引入复杂模型。
  - question 文本过短：降权。
  - category 不明或不在目标方向：降权。
  - evidence 为空：降权。
  - 用户 accepted：升权。
  - 用户 ignored / duplicate：降权。
  - 有多次 attempt：升权。
  - 保存为 card：强升权。

## Phase A Exit Criteria

Phase A 收口完成时，至少满足：

- [ ] 用户能稳定导入 / 抓取题。
- [ ] 新抓取一批题后，用户能在一次浏览中完成保留、忽略、标重复。
- [ ] 用户不会被 candidate 堆积淹没。
- [ ] 用户能明确看到哪些题是待确认、练习中、已沉淀、已隐藏。
- [ ] 用户能完成多次作答、评分、重答和保存卡片。
- [ ] confidence 不再被当作题目质量的强判断依据。

## Phase B-lite：只读画像聚合器

### 目标

从已有 attempts / scores / cards 生成克制的训练画像。它是只读聚合，不改变主练习流程。

不做：

- 自动推荐复杂算法。
- 完整 Review Mode。
- Learn Mode。
- 重型新 UI。
- 数据库化。

### 数据产物

- [ ] 生成 `data/profile/user_profile.json`。

建议字段：

```json
{
  "version": 1,
  "generatedAt": "2026-05-11T00:00:00.000Z",
  "dataConfidence": "low",
  "practiceStats": {
    "attemptCount": 0,
    "scoredAttemptCount": 0,
    "cardCount": 0,
    "categoryCounts": {}
  },
  "scoreSummary": {
    "averageTotal": null,
    "weakestRubric": [],
    "recentTrend": "insufficient_data"
  },
  "gapSummary": {
    "technical": [],
    "expression": [],
    "engineeringMindset": []
  },
  "reviewCandidates": []
}
```

### 实现入口

- [ ] `src/profile/profileService.js`
- [ ] `src/storage/profileStore.js`
- [ ] `src/api/profile.js`
- [ ] `scripts/buildProfile.js`
- [ ] `GET /api/profile`

### 聚合规则

- [ ] attempts / scores 是主数据源。
- [ ] cards 只作为“已沉淀成果”信号。
- [ ] 少于 10 条 scored attempts 时，`dataConfidence = "low"`。
- [ ] 10-30 条 scored attempts 时，`dataConfidence = "medium"`。
- [ ] 30 条以上 scored attempts 时，`dataConfidence = "high"`。
- [ ] 弱项先按 rubric 平均分排序，不引入复杂模型。
- [ ] gap 文本先做保守关键词归类，避免过度解释。
- [ ] `reviewCandidates` 先只输出候选，不自动改变题目状态。

### UI

- [ ] 第一版只加一个只读“训练画像”入口。
- [ ] 展示数据置信度，避免用户误以为画像已经很准。
- [ ] 展示最近练习量、低分维度、高频 gap、建议复练候选。
- [ ] 不做复杂趋势图，除非数据量足够。

## 暂缓

- [ ] 完整 Review Mode。
- [ ] Learn Mode。
- [ ] 多信息源扩展。
- [ ] 复杂推荐算法。
- [ ] 自动合并重复题。
- [ ] 把 confidence 做成强排序或强过滤。
