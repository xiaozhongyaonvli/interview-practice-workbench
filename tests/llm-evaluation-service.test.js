// Unit tests for the LLM evaluation service.
// chatComplete is always mocked; these tests never reach a real model.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLlmDebugStore } from "../src/storage/llmDebugStore.js";
import { createLlmEvaluationService, _internals } from "../src/llm/llmEvaluationService.js";
import { ValidationError } from "../src/domain/errors.js";

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "itw-llm-svc-"));
  const store = createLlmDebugStore({ baseDir: dir });
  return { dir, store };
}

const fakePromptProvider = {
  async extractionPrompt({ query, title, text }) {
    return `EXT prompt q=${query} t=${title.slice(0, 5)} body=${text.length}`;
  },
  async scoringPrompt({ question, answer }) {
    return `SCORE prompt q=${question.slice(0, 5)} a=${answer.length}`;
  },
  async interviewClassifyPrompt({ titles }) {
    return `CLASSIFY prompt count=${titles.length}`;
  }
};

const validExtraction = {
  questions: [
    {
      question: "线上慢 SQL 怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "面试官提到慢日志",
      confidence: 0.86,
      isTechnical: true
    }
  ]
};

const validScoring = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "中等偏上",
  primaryTechnicalGap: "缺锁等待",
  primaryExpressionGap: "结构散",
  engineeringMindsetGap: "缺验证回滚",
  retryInstruction: "下一版按发现-定位-分析-优化-验证"
};

