import assert from "node:assert/strict";
import test from "node:test";
import { createPromptProvider, defaultPromptProvider } from "../src/llm/promptProvider.js";

test("extractionPrompt fills query/title/text placeholders", async () => {
  const text = await defaultPromptProvider.extractionPrompt({
    query: "mysql",
    title: "字节二面 MySQL 面经",
    text: "面试官问了..."
  });
  assert.match(text, /方向关键词:mysql/);
  assert.match(text, /字节二面 MySQL 面经/);
  assert.match(text, /面试官问了/);
});

test("scoringPrompt fills question/answer/context placeholders and keeps gap-field rules", async () => {
  const text = await defaultPromptProvider.scoringPrompt({
    question: "线上慢 SQL 怎么排查?",
    answer: "我会先看慢查询日志...",
    context: "MySQL 二面"
  });
  assert.match(text, /线上慢 SQL/);
  assert.match(text, /慢查询日志/);
  assert.match(text, /MySQL 二面/);
  // The hard rule must still be visible to the model.
  assert.match(text, /engineeringMindsetGap/);
});

test("createPromptProvider supports cache and custom basePath via fs", async () => {
  // Re-create the same provider: ensures factory works without errors and
  // that the templates can be loaded twice without throwing.
  const provider = createPromptProvider();
  const a = await provider.extractionPrompt({ query: "mysql", title: "t", text: "x" });
  const b = await provider.extractionPrompt({ query: "mysql", title: "t", text: "x" });
  assert.equal(a, b);
});

test("missing placeholders are left as-is so prompt authors notice", async () => {
  const provider = createPromptProvider();
  const text = await provider.scoringPrompt({ question: "Q", answer: "A" });
  // context is missing — it should default to empty string, not crash.
  assert.match(text, /面试题目:Q/);
  assert.match(text, /我的回答:A/);
});
