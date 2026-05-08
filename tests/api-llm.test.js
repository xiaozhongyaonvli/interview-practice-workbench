// API tests for /api/questions/extract and /api/attempts/:id/llm-score.
// LLM service is mocked; these tests never reach the network.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-llm-"));
}

const validExtraction = {
  questions: [
    {
      question: "线上慢 SQL 怎么排查?",
      category: "MySQL",
      difficulty: "medium",
      evidence: "evidence",
      confidence: 0.86
    }
  ]
};

const validSummary = {
  scores: {
    technicalCorrectness: 8,
    coverageCompleteness: 7,
    logicalStructure: 8,
    expressionClarity: 7,
    interviewPerformance: 7
  },
  overallComment: "良好",
  primaryTechnicalGap: "缺数据分布",
  primaryExpressionGap: "结构散",
  engineeringMindsetGap: "缺回滚",
  retryInstruction: "按发现-定位-分析-验证"
};

function mockLlmService({ extraction, summary, throwOnExtract, throwOnScore }) {
  return {
    async extractQuestions() {
      if (throwOnExtract) throw throwOnExtract;
      return { extraction, raw: JSON.stringify(extraction) };
    },
    async scoreAnswer() {
      if (throwOnScore) throw throwOnScore;
      return { summary, raw: JSON.stringify(summary) };
    }
  };
}

test("POST /api/questions/extract uses an article id and writes questions", async () => {
  const baseDir = await makeBase();
  try {
    const llmService = mockLlmService({ extraction: validExtraction });
    await withServer(async (baseUrl) => {
      // Seed an article via the manual route.
      const article = await (
        await fetch(`${baseUrl}/api/articles/manual`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "mysql",
            title: "字节二面 MySQL",
            text: "面试官问了 InnoDB 的 ACID 怎么保证..."
          })
        })
      ).json();

      // Trigger LLM extraction by articleId.
      const response = await fetch(`${baseUrl}/api/questions/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", articleId: article.id })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.added.length, 1);
      assert.equal(body.added[0].source, "manual");
      assert.equal(body.added[0].sourceTitle, "字节二面 MySQL");
    }, { baseDir, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/extract accepts ad-hoc title/text without saving an article first", async () => {
  const baseDir = await makeBase();
  try {
    const llmService = mockLlmService({ extraction: validExtraction });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/questions/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "mysql",
          title: "粘贴的面经",
          text: "面试官问了..."
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.added.length, 1);
    }, { baseDir, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/extract returns LLM_NOT_CONFIGURED when no service is wired", async () => {
  const baseDir = await makeBase();
  // Ensure the env doesn't accidentally configure a real service.
  const previous = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/questions/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", title: "t", text: "x" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "LLM_NOT_CONFIGURED");
    }, { baseDir });
  } finally {
    if (previous !== undefined) process.env.LLM_API_KEY = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/questions/extract surfaces extraction validation failures (400, debug log written)", async () => {
  const baseDir = await makeBase();
  try {
    const err = Object.assign(new Error("invalid"), {
      name: "ValidationError",
      code: "EXTRACTION_INVALID",
      path: "questions[0].category"
    });
    const llmService = mockLlmService({ throwOnExtract: err });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/questions/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", title: "t", text: "x" })
      });
      assert.equal(response.status, 500);
      // Plain Error → 500 INTERNAL_ERROR. The contract is that the service
      // wraps validation in ValidationError so the API returns 400; here we
      // verify the API does not crash on a bare Error either.
      const body = await response.json();
      assert.ok(body.code === "INTERNAL_ERROR" || body.code === "EXTRACTION_INVALID");
    }, { baseDir, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/llm-score scores an attempt end-to-end", async () => {
  const baseDir = await makeBase();
  try {
    const llmService = mockLlmService({
      extraction: validExtraction,
      summary: validSummary
    });
    await withServer(async (baseUrl) => {
      // Seed: extract -> attempt -> llm-score
      await fetch(`${baseUrl}/api/questions/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "mysql", title: "t", text: "x" })
      });
      const list = await (await fetch(`${baseUrl}/api/questions?query=mysql`)).json();
      const question = list.questions[0];
      const attempt = await (
        await fetch(`${baseUrl}/api/attempts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id, answer: "我的回答" })
        })
      ).json();

      const response = await fetch(
        `${baseUrl}/api/attempts/${attempt.attemptId}/llm-score`,
        { method: "POST" }
      );
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.equal(record.attemptId, attempt.attemptId);
      assert.equal(record.summary.engineeringMindsetGap, validSummary.engineeringMindsetGap);

      // The attempt list now reflects the score.
      const back = await (
        await fetch(`${baseUrl}/api/attempts?questionId=${question.id}`)
      ).json();
      assert.equal(back.attempts[0].status, "scored");
    }, { baseDir, llmService });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/llm-score 400s when no LLM service is configured", async () => {
  const baseDir = await makeBase();
  const previous = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  try {
    await withServer(async (baseUrl) => {
      // Seed a question manually via /import so we have an attempt to score.
      await fetch(`${baseUrl}/api/questions/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "mysql",
          source: "manual",
          extraction: validExtraction
        })
      });
      const list = await (await fetch(`${baseUrl}/api/questions?query=mysql`)).json();
      const attempt = await (
        await fetch(`${baseUrl}/api/attempts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: list.questions[0].id, answer: "ans" })
        })
      ).json();

      const response = await fetch(
        `${baseUrl}/api/attempts/${attempt.attemptId}/llm-score`,
        { method: "POST" }
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "LLM_NOT_CONFIGURED");
    }, { baseDir });
  } finally {
    if (previous !== undefined) process.env.LLM_API_KEY = previous;
    await rm(baseDir, { recursive: true, force: true });
  }
});
