# 面试问题抽题提示词 v1

## 任务

从一段面经文章里抽取候选面试题。只抽真实技术面试问题,不要抽情绪、流程、时间线、求助帖。

## 输入

```text
方向关键词:{{query}}
文章标题:{{title}}
文章正文:
{{text}}
```

## 输出

只返回 JSON 对象,不要带 markdown 代码块、注释或其他散文。结构必须严格匹配:

```json
{
  "questions": [
    {
      "question": "...",
      "category": "MySQL | Redis | Java | 计网 | 计系统 | Agent",
      "difficulty": "easy | medium | hard",
      "evidence": "原文出现该问题的简短上下文片段",
      "confidence": 0.86,
      "isTechnical": true
    }
  ]
}
```

## 抽题约束

- 只抽真实技术面试问题。
- 必须能独立回答,不依赖大段上下文。
- 不能是"二面挂了怎么办"这种非技术问题。
- 同义问题尽量合并。
- category 必须在允许列表里;无法归类的问题直接丢弃。
- difficulty 用英文 easy / medium / hard。
- confidence 取 [0, 1]。
- 至少抽 1 个,最多 8 个。
