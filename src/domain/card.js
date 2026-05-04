// CardRecord — the curated, "graduate-level" record that ends up in
// cards/*.json. Generated from a QuestionRecord plus a chosen AttemptRecord
// when the user explicitly clicks "save as card".
//
// CardRecord MUST stay structurally compatible with the legacy cards/*.json
// shape so the existing front-end and any external tooling continue to work.
// Keep validation lenient on the deep `feedback` shape — the legacy schema
// (`interview-coach-v2`) has many optional sub-sections and we should not
// reject a real saved card because one optional tip array is missing.
//
// Reference: phase-a-practice-loop-requirements 第 6.4 节,
// CARD_GENERATION_SPEC.md, sample card cards/slow-sql-troubleshooting.json.

import { ValidationError } from "./errors.js";
import { isAllowedCategory } from "./categories.js";
import { isAllowedDifficulty } from "./difficulty.js";
import { SCORE_KEYS } from "./scoreSummary.js";

function fail(path, message, value) {
  throw new ValidationError(`CardRecord.${path}: ${message}`, {
    code: "CARD_INVALID",
    path,
    value
  });
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate a CardRecord. Required fields mirror the legacy cards/*.json shape
 * so the existing front-end can render saved cards without modification.
 */
export function validateCardRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    fail("", "must be an object", record);
  }

  if (!isNonEmptyString(record.id)) {
    fail("id", "must be a non-empty string", record.id);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(record.id)) {
    fail("id", "may only contain letters, digits, underscore, and dash", record.id);
  }

  if (!isNonEmptyString(record.title)) {
    fail("title", "must be a non-empty string", record.title);
  }

  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) {
    fail("count", "must be a non-negative integer", record.count);
  }

  if (!isAllowedCategory(record.category)) {
    fail("category", "is not in the allowed category list", record.category);
  }

  if (!Array.isArray(record.tags)) {
    fail("tags", "must be an array of strings", record.tags);
  }
  for (const tag of record.tags) {
    if (typeof tag !== "string") {
      fail("tags", "every tag must be a string", tag);
    }
  }

  if (!isAllowedDifficulty(record.difficulty)) {
    fail("difficulty", "must be easy/medium/hard or 简单/中等/困难", record.difficulty);
  }

  if (!isNonEmptyString(record.createdAt)) {
    fail("createdAt", "must be a non-empty date string", record.createdAt);
  }
  if (!isNonEmptyString(record.updatedAt)) {
    fail("updatedAt", "must be a non-empty date string", record.updatedAt);
  }

  if (!isNonEmptyString(record.question)) {
    fail("question", "must be a non-empty string", record.question);
  }

  if (!isNonEmptyString(record.myAnswer)) {
    fail("myAnswer", "must be a non-empty string", record.myAnswer);
  }

  if (!isNonEmptyString(record.feedbackPromptVersion)) {
    fail("feedbackPromptVersion", "must be a non-empty string", record.feedbackPromptVersion);
  }

  if (record.feedback === null || typeof record.feedback !== "object" || Array.isArray(record.feedback)) {
    fail("feedback", "must be an object", record.feedback);
  }

  // Cards minted from an attempt MUST carry the five-score performanceScore
  // block. Long sub-sections (highScoreAnswer, followUpQuestions, etc.) stay
  // optional so legacy-saved cards remain importable.
  const perf = record.feedback.performanceScore;
  if (perf === null || typeof perf !== "object" || Array.isArray(perf)) {
    fail("feedback.performanceScore", "must be an object", perf);
  }
  if (!perf.scores || typeof perf.scores !== "object" || Array.isArray(perf.scores)) {
    fail("feedback.performanceScore.scores", "must be an object", perf?.scores);
  }
  for (const key of SCORE_KEYS) {
    const v = perf.scores[key];
    if (typeof v !== "number" || Number.isNaN(v) || !Number.isInteger(v) || v < 1 || v > 10) {
      fail(`feedback.performanceScore.scores.${key}`, "must be an integer between 1 and 10", v);
    }
  }

  return record;
}
