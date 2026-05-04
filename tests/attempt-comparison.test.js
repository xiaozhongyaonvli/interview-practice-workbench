import assert from "node:assert/strict";
import test from "node:test";
import {
  totalScore,
  selectBestAttempt,
  scoreDelta
} from "../src/domain/attemptComparison.js";

const sumA = {
  scores: {
    technicalCorrectness: 5,
    coverageCompleteness: 5,
    logicalStructure: 5,
    expressionClarity: 5,
    interviewPerformance: 5
  },
  primaryTechnicalGap: "...",
  primaryExpressionGap: "...",
  engineeringMindsetGap: "...",
  retryInstruction: "..."
};

const sumB = {
  ...sumA,
  scores: {
    technicalCorrectness: 7,
    coverageCompleteness: 6,
    logicalStructure: 8,
    expressionClarity: 7,
    interviewPerformance: 7
  }
};

test("totalScore averages the five rubric scores", () => {
  assert.equal(totalScore(sumA), 5);
  assert.equal(totalScore(sumB), 7);
});

test("totalScore returns null when summary or scores is missing", () => {
  assert.equal(totalScore(null), null);
  assert.equal(totalScore({}), null);
  assert.equal(totalScore({ scores: { technicalCorrectness: 5 } }), null);
});

test("selectBestAttempt picks the highest-totaling scored attempt", () => {
  const attempts = [
    { attemptId: "a1", createdAt: "2026-05-04T10:00:00Z", summary: sumA },
    { attemptId: "a2", createdAt: "2026-05-04T11:00:00Z", summary: sumB }
  ];
  const best = selectBestAttempt(attempts);
  assert.equal(best.attemptId, "a2");
});

test("selectBestAttempt skips attempts without a valid summary", () => {
  const attempts = [
    { attemptId: "a1", createdAt: "2026-05-04T10:00:00Z", summary: null },
    { attemptId: "a2", createdAt: "2026-05-04T11:00:00Z", summary: sumA }
  ];
  const best = selectBestAttempt(attempts);
  assert.equal(best.attemptId, "a2");
});

test("selectBestAttempt breaks ties by the latest createdAt", () => {
  const attempts = [
    { attemptId: "early", createdAt: "2026-05-04T10:00:00Z", summary: sumA },
    { attemptId: "late", createdAt: "2026-05-05T10:00:00Z", summary: sumA }
  ];
  const best = selectBestAttempt(attempts);
  assert.equal(best.attemptId, "late");
});

test("selectBestAttempt returns null when nothing is scored", () => {
  const attempts = [
    { attemptId: "a1", createdAt: "x", summary: null },
    { attemptId: "a2", createdAt: "y", summary: undefined }
  ];
  assert.equal(selectBestAttempt(attempts), null);
});

test("selectBestAttempt returns null on empty list", () => {
  assert.equal(selectBestAttempt([]), null);
  assert.equal(selectBestAttempt(null), null);
});

test("scoreDelta computes total and per-key differences", () => {
  const d = scoreDelta(sumA, sumB);
  assert.equal(d.total, 2);
  assert.equal(d.perKey.technicalCorrectness, 2);
  assert.equal(d.perKey.coverageCompleteness, 1);
  assert.equal(d.perKey.logicalStructure, 3);
  assert.equal(d.perKey.expressionClarity, 2);
  assert.equal(d.perKey.interviewPerformance, 2);
});

test("scoreDelta returns null when either side is missing", () => {
  assert.equal(scoreDelta(sumA, null), null);
  assert.equal(scoreDelta(null, sumB), null);
});