test("tryExtractJson tolerates plain JSON, ```json``` fences, and leading prose", () => {
  assert.deepEqual(_internals.tryExtractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(
    _internals.tryExtractJson('```json\n{"a":1}\n```'),
    { a: 1 }
  );
  assert.deepEqual(
    _internals.tryExtractJson('Here is your JSON:\n```\n{"a":2}\n```'),
    { a: 2 }
  );
  assert.deepEqual(
    _internals.tryExtractJson('Some prose then {"a":3} more prose'),
    { a: 3 }
  );
  assert.equal(_internals.tryExtractJson("not json"), null);
});

test("extractQuestions returns parsed extraction on a clean LLM reply", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => JSON.stringify(validExtraction);
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const result = await svc.extractQuestions({ query: "mysql", title: "面经", text: "正文..." });
    assert.equal(result.extraction.questions.length, 1);
    assert.equal(result.raw, JSON.stringify(validExtraction));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractQuestions accepts explicit non-interview extraction with zero questions", async () => {
  const { dir, store } = await makeStore();
  try {
    const svc = createLlmEvaluationService({
      chatComplete: async () => JSON.stringify({ isInterview: false, questions: [] }),
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const { extraction } = await svc.extractQuestions({
      query: "mysql",
      title: "求建议",
      text: "求规划"
    });
    assert.equal(extraction.isInterview, false);
    assert.deepEqual(extraction.questions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("extractQuestions handles ```json``` fenced reply", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => "```json\n" + JSON.stringify(validExtraction) + "\n```";
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const result = await svc.extractQuestions({ query: "mysql", title: "x", text: "y" });
    assert.equal(result.extraction.questions.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractQuestions persists raw on non-JSON reply and throws EXTRACTION_NOT_JSON", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => "I am unable to answer in JSON.";
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(
      svc.extractQuestions({ query: "mysql", title: "x", text: "y" }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, "EXTRACTION_NOT_JSON");
        return true;
      }
    );
    const log = await store.readPhase("extraction");
    assert.equal(log.length, 1);
    assert.equal(log[0].error.code, "EXTRACTION_NOT_JSON");
    assert.match(log[0].rawResponse, /unable to answer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractQuestions persists raw on schema-invalid reply", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => JSON.stringify({ questions: [{ question: "Q", category: "前端", difficulty: "medium", confidence: 0.9 }] });
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(svc.extractQuestions({ query: "mysql", title: "x", text: "y" }), ValidationError);
    const log = await store.readPhase("extraction");
    assert.equal(log[0].error.code, "EXTRACTION_INVALID");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractQuestions wraps a transport-layer error as LLM_CALL_FAILED", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => {
      throw new Error("ECONNRESET");
    };
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(
      svc.extractQuestions({ query: "mysql", title: "x", text: "y" }),
      (err) => err.code === "LLM_CALL_FAILED"
    );
    const log = await store.readPhase("extraction");
    assert.equal(log[0].error.code, "LLM_CALL_FAILED");
    assert.match(log[0].error.message, /ECONNRESET/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoreAnswer returns parsed summary on clean reply", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => JSON.stringify(validScoring);
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const result = await svc.scoreAnswer({ question: "Q?", answer: "A...", context: "" });
    assert.equal(result.summary.engineeringMindsetGap, validScoring.engineeringMindsetGap);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoreAnswer rejects a summary missing engineeringMindsetGap and persists raw", async () => {
  const { dir, store } = await makeStore();
  try {
    const broken = { ...validScoring };
    delete broken.engineeringMindsetGap;
    const chat = async () => JSON.stringify(broken);
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(
      svc.scoreAnswer({ question: "Q?", answer: "A..." }),
      (err) => err.code === "SCORE_SUMMARY_INVALID"
    );
    const log = await store.readPhase("scoring");
    assert.equal(log[0].error.code, "SCORE_SUMMARY_INVALID");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoreAnswer rejects non-JSON reply and persists raw", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => "Sorry, I can't comply.";
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(
      svc.scoreAnswer({ question: "Q?", answer: "A" }),
      (err) => err.code === "SCORING_NOT_JSON"
    );
    const log = await store.readPhase("scoring");
    assert.match(log[0].rawResponse, /can't comply/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyInterviewTitles returns flags aligned with titles on a clean reply", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () =>
      JSON.stringify([
        { index: 0, isInterview: true },
        { index: 1, isInterview: false },
        { index: 2, isInterview: true }
      ]);
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const out = await svc.classifyInterviewTitles({
      titles: ["字节二面 MySQL 面经", "求帮看一份内推", "美团 SQL 笔面经"]
    });
    assert.deepEqual(out.flags, [true, false, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyInterviewTitles short-circuits empty titles", async () => {
  const { dir, store } = await makeStore();
  try {
    let called = false;
    const chat = async () => {
      called = true;
      return "[]";
    };
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const out = await svc.classifyInterviewTitles({ titles: [] });
    assert.deepEqual(out.flags, []);
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyInterviewTitles persists raw and throws CLASSIFY_NOT_JSON on garbage", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => "I cannot answer in JSON.";
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    await assert.rejects(
      svc.classifyInterviewTitles({ titles: ["a", "b"] }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, "CLASSIFY_NOT_JSON");
        return true;
      }
    );
    const log = await store.readPhase("classify");
    assert.equal(log.length, 1);
    assert.equal(log[0].error.code, "CLASSIFY_NOT_JSON");
    assert.match(log[0].rawResponse, /cannot answer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyInterviewTitles logs CLASSIFY_LENGTH_MISMATCH but defaults missing rows to true", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () => JSON.stringify([{ index: 0, isInterview: true }]);
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const out = await svc.classifyInterviewTitles({ titles: ["a", "b", "c"] });
    assert.deepEqual(out.flags, [true, true, true]);
    const log = await store.readPhase("classify");
    assert.equal(log[0].error.code, "CLASSIFY_LENGTH_MISMATCH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("classifyInterviewTitles tolerates ```json``` fences", async () => {
  const { dir, store } = await makeStore();
  try {
    const chat = async () =>
      "```json\n" +
      JSON.stringify([
        { index: 0, isInterview: false },
        { index: 1, isInterview: true }
      ]) +
      "\n```";
    const svc = createLlmEvaluationService({
      chatComplete: chat,
      promptProvider: fakePromptProvider,
      llmDebugStore: store
    });
    const out = await svc.classifyInterviewTitles({ titles: ["x", "y"] });
    assert.deepEqual(out.flags, [false, true]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
