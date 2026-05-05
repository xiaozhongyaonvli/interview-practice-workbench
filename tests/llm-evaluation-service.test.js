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
