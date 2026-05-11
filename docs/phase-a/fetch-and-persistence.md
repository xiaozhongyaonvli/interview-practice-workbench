# 抓取与持久化

本文合并原 `phase-a-fetch-and-persistence-improvements` 和 `phase-a-nowcoder-feed-classify-design` 的有效结论，只保留当前实现需要知道的行为。

## NowCoder 抓取

- [x] 每次最多保存 2 篇 fresh article。
- [x] 支持搜索 query。
- [x] query 为空时进入 feed 模式。
- [x] feed 模式使用 `__feed__` 作为问题和文章分区。
- [x] 抓取前按 URL 排除已经保存过的文章。
- [x] 抓取失败按文章粒度汇报，不阻断其它文章保存。
- [x] LLM 配置存在时，对标题做面经相关性分类。
- [x] LLM 未配置时跳过标题分类，基础抓取仍可用。

## Cursor 策略

cursor key 使用本地日期：

```text
{mode}-{partitionQuery}-{YYYY-MM-DD}
```

当前行为：

- [x] 同一天重复抓取会从 cursor offset 继续。
- [x] 跨天使用新的 cursor key，从 offset 0 开始。
- [x] URL 去重仍然跨天生效，避免重复保存老文章。
- [x] cursor 读写失败不阻断抓取，降级依赖 URL 去重。

## TTL 清理

- [x] NowCoder article 默认保留 14 天。
- [x] 手动导入文章不受 NowCoder TTL 影响。
- [x] TTL 清理失败不阻断本次抓取。

## 问题池清理

- [x] ignored 问题默认不展示。
- [x] 提供 `POST /api/questions/purge-ignored` 批量物理删除。
- [x] 导入新题或抓取前会自动 purge ignored。
- [x] 保存为卡片后会从活跃问题池删除源问题。
- [x] attempts / scores 不级联删除，保留训练历史。

## 前端持久化

- [x] `localStorage` 保存最近 query。
- [x] `localStorage` 保存当前 question id。
- [x] URL hash 保存当前 view。
- [x] 刷新后恢复最近分区、页面和练习题。

## 不做

- [ ] 抓取篇数配置项。
- [ ] 复杂文章调度器。
- [ ] ignored 的长期回收站。
- [ ] 孤儿 attempts / scores 的独立浏览入口。
- [ ] 多信息源统一抓取后台。
