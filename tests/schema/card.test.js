import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateCardRecord } from "../../src/domain/card.js";
import { ValidationError } from "../../src/domain/errors.js";

const baseCard = Object.freeze({
  id: "mysql-slow-sql-troubleshooting",
  title: "线上出现慢 SQL,怎么排查?",
  count: 0,
  category: "MySQL",
  tags: ["MySQL"],
  difficulty: "medium",
  createdAt: "2026-05-04",
  updatedAt: "2026-05-04",
  question: "线上出现慢 SQL,怎么排查?",
  myAnswer: "先看慢查询日志,再用 explain 分析,最后压测验证...",
  feedbackPromptVersion: "interview-coach-v2",
  feedback: {
    performanceScore: {
      scores: {
        technicalCorrectness: 7,
        coverageCompleteness: 6,
        logicalStructure: 7,
        expressionClarity: 7,
        interviewPerformance: 6
      },
      overallComment: "中等偏上"
    }
  }
});

test("validates a CardRecord with the minimum required feedback", () => {
  assert.doesNotThrow(() => validateCardRecord({ ...baseCard }));
});

test("validates a real legacy card from cards/", async () => {
  // Cross-check that legacy cards still pass — Step 1 must not break the
  // existing card library. We read from the workspace root, two directories
  // up from this test file.
  const legacyPath = new URL(
    "../../../cards/slow-sql-troubleshooting.json",
    import.meta.url
  );
  const json = JSON.parse(await readFile(legacyPath, "utf8"));
  assert.doesNotThrow(() => validateCardRecord(json));
});

test("rejects a card with an unknown category", () => {
  const bad = { ...baseCard, category: "前端" };
  assert.throws(
    () => validateCardRecord(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "CARD_INVALID");
      assert.equal(err.path, "category");
      return true;
    }
  );
});

test("rejects a card whose feedback.performanceScore is missing", () => {
  const bad = { ...baseCard, feedback: {} };
  assert.throws(
    () => validateCardRecord(bad),
    (err) => {
      assert.equal(err.path, "feedback.performanceScore");
      return true;
    }
  );
});

test("rejects a card whose performanceScore.scores is missing a key", () => {
  const bad = JSON.parse(JSON.stringify(baseCard));
  delete bad.feedback.performanceScore.scores.engineeringMindsetGap;
  delete bad.feedback.performanceScore.scores.interviewPerformance;
  assert.throws(() => validateCardRecord(bad), ValidationError);
});

test("rejects a card with a non-integer score", () => {
  const bad = JSON.parse(JSON.stringify(baseCard));
  bad.feedback.performanceScore.scores.technicalCorrectness = 7.5;
  assert.throws(() => validateCardRecord(bad), ValidationError);
});

test("rejects a card with a negative count", () => {
  const bad = { ...baseCard, count: -1 };
  assert.throws(() => validateCardRecord(bad), ValidationError);
});

test("rejects an id with unsafe characters", () => {
  const bad = { ...baseCard, id: "mysql/slow sql" };
  assert.throws(() => validateCardRecord(bad), ValidationError);
});
