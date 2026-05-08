// API tests for POST /api/attempts/:id/score.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withServer } from "./helpers/withServer.js";

async function makeBase() {
  return await mkdtemp(join(tmpdir(), "itw-api-scoring-"));
}

const validSummary = {
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 7,
    expressionClarity: 7,
    interviewPerformance: 6
  },
  overallComment: "中等偏上,表达可以,工程落点不足",
  primaryTechnicalGap: "没有覆盖锁等待和数据分布",
  primaryExpressionGap: "开头没有先给排查框架",
  engineeringMindsetGap: "缺少验证、灰度、回滚意识",
  retryInstruction: "下一版按确认范围 → 定位 SQL → 执行计划 → 优化 → 验证的顺序"
};

async function seedAttempt(baseUrl, questionId = "mysql-slow-sql") {
  const response = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionId, answer: "first version" })
  });
  return await response.json();
}

test("POST /api/attempts/:id/score with a valid summary returns 201", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      const response = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: validSummary })
      });
      assert.equal(response.status, 201);
      const record = await response.json();
      assert.equal(record.attemptId, attempt.attemptId);
      assert.equal(record.feedbackPromptVersion, "interview-coach-v2");
      assert.equal(record.summary.engineeringMindsetGap, validSummary.engineeringMindsetGap);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/score accepts a rawResponse string and parses it", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      const response = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawResponse: JSON.stringify(validSummary) })
      });
      assert.equal(response.status, 201);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/score rejects a summary missing engineeringMindsetGap", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      const bad = { ...validSummary };
      delete bad.engineeringMindsetGap;

      const response = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: bad })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "SCORE_SUMMARY_INVALID");
      assert.equal(body.path, "engineeringMindsetGap");

      // The raw payload was preserved in the LLM debug log so the user can
      // inspect what the model produced.
      const debug = await readFile(
        join(baseDir, "llm", "scoring_results.jsonl"),
        "utf8"
      );
      assert.match(debug, /SCORE_SUMMARY_INVALID/);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/score rejects scores outside 1..10", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      const bad = JSON.parse(JSON.stringify(validSummary));
      bad.scores.technicalCorrectness = 12;
      const response = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: bad })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "SCORE_SUMMARY_INVALID");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/score logs non-JSON rawResponse to llm debug", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      const response = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawResponse: "not json at all" })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "SCORING_NOT_JSON");

      const debug = await readFile(
        join(baseDir, "llm", "scoring_results.jsonl"),
        "utf8"
      );
      assert.match(debug, /not json at all/);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("POST /api/attempts/:id/score returns 400 for an unknown attempt id", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/attempts/no-such-attempt/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: validSummary })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, "ATTEMPT_NOT_FOUND");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("GET /api/attempts after scoring exposes summary and status='scored'", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: validSummary })
      });
      const list = await (
        await fetch(`${baseUrl}/api/attempts?questionId=mysql-slow-sql`)
      ).json();
      assert.equal(list.attempts.length, 1);
      assert.equal(list.attempts[0].status, "scored");
      assert.equal(list.attempts[0].summary.engineeringMindsetGap, validSummary.engineeringMindsetGap);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("re-scoring an attempt appends a new score record (no in-place mutation)", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: validSummary })
      });
      // Re-score with a higher technicalCorrectness.
      const second = JSON.parse(JSON.stringify(validSummary));
      second.scores.technicalCorrectness = 9;
      await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: second })
      });
      const log = await readFile(
        join(baseDir, "scores", "scores.jsonl"),
        "utf8"
      );
      const lines = log.trim().split("\n");
      assert.equal(lines.length, 2);
      const latest = JSON.parse(lines[1]);
      assert.equal(latest.summary.scores.technicalCorrectness, 9);

      // The list endpoint now reflects the latest score.
      const list = await (
        await fetch(`${baseUrl}/api/attempts?questionId=mysql-slow-sql`)
      ).json();
      assert.equal(list.attempts[0].summary.scores.technicalCorrectness, 9);
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("DELETE /api/attempts/:id removes the attempt and its score records", async () => {
  const baseDir = await makeBase();
  try {
    await withServer(async (baseUrl) => {
      const attempt = await seedAttempt(baseUrl);
      await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}/score`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary: validSummary })
      });

      const del = await fetch(`${baseUrl}/api/attempts/${attempt.attemptId}`, {
        method: "DELETE"
      });
      assert.equal(del.status, 200);
      const payload = await del.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.attemptId, attempt.attemptId);
      assert.equal(payload.removedScores, 1);

      const list = await (
        await fetch(`${baseUrl}/api/attempts?questionId=mysql-slow-sql`)
      ).json();
      assert.equal(list.attempts.length, 0);

      const log = await readFile(
        join(baseDir, "scores", "scores.jsonl"),
        "utf8"
      );
      assert.equal(log.trim(), "");
    }, { baseDir });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
