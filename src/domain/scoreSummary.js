// ScoreSummary — the structured summary produced by the LLM scoring step. It
// MUST contain three first-class gap fields so the retry loop and Phase B
// profile have the signals they need:
//
//   - primaryTechnicalGap     最影响通过率的技术问题
//   - primaryExpressionGap    最影响面试观感的表达问题
//   - engineeringMindsetGap   最缺少的工程意识或落地点
//   - retryInstruction        下一版只需优先改什么
//
// Reference: ceo-review-interview-training-plan §7, phase-a-implementation-plan
// Step 5 schema test "缺少 engineeringMindsetGap 的评分摘要失败".

import { ValidationError } from "./errors.js";

export const SCORE_KEYS = Object.freeze([
  "technicalCorrectness",
  "coverageCompleteness",
  "logicalStructure",
  "expressionClarity",
  "interviewPerformance"
]);

export const REQUIRED_GAP_FIELDS = Object.freeze([
  "primaryTechnicalGap",
  "primaryExpressionGap",
  "engineeringMindsetGap",
  "retryInstruction"
]);

function fail(path, message, value) {
  throw new ValidationError(`ScoreSummary.${path}: ${message}`, {
    code: "SCORE_SUMMARY_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateScoreSummary(summary) {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    fail("", "must be an object", summary);
  }

  if (
    summary.scores === null ||
    typeof summary.scores !== "object" ||
    Array.isArray(summary.scores)
  ) {
    fail("scores", "must be an object with the five score fields", summary.scores);
  }

  for (const key of SCORE_KEYS) {
    const v = summary.scores[key];
    if (typeof v !== "number" || Number.isNaN(v)) {
      fail(`scores.${key}`, "must be a number", v);
    }
    if (!Number.isInteger(v)) {
      fail(`scores.${key}`, "must be an integer", v);
    }
    if (v < 1 || v > 10) {
      fail(`scores.${key}`, "must be between 1 and 10 (inclusive)", v);
    }
  }

  for (const field of REQUIRED_GAP_FIELDS) {
    if (!isNonEmptyString(summary[field])) {
      fail(field, "must be a non-empty string (required by retry loop)", summary[field]);
    }
  }

  // overallComment is recommended but not required at the summary level —
  // long feedback is allowed to live under feedback.* in AttemptRecord.
  if (
    summary.overallComment !== undefined &&
    summary.overallComment !== null &&
    typeof summary.overallComment !== "string"
  ) {
    fail("overallComment", "must be a string when present", summary.overallComment);
  }

  return summary;
}

export function totalScore(summary) {
  return SCORE_KEYS.reduce((sum, key) => sum + summary.scores[key], 0) / SCORE_KEYS.length;
}
