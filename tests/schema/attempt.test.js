import assert from "node:assert/strict";
import test from "node:test";
import { validateAttemptRecord } from "../../src/domain/attempt.js";
import { validateScoreSummary, REQUIRED_GAP_FIELDS } from "../../src/domain/scoreSummary.js";
import { ValidationError } from "../../src/domain/errors.js";

const validScores = Object.freeze({
  technicalCorrectness: 7,
  coverageCompleteness: 6,
  logicalStructure: 7,
  expressionClarity: 7,
  interviewPerformance: 6
});

const validSummary = Object.freeze({
  scores: validScores,
  overallComment: "中等偏上,缺少工程落点",
  primaryTechnicalGap: "没有覆盖锁等待和数据分布",
  primaryExpressionGap: "开头没有先给排查框架",
  engineeringMindsetGap: "缺少验证、灰度、回滚意识",
  retryInstruction: "下一版按发现-定位-分析-优化-验证的顺序回答"
});

const answeredAttempt = Object.freeze({
  attemptId: "attempt-001",
  questionId: "mysql-slow-sql-troubleshooting",
  answer: "我会先看慢查询日志,然后用 explain 看执行计划...",
  createdAt: "2026-05-04T10:00:00Z",
  status: "answered"
});

const scoredAttempt = Object.freeze({
  ...answeredAttempt,
  attemptId: "attempt-002",
  status: "scored",
  feedbackPromptVersion: "interview-coach-v2",
  summary: validSummary
});

test("validates an answered AttemptRecord without a summary", () => {
  assert.doesNotThrow(() => validateAttemptRecord({ ...answeredAttempt }));
});

test("validates a scored AttemptRecord with a complete summary", () => {
  assert.doesNotThrow(() => validateAttemptRecord({ ...scoredAttempt }));
});

test("rejects a scored attempt without a summary", () => {
  const bad = { ...scoredAttempt };
  delete bad.summary;
  assert.throws(
    () => validateAttemptRecord(bad),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.path, "summary");
      return true;
    }
  );
});

test("rejects a summary missing engineeringMindsetGap", () => {
  const badSummary = { ...validSummary };
  delete badSummary.engineeringMindsetGap;
  assert.throws(
    () => validateScoreSummary(badSummary),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, "SCORE_SUMMARY_INVALID");
      assert.equal(err.path, "engineeringMindsetGap");
      return true;
    }
  );
});

test("rejects a summary missing any of the four gap fields", () => {
  for (const field of REQUIRED_GAP_FIELDS) {
    const bad = { ...validSummary };
    delete bad[field];
    assert.throws(
      () => validateScoreSummary(bad),
      (err) => {
        assert.equal(err.path, field);
        return true;
      },
      `removing ${field} should fail`
    );
  }
});

test("rejects scores outside the 1-10 inclusive range", () => {
  for (const value of [0, 11, -1, 5.5]) {
    const bad = {
      ...validSummary,
      scores: { ...validScores, technicalCorrectness: value }
    };
    assert.throws(
      () => validateScoreSummary(bad),
      ValidationError,
      `score=${value} should be rejected`
    );
  }
});

test("rejects an attempt with empty answer", () => {
  const bad = { ...answeredAttempt, answer: "   " };
  assert.throws(() => validateAttemptRecord(bad), ValidationError);
});

test("rejects an attempt status outside the documented state machine", () => {
  const bad = { ...answeredAttempt, status: "draft" };
  assert.throws(() => validateAttemptRecord(bad), ValidationError);
});

test("rejects a scored attempt missing feedbackPromptVersion", () => {
  const bad = { ...scoredAttempt };
  delete bad.feedbackPromptVersion;
  assert.throws(() => validateAttemptRecord(bad), ValidationError);
});
